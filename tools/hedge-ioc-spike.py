# /// script
# requires-python = ">=3.10"
# dependencies = ["hyperliquid-python-sdk", "eth-account"]
# ///
"""Bounded testnet IOC spike. Reads by default; send requires --execute.

Reuses hip4.py's existing SDK/signing path. Each step is sent at most once per
state directory; uncertain submissions require read-only reconciliation.
"""
import argparse
import subprocess
import json
import os
import re
import sys
import time
import urllib.request
from decimal import Decimal as D
from pathlib import Path

API = "https://api.hyperliquid-testnet.xyz"
PROBE = "0x614992bbbe2BA4a35DC625b29FC66dCbCfe9FA6E"
HOUSE = "0x171070FE2E9f5bB1738Ecf6979C24057EBe1576D"
AGENT = "0x4328154291e79869Ba76017586533A6Bc50Cf273"
OUTCOME, ASSET, COIN = 19468, 100194680, "#194680"
STEPS = ["split", "full-ask", "full-buy", "partial-ask", "partial-buy", "empty-buy"]
BUY_STEPS = ["full-buy", "partial-buy", "empty-buy"]

class Stop(ValueError):
    """Only constant, safe-to-display validation messages belong here."""
EXPECTED = {"full-buy": D(10), "partial-buy": D(5), "empty-buy": D(0)}

def account(step):
    return PROBE if step in BUY_STEPS else HOUSE

def cloid(step):
    # Fixed experiment namespace: another state folder does not create new IDs.
    return "0x" + (202609180000 + STEPS.index(step)).to_bytes(16, "big").hex()

def action(step):
    if step == "split":
        return {"type": "userOutcome", "splitOutcome": {"outcome": OUTCOME, "amount": "15"}}
    return {"type": "order", "orders": [{"a": ASSET, "b": step in BUY_STEPS,
            "p": "0.5", "s": "5" if step == "partial-ask" else "10", "r": False,
            "t": {"limit": {"tif": "Ioc" if step in BUY_STEPS else "Gtc"}}, "c": cloid(step)}], "grouping": "na"}

def info(payload):
    req = urllib.request.Request(API + "/info", data=json.dumps(payload).encode(),
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=15) as response:
        return json.load(response)

def balance(state, token):
    names = {"USDC"} if token == 0 else {"#" + str(token - 100000000), "+" + str(token - 100000000)}
    rows = [x for x in state["balances"] if x.get("token") == token or x.get("coin") in names]
    if len(rows) > 1:
        raise Stop("ambiguous token balance")
    return (D(rows[0]["total"]), D(rows[0]["hold"])) if rows else (D(0), D(0))

def snapshot(step):
    a = account(step)
    result = {"atMs": int(time.time() * 1000), "account": a,
              "balance": info({"type": "spotClearinghouseState", "user": a}),
              "openOrders": info({"type": "openOrders", "user": a}),
              "fills": info({"type": "userFills", "user": a}),
              "book": info({"type": "l2Book", "coin": COIN})}
    if step != "split":
        result["order"] = info({"type": "orderStatus", "user": a, "oid": cloid(step)})
    return result

def save_new(path, value):
    # Persist before network submission, never overwrite ambiguous evidence.
    with path.open("x") as out:
        json.dump(value, out, indent=2)
        out.write("\n")
        out.flush()
        os.fsync(out.fileno())
    fd = os.open(path.parent, os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)

def submit_once(path, intent, sender, discard=False):
    save_new(path, intent)
    response = sender()
    if not discard:
        save_new(path.with_name(path.stem + "-response.json"), response)
    return response

def ready(step, before):
    if step != "split" and before["order"].get("status") != "unknownOid":
        raise Stop("client ID already exists; reconcile instead of sending")
    if before["openOrders"]:
        raise Stop("actor has an open order; reconcile first")
    for token in [0, ASSET, ASSET + 1]:
        if balance(before["balance"], token)[1] != 0:
            raise Stop("actor has held balance")
    asks = before["book"]["levels"][1]
    expected_depth = {"full-buy": D(10), "partial-buy": D(5)}.get(step, D(0))
    depth = sum((D(x["sz"]) for x in asks if D(x["px"]) <= D("0.5")), D(0))
    if depth != expected_depth:
        raise Stop("book changed; do not force the planned fill")
    if step in ["split", "full-ask", "partial-ask", "empty-buy"] and asks:
        raise Stop("expected empty ask book")
    total, _ = balance(before["balance"], 0)
    if total < (D("15.03") if step == "split" else D("5.01") if step in BUY_STEPS else D(0)):
        raise Stop("insufficient existing cash for capped attempt")
    if step.endswith("ask") and balance(before["balance"], ASSET)[0] < D(action(step)["orders"][0]["s"]):
        raise Stop("counterparty lacks shares")

def verify(step, before, after, response=None):
    base, now = before["balance"], after["balance"]
    yes = balance(now, ASSET)[0] - balance(base, ASSET)[0]
    debit = balance(base, 0)[0] - balance(now, 0)[0]
    if step == "split":
        return (yes == 15 and balance(now, ASSET + 1)[0] - balance(base, ASSET + 1)[0] == 15
                and D(15) <= debit <= D("15.03") and not after["openOrders"])
    status = after["order"].get("order", {}).get("status")
    details = after["order"].get("order", {}).get("order", {})
    if step.endswith("ask"):
        size = D(action(step)["orders"][0]["s"])
        return (status == "open" and details.get("cloid") == cloid(step)
                and D(details["sz"]) == size and D(details["limitPx"]) == D("0.5")
                and yes == 0 and balance(now, ASSET)[1] == size)
    qty = EXPECTED[step]
    statuses = (response or {}).get("response", {}).get("data", {}).get("statuses", [])
    no_match = any(isinstance(x, dict) and str(x.get("error", "")).startswith("Order could not immediately match") for x in statuses)
    terminal = status in {"filled", "canceled", "iocCancelRejected"}
    if qty == 0 and no_match:
        terminal = True  # Explicit exchange rejection, not inferred from zero hold.
    if not terminal or yes != qty or after["openOrders"] or balance(now, ASSET)[1] or balance(now, 0)[1]:
        return False
    fills = [f for f in after["fills"] if f.get("oid") == details.get("oid") and f.get("coin") in {COIN, COIN.replace("#", "+")}]
    if qty:
        if sum((D(f["sz"]) for f in fills), D(0)) != qty or any(D(f["px"]) > D("0.5") or f["side"] != "B" or f["feeToken"] != "USDC" for f in fills):
            return False
        cost = sum((D(f["px"]) * D(f["sz"]) + D(f["fee"]) for f in fills), D(0))
        return debit == cost and D(0) <= debit <= qty * D("0.5") + D("0.01")
    return debit == 0

def read_key(path, expected):
    # Supports the old spike's JSON scratch key and the existing root .env.
    from eth_account import Account
    contents = Path(path).read_text()
    for candidate in re.findall(r'(?<![a-fA-F0-9])(?:0x)?[a-fA-F0-9]{64}(?![a-fA-F0-9])', contents):
        try:
            wallet = Account.from_key(candidate)
            if wallet.address.lower() == expected.lower():
                return wallet
        except ValueError:
            continue
    raise Stop("file does not contain expected signer")

def selftest():
    import tempfile
    from copy import deepcopy
    b = lambda cash, yes, hold="0": {"balances": [{"coin": "USDC", "token": 0, "total": cash, "hold": "0"}, {"coin": "+194680", "total": yes, "hold": hold}]}
    before = {"balance": b("18.986", "0")}
    after = {"balance": b("13.986", "10"), "openOrders": [], "order": {"status": "order", "order": {"status": "filled", "order": {"oid": 7}}},
             "fills": [{"oid": 7, "coin": COIN, "side": "B", "sz": "10", "px": "0.5", "fee": "0", "feeToken": "USDC"}]}
    assert verify("full-buy", before, after)
    partial = deepcopy(after); partial["balance"] = b("16.486", "5"); partial["fills"][0]["sz"] = "5"; partial["order"]["order"]["status"] = "canceled"
    assert verify("partial-buy", before, partial)
    assert not verify("full-buy", before, partial)
    bad = deepcopy(after); bad["order"] = {"status": "unknownOid"}
    assert not verify("full-buy", before, bad)
    bad = deepcopy(after); bad["balance"] = b("13.986", "10", "1")
    assert not verify("full-buy", before, bad)
    bad = deepcopy(after); bad["fills"][0]["px"] = "0.6"
    assert not verify("full-buy", before, bad)
    empty = {"balance": b("18.986", "0"), "openOrders": [], "order": {"status": "unknownOid"}, "fills": []}
    assert not verify("empty-buy", before, empty)
    assert not verify("empty-buy", before, empty, {"status": "ok", "response": {"data": {"statuses": [{"error": "Order must have minimum value of $10."}]}}})
    rejected = {"status": "ok", "response": {"data": {"statuses": [{"error": "Order could not immediately match against any resting orders."}]}}}
    assert verify("empty-buy", before, empty, rejected)
    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / "full-buy.json"
        sent = []
        def timeout_after_send():
            sent.append(True)
            raise TimeoutError()
        try:
            submit_once(path, {"step": "full-buy", "before": before}, timeout_after_send)
        except TimeoutError:
            pass
        # A newly constructed caller sees persisted intent and cannot send twice.
        try:
            submit_once(Path(str(path)), {}, lambda: sent.append(True))
            raise AssertionError("duplicate allowed")
        except FileExistsError:
            pass
        child = subprocess.run([sys.executable, "-c", "import runpy,sys; from pathlib import Path; "
            "m=runpy.run_path(sys.argv[1]); "
            "m['submit_once'](Path(sys.argv[2]),{},lambda:sys.exit(99))", __file__, str(path)], capture_output=True)
        assert child.returncode == 1 and b"FileExistsError" in child.stderr
        assert len(sent) == 1 and verify("full-buy", json.loads(path.read_text())["before"], after)
    assert sum(D(action(s)["orders"][0]["p"]) * D(action(s)["orders"][0]["s"]) for s in BUY_STEPS) == 15
    print("PASS: full/partial fill, cap/hold guards, unknown/rejection handling, persisted timeout recovery, duplicate-send refusal; max probe notional 15 USDC")

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=["plan", "selftest", "snapshot", "send", "reconcile", "cancel"])
    parser.add_argument("step", nargs="?", choices=STEPS)
    parser.add_argument("--state", default="/private/tmp/hype-ioc-20260918")
    parser.add_argument("--key-file")
    parser.add_argument("--execute", action="store_true")
    parser.add_argument("--discard-response", action="store_true")
    args = parser.parse_args()
    if args.command == "selftest":
        selftest(); return
    if args.command == "plan":
        print(json.dumps({"network": "testnet", "outcome": OUTCOME, "probeMaxNotional": "15", "probeFeeBudget": "0.03", "counterpartySplit": "15", "steps": [{"step": s, "account": account(s), "action": action(s)} for s in STEPS]}, indent=2)); return
    if args.step is None:
        parser.error("step required")
    step = args.step
    if args.command == "snapshot":
        print(json.dumps(snapshot(step), indent=2)); return
    state = Path(args.state); state.mkdir(parents=True, exist_ok=True)
    path = state / (step + ".json")
    if args.command == "reconcile":
        intent = json.loads(path.read_text())
        response_path = state / (step + "-response.json")
        response = json.loads(response_path.read_text()) if response_path.exists() else None
        after = snapshot(step)
        save_new(state / (step + "-read-" + str(after["atMs"]) + ".json"), after)
        if not verify(step, intent["before"], after, response):
            raise Stop("PENDING or unexpected result; preserve state and inspect, do not resend")
        if not (state / (step + "-verified.json")).exists():
            save_new(state / (step + "-verified.json"), after)
        print("PASS " + step + ": reconciled from persisted intent and fresh reads"); return
    if not args.execute or not args.key_file:
        parser.error("send requires explicit --execute and --key-file after user approval")
    cancel = args.command == "cancel"
    if cancel:
        if step not in ["full-ask", "partial-ask"] or not path.exists():
            raise Stop("cancel only a recorded counterparty test ask")
        path = state / (step + "-cancel.json")
    elif any(state.glob("*-cancel.json")):
        raise Stop("test aborted for cleanup; inspect before any further order")
    if path.exists():
        raise Stop("intent already exists: use reconcile; sending again is forbidden")
    prior = STEPS[:STEPS.index(step)]
    if not cancel and not all((state / (s + "-verified.json")).exists() for s in prior):
        raise Stop("reconcile all previous steps first")
    expected = AGENT if step in BUY_STEPS else HOUSE
    wallet = read_key(args.key_file, expected)
    # Cleanup must remain possible if trading metadata or fee rates change.
    if not cancel:
        markets = info({"type": "outcomeMeta"})["outcomes"]
        market = next((m for m in markets if m["outcome"] == OUTCOME), None)
        if market is None or market.get("venue") != "flip" or market.get("deployerFeeScale") != "1.0":
            raise Stop("market identity/fee scale changed")
        fees = info({"type": "userFees", "user": account(step)})
        if 2 * max(D(fees["userSpotCrossRate"]), D(fees["userSpotAddRate"])) > D("0.002"):
            raise Stop("fee budget must be reviewed")
    before = snapshot(step)
    if cancel:
        if before["order"].get("order", {}).get("status") != "open":
            raise Stop("ask is not confirmed open; reconcile instead")
    else:
        ready(step, before)
    from hyperliquid.exchange import Exchange
    from hyperliquid.utils.signing import sign_l1_action
    exchange = Exchange(wallet, API, account_address=account(step))
    nonce = int(time.time() * 1000)
    exchange.expires_after = nonce + 15000
    request = {"type": "cancelByCloid", "cancels": [{"asset": ASSET, "cloid": cloid(step)}]} if cancel else action(step)
    intent = {"step": step, "network": "testnet", "account": account(step), "action": request, "nonce": nonce, "expiresAfter": exchange.expires_after, "before": before}
    def sender():
        sig = sign_l1_action(wallet, request, None, nonce, exchange.expires_after, False)
        return exchange._post_action(request, sig, nonce)
    submit_once(path, intent, sender, args.discard_response)
    if cancel:
        print("Cancellation attempted once; use snapshot to verify canceled/filled status and released holds. Test stopped.")
        return
    print("Submission attempted once; " + ("response deliberately discarded. " if args.discard_response else "response saved. ") + "Run reconcile from a fresh process.")

if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        # SDK/request exceptions must never print private config or key contents.
        print("STOP: " + (str(error) if isinstance(error, Stop) else type(error).__name__) + "; inspect saved public evidence; do not resend.", file=sys.stderr)
        sys.exit(1)

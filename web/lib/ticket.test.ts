import { beforeEach, expect, test, vi } from "vitest";
import { mintTicket, TicketSession } from "./ticket";
import { requestQuote, type QuoteResult } from "./writer";

vi.mock("./writer", () => ({ requestQuote: vi.fn() }));
const taker = `0x${"1".repeat(40)}` as const;
const vault = `0x${"2".repeat(40)}` as const;
const input = { taker, legs: [{ vault, isYes: true }], stake: "1000000", inviteCode: "invite" };
const result = (): Extract<QuoteResult, { ok: true }> => ({ ok: true, sig: "0x1234", quote: {
  taker, maker: taker, legs: input.legs, premium: input.stake, maxPayout: "2000000", deadline: String(Math.floor(Date.now() / 1000) + 30), quoteId: `0x${"a".repeat(64)}`,
} });
beforeEach(() => vi.resetAllMocks());

test("superseded quotes and changed ticket contexts cannot become current", async () => {
  const session = new TicketSession();
  for (const key of ["selections", "stake", "wallet", "chain", "invite"]) {
    session.select("original");
    let finish!: (value: QuoteResult) => void;
    vi.mocked(requestQuote).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const pending = session.quote(input);
    session.select(key);
    session.select("original");
    finish(result());
    expect(await pending).toBeNull();
  }
  let finish!: (value: QuoteResult) => void;
  vi.mocked(requestQuote).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })).mockResolvedValueOnce(result());
  const old = session.quote(input);
  expect((await session.quote(input))?.result.ok).toBe(true);
  finish(result());
  expect(await old).toBeNull();
  expect(session.beginMint()).toBe(true);
  expect(session.beginMint()).toBe(false);
});

function setup(allowance = 0n) {
  const calls: string[] = [];
  const client = {
    readContract: async ({ functionName }: { functionName: string }) => { calls.push(functionName); return functionName === "allowance" ? allowance : 1000000n; },
    simulateContract: vi.fn(async () => { calls.push("simulate"); }),
    waitForTransactionReceipt: vi.fn(async () => { calls.push("receipt"); return { status: "success" }; }),
  };
  const write = vi.fn(async ({ functionName }: { functionName: string }) => { calls.push(functionName); return "0x1"; });
  const fresh = result();
  vi.mocked(requestQuote).mockImplementation(async () => { calls.push("requote"); return fresh; });
  const args = { client: client as never, write: write as never, usdc: vault, quote: result().quote, sig: "0x1234" as const, input, current: () => true, onQuote: vi.fn() };
  return { calls, client, write, args, fresh };
}

test("mint preserves exact approval, fresh quote, simulation and receipt order", async () => {
  const { calls, args, write, fresh } = setup();
  expect(await mintTicket(args)).toBe(true);
  expect(calls).toEqual(["allowance", "balanceOf", "approve", "receipt", "requote", "simulate", "mint", "receipt"]);
  expect(write.mock.calls[0][0]).toMatchObject({ functionName: "approve", args: [expect.any(String), 1000000n], account: taker, chainId: 998 });
  expect(write.mock.calls[1][0]).toMatchObject({ functionName: "mint", args: [expect.objectContaining({ premium: 1000000n, maxPayout: 2000000n, quoteId: fresh.quote.quoteId }), fresh.sig] });
});

test("wallet/context changes, quote failure and receipt reverts stop minting", async () => {
  const changed = setup();
  let current = true;
  changed.args.current = () => current;
  changed.client.waitForTransactionReceipt.mockImplementationOnce(async () => { current = false; return { status: "success" }; });
  await expect(mintTicket(changed.args)).rejects.toThrow("Ticket changed");
  expect(changed.calls).not.toContain("mint");

  const failed = setup();
  vi.mocked(requestQuote).mockResolvedValueOnce({ ok: false, status: 409, error: "leg-settled" });
  expect(await mintTicket(failed.args)).toBe(false);
  expect(failed.calls).not.toContain("mint");

  const reverted = setup(1000000n);
  reverted.client.waitForTransactionReceipt.mockResolvedValueOnce({ status: "reverted" });
  await expect(mintTicket(reverted.args)).rejects.toThrow("QUOTE_EXPIRED");
  const rejected = setup();
  rejected.write.mockRejectedValueOnce(new Error("User rejected"));
  await expect(mintTicket(rejected.args)).rejects.toThrow("User rejected");
  expect(rejected.calls).not.toContain("mint");
});

test("expiring quotes reprice without approval; changed premiums never spend", async () => {
  const expiring = setup(1000000n);
  expiring.args.quote.deadline = String(Math.floor(Date.now() / 1000) + 1);
  await mintTicket(expiring.args);
  expect(expiring.calls).toContain("requote");
  expect(expiring.calls).not.toContain("approve");
  const changed = setup();
  changed.fresh.quote.premium = "2000000";
  await expect(mintTicket(changed.args)).rejects.toThrow("changed ticket terms");
  expect(changed.calls).not.toContain("mint");
});

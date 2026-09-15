# /// script
# requires-python = ">=3.10"
# dependencies = ["hyperliquid-python-sdk", "eth-account"]
# ///
# Post one signed HyperCore exchange action for the PRIVATE_KEY wallet:
#   uv run tools/hip4.py '{"type":"outcomeDeploy","venue":"flip","operation":{...}}'
# Used for HIP-4 deployer actions the SDK has no method for. JSON key order is
# preserved and hashed (msgpack), so keep the order documented by Hyperliquid.
import json
import os
import sys

from eth_account import Account
from hyperliquid.exchange import Exchange
from hyperliquid.utils.constants import TESTNET_API_URL
from hyperliquid.utils.signing import get_timestamp_ms, sign_l1_action

action = json.loads(sys.argv[1])
exchange = Exchange(Account.from_key(os.environ["PRIVATE_KEY"]), TESTNET_API_URL)
nonce = get_timestamp_ms()
signature = sign_l1_action(exchange.wallet, action, None, nonce, exchange.expires_after, False)
response = exchange._post_action(action, signature, nonce)
print(json.dumps(response))
sys.exit(0 if response.get("status") == "ok" else 1)

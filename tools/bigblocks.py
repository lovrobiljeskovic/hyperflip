# /// script
# requires-python = ">=3.10"
# dependencies = ["hyperliquid-python-sdk", "eth-account"]
# ///
# Toggle big blocks for the deployer wallet: `uv run tools/bigblocks.py on|off`.
# OutcomeVault deploys exceed the small-block gas limit; toggle back off after
# or every later tx crawls at the ~60s big-block cadence.
import os
import sys

from eth_account import Account
from hyperliquid.exchange import Exchange
from hyperliquid.utils.constants import TESTNET_API_URL

flag = sys.argv[1] == "on"
wallet = Account.from_key(os.environ["PRIVATE_KEY"])
print(Exchange(wallet, TESTNET_API_URL).use_big_blocks(flag))

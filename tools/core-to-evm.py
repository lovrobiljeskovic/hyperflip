# Move USDC from a wallet's HyperCore spot balance to the same address on HyperEVM.
# This is the safe direction (EVM->Core sank funds on testnet, see BUILD_STATE.md M1).
#   PRIVATE_KEY=<key> uv run --with hyperliquid-python-sdk --with eth-account python tools/core-to-evm.py <amount>
import os
import sys

from eth_account import Account
from hyperliquid.exchange import Exchange
from hyperliquid.utils.constants import TESTNET_API_URL

# Per-token Core system address: first byte 0x20, then the token index big-endian.
# 0x2222...2222 is HYPE only; USDC is token index 0.
EVM_SYSTEM_ADDRESS = "0x2000000000000000000000000000000000000000"
USDC = "USDC:0xeb62eee3685fc4c43992febcd9e75443"  # testnet token 0, from spotMeta

amount = float(sys.argv[1])
wallet = Account.from_key(os.environ["PRIVATE_KEY"])
print("from", wallet.address, "amount", amount)
# sendAsset, not spotSend: spotSend answers "Action disabled when unified account
# is active", sendAsset is the unified-account replacement.
print(Exchange(wallet, TESTNET_API_URL).send_asset(EVM_SYSTEM_ADDRESS, "spot", "spot", USDC, amount))

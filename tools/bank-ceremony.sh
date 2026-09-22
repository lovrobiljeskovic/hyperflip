#!/usr/bin/env bash
# Cold-key ceremony for the Elysium ParlayVault: move the bank's USDC float and some gas from
# HyperEVM testnet (998) to Elysium (99801) and approve the new vault. Run from the repo root:
#   bash tools/bank-ceremony.sh [KEY_FILE] [USDC_AMOUNT]
# KEY_FILE defaults to the first file under ~/.hype-keys whose key derives the bank address.
# Prints addresses and balances only, never the key.
set -euo pipefail
BANK=0x3325D57D906F24AE9AfdE5229Ac8174A8fa0C5A7
INBOX=0x11178Df40CBf87a4343f4B3F8B09B366ceFA8Ec0
ROUTER=0x1aAE2caD8B0249905492087EF230FcCEa3707C45
GATEWAY=0x792487eF5E423104bec94e8c58E814e5E0450cEA
USDC_998=0x2B3370eE501B4a559b57D449569354196457D8Ab
USDC_ELY=0x7D29d8047B905000459c0E80c34a26CeedcB47b2
VAULT=0xEAD53F4C662C69Ed31AE2d9054d6B0a4aE1A00D6
L1=https://rpc.hyperliquid-testnet.xyz/evm
L2=https://testnet-rpc.elysium.kinetiq.xyz
AMOUNT=${2:-250000000} # 6-decimal USDC base units

key_of() { grep -oE '0x[0-9a-fA-F]{64}' "$1" 2>/dev/null | head -1; }
KEY=""
if [ -n "${1:-}" ]; then KEY=$(key_of "$1"); else
  for f in ~/.hype-keys/*; do
    k=$(key_of "$f") || true
    [ -n "$k" ] && [ "$(cast wallet address --private-key "$k" 2>/dev/null | tail -1)" = "$BANK" ] && { KEY=$k; echo "bank key: $f"; break; }
  done
fi
[ -n "$KEY" ] || { echo "no file under ~/.hype-keys derives the bank $BANK; pass the file as the first argument" >&2; exit 1; }
[ "$(cast wallet address --private-key "$KEY" | tail -1)" = "$BANK" ] || { echo "key does not derive the bank address" >&2; exit 1; }

send() { cast send --private-key "$KEY" "$@" | grep -E '^(status|transactionHash)' | tr '\n' ' '; echo; }
echo "998 USDC: $(cast call --rpc-url $L1 $USDC_998 'balanceOf(address)(uint256)' $BANK | tail -1)  998 HYPE: $(cast balance --rpc-url $L1 $BANK | tail -1)"

echo "1/4 gas to Elysium (0.01 HYPE)";       send --rpc-url $L1 --legacy --value 0.01ether $INBOX "depositEth()"
echo "2/4 approve gateway for $AMOUNT";      send --rpc-url $L1 --legacy $USDC_998 "approve(address,uint256)" $GATEWAY $AMOUNT
echo "3/4 bridge $AMOUNT USDC";              send --rpc-url $L1 --legacy --value 0.0002ether $ROUTER \
  "outboundTransfer(address,address,uint256,uint256,uint256,bytes)" $USDC_998 $BANK $AMOUNT 300000 20000000 \
  "$(cast abi-encode 'f(uint256,bytes)' 100000000000000 0x)"

echo "waiting for the bridge (up to 5 min)…"
for i in $(seq 1 30); do
  usdc=$(cast call --rpc-url $L2 $USDC_ELY 'balanceOf(address)(uint256)' $BANK | tail -1 | cut -d' ' -f1)
  hype=$(cast balance --rpc-url $L2 $BANK | tail -1)
  [ "$usdc" != "0" ] && [ "$hype" != "0" ] && break
  sleep 10
done
echo "Elysium USDC: $usdc  Elysium HYPE: $hype"
[ "$usdc" != "0" ] && [ "$hype" != "0" ] || { echo "bridge not landed yet; rerun step 4 by hand later" >&2; exit 1; }

echo "4/4 approve the Elysium vault (unbounded)"; send --rpc-url $L2 $USDC_ELY "approve(address,uint256)" $VAULT "$(cast max-uint)"
echo "allowance: $(cast call --rpc-url $L2 $USDC_ELY 'allowance(address,address)(uint256)' $BANK $VAULT | tail -1)"
echo "done"

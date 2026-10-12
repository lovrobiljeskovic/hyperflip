#!/usr/bin/env bash
# Cut the box over to the Elysium ParlayVault. Run from the repo root on the laptop:
#   bash tools/box-cutover.sh
# Syncs writer, keeper, registry and the rotation checkout, sets the Elysium keys in
# /opt/hype/.env, rebuilds Foundry artifacts for rotation, clears the old parlay index,
# restarts writer and keeper and prints their health. Idempotent.
set -euo pipefail
BOX=${BOX:-root@91.99.94.25}
STAGE=/tmp/hype-cutover

echo "== stage files on the box"
# tar keeps the directory prefixes (rsync with several sources flattens them to the last component).
tar czf - --exclude settlement-cache.json --exclude parlays.json --exclude quotes.jsonl --exclude waitlist.json \
  writer/src writer/abi keeper/src keeper/abi services registry/deployment.mts registry/deployment.testnet.json registry/markets.json \
  tools script src foundry.toml | ssh "$BOX" "rm -rf $STAGE && mkdir -p $STAGE && tar xzf - -C $STAGE"

ssh "$BOX" bash -s <<'REMOTE'
set -euo pipefail
S=/tmp/hype-cutover
echo "== services"
cp -r $S/writer/src/. /opt/hype/writer/src/
cp -r $S/writer/abi/. /opt/hype/writer/abi/
cp -r $S/keeper/src/. /opt/hype/keeper/src/
cp -r $S/keeper/abi/. /opt/hype/keeper/abi/
mkdir -p /opt/hype/services && cp -r $S/services/. /opt/hype/services/
cp $S/registry/deployment.mts $S/registry/deployment.testnet.json /opt/hype/registry/
cp $S/registry/markets.json /opt/hype/registry/markets.json          # cp writes through a symlink, rsync would replace it
echo "== rotation checkout"
mkdir -p /opt/hype/repo/registry
cp -r $S/tools/. /opt/hype/repo/tools/
cp -r $S/script/. /opt/hype/repo/script/
cp -r $S/src/. /opt/hype/repo/src/
cp $S/foundry.toml /opt/hype/repo/foundry.toml
cp $S/registry/deployment.mts $S/registry/deployment.testnet.json /opt/hype/repo/registry/
[ -L /opt/hype/repo/registry/markets.json ] || cp $S/registry/markets.json /opt/hype/repo/registry/markets.json
# Rotation (hourly) needs these artifacts; a failed build must not stop the service cutover.
(cd /opt/hype/repo && PATH=$HOME/.foundry/bin:$PATH forge build 2>&1 | grep -vE "^(note|warning)|╰|^\s*$|foundry-pp|Detected artifacts|forge clean" | tail -8 && echo "forge build ok") \
  || echo "!! forge build FAILED in /opt/hype/repo — services continue; fix before the next :10 rotation"
echo "== .env"
setkey() { # setkey FILE KEY VALUE — replace or append, keep the file's mode
  if grep -q "^$2=" "$1"; then sed -i "s|^$2=.*|$2=$3|" "$1"; else printf '%s=%s\n' "$2" "$3" >> "$1"; fi
}
# defkey: append only when missing. The box carries a keyed Conduit URL in *_RPC that the
# public URL must never overwrite (public endpoint rate-limits boot, writer crash-loops).
defkey() { grep -q "^$2=" "$1" || printf '%s=%s\n' "$2" "$3" >> "$1"; }
for f in /opt/hype/.env $( [ -f /opt/hype/repo/.env ] && [ ! -L /opt/hype/repo/.env ] && echo /opt/hype/repo/.env ); do
  setkey $f PARLAY_VAULT_ADDRESS 0xEAD53F4C662C69Ed31AE2d9054d6B0a4aE1A00D6
  setkey $f PARLAY_DEPLOY_BLOCK 27935
  defkey $f WRITER_RPC https://testnet-rpc.elysium.kinetiq.xyz
  setkey $f PARLAY_INDEX_FROM_BLOCK 27935
  defkey $f ELYSIUM_RPC https://testnet-rpc.elysium.kinetiq.xyz
  setkey $f RELAY_ADDRESS 0x7F495A95D34b14896820B178Da269a1B1EdC3612
  setkey $f INBOX_ADDRESS 0x11178Df40CBf87a4343f4B3F8B09B366ceFA8Ec0
  setkey $f ROTATE_VENUES flip,flp
  grep -q "^EVM_CHAIN_ID=" $f && setkey $f EVM_CHAIN_ID 99801
  echo "$f: $(grep -cE '^(PARLAY_VAULT_ADDRESS|PARLAY_DEPLOY_BLOCK|WRITER_RPC|PARLAY_INDEX_FROM_BLOCK|ELYSIUM_RPC|RELAY_ADDRESS|INBOX_ADDRESS|ROTATE_VENUES)=' $f)/8 keys set"
done
echo "== restart"
rm -f /opt/hype/writer/parlays.json
systemctl restart writer keeper
sleep 12
systemctl is-active writer keeper
curl -sf http://localhost:8787/health | head -c 600; echo
echo "== last keeper lines"
journalctl -u keeper -n 5 --no-pager | cut -c1-160
echo "== last writer lines"
journalctl -u writer -n 5 --no-pager | cut -c1-160
rm -rf $S
REMOTE
echo "box cutover done"

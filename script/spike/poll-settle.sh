#!/bin/zsh
# S2b item 4: log 0x814 status + probe 0x801 balances once a minute until status 3 is seen
# twice. Start it BEFORE the game ends (prune follows settle within ~10 min):
#   nohup script/spike/poll-settle.sh > script/spike/settle-19467.log 2>&1 &
cd /tmp
RPC=https://rpcs.chain.link/hyperevm/testnet
PROBE=0x614992bbbe2BA4a35DC625b29FC66dCbCfe9FA6E
O=19467; Y=$((100000000 + 10*O)); N=$((Y+1)); pruned=0
while true; do
  ST=$(cast call 0x0000000000000000000000000000000000000814 $(cast abi-encode "f(uint32)" $O) --rpc-url $RPC 2>/dev/null | xargs cast abi-decode "f()(uint8,uint64,uint32)" 2>/dev/null | awk '{print $1}' | tr '\n' ' ')
  line="$(date -u +%FT%TZ) status/settled/question: $ST |"
  for T in 0 $Y $N; do
    R=$(cast call 0x0000000000000000000000000000000000000801 $(cast abi-encode "f(address,uint64)" $PROBE $T) --rpc-url $RPC 2>/dev/null)
    if [[ $R == 0x* ]]; then
      D=$(cast abi-decode "f()(uint64,uint64,uint64)" $R 2>/dev/null | awk '{print $1}' | tr '\n' '/')
      line="$line $T total/hold/entry $D"
    else line="$line $T REVERT"; fi
  done
  echo "$line"
  [[ $ST == 3* ]] && ((pruned++)) && [[ $pruned -ge 2 ]] && exit 0
  sleep 60
done

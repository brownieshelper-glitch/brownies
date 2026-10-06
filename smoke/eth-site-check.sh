#!/usr/bin/env bash
# Checks the app page against a local Ethereum fork with the coin launched the real way (eth-launch), the four
# brownies on the payroll and one skill proposed. Nothing leaves this machine.
#   bash smoke/eth-site-check.sh         from agent-company/, Git Bash
set -euo pipefail
cd "$(dirname "$0")/.."
F="$HOME/.foundry/bin"; PORT=8557; RPC="http://127.0.0.1:$PORT"; WPORT=8789
K0=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
K1=0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d; A1=0x70997970C51812dc3A010C7d01b50e0d17dc79C8
ANVIL_PID=""; WEB_PID=""
cleanup() { for p in "$WEB_PID" "$ANVIL_PID"; do [ -n "$p" ] && kill "$p" 2>/dev/null || true; done; echo "stopped the check's anvil and web server"; }
trap cleanup EXIT
"$F/anvil" --fork-url https://ethereum-rpc.publicnode.com --port $PORT --silent >/tmp/brownies-ethcheck-anvil.log 2>&1 &
ANVIL_PID=$!
for i in $(seq 1 60); do curl -s -X POST "$RPC" -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' | grep -q '0x1"' && break; sleep 1; done
echo "anvil up"
RPC_URL="$RPC" node eth-launch/launch.mjs fork > /tmp/brownies-ethcheck-launch.log 2>&1 && echo "launched on the fork"
RPC_URL="$RPC" node eth-launch/rehearse-fees.mjs web/deployments/1.fork.json > /tmp/brownies-ethcheck-fees.log 2>&1 && echo "fees collected and split"
read TOKEN STAKING SUGAR VAULT REGISTRY < <(node -e "const j=require('./web/deployments/1.fork.json');console.log(j.token,j.staking,j.sugar,j.teamVault,j.skillRegistry)")
n=1; for name in Fudge Crumb Nib Chip; do "$F/cast" send --private-key $K0 $VAULT "addHelper(string,bytes32,uint32)" $name 0x000000000000000000000000000000000000000000000000000000000000000$n 1 --rpc-url "$RPC" >/dev/null; n=$((n+1)); done
echo "four brownies on the payroll"
# account 1 holds BROWNIE from the rehearsal trades: it stakes, waits a day, proposes a skill and votes yes
"$F/cast" send --private-key $K1 $TOKEN "approve(address,uint256)" $STAKING 10000000000000000000000 --rpc-url "$RPC" >/dev/null
"$F/cast" send --private-key $K1 $STAKING "stake(uint256)" 10000000000000000000000 --rpc-url "$RPC" >/dev/null
"$F/cast" rpc evm_increaseTime 86401 --rpc-url "$RPC" >/dev/null; "$F/cast" rpc evm_mine --rpc-url "$RPC" >/dev/null
"$F/cast" send --private-key $K1 $REGISTRY "submit(string,uint256)" "https://github.com/brownieshelper-glitch/brownies/pull/1" 5000000 --rpc-url "$RPC" >/dev/null
"$F/cast" send --private-key $K1 $REGISTRY "vote(uint256,bool)" 0 true --rpc-url "$RPC" >/dev/null
echo "one skill proposed and voted"
( cd web && exec env PORT=$WPORT node serve.mjs >/tmp/brownies-ethcheck-web.log 2>&1 ) &
WEB_PID=$!
sleep 2
node smoke/eth-site-check.mjs "http://127.0.0.1:$WPORT/app.html?intro=0&dep=1.fork&rpc=$(node -e "console.log(encodeURIComponent('$RPC'))")"

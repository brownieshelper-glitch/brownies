#!/usr/bin/env bash
# Checks the gateway's keeper against a local Ethereum fork: the coin launched the real way, fees traded and claimed
# once, the four brownies on the payroll, then the keeper's three duties. Nothing leaves this machine.
#   bash smoke/eth-keeper-check.sh         from agent-company/, Git Bash
set -euo pipefail
cd "$(dirname "$0")/.."
F="$HOME/.foundry/bin"; PORT=8559; RPC="http://127.0.0.1:$PORT"
K0=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
ANVIL_PID=""
cleanup() { [ -n "$ANVIL_PID" ] && kill "$ANVIL_PID" 2>/dev/null || true; echo "stopped the check's anvil"; }
trap cleanup EXIT
"$F/anvil" --fork-url https://ethereum-rpc.publicnode.com --port $PORT --silent >/tmp/brownies-keepercheck-anvil.log 2>&1 &
ANVIL_PID=$!
for i in $(seq 1 60); do curl -s -X POST "$RPC" -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' | grep -q '0x1"' && break; sleep 1; done
echo "anvil up"
REC=web/deployments/1.fork.json
RPC_URL="$RPC" node eth-launch/launch.mjs fork > /tmp/brownies-keepercheck-launch.log 2>&1 || { tail -5 /tmp/brownies-keepercheck-launch.log; exit 1; }
echo "launched on the fork ($REC)"
RPC_URL="$RPC" node eth-launch/rehearse-fees.mjs "$REC" > /tmp/brownies-keepercheck-fees.log 2>&1 && echo "fees traded, claimed once and split"
VAULT=$(node -e "console.log(require('./$REC').teamVault)")
n=1; for name in Fudge Crumb Nib Chip; do "$F/cast" send --private-key $K0 $VAULT "addHelper(string,bytes32,uint32)" $name 0x000000000000000000000000000000000000000000000000000000000000000$n 1 --rpc-url "$RPC" >/dev/null; n=$((n+1)); done
echo "four brownies on the payroll"
RPC_URL="$RPC" node smoke/eth-keeper-check.mjs "$REC"

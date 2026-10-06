#!/usr/bin/env bash
# Full rehearsal of the Ethereum launch on a LOCAL anvil fork of mainnet. Sends nothing anywhere else.
#
#   ./eth-launch/rehearse.sh            (from agent-company; Git Bash on Windows is fine)
#
# 1. starts anvil forking Ethereum on port 8557 (8558 if 8557 is busy; never any other port)
# 2. forge build, so launch.mjs reads fresh artifacts
# 3. check-derivation.mjs: recomputes the real Programmable launches from their inputs (proof of the encoding)
# 4. launch.mjs fork: core, registry, setPayer, deployGraph with anvil's public account 0
# 5. rehearse-fees.mjs: buys and sells through the Universal Router, claimCreator and harvester.claim by a stranger
# 6. stops ITS OWN anvil only (by pid). Other anvil or node processes (8546, 8556, ...) are never touched.
set -euo pipefail
cd "$(dirname "$0")/.."
FOUNDRY="${FOUNDRY_BIN:-$HOME/.foundry/bin}"
FORK_URL="${FORK_URL:-https://ethereum-rpc.publicnode.com}"
ANVIL_PID=""
LOG="$(mktemp -t brownies-anvil-XXXXXX.log)"

port_busy() { netstat -ano 2>/dev/null | grep -E "[:.]$1[[:space:]]" | grep -qi listen; }
PORT=8557
if port_busy "$PORT"; then
  echo "port 8557 is in use, trying 8558"
  PORT=8558
  if port_busy "$PORT"; then echo "ports 8557 and 8558 are both in use; stop one of YOUR anvils or free a port"; exit 1; fi
fi
RPC="http://127.0.0.1:$PORT"

cleanup() {
  if [ -n "$ANVIL_PID" ] && kill -0 "$ANVIL_PID" 2>/dev/null; then
    echo "stopping the rehearsal anvil (pid $ANVIL_PID)"
    kill "$ANVIL_PID" 2>/dev/null || true
    sleep 2
    kill -9 "$ANVIL_PID" 2>/dev/null || true
    if port_busy "$PORT"; then echo "WARNING: something still listens on $PORT; the rehearsal anvil (pid $ANVIL_PID) may need a manual stop"; else echo "port $PORT is free again"; fi
  fi
  echo "anvil log: $LOG"
}
trap cleanup EXIT

echo "starting anvil, fork of $FORK_URL on $RPC"
"$FOUNDRY/anvil" --fork-url "$FORK_URL" --port "$PORT" --host 127.0.0.1 --chain-id 1 --retries 5 --timeout 60000 --silent >"$LOG" 2>&1 &
ANVIL_PID=$!
for i in $(seq 1 90); do
  if curl -s -X POST "$RPC" -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}' | grep -q '"result"'; then break; fi
  if ! kill -0 "$ANVIL_PID" 2>/dev/null; then echo "anvil died while starting:"; tail -20 "$LOG"; exit 1; fi
  sleep 1
done
curl -s -X POST "$RPC" -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}' | grep -q '"result"' || { echo "anvil did not answer on $RPC"; tail -20 "$LOG"; exit 1; }
echo "anvil up (pid $ANVIL_PID), block $(curl -s -X POST "$RPC" -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}' | grep -oE '0x[0-9a-f]+' | tail -1)"

echo; echo "== forge build"
"$FOUNDRY/forge" build >/dev/null
echo "built"

echo; echo "== 1/3 derivation check against the real launches (read-only, through the fork)"
RPC_URL="$RPC" node eth-launch/check-derivation.mjs

echo; echo "== 2/3 launch on the fork"
rm -f web/deployments/1.fork.json
RPC_URL="$RPC" node eth-launch/launch.mjs fork

echo; echo "== 3/3 trades, claimCreator, harvester.claim"
RPC_URL="$RPC" node eth-launch/rehearse-fees.mjs web/deployments/1.fork.json

echo; echo "REHEARSAL COMPLETE on $RPC. Record: web/deployments/1.fork.json and eth-launch/launch-record-*.json"

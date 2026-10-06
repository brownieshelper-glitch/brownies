#!/usr/bin/env bash
# A full local copy of Brownies on a fork of Ethereum mainnet, for testing the site in a real browser. Nothing
# leaves this machine: anvil reads mainnet state from the public RPC, every transaction is mined locally.
#
#   bash smoke/site-stack.sh             brings the stack up, prints the URLs and the pids, stays up until Ctrl+C
#                                        (or until the file /tmp/brownies-stack.stop appears)
#   bash smoke/site-stack.sh once        the same, then runs node smoke/site-e2e.mjs all and tears everything down
#   bash smoke/site-stack.sh once flow   one mode only: flow | intro | pages | shots
#   KEEPER=1 bash smoke/site-stack.sh    also runs the gateway's keeper as anvil account 9 (off by default, so the
#                                        page's own "Collect the tax" button has work to do in the browser flow)
#
# What it does, in order (the real Ethereum launch flow from eth-launch/, then the test state):
#   1. anvil forks Ethereum on :8563                 6. anvil account 1 gets 1,000 USDC; 0.1 WETH of unbooked fee goes to the harvester
#   2. eth-launch/launch.mjs fork                    7. account 1 stakes 10,000 BROWNIE, waits a day, proposes a skill, votes yes
#   3. eth-launch/rehearse-fees.mjs (trades, claims) 8. a stand-in for OpenRouter (:8793), the gateway live on the fork (:8792),
#   4. eth-launch/add-helpers.mjs fork (four helpers)   the site (:8791)
#   5. the record is web/deployments/1.fork.json     9. smoke/seed-team.mjs fills the gateway with sample reports
# The test wallet is anvil account 1: it holds BROWNIE from the rehearsal trades, 1,000 USDC and the stake above.
# It stops ONLY the processes it started, each by its own pid. It never kills anything by name.
set -euo pipefail
cd "$(dirname "$0")/.."
F="${FOUNDRY_BIN:-$HOME/.foundry/bin}"
FORK_URL="${FORK_URL:-https://ethereum-rpc.publicnode.com}"
APORT=8563; GPORT=8792; WPORT=8791; UPORT=8793
RPC="http://127.0.0.1:$APORT"; GW="http://127.0.0.1:$GPORT"; SITE="http://127.0.0.1:$WPORT"; UP="http://127.0.0.1:$UPORT"
# anvil's public test accounts (the mnemonic "test test ... junk"); nothing here is a secret
K0=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
K1=0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d; A1=0x70997970C51812dc3A010C7d01b50e0d17dc79C8
K3=0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6
A4=0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65; A5=0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc
A6=0x976EA74026E726554dB657fA54763abd0C3a0aa9; A7=0x14dC79964da2C08b23698B3D3cc7Ca32193d9955
K9=0x2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6; A9=0xa0Ee7A142d267C1f36714E4a8F75612F20a79720
USDC=0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48; WETH=0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2
TEAM_KEY=local-test-team-key-0123456789abcdef
STOP=/tmp/brownies-stack.stop
REC=web/deployments/1.fork.json
LOGDIR="$(mktemp -d -t brownies-stack-XXXXXX)"; LOGW="$(cygpath -m "$LOGDIR" 2>/dev/null || echo "$LOGDIR")"
MODE="${1:-}"

rpc() { curl -s -X POST "$RPC" -H 'content-type: application/json' -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"$1\",\"params\":${2:-[]}}"; }
port_busy() { netstat -ano 2>/dev/null | grep -E "[:.]$1[[:space:]]" | grep -qi listen; }
enc() { node -e "console.log(encodeURIComponent(process.argv[1]))" "$1"; }

ANVIL_PID=""; UP_PID=""; GW_PID=""; WEB_PID=""
# Stop one process this script started, by its pid only. A native program (node, anvil) started from Git Bash can
# outlive its msys wrapper, so its own Windows pid is noted first and finished by pid as well. Never by name.
stop_pid() {
  local p="$1" name="$2" w=""
  [ -n "$p" ] || return 0
  w="$(cat "/proc/$p/winpid" 2>/dev/null || true)"
  kill "$p" 2>/dev/null || true
  for i in 1 2 3 4 5 6; do kill -0 "$p" 2>/dev/null || break; sleep 0.5; done
  kill -0 "$p" 2>/dev/null && kill -9 "$p" 2>/dev/null || true
  if [ -n "$w" ] && tasklist //FI "PID eq $w" //NH 2>/dev/null | grep -qE "[[:space:]]$w[[:space:]]"; then taskkill //PID "$w" //T //F >/dev/null 2>&1 || true; fi
  echo "  stopped $name (pid $p)"
}
cleanup() {
  echo; echo "stopping the stack (only what this script started)"
  stop_pid "$WEB_PID" "the web server"; stop_pid "$GW_PID" "the gateway"; stop_pid "$UP_PID" "the stand-in upstream"; stop_pid "$ANVIL_PID" "anvil"
  for p in $APORT $GPORT $WPORT $UPORT; do port_busy "$p" && echo "  WARNING: something still listens on port $p; see the pids above" || true; done
  rm -f "$STOP"
  echo "STACK STOPPED  (logs in $LOGDIR)"
}
for p in $APORT $GPORT $WPORT $UPORT; do
  if port_busy "$p"; then echo "port $p is in use. Stop YOUR process on it first: this script never kills anything it did not start."; exit 1; fi
done
rm -f "$STOP"
trap cleanup EXIT
trap 'exit 130' INT TERM

echo "== 1/9 anvil, a fork of $FORK_URL on $RPC"
"$F/anvil" --fork-url "$FORK_URL" --port $APORT --host 127.0.0.1 --chain-id 1 --retries 5 --timeout 60000 --silent >"$LOGDIR/anvil.log" 2>&1 &
ANVIL_PID=$!
for i in $(seq 1 90); do
  rpc eth_chainId | grep -q '"0x1"' && break
  kill -0 "$ANVIL_PID" 2>/dev/null || { echo "anvil died while starting:"; tail -20 "$LOGDIR/anvil.log"; exit 1; }
  sleep 1
done
rpc eth_chainId | grep -q '"0x1"' || { echo "anvil did not answer on $RPC"; tail -20 "$LOGDIR/anvil.log"; exit 1; }
echo "anvil up (pid $ANVIL_PID), block $("$F/cast" block-number --rpc-url "$RPC")"

echo "== 2/9 launch on the fork (eth-launch/launch.mjs fork)"
rm -f "$REC"
RPC_URL="$RPC" node eth-launch/launch.mjs fork >"$LOGDIR/launch.log" 2>&1 || { tail -15 "$LOGDIR/launch.log"; exit 1; }
[ -f "$REC" ] || { echo "no record at $REC"; exit 1; }
echo "launched; record $REC"

echo "== 3/9 trades, claimCreator, harvester.claim (eth-launch/rehearse-fees.mjs)"
RPC_URL="$RPC" node eth-launch/rehearse-fees.mjs "$REC" >"$LOGDIR/fees.log" 2>&1 || { tail -15 "$LOGDIR/fees.log"; exit 1; }
grep -E "^  (creator fee|SUGAR in the TeamVault)" "$LOGDIR/fees.log" || true

echo "== 4/9 the four brownies on the payroll (eth-launch/add-helpers.mjs fork)"
FUDGE_ADDRESS=$A4 CRUMB_ADDRESS=$A5 NIB_ADDRESS=$A6 CHIP_ADDRESS=$A7 RPC_URL="$RPC" node eth-launch/add-helpers.mjs fork "$REC" >"$LOGDIR/helpers.log" 2>&1 || { tail -15 "$LOGDIR/helpers.log"; exit 1; }
tail -1 "$LOGDIR/helpers.log"
read TOKEN STAKING SUGAR VAULT REGISTRY HARVESTER LEDGER START < <(node -e "const j=require('./$REC');console.log(j.token,j.staking,j.sugar,j.teamVault,j.skillRegistry,j.harvester,j.ledger,j.startBlock)")

echo "== 5/9 the test wallet: 1,000 USDC for anvil account 1, 0.1 WETH of unbooked fee for the harvester"
# USDC balances live in slot 9 of the FiatToken storage (a mapping by address); the fork lets us write there
SLOT="$("$F/cast" index address $A1 9)"
rpc anvil_setStorageAt "[\"$USDC\",\"$SLOT\",\"0x$(printf '%064x' 1000000000)\"]" >/dev/null
HAVE="$("$F/cast" call $USDC "balanceOf(address)(uint256)" $A1 --rpc-url "$RPC" | awk '{print $1}')"
[ "$HAVE" = "1000000000" ] || { echo "USDC funding failed: balance $HAVE"; exit 1; }
# fee the ledger would pay the harvester, so "Collect the tax" has something to book and swap (0.1 WETH: 60% of it is over MIN_SWAP)
"$F/cast" send --private-key $K3 $WETH "deposit()" --value 100000000000000000 --rpc-url "$RPC" >/dev/null
"$F/cast" send --private-key $K3 $WETH "transfer(address,uint256)" $HARVESTER 100000000000000000 --rpc-url "$RPC" >/dev/null
echo "account 1 holds $("$F/cast" call $TOKEN "balanceOf(address)(uint256)" $A1 --rpc-url "$RPC" | awk '{print $1}') BROWNIE atoms, 1,000 USDC; harvester holds 0.1 WETH unbooked"

echo "== 6/9 account 1 stakes 10,000 BROWNIE, a day passes, it proposes a skill and votes yes"
"$F/cast" send --private-key $K1 $TOKEN "approve(address,uint256)" $STAKING 10000000000000000000000 --rpc-url "$RPC" >/dev/null
"$F/cast" send --private-key $K1 $STAKING "stake(uint256)" 10000000000000000000000 --rpc-url "$RPC" >/dev/null
rpc evm_increaseTime '[86401]' >/dev/null; rpc evm_mine >/dev/null
"$F/cast" send --private-key $K1 $REGISTRY "submit(string,uint256)" "https://github.com/brownieshelper-glitch/brownies/pull/1" 5000000 --rpc-url "$RPC" >/dev/null
"$F/cast" send --private-key $K1 $REGISTRY "vote(uint256,bool)" 0 true --rpc-url "$RPC" >/dev/null
echo "skill #0 proposed (asks 5 SUGAR) and voted yes"

echo "== 7/9 the stand-in upstream (:$UPORT), the gateway (:$GPORT) and the site (:$WPORT)"
PORT=$UPORT node smoke/mock-upstream.mjs >"$LOGDIR/upstream.log" 2>&1 &
UP_PID=$!
KEEPER_KEY=""; KEEPER_NOTE="off (KEEPER=1 turns it on)"
if [ "${KEEPER:-0}" = "1" ]; then KEEPER_KEY=$K9; KEEPER_NOTE="on, anvil account 9 $A9, every 30 s"; fi
# every setting is given here so that nothing is read from a gateway/.env on this machine
env PORT=$GPORT RPC_URL="$RPC" CHAIN_ID=1 SUGAR_ADDRESS=$SUGAR HARVESTER_ADDRESS=$HARVESTER LEDGER_ADDRESS=$LEDGER TEAM_VAULT_ADDRESS=$VAULT START_BLOCK=$START \
  DB_PATH="$LOGW/gateway.sqlite" TEAM_LOG_KEY=$TEAM_KEY OPENROUTER_API_KEY=local-test-upstream-key OPENROUTER_URL="$UP" \
  KEEPER_PRIVATE_KEY="$KEEPER_KEY" CLAIM_EVERY_SECONDS=30 CLAIM_MIN_ETH=0.001 BROWNIES_GATEWAY_ENV= \
  node gateway/server.mjs >"$LOGDIR/gateway.log" 2>&1 &
GW_PID=$!
PORT=$WPORT node web/serve.mjs >"$LOGDIR/web.log" 2>&1 &
WEB_PID=$!
for i in $(seq 1 40); do
  curl -s "$GW/health" | grep -q '"ok":true' && curl -s -o /dev/null "$SITE/" && curl -s -o /dev/null "$UP/models" && break
  sleep 1
done
curl -s "$GW/health" | grep -q '"live":true' || { echo "the gateway is not live on the fork:"; tail -20 "$LOGDIR/gateway.log"; exit 1; }
curl -s -o /dev/null "$SITE/app.html" || { echo "the site did not come up:"; tail -20 "$LOGDIR/web.log"; exit 1; }

echo "== 8/9 sample reports for the Kitchen and Progress pages (smoke/seed-team.mjs)"
node smoke/seed-team.mjs "$GW" "$TEAM_KEY"

Q="dep=1.fork&rpc=$(enc "$RPC")&gw=$(enc "$GW")"
echo
echo "== 9/9 STACK READY"
echo "  site      $SITE"
echo "  app       $SITE/app.html?intro=0&$Q"
echo "  kitchen   $SITE/team.html?$Q"
echo "  progress  $SITE/progress.html?$Q"
echo "  gateway   $GW  (live on the fork, health at $GW/health)"
echo "  rpc       $RPC  (anvil, chain 1, fork of $FORK_URL)"
echo "  upstream  $UP  (a stand-in for OpenRouter: smoke/mock-upstream.mjs)"
echo "  wallet    anvil account 1 $A1: BROWNIE, 1,000 USDC, 10,000 staked, skill #0 proposed and voted"
echo "  keeper    $KEEPER_NOTE"
echo "  pids      anvil $ANVIL_PID, upstream $UP_PID, gateway $GW_PID, web $WEB_PID"
echo "  logs      $LOGDIR"
echo "  record    $REC"

if [ "$MODE" = "once" ]; then
  echo; echo "== node smoke/site-e2e.mjs ${2:-all}"
  set +e; node smoke/site-e2e.mjs "${2:-all}"; CODE=$?; set -e
  exit $CODE
fi
echo; echo "Ctrl+C stops the stack (or: touch $STOP)"
while [ ! -f "$STOP" ]; do
  kill -0 "$ANVIL_PID" 2>/dev/null || { echo "anvil stopped on its own:"; tail -5 "$LOGDIR/anvil.log"; break; }
  sleep 2
done

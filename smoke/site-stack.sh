#!/usr/bin/env bash
# A full local copy of Brownies for testing the site. Nothing touches the real chain.
#   anvil fork of Robinhood Chain (:8556) + the real deploy script broadcast to it + the gateway (:8795)
#   + the site (:8788). It stays up until the file /tmp/brownies-stack.stop appears, then stops only what it started.
# The test wallet is anvil account 1. It gets BROWNIE (bought on the forked Pons curve) and 1,000 USDG.
#   open: http://127.0.0.1:8788/app.html?dep=4663.smoke&rpc=http://127.0.0.1:8556&gw=http://127.0.0.1:8795
set -euo pipefail
cd "$(dirname "$0")/.."
F="$HOME/.foundry/bin"
RPC_LIVE="https://rpc.mainnet.chain.robinhood.com"
APORT=8556; GPORT=8795; WPORT=8788
RPC="http://127.0.0.1:$APORT"; GW="http://127.0.0.1:$GPORT"
K0=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
K1=0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d; A1=0x70997970C51812dc3A010C7d01b50e0d17dc79C8
K2=0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a; A2=0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC
USDG=0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168
USDG_WHALE=0x52e65B17fB6E5BA00Ed806f37Afcd2DaA50271Ca
STOP=/tmp/brownies-stack.stop
rm -f "$STOP"

fresh() { "$F/cast" wallet new --json | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d);const o=Array.isArray(j)?j[0]:(j.data?j.data[0]:j);console.log(o.address);})"; }
MAIN=$(fresh); FUND=$(fresh); AGENT=$(fresh)

ANVIL_PID=""; GW_PID=""; WEB_PID=""
cleanup() { for p in "$WEB_PID" "$GW_PID" "$ANVIL_PID"; do [ -n "$p" ] && kill "$p" 2>/dev/null || true; done; rm -f "$STOP"; echo "STACK STOPPED"; }
trap cleanup EXIT

"$F/anvil" --fork-url "$RPC_LIVE" --port $APORT --silent >/tmp/brownies-anvil.log 2>&1 &
ANVIL_PID=$!
for i in $(seq 1 90); do curl -s -X POST "$RPC" -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' | grep -q 0x1237 && break; sleep 1; done
echo "anvil up"

mkdir -p web/deployments
PRIVATE_KEY=$K0 MAIN_WALLET=$MAIN FUNDING_WALLET=$FUND AGENT_WALLET=$AGENT TOKEN_NAME=Brownies TOKEN_SYMBOL=BROWNIE SALT=site-$RANDOM BUY_ETH=0 \
  "$F/forge" script script/Deploy.s.sol:Deploy --rpc-url "$RPC" --broadcast 2>&1 | grep -E "ONCHAIN EXECUTION COMPLETE|Error" || true
J=web/deployments/4663.json
[ -f "$J" ] || { echo "no deployment json"; exit 1; }
BLOCK=$(( $("$F/cast" block-number --rpc-url "$RPC") - 20 ))
node -e "const fs=require('fs');const j=JSON.parse(fs.readFileSync('$J'));j.startBlock=$BLOCK;fs.writeFileSync('web/deployments/4663.smoke.json',JSON.stringify(j,null,2));"
rm -f "$J"
read SUGAR HARVESTER CURVE TOKEN VAULT < <(node -e "const j=require('./web/deployments/4663.smoke.json');console.log(j.sugar,j.harvester,j.curve,j.token,j.teamVault)")
# the four brownies go on the payroll (the deployer owns the team vault)
n=1; for name in Fudge Crumb Nib Chip; do "$F/cast" send --private-key $K0 $VAULT "addHelper(string,bytes32,uint32)" $name 0x000000000000000000000000000000000000000000000000000000000000000$n 1 --rpc-url "$RPC" >/dev/null; n=$((n+1)); done
echo "deployed: token $TOKEN"

# past the snipe window, then the test wallet buys BROWNIE and a second wallet trades to create tax
"$F/cast" rpc evm_increaseTime 6 --rpc-url "$RPC" >/dev/null; "$F/cast" rpc evm_mine --rpc-url "$RPC" >/dev/null
"$F/cast" send --private-key $K1 $CURVE "buy(uint256,uint256,address)" 500000000000000000 0 $A1 --value 500000000000000000 --rpc-url "$RPC" >/dev/null
for i in 1 2 3 4 5; do "$F/cast" send --private-key $K2 $CURVE "buy(uint256,uint256,address)" 200000000000000000 0 $A2 --value 200000000000000000 --rpc-url "$RPC" >/dev/null; done
"$F/cast" rpc anvil_impersonateAccount $USDG_WHALE --rpc-url "$RPC" >/dev/null
"$F/cast" rpc anvil_setBalance $USDG_WHALE 0x56BC75E2D63100000 --rpc-url "$RPC" >/dev/null
"$F/cast" send --unlocked --from $USDG_WHALE $USDG "transfer(address,uint256)" $A1 1000000000 --rpc-url "$RPC" >/dev/null
echo "test wallet funded: BROWNIE and 1,000 USDG"

UPSTREAM_KEY=$(grep '^OPENROUTER_API_KEY=' /c/Users/andrea/helix-secrets/synapse-gateway.env 2>/dev/null | cut -d= -f2 | tr -d '\r' || true)
TEAM_KEY=local-test-team-key-0123456789abcdef
mkdir -p gateway/data; rm -f gateway/data/site.sqlite*
( cd gateway && exec env PORT=$GPORT RPC_URL=$RPC CHAIN_ID=4663 SUGAR_ADDRESS=$SUGAR HARVESTER_ADDRESS=$HARVESTER START_BLOCK=$BLOCK DB_PATH=./data/site.sqlite TEAM_LOG_KEY=$TEAM_KEY OPENROUTER_API_KEY=$UPSTREAM_KEY node server.mjs >/tmp/brownies-gw.log 2>&1 ) &
GW_PID=$!
( cd web && exec env PORT=$WPORT node serve.mjs >/tmp/brownies-web.log 2>&1 ) &
WEB_PID=$!
for i in $(seq 1 30); do curl -s "$GW/health" | grep -q '"ok":true' && curl -s -o /dev/null "http://127.0.0.1:$WPORT/" && break; sleep 1; done
node smoke/seed-team.mjs "$GW" "$TEAM_KEY" || true
echo "STACK READY  site http://127.0.0.1:$WPORT  gateway $GW  rpc $RPC"

while [ ! -f "$STOP" ]; do sleep 2; done

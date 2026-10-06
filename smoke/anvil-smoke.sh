#!/usr/bin/env bash
# End to end on a LOCAL fork of Robinhood Chain (anvil). Nothing touches the real chain.
#   1. anvil forks Robinhood Chain
#   2. Deploy.s.sol runs for real against anvil: core + BROWNIE launch on the forked Pons + first buy
#   3. the gateway starts against anvil
#   4. a holder gets USDG (impersonated from the Morpho vault), mints SUGAR at par and activates it to their wallet
#   5. the gateway credits it; the wallet's signature is its key; /v1/key shows the balance; chat answers 503 (no upstream key)
#   6. a crowd buys on the curve; the keeper path (harvester.claim) runs; /api/protocol/stats shows the harvester figures
# Kills ONLY the anvil and gateway processes it started.
set -euo pipefail
cd "$(dirname "$0")/.."
F="$HOME/.foundry/bin"
RPC_LIVE="https://rpc.mainnet.chain.robinhood.com"
APORT=8556; GPORT=8795
RPC="http://127.0.0.1:$APORT"
GW="http://127.0.0.1:$GPORT"
# anvil's well known accounts
K0=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80; A0=0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266
K1=0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d; A1=0x70997970C51812dc3A010C7d01b50e0d17dc79C8
# fresh wallets for the three roles: a well known anvil address can carry code on the real chain (account 4 does)
fresh() { "$F/cast" wallet new --json | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d);const o=Array.isArray(j)?j[0]:(j.data?j.data[0]:(j.wallets?j.wallets[0]:j));console.log(o.address);})"; }
A2=$(fresh)    # funding wallet
A3=$(fresh)    # agent wallet
MAIN=$(fresh)  # main wallet
echo "roles: main $MAIN funding $A2 agent $A3"
USDG=0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168
USDG_WHALE=0x52e65B17fB6E5BA00Ed806f37Afcd2DaA50271Ca  # the WETH/USDG v3 pool holds its USDG as a plain balance

ANVIL_PID=""; GW_PID=""
cleanup() { [ -n "$GW_PID" ] && kill "$GW_PID" 2>/dev/null || true; [ -n "$ANVIL_PID" ] && kill "$ANVIL_PID" 2>/dev/null || true; }
trap cleanup EXIT

step() { echo; echo "== $*"; }

# SMOKE_UPSTREAM=1 runs the gateway with the real OpenRouter key from the secrets file and makes a real chat call
# (free models by default, so it costs nothing; SMOKE_MODEL=<paid model id> shows a real charge). Never printed.
UPSTREAM_KEY=""
if [ "${SMOKE_UPSTREAM:-}" = "1" ]; then
  UPSTREAM_KEY=$(grep '^OPENROUTER_API_KEY=' /c/Users/andrea/helix-secrets/synapse-gateway.env | cut -d= -f2 | tr -d '\r')
  [ -n "$UPSTREAM_KEY" ] && echo "upstream key: taken from the secrets file" || echo "upstream key: EMPTY in the secrets file"
fi

step "1. anvil forks Robinhood Chain"
"$F/anvil" --fork-url "$RPC_LIVE" --port $APORT --silent >/tmp/brownies-anvil.log 2>&1 &
ANVIL_PID=$!
for i in $(seq 1 90); do
  if curl -s -X POST "$RPC" -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' | grep -q 0x1237; then break; fi
  sleep 1
done
curl -s -X POST "$RPC" -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' | grep -q 0x1237 || { echo "anvil did not come up"; exit 1; }
echo "anvil up (pid $ANVIL_PID)"

step "2. deploy the core and launch BROWNIE on the forked Pons (real broadcast, to anvil)"
mkdir -p web/deployments
PRIVATE_KEY=$K0 MAIN_WALLET=$MAIN FUNDING_WALLET=$A2 AGENT_WALLET=$A3 TOKEN_NAME=Brownies TOKEN_SYMBOL=BROWNIE SALT=smoke-$RANDOM BUY_ETH=10000000000000000 \
  "$F/forge" script script/Deploy.s.sol:Deploy --rpc-url "$RPC" --broadcast 2>&1 | grep -E "predicted|written|Error|revert|ONCHAIN EXECUTION COMPLETE" || true
J=web/deployments/4663.json
[ -f "$J" ] || { echo "no deployment json"; exit 1; }
read SUGAR MINTER HARVESTER STAKING TOKEN CURVE L1BLOCK < <(node -e "const j=require('./$J');console.log(j.sugar,j.minter,j.harvester,j.staking,j.token,j.curve,j.block)")
# block.number inside the EVM is the L1 block on Robinhood Chain; the indexer needs the L2 block eth_blockNumber reports
BLOCK=$(( $("$F/cast" block-number --rpc-url "$RPC") - 20 ))
echo "SUGAR $SUGAR"; echo "MINTER $MINTER"; echo "HARVESTER $HARVESTER"; echo "TOKEN $TOKEN"; echo "CURVE $CURVE"; echo "deploy L1 block $L1BLOCK, indexer start (L2) $BLOCK"
mv "$J" web/deployments/4663.smoke.json

step "3. the gateway, against anvil"
mkdir -p gateway/data; rm -f gateway/data/smoke.sqlite*
# exec, so the PID we record is node itself and the cleanup kills the real process, not a subshell around it
( cd gateway && exec env PORT=$GPORT RPC_URL=$RPC CHAIN_ID=4663 SUGAR_ADDRESS=$SUGAR HARVESTER_ADDRESS=$HARVESTER START_BLOCK=$BLOCK DB_PATH=./data/smoke.sqlite OPENROUTER_API_KEY=$UPSTREAM_KEY node server.mjs >/tmp/brownies-gw.log 2>&1 ) &
GW_PID=$!
for i in $(seq 1 30); do curl -s "$GW/health" | grep -q '"ok":true' && break; sleep 1; done
curl -s "$GW/health"; echo

step "4. a holder (account 1) gets 1,000 USDG from the WETH/USDG pool and mints 5 SUGAR at par, activated to their wallet"
"$F/cast" rpc anvil_impersonateAccount $USDG_WHALE --rpc-url "$RPC" >/dev/null
"$F/cast" rpc anvil_setBalance $USDG_WHALE 0x56BC75E2D63100000 --rpc-url "$RPC" >/dev/null
"$F/cast" send --unlocked --from $USDG_WHALE $USDG "transfer(address,uint256)" $A1 1000000000 --rpc-url "$RPC" >/dev/null
echo "A1 USDG: $("$F/cast" call $USDG "balanceOf(address)(uint256)" $A1 --rpc-url "$RPC")"
"$F/cast" send --private-key $K1 $USDG "approve(address,uint256)" $MINTER 5000000 --rpc-url "$RPC" >/dev/null
BEN=0x000000000000000000000000${A1#0x}
TX=$("$F/cast" send --private-key $K1 $MINTER "mintAndActivate(uint256,bytes32)" 5000000 $BEN --rpc-url "$RPC" --json | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).transactionHash))")
echo "activation tx $TX"
echo "funding wallet USDG: $("$F/cast" call $USDG "balanceOf(address)(uint256)" $A2 --rpc-url "$RPC")  (expect 5000000)"
echo "SUGAR totalActivated: $("$F/cast" call $SUGAR "totalActivated()(uint256)" --rpc-url "$RPC")"

step "5. the gateway credits it and the wallet's signature is the key"
curl -s -X POST "$GW/api/protocol/index-tx" -H 'content-type: application/json' -d "{\"tx\":\"$TX\"}"; echo
KEY=$(cd gateway && node -e "
import('ethers').then(async ({Wallet})=>{ const {keyMessage,keyFromSignature}=await import('./auth.mjs'); const w=new Wallet('$K1'); const sig=await w.signMessage(keyMessage(4663,0)); console.log(keyFromSignature(sig,0)); });")
echo "key ${KEY:0:24}..."
echo "GET /v1/key:"; curl -s -H "Authorization: Bearer $KEY" "$GW/v1/key"; echo
echo "GET /v1/key with a bad key:"; curl -s -H "Authorization: Bearer sk-brownie-0-AAAA" "$GW/v1/key"; echo
echo "GET /v1/models (first 160 chars):"; curl -s "$GW/v1/models" | head -c 160 || true; echo
if [ -n "$UPSTREAM_KEY" ]; then
  echo "REAL chat through the gateway (upstream OpenRouter):"
  node smoke/chat-check.mjs "$GW" "$KEY" ${SMOKE_MODEL:-} || echo "  chat check failed"
else
  echo "POST /v1/chat/completions without an upstream key:"; curl -s -X POST -H "Authorization: Bearer $KEY" -H 'content-type: application/json' -d '{"model":"openai/gpt-4o-mini","messages":[{"role":"user","content":"hi"}],"max_tokens":5}' "$GW/v1/chat/completions"; echo
fi
echo "rotate:"; curl -s -X POST -H "Authorization: Bearer $KEY" "$GW/v1/key/rotate"; echo
echo "old key after rotate:"; curl -s -H "Authorization: Bearer $KEY" "$GW/v1/key"; echo
echo "public account read:"; curl -s "$GW/api/protocol/account/$A1" | head -c 300 || true; echo

step "6. a crowd buys BROWNIE on the forked curve, then anyone claims for the harvester"
"$F/cast" rpc evm_increaseTime 5 --rpc-url "$RPC" >/dev/null; "$F/cast" rpc evm_mine --rpc-url "$RPC" >/dev/null
for i in 1 2 3 4 5; do "$F/cast" send --private-key $K1 $CURVE "buy(uint256,uint256,address)" 200000000000000000 0 $A1 --value 200000000000000000 --rpc-url "$RPC" >/dev/null; done
echo "escrowed before claim: $("$F/cast" call $HARVESTER "escrowed()(uint256)" --rpc-url "$RPC") (0 until the harvester sweeps the curve inside claim)"
echo "curve creatorTaxBalance: $("$F/cast" call $CURVE "creatorTaxBalance()(uint256)" --rpc-url "$RPC")"
# default gas estimation on purpose: this is what a wallet or the keeper does, and the gas floor must make it enough
read CSTATUS CGAS CHASH < <("$F/cast" send --private-key $K1 $HARVESTER "claim()" --rpc-url "$RPC" --json | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d);console.log(j.status,parseInt(j.gasUsed),j.transactionHash);})")
echo "claim tx: status $CSTATUS gasUsed $CGAS hash $CHASH"
curl -s -X POST "$GW/api/protocol/index-tx" -H 'content-type: application/json' -d "{\"tx\":\"$CHASH\"}"; echo "  (the agent's 10% row, indexed at once)"
echo "curve creatorTaxBalance after claim (expect 0): $("$F/cast" call $CURVE "creatorTaxBalance()(uint256)" --rpc-url "$RPC")"
echo "main wallet ETH: $("$F/cast" balance $MAIN --rpc-url "$RPC")"
echo "totalStakersFunded (USDG atoms): $("$F/cast" call $HARVESTER "totalStakersFunded()(uint256)" --rpc-url "$RPC")"
echo "totalTeamFunded (USDG atoms, SUGAR in the team vault): $("$F/cast" call $HARVESTER "totalTeamFunded()(uint256)" --rpc-url "$RPC")"
echo "staking totalFunded: $("$F/cast" call $STAKING "totalFunded()(uint256)" --rpc-url "$RPC")"
sleep 2
echo "stats:"; curl -s "$GW/api/protocol/stats"; echo
echo "agent wallet account (the 10% row landed as balance):"; curl -s "$GW/api/protocol/account/$A3" | head -c 200 || true; echo

step "done"
echo "gateway log tail:"; tail -5 /tmp/brownies-gw.log

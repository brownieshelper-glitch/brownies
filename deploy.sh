#!/usr/bin/env bash
# Brownies phase 1: deploy the core and launch BROWNIE on Pons, Robinhood Chain (4663).
#
#   ./deploy.sh              dry run: simulates both transactions on a fork, sends nothing
#   ./deploy.sh broadcast    the real thing, ONLY after the owner says "launch it"
#
# Secrets live OUTSIDE OneDrive in C:\Users\andrea\helix-secrets\synapse.env (never in this folder, never in chat):
#   PRIVATE_KEY=0x...            the owner's deploy wallet, pays the Pons fee and gas, launches, is snipe exempt
#   MAIN_WALLET=0x...            ADDRESS ONLY, the protocol's 40%; not the deploy key
#   FUNDING_WALLET=0x...         ADDRESS ONLY, the inference funding wallet (USDG lands here)
#   AGENT_WALLET=0x...           ADDRESS ONLY, the Brownies agent's key wallet (SUGAR is activated to it)
#   TOKEN_NAME=Brownies  TOKEN_SYMBOL=BROWNIE  TOKEN_LOGO=https://...  TOKEN_DESCRIPTION="..."
#   TOKEN_TWITTER=  TOKEN_TELEGRAM=  TOKEN_WEBSITE=
#   SALT=any-string              change it and the predicted token address changes
#   MIN_POSITION=10000000000000000000000   (10,000 BROWNIE in wei; optional)
#   BUY_ETH=0                    optional first buy in wei
set -euo pipefail
cd "$(dirname "$0")"
ENV_FILE="${BROWNIES_ENV:-/c/Users/andrea/helix-secrets/synapse.env}"
RPC="https://rpc.mainnet.chain.robinhood.com"
FORGE="${FORGE:-$HOME/.foundry/bin/forge}"

[ -f "$ENV_FILE" ] || { echo "missing $ENV_FILE"; exit 1; }
# Read KEY=VALUE lines without executing the file: safe for a file saved by Notepad (CRLF line ends) and for
# values with spaces. Comment lines and empty lines are skipped; surrounding double quotes are dropped.
while IFS= read -r line || [ -n "$line" ]; do
  line="${line%$'\r'}"
  case "$line" in ''|\#*) continue ;; esac
  case "$line" in *=*) ;; *) continue ;; esac
  key="${line%%=*}"; val="${line#*=}"
  val="${val%\"}"; val="${val#\"}"
  [ -n "$val" ] && export "$key=$val"
done < "$ENV_FILE"
for v in PRIVATE_KEY MAIN_WALLET FUNDING_WALLET TOKEN_NAME TOKEN_SYMBOL SALT; do
  [ -n "${!v:-}" ] || { echo "$v is not set in $ENV_FILE"; exit 1; }
done

echo "chain check"
cid=$("$FORGE" --version >/dev/null && curl -s -X POST "$RPC" -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' | grep -oE '0x[0-9a-f]+' | tail -1)
[ "$cid" = "0x1237" ] || { echo "RPC is not Robinhood Chain (got $cid)"; exit 1; }

mkdir -p web/deployments
echo "fresh build"
"$FORGE" build >/dev/null

if [ "${1:-}" = "broadcast" ]; then
  echo "BROADCASTING to Robinhood Chain"
  L2_BEFORE=$("$HOME/.foundry/bin/cast" block-number --rpc-url "$RPC")
  "$FORGE" script script/Deploy.s.sol:Deploy --rpc-url "$RPC" --broadcast -vv
  # block.number inside the EVM is the L1 block on Robinhood Chain; the gateway's indexer needs the L2 block
  node -e "const fs=require('fs');const p='web/deployments/4663.json';const j=JSON.parse(fs.readFileSync(p));j.startBlock=$L2_BEFORE-5;fs.writeFileSync(p,JSON.stringify(j,null,2));console.log('startBlock (L2) written:',j.startBlock)"
  echo "done. verify every address on Sourcify before announcing anything."
else
  echo "DRY RUN (nothing is sent). Add 'broadcast' to send."
  "$FORGE" script script/Deploy.s.sol:Deploy --rpc-url "$RPC" -vv
  rm -f web/deployments/4663.json
fi

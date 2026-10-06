#!/usr/bin/env bash
# PUBLISH THE SOURCE OF EVERY BROWNIES CONTRACT ON ETHEREUM, so anybody can read what runs at each address.
#
#   bash eth-launch/verify.sh [web/deployments/1.json]       from agent-company/, Git Bash
#   DRY=1 bash eth-launch/verify.sh                           print the commands, send nothing
#
# It sends no transaction and costs no gas: verifying only uploads source code to the explorers.
#   1. Sourcify, always. Free, no account. Needs no constructor arguments.
#   2. Etherscan, when C:\Users\andrea\helix-secrets\etherscan.env holds ETHERSCAN_API_KEY=... (a free key from
#      etherscan.io). Without that file this step is skipped and says so. Etherscan needs the constructor arguments,
#      which are written out here from the record: six of the seven contracts were created inside BrownieCore's
#      constructor, so no deployment transaction holds their arguments.
# The build must be the one that was deployed: same solc 0.8.26, via_ir, optimizer 200 (foundry.toml), fresh
# `forge build` first. Relative remappings only, so no local path ends up in the published metadata.
set -uo pipefail
export PATH="$PATH:/c/Users/andrea/.foundry/bin"
cd "$(dirname "$0")/.."

REC="${1:-web/deployments/1.json}"
[ -f "$REC" ] || { echo "no record at $REC (the real launch writes it)"; exit 1; }
RPC="${RPC_URL:-https://ethereum-rpc.publicnode.com}"
KEYFILE="${ETHERSCAN_ENV:-/c/Users/andrea/helix-secrets/etherscan.env}"
DRY="${DRY:-0}"

MODE=$(node -e "console.log(require('./$REC').mode || 'broadcast')")
[ "$MODE" = "fork" ] && { echo "a fork record cannot be verified on a public explorer"; exit 1; }
[ "$DRY" = "1" ] || [ "$(cast chain-id --rpc-url "$RPC" 2>/dev/null)" = "1" ] || { echo "The RPC $RPC is not Ethereum mainnet. Stopping."; exit 1; }

r() { node -e "console.log(require('./$REC').$1)"; }
TOKEN=$(r token); STAKING=$(r staking); SUGAR=$(r sugar); MINTER=$(r minter); HARVESTER=$(r harvester)
VAULT=$(r teamVault); REGISTRY=$(r skillRegistry); CORE=$(r core)
MAIN=$(r mainWallet); FUNDING=$(r fundingWallet); OWNER=$(r teamOwner); MINPOS=$(r minPosition)
WETH=0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2
USDC=0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48
POOL=0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640

echo ">>> fresh build"
[ "$DRY" = "1" ] || forge build >/dev/null || { echo "build failed"; exit 1; }

# address | source:contract | constructor args (hex)
CONTRACTS="
$CORE|src/BrownieCore.sol:BrownieCore|$(cast abi-encode "f((address,address,address,address,address,address,address,uint256))" "($TOKEN,$WETH,$USDC,$POOL,$MAIN,$FUNDING,$OWNER,$MINPOS)")
$STAKING|src/BrownieStaking.sol:BrownieStaking|$(cast abi-encode "f(address,address,address,address,uint256,address)" $TOKEN $SUGAR $USDC $FUNDING $MINPOS $OWNER)
$MINTER|src/SugarMinter.sol:SugarMinter|$(cast abi-encode "f(address,address,address)" $USDC $SUGAR $FUNDING)
$SUGAR|src/Sugar.sol:Sugar|$(cast abi-encode "f(address,address)" $STAKING $MINTER)
$VAULT|src/TeamVault.sol:TeamVault|$(cast abi-encode "f(address,address)" $SUGAR $OWNER)
$HARVESTER|src/BrownieHarvester.sol:BrownieHarvester|$(cast abi-encode "f(address,address,address,address,address,address,address,address,address)" $TOKEN $WETH $USDC $POOL $STAKING $MINTER $MAIN $VAULT $OWNER)
$REGISTRY|src/SkillRegistry.sol:SkillRegistry|$(cast abi-encode "f(address,address)" $STAKING $VAULT)
"

# a dry run prints the command with the Etherscan key hidden, so the key never reaches a screen or a log
run() { if [ "$DRY" = "1" ]; then echo "  $*" | sed -E 's/(--etherscan-api-key) [^ ]+/\1 <key from etherscan.env>/'; else "$@"; fi; }

echo ">>> 1. Sourcify"
echo "$CONTRACTS" | while IFS='|' read -r ADDR SRC ARGS; do
  [ -z "$ADDR" ] && continue
  echo "-- $SRC at $ADDR"
  run forge verify-contract --chain 1 --verifier sourcify --watch "$ADDR" "$SRC" 2>&1 | grep -v "^$" | tail -3
done

echo ">>> 2. Etherscan"
if [ -f "$KEYFILE" ] && grep -q '^ETHERSCAN_API_KEY=.\+' "$KEYFILE"; then
  KEY=$(grep '^ETHERSCAN_API_KEY=' "$KEYFILE" | head -1 | cut -d= -f2- | tr -d '\r"')
  echo "$CONTRACTS" | while IFS='|' read -r ADDR SRC ARGS; do
    [ -z "$ADDR" ] && continue
    echo "-- $SRC at $ADDR"
    run forge verify-contract --chain 1 --verifier etherscan --etherscan-api-key "$KEY" --constructor-args "$ARGS" --watch "$ADDR" "$SRC" 2>&1 | grep -v "^$" | tail -3
  done
else
  echo "skipped: no ETHERSCAN_API_KEY in $KEYFILE (a free key from etherscan.io turns this step on)"
fi
echo ">>> done. Sourcify: https://repo.sourcify.dev/contracts/full_match/1/<address>/  Etherscan: https://etherscan.io/address/<address>#code"

#!/usr/bin/env bash
# The public repository must hold the EXACT bytes of every source the pack compiles, at the commit named in the
# request (source.publicOrigin.revision). lib/ is gitignored, so the handful of dependency files are force-added.
#
#   bash eth-launch/custom-hook/publish-sources.sh <workdir>            shows what would be committed (dry run)
#   bash eth-launch/custom-hook/publish-sources.sh <workdir> --commit   stages + commits (does NOT push)
#
# <workdir> is the pack work directory (it holds sources.txt). Push only on the owner's word; then use the pushed
# commit hash as --revision for launch-stamped.mjs prepare.
set -euo pipefail
cd "$(dirname "$0")/../.."
W="${1:?work directory with sources.txt}"
LIST="$W/sources.txt"
[ -f "$LIST" ] || { echo "no $LIST"; exit 1; }
echo "== files the pack compiles (must be byte-identical in the public commit)"
while read -r f; do
  [ -z "$f" ] && continue
  if ! cmp -s "$f" "$W/$f"; then echo "DIFFERS from the work directory: $f"; exit 1; fi
  if grep -q $'\r' "$f"; then echo "CRLF in $f (the pack needs LF)"; exit 1; fi
  echo "   $f"
done < "$LIST"
TOOLING="eth-launch/custom-hook/build.mjs eth-launch/custom-hook/pack.mjs eth-launch/custom-hook/route.mjs eth-launch/custom-hook/win-fsync-shim.mjs eth-launch/custom-hook/publish-sources.sh src/hook test/Hook.t.sol"
if [ "${2:-}" = "--commit" ]; then
  git add -f $(cat "$LIST")
  git add $TOOLING
  git status --short | head -60
  git commit -m "The evolving hook (launcher, token, hook, modules) and the Programmable custom-hook pack tooling; the exact dependency sources the pack compiles" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
  echo "committed $(git rev-parse HEAD)  (not pushed)"
else
  echo "== dry run: nothing staged. With --commit these are added too: $TOOLING"
  git add -n -f $(cat "$LIST") $TOOLING | head -60
fi

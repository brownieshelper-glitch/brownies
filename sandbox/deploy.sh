#!/usr/bin/env bash
# Puts the sandbox on the stream server (the host is EMBER_HOST in brownies-secrets/brownies-ember.env, or
# SANDBOX_HOST in brownies-secrets/brownies-sandbox.env when it has a server of its own) and gives the helpers its
# address and token: SANDBOX_URL and SANDBOX_TOKEN are written into brownies-secrets/brownies-helpers.env, never
# shown. Usage, from the project folder:
#   bash sandbox/deploy.sh          copy the server, run the setup, fetch the token, write the helpers' settings
#   bash sandbox/deploy.sh test     three jobs through the live sandbox: a sum, a network attempt (must fail), a timeout
#   bash sandbox/deploy.sh status   the service, the health line
set -euo pipefail
cd "$(dirname "$0")/.."
S=${SANDBOX_SECRETS:-$HOME/brownies-secrets}
HOSTIP=""
[ -f "$S/brownies-sandbox.env" ] && HOSTIP=$(grep -E '^SANDBOX_HOST=' "$S/brownies-sandbox.env" | head -1 | cut -d= -f2- | tr -d '[:space:]' || true)
[ -n "$HOSTIP" ] || HOSTIP=$(grep -E '^EMBER_HOST=' "$S/brownies-ember.env" | head -1 | cut -d= -f2- | tr -d '[:space:]')
[ -n "$HOSTIP" ] || { echo "no host: set SANDBOX_HOST in $S/brownies-sandbox.env or EMBER_HOST in $S/brownies-ember.env"; exit 1; }
SSH="ssh -i $HOME/.ssh/brownies_key -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=15 root@$HOSTIP"
SCP="scp -q -i $HOME/.ssh/brownies_key -o BatchMode=yes -o StrictHostKeyChecking=accept-new"
URL="http://$HOSTIP:8799"
token() { grep -E '^SANDBOX_TOKEN=' "$S/brownies-sandbox.env" | head -1 | cut -d= -f2- | tr -d '[:space:]'; }
case "${1:-deploy}" in
  deploy)
    echo "== server reachable: $($SSH 'echo yes' 2>/dev/null || echo no)"
    $SSH "mkdir -p /srv/sandbox"
    $SCP sandbox/server.mjs sandbox/setup.sh "root@$HOSTIP:/srv/sandbox/"
    $SSH "bash /srv/sandbox/setup.sh"
    # the token, from the server's file into the local secrets file, never through the screen
    $SSH "grep -E '^SANDBOX_TOKEN=' /etc/sandbox/sandbox.env" | { read -r line; printf 'SANDBOX_HOST=%s\nSANDBOX_URL=%s\n%s\n' "$HOSTIP" "$URL" "$line" > "$S/brownies-sandbox.env"; }
    node -e '
      const fs = require("fs"); const [helpersEnv, sandboxEnv] = process.argv.slice(1);
      const pick = (file, key) => { const m = fs.readFileSync(file, "utf8").match(new RegExp("^" + key + "=(.*)$", "m")); return m ? m[1].trim() : ""; };
      let text = fs.readFileSync(helpersEnv, "utf8");
      for (const key of ["SANDBOX_URL", "SANDBOX_TOKEN"]) {
        const value = pick(sandboxEnv, key);
        if (new RegExp("^" + key + "=", "m").test(text)) text = text.replace(new RegExp("^" + key + "=.*$", "m"), key + "=" + value);
        else text += (text.endsWith("\n") ? "" : "\n") + key + "=" + value + "\n";
      }
      fs.writeFileSync(helpersEnv, text);
      console.log("== helpers env: SANDBOX_URL and SANDBOX_TOKEN " + (pick(helpersEnv, "SANDBOX_TOKEN") ? "set" : "EMPTY"));
    ' "$S/brownies-helpers.env" "$S/brownies-sandbox.env"
    echo "== sandbox at $URL (reachable from the helpers' droplet only). Next: bash helpers/deploy-server.sh so the helpers read the new settings.";;
  status) $SSH "systemctl is-active sandbox; curl -s -H 'authorization: Bearer $(token)' http://127.0.0.1:8799/health"; echo;;
  test)
    # the four checks (sandbox/check.mjs) run from the helpers' droplet, the only machine the sandbox port answers; the token comes from that droplet's own env
    $SCP sandbox/check.mjs root@142.93.168.190:/srv/brownies/sandbox-check.mjs
    ssh -i "$HOME/.ssh/brownies_key" -o BatchMode=yes root@142.93.168.190 'cd /srv/brownies/helpers && set -a && . /etc/brownies/helpers.env && set +a && node --no-warnings /srv/brownies/sandbox-check.mjs';;
  test-curl)
    T=$(token); [ -n "$T" ] || { echo "no token in $S/brownies-sandbox.env; deploy first"; exit 1; }
    # a tarball with one file, made here, sent as base64: the job runs node on it
    TAR=$(cd "$(mktemp -d)" && printf 'console.log("sum", 2 + 2); console.log(JSON.stringify(process.versions.node));' > sum.js && tar czf - sum.js | base64 -w0)
    # the sandbox port is open to the helpers' droplet only, so the jobs are sent from there
    ssh -i "$HOME/.ssh/brownies_key" -o BatchMode=yes root@142.93.168.190 "T='$T'; U='$URL'; TAR='$TAR';
      echo '-- 1. a sum, no network'; curl -s -m 120 -H \"authorization: Bearer \$T\" -H 'content-type: application/json' -d \"{\\\"image\\\":\\\"node\\\",\\\"tar\\\":\\\"\$TAR\\\",\\\"command\\\":\\\"node sum.js\\\",\\\"timeoutSeconds\\\":60}\" \$U/run | head -c 400; echo;
      echo '-- 2. a network attempt from the box (must fail)'; curl -s -m 120 -H \"authorization: Bearer \$T\" -H 'content-type: application/json' -d \"{\\\"image\\\":\\\"node\\\",\\\"tar\\\":\\\"\$TAR\\\",\\\"command\\\":\\\"node -e \\\\\\\"fetch('https://example.com').then(()=>console.log('REACHED')).catch(e=>console.log('blocked:', e.cause?.code || e.message))\\\\\\\"\\\",\\\"timeoutSeconds\\\":60}\" \$U/run | head -c 400; echo;
      echo '-- 3. a loop that must be killed at 10 seconds'; curl -s -m 120 -H \"authorization: Bearer \$T\" -H 'content-type: application/json' -d \"{\\\"image\\\":\\\"node\\\",\\\"tar\\\":\\\"\$TAR\\\",\\\"command\\\":\\\"node -e 'for(;;){}'\\\",\\\"timeoutSeconds\\\":10}\" \$U/run | head -c 300; echo;
      echo '-- 4. without the token'; curl -s -m 20 -o /dev/null -w '%{http_code}\n' \$U/health";;
  *) echo "usage: bash sandbox/deploy.sh [deploy|test|test-curl|status]"; exit 1;;
esac

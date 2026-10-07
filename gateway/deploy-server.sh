#!/usr/bin/env bash
# Puts the Brownies gateway on the server (the HELIX droplet) behind Caddy with https at api.feedthebrownies.com.
#   bash gateway/deploy-server.sh            from agent-company/, Git Bash
# Reads the local secrets to build the server's env file, writes nothing to the screen but status lines.
# Secrets: C:\Users\andrea\helix-secrets\brownies-gateway.env (made on the first run), synapse-gateway.env
# (OPENROUTER_API_KEY), brownies-wallets.env (KEEPER_PRIVATE_KEY). SSH key: ~/.ssh/helix_keeper.
set -euo pipefail
cd "$(dirname "$0")/.."
HOST=root@142.93.168.190
SSH="ssh -i $HOME/.ssh/helix_keeper -o BatchMode=yes -o ConnectTimeout=15 $HOST"
DOMAIN=api.feedthebrownies.com
S=/c/Users/andrea/helix-secrets

# ---- the local settings file for the Ethereum gateway (made once) ----
if [ ! -f "$S/brownies-gateway.env" ]; then
  node -e '
    const fs = require("fs"), crypto = require("crypto");
    const pick = (file, key) => { const m = fs.readFileSync(file, "utf8").match(new RegExp("^" + key + "=(.*)$", "m")); return m ? m[1].trim() : ""; };
    const lines = [
      "# The Brownies gateway on Ethereum, settings made 2026-10-06. Never copy values into chat or into OneDrive.",
      "PORT=8790", "RPC_URL=https://ethereum-rpc.publicnode.com", "CHAIN_ID=1",
      "SUGAR_ADDRESS=", "HARVESTER_ADDRESS=", "LEDGER_ADDRESS=", "TEAM_VAULT_ADDRESS=", "START_BLOCK=0",
      "DB_PATH=/var/lib/brownies/gateway.sqlite", "CLAIM_EVERY_SECONDS=300", "CLAIM_MIN_ETH=0.05", "KEEPER_FLOOR_ETH=0.01", "RELEASE_MIN_SUGAR=1", "PRICE_MULTIPLIER=1",
      "OPENROUTER_API_KEY=" + pick(process.argv[1] + "/synapse-gateway.env", "OPENROUTER_API_KEY"),
      "KEEPER_PRIVATE_KEY=" + pick(process.argv[1] + "/brownies-wallets.env", "KEEPER_PRIVATE_KEY"),
      "TEAM_LOG_KEY=" + crypto.randomBytes(24).toString("hex"), ""];
    fs.writeFileSync(process.argv[1] + "/brownies-gateway.env", lines.join("\n"));
    console.log("made brownies-gateway.env with keys: " + lines.filter(l => /^[A-Z_]+=/.test(l)).map(l => l.split("=")[0] + (l.split("=")[1] ? "" : " (empty)")).join(", "));
  ' "$S"
fi

echo "== server reachable: $($SSH 'echo yes && node --version')"

# ---- code ----
tar czf - gateway/server.mjs gateway/ledger.mjs gateway/chain.mjs gateway/auth.mjs gateway/teamlog.mjs gateway/package.json gateway/package-lock.json \
  | $SSH 'mkdir -p /srv/brownies /var/lib/brownies /etc/brownies && tar xzf - -C /srv/brownies && cd /srv/brownies/gateway && npm ci --omit=dev --no-audit --no-fund 2>&1 | tail -1'
echo "== code copied and dependencies installed"

# ---- the env file, straight from the local file to the server, never through the screen ----
$SSH 'cat > /etc/brownies/gateway.env && chmod 600 /etc/brownies/gateway.env' < "$S/brownies-gateway.env"
echo "== env file in place: $($SSH 'grep -c = /etc/brownies/gateway.env') settings"

# ---- systemd + Caddy ----
$SSH 'cat > /etc/systemd/system/brownies-gateway.service <<EOF
[Unit]
Description=Brownies gateway (SUGAR activations, OpenRouter proxy, team log)
After=network-online.target
Wants=network-online.target

[Service]
WorkingDirectory=/srv/brownies/gateway
EnvironmentFile=/etc/brownies/gateway.env
ExecStart=/usr/bin/env node server.mjs
Restart=always
RestartSec=5
User=root

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload && systemctl enable --now brownies-gateway >/dev/null 2>&1; systemctl restart brownies-gateway; sleep 2; systemctl is-active brownies-gateway; curl -s http://127.0.0.1:8790/health'
echo
$SSH "if ! command -v caddy >/dev/null; then (apt-get install -y -qq caddy >/dev/null 2>&1 || (apt-get install -y -qq debian-keyring debian-archive-keyring apt-transport-https curl >/dev/null 2>&1 && curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg && curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list && apt-get update -qq >/dev/null && apt-get install -y -qq caddy >/dev/null)); fi; command -v caddy && caddy version | head -1"
# /admin/*, /bake/* and /tiktok/* go to the helpers' own server (the control room, the Bakery, the TikTok connect routes); everything else to the gateway
$SSH "printf '%s\n' '$DOMAIN {' '  handle /admin/* {' '    reverse_proxy 127.0.0.1:8791' '  }' '  handle /bake/* {' '    reverse_proxy 127.0.0.1:8791' '  }' '  handle /tiktok/* {' '    reverse_proxy 127.0.0.1:8791' '  }' '  reverse_proxy 127.0.0.1:8790' '}' > /etc/caddy/Caddyfile && systemctl enable --now caddy >/dev/null 2>&1; systemctl reload caddy || systemctl restart caddy; sleep 1; systemctl is-active caddy"
echo "== caddy serves $DOMAIN -> 127.0.0.1:8790 (the certificate arrives once the name points here)"

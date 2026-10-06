#!/usr/bin/env bash
# Puts the Brownies helpers (the runtime of Fudge, Crumb, Nib and Chip) on the server, next to the gateway.
#   bash helpers/deploy-server.sh            from agent-company/, Git Bash
# The server's env file is a straight copy of C:\Users\andrea\helix-secrets\brownies-helpers.env, sent over ssh and
# never through the screen. The first run writes that file as a template (with the names below, the shared values
# taken from brownies-gateway.env) and stops, so the owner can fill the accounts. Nothing here prints a value.
# SSH key: ~/.ssh/helix_keeper (the same droplet as the gateway).
set -euo pipefail
cd "$(dirname "$0")/.."
HOST=root@142.93.168.190
SSH="ssh -i $HOME/.ssh/helix_keeper -o BatchMode=yes -o ConnectTimeout=15 $HOST"
S=/c/Users/andrea/helix-secrets
ENV_LOCAL="$S/brownies-helpers.env"

# ---- the local settings file (made once as a template; the owner fills the empty names) ----
if [ ! -f "$ENV_LOCAL" ]; then
  node -e '
    const fs = require("fs");
    const pick = (file, key) => { try { const m = fs.readFileSync(file, "utf8").match(new RegExp("^" + key + "=(.*)$", "m")); return m ? m[1].trim() : ""; } catch { return ""; } };
    const gw = process.argv[1] + "/brownies-gateway.env";
    const lines = [
      "# The Brownies helpers on the server, made " + new Date().toISOString().slice(0, 10) + ". Never copy values into chat or into OneDrive.",
      "# MODE: prelaunch = think through OpenRouter with a daily cap per helper; live = think through the gateway with each helper wallet key.",
      "MODE=prelaunch",
      "OPENROUTER_API_KEY=" + pick(gw, "OPENROUTER_API_KEY"),
      "GATEWAY_URL=https://api.feedthebrownies.com",
      "TEAM_LOG_KEY=" + pick(gw, "TEAM_LOG_KEY"),
      "# Telegram: the bot token, the owner chat id (alerts and approvals), the group chat id (Crumb answers there)",
      "TELEGRAM_BOT_TOKEN=", "TELEGRAM_OWNER_CHAT_ID=", "TELEGRAM_GROUP_CHAT_ID=",
      "# X: OAuth 2.0 user tokens of @Feedthebrownies (scopes tweet.read tweet.write users.read offline.access). The rotated pair lives in X_TOKEN_FILE.",
      "X_CLIENT_ID=", "X_CLIENT_SECRET=", "X_ACCESS_TOKEN=", "X_REFRESH_TOKEN=", "X_TOKEN_FILE=/var/lib/brownies/x-token.json", "X_USERNAME=Feedthebrownies",
      "# GitHub: a fine-grained token with contents, pull requests and issues read/write on the repository",
      "GITHUB_TOKEN=", "GITHUB_REPO=brownieshelper-glitch/brownies",
      "# The helpers wallets (MODE=live only): each key signs the gateway key message; the address is the helper in the team vault",
      "FUDGE_PRIVATE_KEY=", "CRUMB_PRIVATE_KEY=", "NIB_PRIVATE_KEY=", "CHIP_PRIVATE_KEY=",
      "SITE_URL=https://feedthebrownies.com",
      "DB_PATH=/var/lib/brownies/helpers.sqlite",
      "RPC_URL=https://ethereum-rpc.publicnode.com",
      "DEPLOYMENT_JSON=https://feedthebrownies.com/deployments/1.json",
      "HELPERS_PORT=8791", ""];
    fs.writeFileSync(process.argv[1] + "/brownies-helpers.env", lines.join("\n"), { mode: 0o600 });
    const names = lines.filter((l) => /^[A-Z_]+=/.test(l)).map((l) => l.split("=")[0] + (l.slice(l.indexOf("=") + 1) ? "" : " (empty)"));
    console.log("made brownies-helpers.env with: " + names.join(", "));
  ' "$S"
  echo "== fill the empty names in $ENV_LOCAL (Notepad is fine), then run this script again"
  exit 1
fi

# which names are still empty: names only, never values
EMPTY=$(node -e 'const fs=require("fs"); console.log(fs.readFileSync(process.argv[1],"utf8").split(/\r?\n/).filter(l=>/^[A-Z_]+=\s*$/.test(l)).map(l=>l.split("=")[0]).join(" "))' "$ENV_LOCAL")
[ -n "$EMPTY" ] && echo "== note: empty settings: $EMPTY (the helpers that need them stay off and the log says so)"

echo "== server reachable: $($SSH 'echo yes && node --version')"

# ---- code ----
tar czf - helpers/run.mjs helpers/brownies.json helpers/facts.md helpers/package.json helpers/package-lock.json helpers/lib helpers/helpers \
  | $SSH 'mkdir -p /srv/brownies /var/lib/brownies /etc/brownies && rm -rf /srv/brownies/helpers/lib /srv/brownies/helpers/helpers && tar xzf - -C /srv/brownies && cd /srv/brownies/helpers && npm ci --omit=dev --no-audit --no-fund 2>&1 | tail -1'
echo "== code copied and dependencies installed"

# ---- the env file, straight from the local file to the server, never through the screen ----
$SSH 'cat > /etc/brownies/helpers.env && chmod 600 /etc/brownies/helpers.env' < "$ENV_LOCAL"
echo "== env file in place: $($SSH 'grep -c = /etc/brownies/helpers.env') settings"

# ---- systemd ----
$SSH 'cat > /etc/systemd/system/brownies-helpers.service <<EOF
[Unit]
Description=Brownies helpers (Fudge, Crumb, Nib, Chip)
After=network-online.target brownies-gateway.service
Wants=network-online.target

[Service]
WorkingDirectory=/srv/brownies/helpers
EnvironmentFile=/etc/brownies/helpers.env
Environment=HELPERS_ENV=/etc/brownies/helpers.env
ExecStart=/usr/bin/env node run.mjs
Restart=always
RestartSec=10
User=root

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload && systemctl enable --now brownies-helpers >/dev/null 2>&1; systemctl restart brownies-helpers; sleep 3; systemctl is-active brownies-helpers; curl -s http://127.0.0.1:8791/health; echo; journalctl -u brownies-helpers -n 6 --no-pager -o cat'
echo "== helpers running; the Kitchen at https://feedthebrownies.com/team.html shows their reports"

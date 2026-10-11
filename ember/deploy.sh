#!/usr/bin/env bash
# Deploys the kitchen cam to its server: the scripts, the music bed, the env file (copied from the owner's secrets
# folder, never printed), the one-time setup, then the units. Usage, from the project folder:
#   bash ember/deploy.sh              everything, and the stream is left as it was (off until "start")
#   bash ember/deploy.sh start        starts the browser and the stream (the channel goes live)
#   bash ember/deploy.sh stop         stops the stream and the browser
#   bash ember/deploy.sh test         records 20 seconds to /srv/ember/test.mp4 and copies it back to ember/test.mp4
#   bash ember/deploy.sh status       the status file and the last log lines
# The server's address is EMBER_HOST in the env file (brownies-secrets/brownies-ember.env).
set -euo pipefail
cd "$(dirname "$0")/.."
S=${EMBER_SECRETS:-$HOME/brownies-secrets}
ENV_LOCAL="$S/brownies-ember.env"
[ -f "$ENV_LOCAL" ] || { echo "no env file at $ENV_LOCAL"; exit 1; }
HOSTIP=$(grep -E '^EMBER_HOST=' "$ENV_LOCAL" | head -1 | cut -d= -f2- | tr -d '[:space:]')
[ -n "$HOSTIP" ] || { echo "EMBER_HOST is not set in $ENV_LOCAL (the server's IP)"; exit 1; }
SSH="ssh -i $HOME/.ssh/brownies_key -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=15 root@$HOSTIP"
SCP="scp -q -i $HOME/.ssh/brownies_key -o BatchMode=yes -o StrictHostKeyChecking=accept-new"
case "${1:-deploy}" in
  start) $SSH "systemctl start ember-browser ember-stream && sleep 12 && systemctl is-active ember-browser ember-stream && journalctl -u ember-stream --no-pager -n 3 -o cat"; echo "== started";;
  stop) $SSH "systemctl stop ember-stream ember-browser; systemctl is-active ember-stream || true"; echo "== stopped";;
  status) $SSH "cat /srv/ember/public/status.json 2>/dev/null; echo; journalctl -u ember-stream --no-pager -n 8 -o cat"; ;;
  test)
    $SSH "systemctl is-active --quiet ember-browser || systemctl start ember-browser; sleep 10; sudo -u ember EMBER_ENV=/etc/ember/ember.env /srv/ember/stream.sh test && ls -la /srv/ember/test.mp4"
    $SCP "root@$HOSTIP:/srv/ember/test.mp4" ember/test.mp4 && echo "== 20 seconds recorded to ember/test.mp4";;
  deploy)
    echo "== server reachable: $($SSH 'echo yes' 2>/dev/null || echo no)"
    $SSH "mkdir -p /srv/ember/public /etc/ember"
    $SCP ember/stream.sh ember/health.sh ember/setup.sh "root@$HOSTIP:/srv/ember/"
    [ -f ember/music.wav ] && $SCP ember/music.wav "root@$HOSTIP:/srv/ember/music.wav" && echo "== music bed copied"
    $SCP "$ENV_LOCAL" "root@$HOSTIP:/etc/ember/ember.env"
    $SSH "chmod 600 /etc/ember/ember.env && chown root:ember /etc/ember/ember.env 2>/dev/null; chmod 640 /etc/ember/ember.env; bash /srv/ember/setup.sh"
    echo "== env file in place: $(grep -cE '^[A-Z_]+=.+' "$ENV_LOCAL") settings"
    echo "== deployed; the stream is $($SSH 'systemctl is-active ember-stream' || true). Start it with: bash ember/deploy.sh start";;
  *) echo "usage: bash ember/deploy.sh [deploy|start|stop|test|status]"; exit 1;;
esac

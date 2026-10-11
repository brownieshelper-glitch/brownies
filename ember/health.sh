#!/usr/bin/env bash
# Writes /srv/ember/public/status.json once a minute (ember-health-write.timer): whether the display, the browser
# and the stream run, how long the stream has run, the last warning ffmpeg printed, the machine's load. The
# brownies' watcher (helpers/ember.mjs) reads it and tells the owner when the stream is down or back. No secrets.
set -u
OUT=/srv/ember/public/status.json
up() { systemctl is-active --quiet "$1" && echo true || echo false; }
since() { local s; s=$(systemctl show -p ActiveEnterTimestamp --value "$1" 2>/dev/null); [ -n "$s" ] && date -d "$s" +%s 2>/dev/null || echo 0; }
LAST=$(journalctl -u ember-stream --no-pager -n 20 -o cat 2>/dev/null | grep -v "^$" | tail -1 | tr -d '"\\' | cut -c1-160)
LOAD=$(cut -d' ' -f1 /proc/loadavg)
MEM=$(free -m | awk '/Mem:/ {printf "%d", $3 * 100 / $2}')
NOW=$(date +%s)
STREAM_SINCE=$(since ember-stream)
mkdir -p /srv/ember/public
cat > "$OUT.tmp" <<EOF
{"at":$NOW,"display":$(up ember-display),"browser":$(up ember-browser),"stream":$(up ember-stream),"streamSeconds":$(( STREAM_SINCE > 0 ? NOW - STREAM_SINCE : 0 )),"load":$LOAD,"memoryPct":$MEM,"last":"$LAST"}
EOF
mv "$OUT.tmp" "$OUT"

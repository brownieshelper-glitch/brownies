#!/usr/bin/env bash
# The kitchen cam looks after itself. Once a minute (ember-health-write.timer, as root) this script
#   1. looks: the display, the browser, the stream, how many of the places the stream is set to reach it is
#      connected to, how much it is sending;
#   2. repairs what has stopped: starts a part that is not running, and restarts the stream when it is running
#      and reaches nobody, sends next to nothing, or has had a place disconnected for a quarter of an hour
#      (each place also reconnects on its own inside ffmpeg, see stream.sh; this is the backstop);
#   3. writes /srv/ember/public/status.json, which the brownies' watcher (helpers/ember.mjs) reads to tell the
#      owner what happened.
# Nothing is repaired while /srv/ember/paused exists ("deploy.sh stop" writes it: the owner wants it off).
# No secret is read or printed: of the settings only which names are filled.
set -u
OUT=/srv/ember/public/status.json
ENV_FILE=${EMBER_ENV:-/etc/ember/ember.env}
PAUSED=/srv/ember/paused
STATE=/run/ember-heal
LOG=/var/log/ember-heal.log
mkdir -p "$STATE" /srv/ember/public
NOW=$(date +%s)

up() { systemctl is-active --quiet "$1" && echo true || echo false; }
since() { local s; s=$(systemctl show -p ActiveEnterTimestamp --value "$1" 2>/dev/null); [ -n "$s" ] && date -d "$s" +%s 2>/dev/null || echo 0; }
num() { local v; v=$(cat "$STATE/$1" 2>/dev/null); [[ "$v" =~ ^[0-9]+$ ]] && echo "$v" || echo 0; }
has() { grep -qE "^$1=.+" "$ENV_FILE" 2>/dev/null; }

# ---- look ----
PLACES=0
has TWITCH_STREAM_KEY && PLACES=$((PLACES + 1))
has YOUTUBE_STREAM_KEY && PLACES=$((PLACES + 1))
{ has X_STREAM_KEY && has X_RTMP_URL; } && PLACES=$((PLACES + 1))

DISPLAY_UP=$(up ember-display); BROWSER_UP=$(up ember-browser); STREAM_UP=$(up ember-stream)
STREAM_SINCE=$(since ember-stream)
STREAM_SECONDS=0; [ "$STREAM_UP" = true ] && [ "$STREAM_SINCE" -gt 0 ] && STREAM_SECONDS=$(( NOW - STREAM_SINCE ))
PID=$(pgrep -u ember -f "ffmpeg -hide_banner" 2>/dev/null | head -1)
CONNECTED=0
[ -n "$PID" ] && CONNECTED=$(ss -Htnp state established 2>/dev/null | grep -c "pid=$PID,")

# what the machine sent since the last look, in kbit/s (the stream is nearly all of it)
IFACE=$(ip route show default 2>/dev/null | awk '{print $5; exit}')
TX=$(awk -v i="${IFACE:-eth0}:" '$1 == i {print $10}' /proc/net/dev 2>/dev/null); [[ "$TX" =~ ^[0-9]+$ ]] || TX=0
PREV_TX=$(num tx); PREV_AT=$(num at)
echo "$TX" > "$STATE/tx"; echo "$NOW" > "$STATE/at"
KBIT=0
if [ "$PREV_AT" -gt 0 ] && [ "$NOW" -gt "$PREV_AT" ] && [ "$TX" -ge "$PREV_TX" ]; then KBIT=$(( (TX - PREV_TX) * 8 / (NOW - PREV_AT) / 1000 )); fi

# ---- repair ----
HEAL_WHAT=""; HEAL_WHY=""
strike() { local n; n=$(( $(num "$1") + 1 )); echo "$n" > "$STATE/$1"; echo "$n"; }   # one more minute of the same trouble
forget() { echo 0 > "$STATE/$1"; }
heal() { HEAL_WHAT="$1"; HEAL_WHY="$2"; echo "$NOW" > "$STATE/heal_at"; echo "$1" > "$STATE/heal_what"; echo "$2" > "$STATE/heal_why"; echo "$NOW $1: $2" >> "$LOG"; }
restart_stream() { systemctl restart ember-stream; echo "$NOW" > "$STATE/restart_at"; forget nobody; forget quiet; forget partial; }

if [ -e "$PAUSED" ]; then
  forget nobody; forget quiet; forget partial
elif [ "$DISPLAY_UP" != true ]; then
  systemctl start ember-display ember-browser; heal "started the display and the browser" "the display was not running"
elif [ "$BROWSER_UP" != true ]; then
  systemctl start ember-browser; heal "started the browser" "the browser was not running"
elif [ "$STREAM_UP" != true ]; then
  # between two tries of its own the unit is "activating": only a unit that is really off is started
  if [ "$(systemctl is-active ember-stream)" = inactive ] || [ "$(systemctl is-active ember-stream)" = failed ]; then systemctl start ember-stream; heal "started the stream" "the stream was not running"; fi
elif [ "$PLACES" -gt 0 ] && [ "$STREAM_SECONDS" -gt 120 ]; then
  SINCE_RESTART=$(( NOW - $(num restart_at) ))
  if [ "$CONNECTED" -eq 0 ]; then
    forget quiet; forget partial
    [ "$(strike nobody)" -ge 3 ] && [ "$SINCE_RESTART" -ge 600 ] && { restart_stream; heal "restarted the stream" "it was connected to none of its $PLACES places for 3 minutes"; }
  elif [ "$KBIT" -lt 300 ]; then
    forget nobody; forget partial
    [ "$(strike quiet)" -ge 3 ] && [ "$SINCE_RESTART" -ge 600 ] && { restart_stream; heal "restarted the stream" "it was sending next to nothing for 3 minutes"; }
  elif [ "$CONNECTED" -lt "$PLACES" ]; then
    forget nobody; forget quiet
    [ "$(strike partial)" -ge 15 ] && [ "$SINCE_RESTART" -ge 3600 ] && { restart_stream; heal "restarted the stream" "only $CONNECTED of its $PLACES places had been connected for 15 minutes"; }
  else
    forget nobody; forget quiet; forget partial
  fi
fi

# ---- write ----
clean() { tr -d '"\\' | tr -d '\000-\037' | cut -c1-160; }
LAST=$(journalctl -u ember-stream --no-pager -n 30 -o cat 2>/dev/null | grep -v "^$" | grep -viE "FIFO queue (full|flushed)" | tail -1 | clean)
LOAD=$(cut -d' ' -f1 /proc/loadavg)
MEM=$(free -m | awk '/Mem:/ {printf "%d", $3 * 100 / $2}')
HEAL_AT=$(num heal_at)
HEAL_WHAT_LAST=$(cat "$STATE/heal_what" 2>/dev/null | clean)
HEAL_WHY_LAST=$(cat "$STATE/heal_why" 2>/dev/null | clean)
HEALS_DAY=0; [ -f "$LOG" ] && HEALS_DAY=$(awk -v t=$((NOW - 86400)) '$1 >= t' "$LOG" | wc -l)
PAUSED_JSON=false; [ -e "$PAUSED" ] && PAUSED_JSON=true
cat > "$OUT.tmp" <<EOF
{"at":$NOW,"display":$DISPLAY_UP,"browser":$BROWSER_UP,"stream":$STREAM_UP,"streamSeconds":$STREAM_SECONDS,"places":$PLACES,"connected":$CONNECTED,"kbit":$KBIT,"paused":$PAUSED_JSON,"heal":{"at":$HEAL_AT,"what":"$HEAL_WHAT_LAST","why":"$HEAL_WHY_LAST"},"heals24h":$HEALS_DAY,"load":$LOAD,"memoryPct":$MEM,"last":"$LAST"}
EOF
mv "$OUT.tmp" "$OUT"
chmod 644 "$OUT"

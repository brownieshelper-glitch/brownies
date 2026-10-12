#!/usr/bin/env bash
# Ember, the kitchen cam: grabs the display the browser draws the Room on, lays the music bed under it, and sends
# it to Twitch (and to YouTube and to X when their keys are set), 720p at 30 frames a second, 2.5 Mbit/s. Runs under systemd
# (ember-stream.service) and is restarted when it stops. Settings come from /etc/ember/ember.env; nothing is
# printed from it. "stream.sh test" writes 20 seconds to /srv/ember/test.mp4 instead of streaming anywhere.
set -euo pipefail
ENV_FILE=${EMBER_ENV:-/etc/ember/ember.env}
[ -f "$ENV_FILE" ] && set -a && . "$ENV_FILE" && set +a
DISPLAY_ID=${EMBER_DISPLAY:-:99}
MUSIC=${EMBER_MUSIC:-/srv/ember/music.wav}
FPS=${EMBER_FPS:-30}
SIZE=${EMBER_SIZE:-1280x720}
VBITRATE=${EMBER_VBITRATE:-2500k}
TWITCH_INGEST=${TWITCH_INGEST:-rtmp://ingest.global-contribute.live-video.net/app}
YOUTUBE_INGEST=${YOUTUBE_INGEST:-rtmp://a.rtmp.youtube.com/live2}
# X gives each source its own address and key (Live Studio, the source page): both go in the env file, X_RTMP_URL and
# X_STREAM_KEY. There is no usual address to fall back on.
X_RTMP_URL=${X_RTMP_URL:-}

VIDEO=(-thread_queue_size 512 -f x11grab -framerate "$FPS" -video_size "$SIZE" -draw_mouse 0 -i "$DISPLAY_ID")
if [ -f "$MUSIC" ]; then AUDIO=(-thread_queue_size 512 -stream_loop -1 -i "$MUSIC"); else AUDIO=(-f lavfi -i anullsrc=channel_layout=mono:sample_rate=24000); fi
ENC=(-map 0:v -map 1:a -c:v libx264 -preset veryfast -tune zerolatency -pix_fmt yuv420p -g $((FPS * 2)) -keyint_min $((FPS * 2)) -b:v "$VBITRATE" -maxrate "$VBITRATE" -bufsize 5000k -c:a aac -ar 44100 -b:a 128k -af "volume=0.9")

if [ "${1:-}" = "test" ]; then
  mkdir -p /srv/ember
  exec ffmpeg -hide_banner -loglevel warning -y "${VIDEO[@]}" "${AUDIO[@]}" "${ENC[@]}" -t 20 -f mp4 /srv/ember/test.mp4
fi

OUTS=()
[ -n "${TWITCH_STREAM_KEY:-}" ] && OUTS+=("[f=flv:onfail=ignore]${TWITCH_INGEST}/${TWITCH_STREAM_KEY}")
[ -n "${YOUTUBE_STREAM_KEY:-}" ] && OUTS+=("[f=flv:onfail=ignore]${YOUTUBE_INGEST}/${YOUTUBE_STREAM_KEY}")
[ -n "${X_STREAM_KEY:-}" ] && [ -n "$X_RTMP_URL" ] && OUTS+=("[f=flv:onfail=ignore]${X_RTMP_URL%/}/${X_STREAM_KEY}")
if [ ${#OUTS[@]} -eq 0 ]; then echo "no stream key set (TWITCH_STREAM_KEY, YOUTUBE_STREAM_KEY, or X_RTMP_URL with X_STREAM_KEY, in $ENV_FILE)"; sleep 60; exit 1; fi
TEE=$(IFS='|'; echo "${OUTS[*]}")
echo "streaming $SIZE at $FPS fps to ${#OUTS[@]} place(s)"
exec ffmpeg -hide_banner -loglevel warning -nostats "${VIDEO[@]}" "${AUDIO[@]}" "${ENC[@]}" -flvflags no_duration_filesize -f tee "$TEE"

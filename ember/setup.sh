#!/usr/bin/env bash
# One-time setup of the kitchen cam server (Ubuntu 24.04): a virtual display, Google Chrome in kiosk mode on the
# Room's live page, ffmpeg streaming the display, a status file served on port 8798 for the brownies' watcher.
# Run as root on the server: bash /srv/ember/setup.sh. Idempotent.
set -euo pipefail
LIVE_URL=${LIVE_URL:-https://feedthebrownies.com/room.html?live=1}
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq xvfb ffmpeg fonts-liberation fonts-noto-color-emoji xdg-utils curl python3 unzip >/dev/null
if ! command -v google-chrome >/dev/null; then
  curl -fsSL -o /tmp/chrome.deb https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb
  apt-get install -y -qq /tmp/chrome.deb >/dev/null && rm -f /tmp/chrome.deb
fi
id ember >/dev/null 2>&1 || useradd --system --create-home --shell /usr/sbin/nologin ember
mkdir -p /srv/ember/public /etc/ember
chown -R ember:ember /srv/ember
chmod 600 /etc/ember/ember.env 2>/dev/null || true
chmod +x /srv/ember/stream.sh /srv/ember/health.sh

cat > /etc/systemd/system/ember-display.service <<'EOF'
[Unit]
Description=Ember: the virtual display the Room is drawn on
After=network.target
[Service]
User=ember
ExecStart=/usr/bin/Xvfb :99 -screen 0 1280x720x24 -nolisten tcp -ac
Restart=always
RestartSec=3
[Install]
WantedBy=multi-user.target
EOF

cat > /etc/systemd/system/ember-browser.service <<EOF
[Unit]
Description=Ember: Chrome in kiosk mode on the Room's live page
After=ember-display.service
Requires=ember-display.service
[Service]
User=ember
Environment=DISPLAY=:99
Environment=HOME=/home/ember
ExecStartPre=/bin/sleep 2
ExecStart=/usr/bin/google-chrome --kiosk --no-first-run --no-default-browser-check --disable-infobars --disable-session-crashed-bubble --disable-features=TranslateUI --disable-gpu --disable-dev-shm-usage --window-size=1280,720 --window-position=0,0 --hide-scrollbars --autoplay-policy=no-user-gesture-required --user-data-dir=/home/ember/chrome "${LIVE_URL}"
Restart=always
RestartSec=5
[Install]
WantedBy=multi-user.target
EOF

cat > /etc/systemd/system/ember-stream.service <<'EOF'
[Unit]
Description=Ember: the stream to Twitch and YouTube
After=ember-browser.service
Requires=ember-display.service
[Service]
User=ember
ExecStartPre=/bin/sleep 8
ExecStart=/srv/ember/stream.sh
Restart=always
RestartSec=10
[Install]
WantedBy=multi-user.target
EOF

cat > /etc/systemd/system/ember-health.service <<'EOF'
[Unit]
Description=Ember: the status file on port 8798
After=network.target
[Service]
User=ember
ExecStart=/usr/bin/python3 -m http.server 8798 --directory /srv/ember/public --bind 0.0.0.0
Restart=always
[Install]
WantedBy=multi-user.target
EOF

cat > /etc/systemd/system/ember-health-write.service <<'EOF'
[Unit]
Description=Ember: writes the status file
[Service]
Type=oneshot
ExecStart=/srv/ember/health.sh
EOF
cat > /etc/systemd/system/ember-health-write.timer <<'EOF'
[Unit]
Description=Ember: the status file, every minute
[Timer]
OnBootSec=30
OnUnitActiveSec=60
[Install]
WantedBy=timers.target
EOF

# the browser gets a fresh start every morning (memory), the stream keeps grabbing the display meanwhile
cat > /etc/systemd/system/ember-browser-restart.service <<'EOF'
[Unit]
Description=Ember: a fresh browser once a day
[Service]
Type=oneshot
ExecStart=/bin/systemctl restart ember-browser.service
EOF
cat > /etc/systemd/system/ember-browser-restart.timer <<'EOF'
[Unit]
Description=Ember: restart the browser at 05:00
[Timer]
OnCalendar=*-*-* 05:00:00
[Install]
WantedBy=timers.target
EOF

systemctl daemon-reload
systemctl enable --now ember-display ember-health ember-health-write.timer ember-browser-restart.timer >/dev/null 2>&1
systemctl enable ember-browser ember-stream >/dev/null 2>&1
command -v ufw >/dev/null && ufw allow 8798/tcp >/dev/null 2>&1 || true
echo "setup done: display, browser and stream units installed; the status file is served on :8798"

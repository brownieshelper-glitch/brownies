#!/usr/bin/env bash
# One-time setup of the sandbox on a server (Ubuntu 24.04), next to the kitchen cam: Docker, Node, git, the three
# images, the service on port 8799 with a token of its own, and a firewall that lets only the helpers' droplet
# reach that port (SSH and the cam's status port stay open). Run as root: bash /srv/sandbox/setup.sh. Idempotent.
set -euo pipefail
HELPERS_IP=${HELPERS_IP:-142.93.168.190}
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq docker.io nodejs git curl ufw >/dev/null
systemctl enable --now docker >/dev/null 2>&1
mkdir -p /srv/sandbox /var/lib/sandbox/jobs /etc/sandbox
chmod 700 /var/lib/sandbox
# the token: made once, never printed
if ! grep -q '^SANDBOX_TOKEN=.\+' /etc/sandbox/sandbox.env 2>/dev/null; then
  printf 'PORT=8799\nSANDBOX_TOKEN=%s\nJOBS_DIR=/var/lib/sandbox/jobs\nCPUS=1\nMEMORY=1500m\n' "$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')" > /etc/sandbox/sandbox.env
fi
chmod 600 /etc/sandbox/sandbox.env
# gVisor: a second kernel under every container, so a bug in a stranger's code meets a sandboxed kernel, not the host's
if ! command -v runsc >/dev/null; then
  curl -fsSL https://gvisor.dev/archive.key | gpg --dearmor -o /usr/share/keyrings/gvisor-archive-keyring.gpg
  echo "deb [arch=amd64 signed-by=/usr/share/keyrings/gvisor-archive-keyring.gpg] https://storage.googleapis.com/gvisor/releases release main" > /etc/apt/sources.list.d/gvisor.list
  apt-get update -qq && apt-get install -y -qq runsc >/dev/null
  runsc install >/dev/null 2>&1 && systemctl restart docker
fi
if docker info 2>/dev/null | grep -q runsc; then grep -q '^RUNTIME=' /etc/sandbox/sandbox.env || echo 'RUNTIME=runsc' >> /etc/sandbox/sandbox.env; fi
for img in node:22-bookworm-slim python:3.12-slim ghcr.io/foundry-rs/foundry:latest; do docker image inspect "$img" >/dev/null 2>&1 || docker pull -q "$img" >/dev/null; done
cat > /etc/systemd/system/sandbox.service <<'EOF'
[Unit]
Description=Brownies sandbox: strangers' code in a box, for the code reviews
After=network-online.target docker.service
Requires=docker.service
[Service]
EnvironmentFile=/etc/sandbox/sandbox.env
WorkingDirectory=/srv/sandbox
ExecStart=/usr/bin/node /srv/sandbox/server.mjs
Restart=always
RestartSec=3
[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now sandbox >/dev/null 2>&1
systemctl restart sandbox
# the firewall: SSH open, the cam's status port open, the sandbox port only from the helpers' droplet
ufw allow OpenSSH >/dev/null
ufw allow 8798/tcp >/dev/null
ufw allow from "$HELPERS_IP" to any port 8799 proto tcp >/dev/null
ufw --force enable >/dev/null
sleep 2
echo "sandbox: $(systemctl is-active sandbox); docker: $(docker --version | cut -d, -f1); runtime: $(grep -q '^RUNTIME=runsc' /etc/sandbox/sandbox.env && echo gVisor || echo plain); node: $(node --version); images: $(docker image ls --format '{{.Repository}}' | tr '\n' ' ')"
echo "firewall: $(ufw status | grep -c ALLOW) rules"

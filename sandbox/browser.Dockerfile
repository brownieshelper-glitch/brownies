# The browser box: Debian's Chromium on the Node image, for rendering pages to screenshots with no network.
# Built once on the sandbox droplet by setup.sh (docker build -t brownies-browser -f browser.Dockerfile .).
FROM node:22-bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends chromium fonts-liberation fonts-dejavu-core \
 && rm -rf /var/lib/apt/lists/*
ENV CHROME_BIN=/usr/bin/chromium

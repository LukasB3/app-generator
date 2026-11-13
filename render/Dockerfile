# The browser a finished app is opened in before it is published. It holds a
# headless Chromium and a small driver, and nothing of value: no credentials,
# and it is started without a network and without a mount.
FROM node:22-bookworm-slim AS chrome

# Chrome for Testing publishes no checksums. This is the SHA-256 of the file as
# downloaded on 2026-11-13; a different file fails the build.
ARG CHROME_VERSION=157.0.8103.78
ARG CHROME_SHA256=f90329720fb61e5a76da9b6b509b6ad12a484c9c5df0359403e935177c6d153a
RUN apt-get update \
 && apt-get install --yes --no-install-recommends ca-certificates curl unzip \
 && curl --fail --silent --show-error --location --output /tmp/chrome.zip \
      "https://storage.googleapis.com/chrome-for-testing-public/${CHROME_VERSION}/linux64/chrome-headless-shell-linux64.zip" \
 && echo "${CHROME_SHA256}  /tmp/chrome.zip" | sha256sum --check - \
 && unzip -q /tmp/chrome.zip -d /opt \
 && mv /opt/chrome-headless-shell-linux64 /opt/chrome

FROM node:22-bookworm-slim

# What the browser links against, and fonts: Roboto for the names of system
# fonts, stand-ins for Arial, Times and Courier, and an emoji font. A missing
# library fails the build instead of the first job.
COPY fonts.conf /etc/fonts/local.conf
RUN apt-get update \
 && apt-get install --yes --no-install-recommends \
      libnss3 libnspr4 libdbus-1-3 libatk1.0-0 libatk-bridge2.0-0 libatspi2.0-0 libcups2 libgbm1 libasound2 \
      libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libpango-1.0-0 libcairo2 \
      fontconfig fonts-roboto-unhinted fonts-liberation fonts-noto-color-emoji \
 && rm -rf /var/lib/apt/lists/* \
 && fc-cache --force
COPY --from=chrome /opt/chrome /opt/chrome
RUN ! ldd /opt/chrome/chrome-headless-shell | grep "not found"

COPY driver.mjs cdp.mjs standins.mjs page.js /opt/render/

USER nobody
ENV HOME=/tmp
# Whatever a page does, the container is gone after fifteen seconds.
ENTRYPOINT ["timeout", "--signal=KILL", "15", "node", "/opt/render/driver.mjs"]

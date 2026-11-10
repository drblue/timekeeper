ARG NODE_BASE
FROM ${NODE_BASE}

ENV PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers
WORKDIR /opt/timekeeper

COPY source/ /opt/timekeeper/
COPY source.sha256 /opt/source.sha256
RUN sha256sum -c /opt/source.sha256 \
	&& test "$(node --version)" = v24.19.0 \
	&& if [ "$(npm --version)" != 11.17.0 ]; then npm install --global --no-audit --no-fund npm@11.17.0; fi \
	&& test "$(npm --version)" = 11.17.0 \
	&& npm ci --no-audit --no-fund \
	&& npm run build -w @timekeeper/contracts \
	&& npm run build -w @timekeeper/server \
	&& npm run build:pdf

RUN apt-get update \
	&& apt-get install -y --no-install-recommends ca-certificates procps fonts-liberation \
	&& ./node_modules/.bin/playwright install --with-deps --only-shell chromium \
	&& fc-match Arial \
	&& rm -rf /var/lib/apt/lists/* /root/.npm

RUN find apps packages prototype -type d -perm 0700 -exec chmod 0755 {} + \
	&& find apps packages prototype -type f -perm 0600 -exec chmod 0644 {} +
USER node

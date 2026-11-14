# syntax=docker/dockerfile:1
FROM node:24.19.0-bookworm-slim@sha256:a9f5f7c91a432850b2a8a7797adf5eadb6c733ceed61167806cee7ea7fbc29df AS base
WORKDIR /opt/timekeeper
RUN apt-get update \
	&& apt-get install -y --no-install-recommends ca-certificates openssl \
	&& rm -rf /var/lib/apt/lists/*

FROM base AS dependencies
RUN apt-get update \
	&& apt-get install -y --no-install-recommends g++ make python3 \
	&& rm -rf /var/lib/apt/lists/* \
	&& npm install --global --no-audit --no-fund npm@11.17.0
COPY package.json package-lock.json ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY packages/contracts/package.json packages/contracts/
COPY packages/report-renderer/package.json packages/report-renderer/
RUN npm ci --no-audit --no-fund

FROM dependencies AS build
COPY tsconfig.base.json ./
COPY apps apps
COPY packages packages
COPY prisma/app prisma/app
RUN npm run build

FROM base AS migration
COPY --from=dependencies /opt/timekeeper/node_modules node_modules
COPY package.json ./
COPY prisma/app prisma/app
COPY apps/server/src/auth/database-location.ts apps/server/src/auth/database-location.ts
ENV NODE_ENV=production TIMEKEEPER_DATABASE_URL=file:/var/lib/timekeeper/timekeeper.sqlite
USER 1000:1000
CMD ["sh", "-c", "umask 077 && exec ./node_modules/.bin/prisma migrate deploy --config prisma/app/prisma.config.ts"]

FROM build AS production-dependencies
RUN npm prune --omit=dev --no-audit --no-fund

FROM base AS application
COPY package.json ./
COPY --from=production-dependencies /opt/timekeeper/node_modules node_modules
COPY --from=production-dependencies /opt/timekeeper/apps/server/package.json apps/server/package.json
COPY --from=production-dependencies /opt/timekeeper/apps/server/dist apps/server/dist
COPY --from=production-dependencies /opt/timekeeper/apps/web/dist apps/web/dist
COPY --from=production-dependencies /opt/timekeeper/packages/contracts/package.json packages/contracts/package.json
COPY --from=production-dependencies /opt/timekeeper/packages/contracts/dist packages/contracts/dist
COPY --from=production-dependencies /opt/timekeeper/packages/report-renderer/package.json packages/report-renderer/package.json
COPY --from=production-dependencies /opt/timekeeper/packages/report-renderer/dist packages/report-renderer/dist
COPY prisma/app/migrations prisma/app/migrations
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000 TIMEKEEPER_DATABASE_URL=file:/var/lib/timekeeper/timekeeper.sqlite
USER 1000:1000
EXPOSE 3000
ENTRYPOINT ["sh", "-c", "umask 077 && exec \"$@\"", "timekeeper"]
CMD ["node", "apps/server/dist/index.js"]


FROM application AS backup
USER root
RUN apt-get update \
	&& apt-get install -y --no-install-recommends age=1.1.1-1+b3 \
	&& rm -rf /var/lib/apt/lists/*
USER 1000:1000
CMD ["node", "apps/server/dist/backup/operator.js", "backup"]

FROM application AS runtime

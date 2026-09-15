# syntax=docker/dockerfile:1.7
# One image, two roles. `docker compose --profile app up` runs it twice: once as `web`
# (`next start`) and once as `daemon` (the orchestrator). The runtime keeps the whole workspace
# tree and its full node_modules on purpose: Prisma's CLI (a devDependency of packages/db) runs
# `migrate deploy` from the entrypoint, and Next is built without `output: 'standalone'`, so the
# pruned-runtime trick would have to be maintained against both. Image size is the price; nothing
# in it is a secret.

FROM node:26-bookworm-slim AS build
WORKDIR /app
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates openssl git \
 && rm -rf /var/lib/apt/lists/*
COPY . .
RUN npm ci
# `prisma generate` writes packages/db/src/generated (git-ignored, so it is never in the context).
# It opens no connection, but prisma.config.ts reads DATABASE_URL and Prisma 7 refuses an
# undefined datasource url, hence the placeholder -- build-time only, never in the runtime env.
RUN DATABASE_URL=postgresql://build:build@localhost:5432/build npm run db:generate \
 && npx tsc --build \
 && npx next build apps/web

FROM node:26-bookworm-slim AS runtime
ARG CLAUDE_CODE_VERSION=2.1.272
ENV NODE_ENV=production \
    HOME=/home/app \
    SLAVEOFAI_STATE_DIR=/state
# git + bash: the daemon probes repositories with `git -C` and runs the hook-plane shell scripts
# (scripts/pause-gate.sh, tool-result-tap.sh, deny-all-gate.sh) beside every slave it spawns.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates openssl git bash curl procps \
 && rm -rf /var/lib/apt/lists/* \
 && npm install -g "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
 && mkdir -p /home/app /state \
 && chmod 0777 /home/app /state \
 && git config --system safe.directory '*'
WORKDIR /app
COPY --from=build /app /app
RUN chmod +x /app/docker/entrypoint.sh
EXPOSE 3000
ENTRYPOINT ["/app/docker/entrypoint.sh"]
CMD ["web"]

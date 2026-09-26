# syntax=docker/dockerfile:1

# AuditIQ in one image: the API server, the built web app, and the Claude and Codex CLIs
# that ship inside their npm packages. Everything that changes at runtime lives in /data.

FROM node:24-bookworm-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable
WORKDIR /app

# better-sqlite3 builds a native module when no prebuilt binary matches.
FROM base AS toolchain
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/

FROM toolchain AS build
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build

FROM toolchain AS prod-deps
RUN pnpm install --frozen-lockfile --prod --filter "@auditiq/server..."

FROM base AS runtime
ENV NODE_ENV=production HOST=0.0.0.0 PORT=5180 DATA_DIR=/data HOME=/data/home
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=prod-deps /app/apps/server/node_modules ./apps/server/node_modules
COPY --from=prod-deps /app/packages/shared/node_modules ./packages/shared/node_modules
COPY package.json pnpm-workspace.yaml ./
COPY apps/server ./apps/server
COPY packages/shared ./packages/shared
COPY --from=build /app/apps/web/dist ./apps/web/dist
RUN mkdir -p /data/home && chown -R node:node /data
USER node
VOLUME /data
EXPOSE 5180
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:5180/api/setup/state').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "apps/server/src/index.ts"]

# Factory Desk V2 — application image (Node.js API + built front end).
# Build:  docker compose build        (see DEPLOY_SERVER.md)
#
# Optional build arguments:
#   NODE_IMAGE            base image (default node:22-bookworm-slim)
#   NPM_REGISTRY          npm registry, e.g. https://registry.npmmirror.com for servers in mainland China
#   BETTER_SQLITE3_BINARY_HOST  mirror for better-sqlite3 prebuilt binaries, if GitHub downloads fail
#   INSTALL_BUILD_TOOLS=1 install python3/make/g++ so better-sqlite3 can compile from source as a fallback
# Optional build secret "extra_ca": an extra CA certificate for networks with an intercepting proxy.
ARG NODE_IMAGE=node:22-bookworm-slim

# ---------- build stage: install all dependencies and build the front end ----------
FROM ${NODE_IMAGE} AS build
ARG NPM_REGISTRY=https://registry.npmjs.org/
ARG BETTER_SQLITE3_BINARY_HOST=
ARG INSTALL_BUILD_TOOLS=0
WORKDIR /app
RUN if [ "$INSTALL_BUILD_TOOLS" = "1" ]; then \
      apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*; \
    fi
COPY package.json package-lock.json ./
RUN --mount=type=secret,id=extra_ca,required=false \
    if [ -f /run/secrets/extra_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/extra_ca; fi; \
    if [ -n "$BETTER_SQLITE3_BINARY_HOST" ]; then export npm_config_better_sqlite3_binary_host="$BETTER_SQLITE3_BINARY_HOST"; fi; \
    npm ci --registry="$NPM_REGISTRY" --no-audit --no-fund
COPY index.html vite.config.js ./
COPY src ./src
COPY shared ./shared
RUN npm run build && npm prune --omit=dev

# ---------- runtime stage: production dependencies, server code and built assets only ----------
FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production \
    FACTORY_SHARED_HOST=0.0.0.0 \
    FACTORY_SHARED_PORT=8787 \
    FACTORY_STORAGE_ROOT=/data
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY server ./server
COPY shared ./shared
COPY scripts ./scripts
# Code is owned by root and read-only for the app user; only /data is writable.
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 8787
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8787/api/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"]
CMD ["node", "server/index.js"]

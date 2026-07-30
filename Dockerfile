# ── Archivum Null Backend Dockerfile ──
# Multi-stage build for minimal production image

# Stage 1: Build backend
FROM node:24-alpine AS backend-build
WORKDIR /app/backend
COPY backend/package.json backend/package-lock.json* backend/.npmrc* ./
RUN npm ci --ignore-scripts
COPY backend/ ./
RUN npm run build

# Stage 2: Build frontend
FROM node:24-alpine AS frontend-build
WORKDIR /app/frontend
COPY frontend/package.json frontend/package-lock.json* frontend/.npmrc* ./
RUN npm ci --ignore-scripts
COPY frontend/ ./
RUN npm run build

# Stage 3: Production image
FROM node:24-alpine AS production

# Bust Docker layer cache for apk upgrade so CI always pulls the latest security patches.
# In CI, CACHE_BUST_APK is set to github.run_id so the layer is never stale.
ARG CACHE_BUST_APK=""
RUN apk upgrade --no-cache

# Security: non-root user
RUN addgroup -g 1001 -S archivum && \
    adduser -u 1001 -S archivum -G archivum

WORKDIR /app

# Install production dependencies only, then strip every package manager.
#
# The runtime entrypoint is plain `node`, and the base docker-entrypoint.sh
# only needs node on PATH — so npm, corepack and yarn are all build-time
# tooling that has no business in the shipped image. Each one carries its own
# vendored dependency tree, and those trees, not our dependencies, have been
# the recurring source of image-scan findings: CVE-2026-14257
# (brace-expansion <= 5.0.7) lives in npm's bundle and cannot be fixed by
# upgrading, because every npm release through 12.0.2 still ships 5.0.7.
# Deleting them removes that whole class of finding at the source.
#
# corepack and yarn are clean today; they are removed for the same reason, so
# the next advisory in either never reaches a running container.
WORKDIR /app/backend
COPY backend/package.json backend/package-lock.json* backend/.npmrc* ./
RUN npm ci --omit=dev --ignore-scripts \
 && npm cache clean --force \
 && rm -rf /usr/local/lib/node_modules/npm \
           /usr/local/lib/node_modules/corepack \
           /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
           /usr/local/bin/yarn /usr/local/bin/yarnpkg \
           /opt/yarn-v* \
           /root/.npm
WORKDIR /app

# Copy built backend
COPY --from=backend-build /app/backend/dist ./backend/dist

# Copy built frontend
COPY --from=frontend-build /app/frontend/dist ./frontend/dist

# Copy TOS (can be overridden by volume mount in production)
COPY TOS.md ./TOS.md

# Create data directory
RUN mkdir -p /data/vaults && chown -R archivum:archivum /data

# Switch to non-root user
USER archivum

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://127.0.0.1:${PORT:-3000}/api/health || exit 1

# PORT is a runtime env var (set via env_file / environment: in compose).
# Declaring it as ARG here lets EXPOSE track it at build time when --build-arg PORT=<n> is passed.
ARG PORT=3000
EXPOSE ${PORT}

ENV NODE_ENV=production
ENV STORAGE_PATH=/data/vaults

CMD ["node", "backend/dist/index.js"]

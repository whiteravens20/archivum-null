# check=skip=SecretsUsedInArgOrEnv
# ↑ Parser directive (must be first line). Suppresses a BuildKit false-positive:
#   TURNSTILE_SITE_KEY is a *public* Cloudflare site key — its value is
#   intentionally embedded in the browser bundle and visible to every visitor.
#   It is NOT a secret. See: https://developers.cloudflare.com/turnstile/get-started/
#
# ── Archivum Null Backend Dockerfile ──
# Multi-stage build for minimal production image

# Stage 1: Build backend
FROM node:24-alpine AS backend-build
WORKDIR /app/backend
COPY backend/package.json backend/package-lock.json* ./
RUN npm ci --ignore-scripts
COPY backend/ ./
RUN npm run build

# Stage 2: Build frontend
FROM node:24-alpine AS frontend-build
WORKDIR /app/frontend
COPY frontend/package.json frontend/package-lock.json* frontend/.npmrc* ./
RUN npm ci --ignore-scripts
COPY frontend/ ./
ARG MAX_FILE_SIZE=104857600
ARG TURNSTILE_SITE_KEY=0x0000000000000000000000
ARG DEFAULT_TTL=86400
ARG DEFAULT_MAX_DOWNLOADS=10
ARG CHUNK_SIZE=52428800
ENV MAX_FILE_SIZE=$MAX_FILE_SIZE \
    TURNSTILE_SITE_KEY=$TURNSTILE_SITE_KEY \
    DEFAULT_TTL=$DEFAULT_TTL \
    DEFAULT_MAX_DOWNLOADS=$DEFAULT_MAX_DOWNLOADS \
    CHUNK_SIZE=$CHUNK_SIZE
RUN npm run build

# Stage 3: Production image
FROM node:24-alpine AS production

# Upgrade all Alpine packages to latest patched versions (catches zlib CVE-2026-22184 and any future OS-level CVEs)
RUN apk upgrade --no-cache

# Update npm to get patched minimatch + tar (CVE-2026-26996, CVE-2026-27903, CVE-2026-27904, CVE-2026-26960)
RUN npm install -g npm@latest

# Security: non-root user
RUN addgroup -g 1001 -S archivum && \
    adduser -u 1001 -S archivum -G archivum

WORKDIR /app

# Install production dependencies only
COPY backend/package.json backend/package-lock.json* ./backend/
RUN cd backend && npm ci --omit=dev --ignore-scripts && npm cache clean --force

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

EXPOSE 3000

ENV NODE_ENV=production
ENV STORAGE_PATH=/data/vaults

CMD ["node", "backend/dist/index.js"]

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
COPY frontend/package.json frontend/package-lock.json* ./
RUN npm ci --ignore-scripts
COPY frontend/ ./
RUN npm run build

# Stage 3: Production image
FROM node:24-alpine AS production

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

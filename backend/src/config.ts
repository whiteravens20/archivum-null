const envSchema = {
  MAX_FILE_SIZE: Number(process.env.MAX_FILE_SIZE || 104857600),
  TURNSTILE_SECRET: process.env.TURNSTILE_SECRET || '',
  // Public site key — safe to expose to the browser via /api/config
  TURNSTILE_SITE_KEY: process.env.TURNSTILE_SITE_KEY || '0x0000000000000000000000',
  TURNSTILE_ENABLED: !!process.env.TURNSTILE_SECRET && process.env.TURNSTILE_SECRET !== '0x0000000000000000000000',
  // Expected hostname in Turnstile response (e.g. 'example.com'). Leave empty to skip hostname check.
  TURNSTILE_HOSTNAME: process.env.TURNSTILE_HOSTNAME || '',
  // Upload-specific rate limit
  RATE_LIMIT_WINDOW: Number(process.env.RATE_LIMIT_WINDOW || 60),
  RATE_LIMIT_MAX: Number(process.env.RATE_LIMIT_MAX || 10),
  // General API rate limit (covers all /api/ routes incl. tos, health, vault GET)
  RATE_LIMIT_API_MAX: Number(process.env.RATE_LIMIT_API_MAX || 120),
  // Download-specific rate limit (GET /api/vault/:id/download)
  RATE_LIMIT_DOWNLOAD_MAX: Number(process.env.RATE_LIMIT_DOWNLOAD_MAX || 30),
  // Admin-specific rate limit (all /api/admin/ routes — brute-force protection)
  RATE_LIMIT_ADMIN_MAX: Number(process.env.RATE_LIMIT_ADMIN_MAX || 10),
  DEFAULT_TTL: Number(process.env.DEFAULT_TTL || 86400),
  MAX_TTL: Number(process.env.MAX_TTL || 604800),
  DEFAULT_MAX_DOWNLOADS: Number(process.env.DEFAULT_MAX_DOWNLOADS || 10),
  // Global storage quota — 0 means unlimited
  MAX_TOTAL_STORAGE: Number(process.env.MAX_TOTAL_STORAGE || 0),
  // Chunked upload — chunk size per request in bytes (default 50 MB, safe under Cloudflare's 100 MB limit)
  CHUNK_SIZE: Number(process.env.CHUNK_SIZE || 52428800),
  // How long an incomplete chunked upload session stays alive (seconds, default 30 min)
  UPLOAD_SESSION_TTL: Number(process.env.UPLOAD_SESSION_TTL || 1800),
  ADMIN_USER: process.env.ADMIN_USER || 'admin',
  ADMIN_PASSWORD: process.env.ADMIN_PASSWORD || '',
  STORAGE_PATH: process.env.STORAGE_PATH || '/data/vaults',
  BIND_ADDRESS: process.env.BIND_ADDRESS || '0.0.0.0',
  PORT: Number(process.env.PORT || 3000),
  NODE_ENV: process.env.NODE_ENV || 'development',
  // How many reverse-proxy hops to trust for X-Forwarded-For. 1 = trust nearest proxy only.
  TRUST_PROXY: Number(process.env.TRUST_PROXY ?? 1),
};

export const config = Object.freeze(envSchema);

// AES-GCM encryption overhead: 12-byte IV + 2-byte name len + name + 2-byte mime len
// + mime + 16-byte GCM tag. Worst case ≈ 800 bytes; use 1 KiB to be safe.
export const ENCRYPTION_OVERHEAD = 1024;

export function validateConfig(): void {
  if (!config.ADMIN_PASSWORD || config.ADMIN_PASSWORD === 'CHANGE_ME_IMMEDIATELY') {
    console.warn('[WARN] ADMIN_PASSWORD is not set or uses default. Admin panel will be inaccessible.');
  }
  if (!isFinite(config.MAX_FILE_SIZE) || config.MAX_FILE_SIZE <= 0) {
    throw new Error('MAX_FILE_SIZE must be a positive number');
  }
  if (!isFinite(config.RATE_LIMIT_WINDOW) || !isFinite(config.RATE_LIMIT_MAX) || !isFinite(config.RATE_LIMIT_API_MAX) || !isFinite(config.RATE_LIMIT_DOWNLOAD_MAX) || !isFinite(config.RATE_LIMIT_ADMIN_MAX)) {
    throw new Error('Rate limit values must be valid numbers');
  }
  if (config.RATE_LIMIT_WINDOW <= 0 || config.RATE_LIMIT_MAX <= 0 || config.RATE_LIMIT_API_MAX <= 0 || config.RATE_LIMIT_DOWNLOAD_MAX <= 0 || config.RATE_LIMIT_ADMIN_MAX <= 0) {
    throw new Error('Rate limit values must be positive');
  }
  if (!isFinite(config.MAX_TTL) || config.MAX_TTL <= 0) {
    throw new Error('MAX_TTL must be a positive number');
  }
  if (!isFinite(config.DEFAULT_TTL) || config.DEFAULT_TTL <= 0) {
    throw new Error('DEFAULT_TTL must be a positive number');
  }
  if (config.DEFAULT_TTL > config.MAX_TTL) {
    throw new Error('DEFAULT_TTL must not exceed MAX_TTL');
  }
  if (!isFinite(config.DEFAULT_MAX_DOWNLOADS) || config.DEFAULT_MAX_DOWNLOADS <= 0) {
    throw new Error('DEFAULT_MAX_DOWNLOADS must be a positive number');
  }
  if (!isFinite(config.CHUNK_SIZE) || config.CHUNK_SIZE <= 0) {
    throw new Error('CHUNK_SIZE must be a positive number');
  }
  if (!isFinite(config.UPLOAD_SESSION_TTL) || config.UPLOAD_SESSION_TTL <= 0) {
    throw new Error('UPLOAD_SESSION_TTL must be a positive number');
  }
  if (!isFinite(config.MAX_TOTAL_STORAGE) || config.MAX_TOTAL_STORAGE < 0) {
    throw new Error('MAX_TOTAL_STORAGE must be a non-negative number');
  }
}

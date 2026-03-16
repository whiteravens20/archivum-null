// Pre-compute CHUNK_SIZE so CRYPTO_CHUNK_SIZE can reference it in the same schema.
const _CHUNK_SIZE = Number(process.env.CHUNK_SIZE || 10485760);

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
  // Chunked upload — chunk size per HTTP request in bytes (default 10 MB, works well with homelab/tailscale/VPS setups).
  // Keep below 100 MB when using Cloudflare Tunnel (Cloudflare Free/Pro per-request limit).
  CHUNK_SIZE: _CHUNK_SIZE,
  // How long an incomplete chunked upload session stays alive (seconds, default 60 min).
  // Must be long enough for the largest allowed file on the slowest expected link.
  UPLOAD_SESSION_TTL: Number(process.env.UPLOAD_SESSION_TTL || 3600),
  // Per-chunk plaintext size for client-side AES-GCM streaming encryption.
  // Each chunk is encrypted independently with a unique IV and chunkIndex in AAD.
  // Default: min(5 MB, CHUNK_SIZE) — auto-clamped so smaller CHUNK_SIZE values don't crash.
  CRYPTO_CHUNK_SIZE: Number(process.env.CRYPTO_CHUNK_SIZE || Math.min(5242880, _CHUNK_SIZE)),
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

// Per-chunk AES-GCM overhead: 12-byte IV + 16-byte GCM authentication tag = 28 bytes per chunk.
const PER_CHUNK_OVERHEAD = 28;

/**
 * Calculate total encryption overhead for a given plaintext size.
 * Each crypto chunk adds 28 bytes (12-byte IV + 16-byte GCM tag).
 */
export function calcEncryptionOverhead(plaintextSize: number): number {
  const chunkSize = config.CRYPTO_CHUNK_SIZE;
  const numChunks = Math.max(1, Math.ceil(plaintextSize / chunkSize));
  return numChunks * PER_CHUNK_OVERHEAD;
}

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
  if (!isFinite(config.CRYPTO_CHUNK_SIZE) || config.CRYPTO_CHUNK_SIZE <= 0) {
    throw new Error('CRYPTO_CHUNK_SIZE must be a positive number');
  }
  if (!isFinite(config.UPLOAD_SESSION_TTL) || config.UPLOAD_SESSION_TTL <= 0) {
    throw new Error('UPLOAD_SESSION_TTL must be a positive number');
  }
  if (!isFinite(config.MAX_TOTAL_STORAGE) || config.MAX_TOTAL_STORAGE < 0) {
    throw new Error('MAX_TOTAL_STORAGE must be a non-negative number');
  }
  if (config.CRYPTO_CHUNK_SIZE > config.CHUNK_SIZE) {
    throw new Error('CRYPTO_CHUNK_SIZE must not exceed CHUNK_SIZE');
  }
  if (config.CHUNK_SIZE > config.MAX_FILE_SIZE) {
    throw new Error('CHUNK_SIZE must not exceed MAX_FILE_SIZE');
  }
  if (!isFinite(config.TRUST_PROXY) || config.TRUST_PROXY < 0 || config.TRUST_PROXY > 10) {
    throw new Error('TRUST_PROXY must be between 0 and 10');
  }
  // Soft warnings for rate limit tiers that will never trigger independently
  // because the general API limit (applied to ALL /api/ routes) is lower.
  if (config.RATE_LIMIT_MAX > config.RATE_LIMIT_API_MAX) {
    console.warn('[WARN] RATE_LIMIT_MAX > RATE_LIMIT_API_MAX — upload limit will never trigger (API limit fires first).');
  }
  if (config.RATE_LIMIT_DOWNLOAD_MAX > config.RATE_LIMIT_API_MAX) {
    console.warn('[WARN] RATE_LIMIT_DOWNLOAD_MAX > RATE_LIMIT_API_MAX — download limit will never trigger (API limit fires first).');
  }
  if (config.RATE_LIMIT_ADMIN_MAX > config.RATE_LIMIT_API_MAX) {
    console.warn('[WARN] RATE_LIMIT_ADMIN_MAX > RATE_LIMIT_API_MAX — admin limit will never trigger (API limit fires first).');
  }
}

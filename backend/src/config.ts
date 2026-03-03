const envSchema = {
  MAX_FILE_SIZE: Number(process.env.MAX_FILE_SIZE || 104857600),
  TURNSTILE_SECRET: process.env.TURNSTILE_SECRET || '',
  TURNSTILE_ENABLED: !!process.env.TURNSTILE_SECRET && process.env.TURNSTILE_SECRET !== '0x0000000000000000000000',
  // Expected hostname in Turnstile response (e.g. 'example.com'). Leave empty to skip hostname check.
  TURNSTILE_HOSTNAME: process.env.TURNSTILE_HOSTNAME || '',
  // Upload-specific rate limit
  RATE_LIMIT_WINDOW: Number(process.env.RATE_LIMIT_WINDOW || 60),
  RATE_LIMIT_MAX: Number(process.env.RATE_LIMIT_MAX || 10),
  // General API rate limit (covers all /api/ routes incl. tos, health, vault GET)
  RATE_LIMIT_API_MAX: Number(process.env.RATE_LIMIT_API_MAX || 120),
  DEFAULT_TTL: Number(process.env.DEFAULT_TTL || 86400),
  MAX_TTL: Number(process.env.MAX_TTL || 604800),
  DEFAULT_MAX_DOWNLOADS: Number(process.env.DEFAULT_MAX_DOWNLOADS || 10),
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

export function validateConfig(): void {
  if (!config.ADMIN_PASSWORD || config.ADMIN_PASSWORD === 'CHANGE_ME_IMMEDIATELY') {
    console.warn('[WARN] ADMIN_PASSWORD is not set or uses default. Admin panel will be inaccessible.');
  }
  if (config.MAX_FILE_SIZE <= 0) {
    throw new Error('MAX_FILE_SIZE must be positive');
  }
  if (config.RATE_LIMIT_WINDOW <= 0 || config.RATE_LIMIT_MAX <= 0 || config.RATE_LIMIT_API_MAX <= 0) {
    throw new Error('Rate limit values must be positive');
  }
}

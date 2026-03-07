import { describe, it, expect, vi, beforeEach } from 'vitest';

describe('config', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });

  it('should use default values when env vars are not set', async () => {
    vi.stubEnv('ADMIN_PASSWORD', '');
    vi.stubEnv('TURNSTILE_SECRET', '');

    // Re-import to get fresh config with new env
    const { config } = await import('../config.js');

    expect(config.PORT).toBe(3000);
    expect(config.BIND_ADDRESS).toBe('0.0.0.0');
    expect(config.RATE_LIMIT_WINDOW).toBe(60);
    expect(config.RATE_LIMIT_MAX).toBe(10);
    expect(config.RATE_LIMIT_API_MAX).toBe(120);
    expect(config.RATE_LIMIT_DOWNLOAD_MAX).toBe(30);
    expect(config.DEFAULT_TTL).toBe(86400);
    expect(config.MAX_TTL).toBe(604800);
    expect(config.DEFAULT_MAX_DOWNLOADS).toBe(10);
    expect(config.STORAGE_PATH).toBe('/data/vaults');
    expect(config.MAX_FILE_SIZE).toBe(104857600);
    expect(config.MAX_TOTAL_STORAGE).toBe(0);
    expect(config.ADMIN_USER).toBe('admin');
  });

  it('should detect turnstile as disabled without secret', async () => {
    vi.stubEnv('TURNSTILE_SECRET', '');
    const { config } = await import('../config.js');
    expect(config.TURNSTILE_ENABLED).toBe(false);
  });

  it('should detect turnstile test key as disabled', async () => {
    vi.stubEnv('TURNSTILE_SECRET', '0x0000000000000000000000');
    const { config } = await import('../config.js');
    expect(config.TURNSTILE_ENABLED).toBe(false);
  });

  it('should freeze config object', async () => {
    const { config } = await import('../config.js');
    expect(Object.isFrozen(config)).toBe(true);
  });

  it('should default TRUST_PROXY to 1', async () => {
    const { config } = await import('../config.js');
    expect(config.TRUST_PROXY).toBe(1);
  });

  it('should read TRUST_PROXY from env', async () => {
    vi.stubEnv('TRUST_PROXY', '2');
    vi.resetModules();
    const { config } = await import('../config.js');
    expect(config.TRUST_PROXY).toBe(2);
  });

  it('should default TURNSTILE_HOSTNAME to empty string', async () => {
    const { config } = await import('../config.js');
    expect(config.TURNSTILE_HOSTNAME).toBe('');
  });

  it('should default RATE_LIMIT_API_MAX to 120', async () => {
    const { config } = await import('../config.js');
    expect(config.RATE_LIMIT_API_MAX).toBe(120);
  });

  it('should default RATE_LIMIT_DOWNLOAD_MAX to 30', async () => {
    const { config } = await import('../config.js');
    expect(config.RATE_LIMIT_DOWNLOAD_MAX).toBe(30);
  });
});

describe('validateConfig', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('should warn when ADMIN_PASSWORD is not set', async () => {
    vi.stubEnv('ADMIN_PASSWORD', '');
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { validateConfig } = await import('../config.js');
    validateConfig();
    expect(warnSpy).toHaveBeenCalled();
  });

  it('should warn on CHANGE_ME_IMMEDIATELY password', async () => {
    vi.stubEnv('ADMIN_PASSWORD', 'CHANGE_ME_IMMEDIATELY');
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { validateConfig } = await import('../config.js');
    validateConfig();
    expect(warnSpy).toHaveBeenCalled();
  });

  it('should throw when MAX_TTL is zero', async () => {
    vi.stubEnv('MAX_TTL', '0');
    const { validateConfig } = await import('../config.js');
    expect(() => validateConfig()).toThrow('MAX_TTL must be positive');
  });

  it('should throw when MAX_TTL is negative', async () => {
    vi.stubEnv('MAX_TTL', '-1');
    const { validateConfig } = await import('../config.js');
    expect(() => validateConfig()).toThrow('MAX_TTL must be positive');
  });

  it('should throw when DEFAULT_TTL is zero', async () => {
    vi.stubEnv('DEFAULT_TTL', '0');
    const { validateConfig } = await import('../config.js');
    expect(() => validateConfig()).toThrow('DEFAULT_TTL must be positive');
  });

  it('should throw when DEFAULT_TTL exceeds MAX_TTL', async () => {
    vi.stubEnv('DEFAULT_TTL', '604800');
    vi.stubEnv('MAX_TTL', '86400');
    const { validateConfig } = await import('../config.js');
    expect(() => validateConfig()).toThrow('DEFAULT_TTL must not exceed MAX_TTL');
  });

  it('should throw when DEFAULT_MAX_DOWNLOADS is zero', async () => {
    vi.stubEnv('DEFAULT_MAX_DOWNLOADS', '0');
    const { validateConfig } = await import('../config.js');
    expect(() => validateConfig()).toThrow('DEFAULT_MAX_DOWNLOADS must be positive');
  });

  it('should throw when DEFAULT_MAX_DOWNLOADS is negative', async () => {
    vi.stubEnv('DEFAULT_MAX_DOWNLOADS', '-5');
    const { validateConfig } = await import('../config.js');
    expect(() => validateConfig()).toThrow('DEFAULT_MAX_DOWNLOADS must be positive');
  });

  it('should not throw when DEFAULT_TTL equals MAX_TTL', async () => {
    vi.stubEnv('DEFAULT_TTL', '86400');
    vi.stubEnv('MAX_TTL', '86400');
    vi.stubEnv('ADMIN_PASSWORD', 'secret');
    const { validateConfig } = await import('../config.js');
    expect(() => validateConfig()).not.toThrow();
  });
});

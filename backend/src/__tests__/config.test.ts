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
    expect(config.CHUNK_SIZE).toBe(10485760);
    expect(config.UPLOAD_SESSION_TTL).toBe(3600);
    expect(config.CRYPTO_CHUNK_SIZE).toBe(5242852);
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

  it('should default TRUST_PROXY to loopback', async () => {
    vi.resetModules();
    const { config } = await import('../config.js');
    expect(config.TRUST_PROXY).toEqual(['loopback']);
  });

  it('should read TRUST_PROXY from env as a trimmed list', async () => {
    vi.stubEnv('TRUST_PROXY', ' 10.8.0.1, 172.16.0.0/12 ,loopback');
    vi.resetModules();
    const { config } = await import('../config.js');
    expect(config.TRUST_PROXY).toEqual(['10.8.0.1', '172.16.0.0/12', 'loopback']);
  });

  it('should trust no proxy when TRUST_PROXY is empty', async () => {
    vi.stubEnv('TRUST_PROXY', '');
    vi.resetModules();
    const { config } = await import('../config.js');
    expect(config.TRUST_PROXY).toEqual([]);
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

  it('should default RATE_LIMIT_ADMIN_MAX to 10', async () => {
    const { config } = await import('../config.js');
    expect(config.RATE_LIMIT_ADMIN_MAX).toBe(10);
  });

  it('should default the brand name and tagline to the built-in ones', async () => {
    vi.resetModules();
    const { config } = await import('../config.js');
    expect(config.BRAND_NAME).toBe('Archivum Null');
    expect(config.BRAND_TAGLINE).toBe('Anonymous encrypted file sharing');
    expect(config.BRAND_ACCENT_COLOR).toBe('');
    expect(config.BRAND_THEME).toBe('dark');
    expect(config.BRANDING_PATH).toBe('');
  });

  it('should read the brand name and tagline from env, trimmed', async () => {
    vi.stubEnv('BRAND_NAME', '  Acme Drop ');
    vi.stubEnv('BRAND_TAGLINE', ' Files, sealed ');
    vi.resetModules();
    const { config } = await import('../config.js');
    expect(config.BRAND_NAME).toBe('Acme Drop');
    expect(config.BRAND_TAGLINE).toBe('Files, sealed');
  });

  it('should treat a blank brand name as not set', async () => {
    vi.stubEnv('BRAND_NAME', '   ');
    vi.resetModules();
    const { config } = await import('../config.js');
    expect(config.BRAND_NAME).toBe('Archivum Null');
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
    expect(() => validateConfig()).toThrow('MAX_TTL must be a positive number');
  });

  it('should throw when MAX_TTL is negative', async () => {
    vi.stubEnv('MAX_TTL', '-1');
    const { validateConfig } = await import('../config.js');
    expect(() => validateConfig()).toThrow('MAX_TTL must be a positive number');
  });

  it('should throw when DEFAULT_TTL is zero', async () => {
    vi.stubEnv('DEFAULT_TTL', '0');
    const { validateConfig } = await import('../config.js');
    expect(() => validateConfig()).toThrow('DEFAULT_TTL must be a positive number');
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
    expect(() => validateConfig()).toThrow('DEFAULT_MAX_DOWNLOADS must be a positive number');
  });

  it('should throw when DEFAULT_MAX_DOWNLOADS is negative', async () => {
    vi.stubEnv('DEFAULT_MAX_DOWNLOADS', '-5');
    const { validateConfig } = await import('../config.js');
    expect(() => validateConfig()).toThrow('DEFAULT_MAX_DOWNLOADS must be a positive number');
  });

  it('should not throw when DEFAULT_TTL equals MAX_TTL', async () => {
    vi.stubEnv('DEFAULT_TTL', '86400');
    vi.stubEnv('MAX_TTL', '86400');
    vi.stubEnv('ADMIN_PASSWORD', 'secret');
    const { validateConfig } = await import('../config.js');
    expect(() => validateConfig()).not.toThrow();
  });

  it('should throw when CRYPTO_CHUNK_SIZE exceeds CHUNK_SIZE', async () => {
    vi.stubEnv('CRYPTO_CHUNK_SIZE', '20000000');
    vi.stubEnv('CHUNK_SIZE', '10000000');
    const { validateConfig } = await import('../config.js');
    expect(() => validateConfig()).toThrow('CRYPTO_CHUNK_SIZE must not exceed CHUNK_SIZE');
  });

  it('should throw when CHUNK_SIZE exceeds MAX_FILE_SIZE', async () => {
    vi.stubEnv('CHUNK_SIZE', '200000000');
    vi.stubEnv('MAX_FILE_SIZE', '100000000');
    const { validateConfig } = await import('../config.js');
    expect(() => validateConfig()).toThrow('CHUNK_SIZE must not exceed MAX_FILE_SIZE');
  });

  it('should not throw when CRYPTO_CHUNK_SIZE equals CHUNK_SIZE', async () => {
    vi.stubEnv('CRYPTO_CHUNK_SIZE', '10000000');
    vi.stubEnv('CHUNK_SIZE', '10000000');
    vi.stubEnv('ADMIN_PASSWORD', 'secret');
    const { validateConfig } = await import('../config.js');
    expect(() => validateConfig()).not.toThrow();
  });

  it('should auto-derive CRYPTO_CHUNK_SIZE from CHUNK_SIZE when not set', async () => {
    vi.stubEnv('CHUNK_SIZE', '2000000'); // 2 MB — smaller than 5 MB default
    vi.stubEnv('CRYPTO_CHUNK_SIZE', ''); // not set
    const { config } = await import('../config.js');
    expect(config.CRYPTO_CHUNK_SIZE).toBe(2000000 - 28); // CHUNK_SIZE less one chunk's overhead
  });

  it('should default CRYPTO_CHUNK_SIZE to just under 5 MB when CHUNK_SIZE is larger', async () => {
    vi.stubEnv('CHUNK_SIZE', '50000000'); // 50 MB
    vi.stubEnv('CRYPTO_CHUNK_SIZE', ''); // not set
    const { config } = await import('../config.js');
    expect(config.CRYPTO_CHUNK_SIZE).toBe(5242880 - 28);
  });

  it('should size the default crypto chunk so that whole encrypted chunks fill a request', async () => {
    const { config } = await import('../config.js');
    const encryptedChunk = config.CRYPTO_CHUNK_SIZE + 28;
    // Two per request with the defaults, and not a byte over CHUNK_SIZE
    expect(Math.floor(config.CHUNK_SIZE / encryptedChunk)).toBe(2);
    expect(2 * encryptedChunk).toBe(config.CHUNK_SIZE);
  });

  it('should keep a CRYPTO_CHUNK_SIZE that was set explicitly', async () => {
    vi.stubEnv('CRYPTO_CHUNK_SIZE', '5242880');
    const { config } = await import('../config.js');
    expect(config.CRYPTO_CHUNK_SIZE).toBe(5242880);
  });

  it('should warn when the Turnstile secret is set without a site key', async () => {
    vi.stubEnv('ADMIN_PASSWORD', 'secret');
    vi.stubEnv('TURNSTILE_SECRET', 'a-real-secret');
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { validateConfig } = await import('../config.js');
    validateConfig();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('TURNSTILE_SECRET is set but TURNSTILE_SITE_KEY is not'),
    );
  });

  it('should warn when the Turnstile site key is set without a secret', async () => {
    vi.stubEnv('ADMIN_PASSWORD', 'secret');
    vi.stubEnv('TURNSTILE_SECRET', '');
    vi.stubEnv('TURNSTILE_SITE_KEY', 'a-real-site-key');
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { validateConfig } = await import('../config.js');
    validateConfig();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('TURNSTILE_SITE_KEY is set but TURNSTILE_SECRET is not'),
    );
  });

  it.each([
    ['both keys set', { TURNSTILE_SECRET: 'a-real-secret', TURNSTILE_SITE_KEY: 'a-real-site-key' }],
    ['neither key set', { TURNSTILE_SECRET: '', TURNSTILE_SITE_KEY: '' }],
    [
      'both left at the placeholder',
      {
        TURNSTILE_SECRET: '0x0000000000000000000000',
        TURNSTILE_SITE_KEY: '0x0000000000000000000000',
      },
    ],
  ])('should say nothing about Turnstile with %s', async (_name, env) => {
    vi.stubEnv('ADMIN_PASSWORD', 'secret');
    for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { validateConfig } = await import('../config.js');
    validateConfig();
    expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining('TURNSTILE'));
  });

  it('should warn about defaults the vault limits will override, and still start', async () => {
    vi.stubEnv('ADMIN_PASSWORD', 'secret');
    vi.stubEnv('DEFAULT_TTL', '30');
    vi.stubEnv('DEFAULT_MAX_DOWNLOADS', '5000');
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { validateConfig } = await import('../config.js');
    expect(() => validateConfig()).not.toThrow();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('DEFAULT_TTL is below 60 seconds'),
    );
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('DEFAULT_MAX_DOWNLOADS is above 1000'),
    );
  });

  it.each(['abc', '-1', '70000', '3000.5'])('should reject PORT=%s', async (port) => {
    vi.stubEnv('PORT', port);
    const { validateConfig } = await import('../config.js');
    expect(() => validateConfig()).toThrow('PORT must be an integer between 0 and 65535');
  });

  it.each(['../..', './repo', 'owner/..', 'owner/.', '.../x'])(
    'should reject UPDATE_CHECK_REPO=%s',
    async (repo) => {
      vi.stubEnv('UPDATE_CHECK_ENABLED', 'true');
      vi.stubEnv('UPDATE_CHECK_REPO', repo);
      const { validateConfig } = await import('../config.js');
      expect(() => validateConfig()).toThrow('UPDATE_CHECK_REPO must be in "owner/repo" form');
    },
  );

  it.each(['whiteravens20/archivum-null', 'some.org/my.repo', 'a/.github', '.dotfiles/repo'])(
    'should accept UPDATE_CHECK_REPO=%s',
    async (repo) => {
      vi.stubEnv('ADMIN_PASSWORD', 'secret');
      vi.stubEnv('UPDATE_CHECK_ENABLED', 'true');
      vi.stubEnv('UPDATE_CHECK_REPO', repo);
      const { validateConfig } = await import('../config.js');
      expect(() => validateConfig()).not.toThrow();
    },
  );

  it('should warn when storage is unlimited', async () => {
    vi.stubEnv('ADMIN_PASSWORD', 'secret');
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { validateConfig } = await import('../config.js');
    validateConfig();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('MAX_TOTAL_STORAGE is 0'));
  });

  it('should not warn about storage once a quota is set', async () => {
    vi.stubEnv('ADMIN_PASSWORD', 'secret');
    vi.stubEnv('MAX_TOTAL_STORAGE', '10737418240');
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { validateConfig } = await import('../config.js');
    validateConfig();
    expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining('MAX_TOTAL_STORAGE'));
  });

  it('should reject a legacy TRUST_PROXY hop count', async () => {
    vi.stubEnv('TRUST_PROXY', '1');
    const { validateConfig } = await import('../config.js');
    expect(() => validateConfig()).toThrow('TRUST_PROXY is no longer a hop count');
  });

  it.each([
    '0.0.0.0/0',
    '::/0',
    'true',
    '*',
    '10.0.0.1/33',
    'fd00::/129',
    '10.0.0.0/8/1',
    '10.0.0.0/x',
    '<proxy-ip>',
  ])('should reject TRUST_PROXY entry %s', async (entry) => {
    vi.stubEnv('TRUST_PROXY', `127.0.0.1,${entry}`);
    const { validateConfig } = await import('../config.js');
    expect(() => validateConfig()).toThrow(`TRUST_PROXY entry "${entry}"`);
  });

  it('should accept IPs, CIDR ranges and named ranges in TRUST_PROXY', async () => {
    vi.stubEnv(
      'TRUST_PROXY',
      '10.8.0.1, 172.18.0.0/16, fd00::/8, ::1, loopback, linklocal, uniquelocal',
    );
    vi.stubEnv('ADMIN_PASSWORD', 'secret');
    const { validateConfig } = await import('../config.js');
    expect(() => validateConfig()).not.toThrow();
  });

  it('should accept an empty TRUST_PROXY', async () => {
    vi.stubEnv('TRUST_PROXY', '');
    vi.stubEnv('ADMIN_PASSWORD', 'secret');
    const { validateConfig } = await import('../config.js');
    expect(() => validateConfig()).not.toThrow();
  });

  it('should warn when RATE_LIMIT_MAX exceeds RATE_LIMIT_API_MAX', async () => {
    vi.stubEnv('RATE_LIMIT_MAX', '200');
    vi.stubEnv('RATE_LIMIT_API_MAX', '100');
    vi.stubEnv('ADMIN_PASSWORD', 'secret');
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { validateConfig } = await import('../config.js');
    validateConfig();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('RATE_LIMIT_MAX > RATE_LIMIT_API_MAX'),
    );
  });

  it('should warn when RATE_LIMIT_DOWNLOAD_MAX exceeds RATE_LIMIT_API_MAX', async () => {
    vi.stubEnv('RATE_LIMIT_DOWNLOAD_MAX', '200');
    vi.stubEnv('RATE_LIMIT_API_MAX', '100');
    vi.stubEnv('ADMIN_PASSWORD', 'secret');
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { validateConfig } = await import('../config.js');
    validateConfig();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('RATE_LIMIT_DOWNLOAD_MAX > RATE_LIMIT_API_MAX'),
    );
  });
});

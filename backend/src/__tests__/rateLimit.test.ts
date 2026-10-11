/**
 * Rate-limit middleware — unit tests.
 *
 * Verifies:
 *  - Non-/api/ requests are not rate-limited
 *  - General API limit applies to all /api/ routes
 *  - Upload-specific limit applies to POST /api/vault
 *  - Download-specific limit applies to /api/vault/:id/download
 *  - Admin routes are locked after too many failed logins, and only then
 *  - Rate-limit headers are set correctly
 *  - 429 response includes Retry-After header
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';

describe('Rate-limit middleware', () => {
  let app: FastifyInstance;
  let recordAdminAuthFailure: (ip: string) => void;
  // The address app.inject() connects from
  const CLIENT = '127.0.0.1';

  beforeEach(async () => {
    vi.resetModules();

    // Stub env vars so the freshly-imported config picks them up
    vi.stubEnv('RATE_LIMIT_WINDOW', '60');
    vi.stubEnv('RATE_LIMIT_MAX', '3');           // Upload limit
    vi.stubEnv('RATE_LIMIT_API_MAX', '5');       // General API limit
    vi.stubEnv('RATE_LIMIT_DOWNLOAD_MAX', '2');  // Download limit
    vi.stubEnv('RATE_LIMIT_ADMIN_MAX', '2');     // Admin limit

    app = Fastify({ logger: false });

    const rateLimit = await import('../middleware/rateLimit.js');
    const { rateLimitPlugin } = rateLimit;
    recordAdminAuthFailure = rateLimit.recordAdminAuthFailure;
    // Call the plugin function directly (not via app.register) so the onRequest
    // hook lives in the same scope as the test routes below.
    await rateLimitPlugin(app);

    // Test routes
    app.get('/api/health', async () => ({ status: 'ok' }));
    app.post('/api/vault', async () => ({ created: true }));
    app.post('/api/vault/upload/init', async () => ({ uploadId: 'u1', chunkSize: 52428800, expiresAt: 9999 }));
    app.post('/api/vault/upload/:uploadId/chunk', async () => ({ receivedBytes: 100 }));
    app.post('/api/vault/upload/:uploadId/complete', async () => ({ vaultId: 'v1' }));
    app.get('/api/vault/test-id/download', async () => ({ data: 'ok' }));
    app.get('/api/admin/stats', async () => ({ totalVaults: 0 }));
    app.get('/not-api', async () => ({ ok: true }));

    await app.ready();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await app.close();
  });

  it('should not rate-limit non-/api/ routes', async () => {
    for (let i = 0; i < 10; i++) {
      const res = await app.inject({ method: 'GET', url: '/not-api' });
      expect(res.statusCode).toBe(200);
    }
  });

  it('should set rate-limit headers on /api/ requests', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-ratelimit-limit']).toBeDefined();
    expect(res.headers['x-ratelimit-remaining']).toBeDefined();
    expect(res.headers['x-ratelimit-reset']).toBeDefined();
  });

  it('should enforce general API limit', async () => {
    // API limit is 5
    for (let i = 0; i < 5; i++) {
      const res = await app.inject({ method: 'GET', url: '/api/health' });
      expect(res.statusCode).toBe(200);
    }

    // 6th request should be rate-limited
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(429);
    expect(res.json().error).toContain('Too many requests');
    expect(res.headers['retry-after']).toBeDefined();
  });

  it('should enforce upload-specific limit on POST /api/vault', async () => {
    // Upload limit is 3 (tighter than general API limit of 5)
    for (let i = 0; i < 3; i++) {
      const res = await app.inject({ method: 'POST', url: '/api/vault' });
      expect(res.statusCode).toBe(200);
    }

    // 4th upload should be rate-limited
    const res = await app.inject({ method: 'POST', url: '/api/vault' });
    expect(res.statusCode).toBe(429);
  });

  it('should enforce upload-specific limit on POST /api/vault/upload/init', async () => {
    // Upload limit is 3 — init counts as a new upload
    for (let i = 0; i < 3; i++) {
      const res = await app.inject({ method: 'POST', url: '/api/vault/upload/init' });
      expect(res.statusCode).toBe(200);
    }

    // 4th init should be rate-limited
    const res = await app.inject({ method: 'POST', url: '/api/vault/upload/init' });
    expect(res.statusCode).toBe(429);
  });

  it('should NOT apply upload-specific limit to chunk and complete requests', async () => {
    // Exhaust the upload limit with init requests
    for (let i = 0; i < 3; i++) {
      await app.inject({ method: 'POST', url: '/api/vault/upload/init' });
    }

    // chunk and complete are NOT counted in upload tier — must still go through
    // (general API limit is 5; we've used 3 so far, leaving 2 more)
    const chunkRes = await app.inject({ method: 'POST', url: '/api/vault/upload/u1/chunk' });
    expect(chunkRes.statusCode).toBe(200);

    const completeRes = await app.inject({ method: 'POST', url: '/api/vault/upload/u1/complete' });
    expect(completeRes.statusCode).toBe(200);
  });

  it('should enforce download-specific limit on GET /api/vault/:id/download', async () => {
    // Download limit is 2
    for (let i = 0; i < 2; i++) {
      const res = await app.inject({ method: 'GET', url: '/api/vault/test-id/download' });
      expect(res.statusCode).toBe(200);
    }

    // 3rd download should be rate-limited
    const res = await app.inject({ method: 'GET', url: '/api/vault/test-id/download' });
    expect(res.statusCode).toBe(429);
  });

  it('should count every method in the download tier, not only GET', async () => {
    // Download limit is 2, general limit is 5. A HEAD on the download path must run
    // out with the stricter of the two.
    for (let i = 0; i < 2; i++) {
      const res = await app.inject({ method: 'HEAD', url: '/api/vault/test-id/download' });
      expect(res.statusCode).toBe(200);
    }

    const res = await app.inject({ method: 'HEAD', url: '/api/vault/test-id/download' });
    expect(res.statusCode).toBe(429);
  });

  it('should not let a query string bypass the download tier', async () => {
    // Download limit is 2. Appending a query string must NOT drop the request to
    // the looser general tier — the stricter download limit still applies.
    for (let i = 0; i < 2; i++) {
      const res = await app.inject({ method: 'GET', url: '/api/vault/test-id/download?x=' + i });
      expect(res.statusCode).toBe(200);
    }

    const res = await app.inject({ method: 'GET', url: '/api/vault/test-id/download?x=3' });
    expect(res.statusCode).toBe(429);
  });

  it('should not let a query string bypass the upload tier', async () => {
    // Upload limit is 3. A trailing query string must not evade it.
    for (let i = 0; i < 3; i++) {
      const res = await app.inject({ method: 'POST', url: '/api/vault?x=' + i });
      expect(res.statusCode).toBe(200);
    }

    const res = await app.inject({ method: 'POST', url: '/api/vault?x=4' });
    expect(res.statusCode).toBe(429);
  });

  it('should include retryAfter in 429 response body', async () => {
    // Exhaust general limit
    for (let i = 0; i < 5; i++) {
      await app.inject({ method: 'GET', url: '/api/health' });
    }

    const res = await app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(429);
    const body = res.json();
    expect(body).toHaveProperty('retryAfter');
    expect(body.retryAfter).toBeGreaterThan(0);
  });

  it('should not count admin requests that are not failed logins', async () => {
    // Admin limit is 2, general limit is 5. A signed-in panel polls far more often
    // than twice a minute; only the general limit may stop it.
    for (let i = 0; i < 5; i++) {
      const res = await app.inject({ method: 'GET', url: '/api/admin/stats' });
      expect(res.statusCode).toBe(200);
    }
  });

  it('should lock admin routes for a client once its failed logins reach the limit', async () => {
    recordAdminAuthFailure(CLIENT);
    expect((await app.inject({ method: 'GET', url: '/api/admin/stats' })).statusCode).toBe(200);

    recordAdminAuthFailure(CLIENT);
    const res = await app.inject({ method: 'GET', url: '/api/admin/stats' });
    expect(res.statusCode).toBe(429);
    expect(res.json().error).toContain('failed login attempts');
    expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
    expect(res.json().retryAfter).toBeGreaterThan(0);
  });

  it('should not lock a client out for the failed logins of another', async () => {
    recordAdminAuthFailure('203.0.113.50');
    recordAdminAuthFailure('203.0.113.50');

    const res = await app.inject({ method: 'GET', url: '/api/admin/stats' });
    expect(res.statusCode).toBe(200);
  });

  it('should lift the lockout when the window ends', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      recordAdminAuthFailure(CLIENT);
      recordAdminAuthFailure(CLIENT);
      expect((await app.inject({ method: 'GET', url: '/api/admin/stats' })).statusCode).toBe(429);

      // The window is 60 s
      vi.setSystemTime(Date.now() + 61_000);
      expect((await app.inject({ method: 'GET', url: '/api/admin/stats' })).statusCode).toBe(200);
    } finally {
      vi.useRealTimers();
    }
  });

  it('should not affect non-admin routes with admin rate limit', async () => {
    // Lock the admin routes for this client
    recordAdminAuthFailure(CLIENT);
    recordAdminAuthFailure(CLIENT);
    expect((await app.inject({ method: 'GET', url: '/api/admin/stats' })).statusCode).toBe(429);

    // Non-admin API route should still work (general limit not yet exhausted)
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
  });

  it('should share one bucket across IPv6 addresses in the same /64', async () => {
    const download = (remoteAddress: string) =>
      app.inject({ method: 'GET', url: '/api/vault/test-id/download', remoteAddress });

    expect((await download('2001:db8:1:2::1')).statusCode).toBe(200);
    expect((await download('2001:db8:1:2::2')).statusCode).toBe(200);
    expect((await download('2001:db8:1:2:ffff::3')).statusCode).toBe(429);
    expect((await download('2001:db8:1:3::1')).statusCode).toBe(200);
  });
});

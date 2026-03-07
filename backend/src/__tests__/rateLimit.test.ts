/**
 * Rate-limit middleware — unit tests.
 *
 * Verifies:
 *  - Non-/api/ requests are not rate-limited
 *  - General API limit applies to all /api/ routes
 *  - Upload-specific limit applies to POST /api/vault
 *  - Download-specific limit applies to GET /api/vault/:id/download
 *  - Rate-limit headers are set correctly
 *  - 429 response includes Retry-After header
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';

describe('Rate-limit middleware', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.resetModules();

    // Stub env vars so the freshly-imported config picks them up
    vi.stubEnv('RATE_LIMIT_WINDOW', '60');
    vi.stubEnv('RATE_LIMIT_MAX', '3');           // Upload limit
    vi.stubEnv('RATE_LIMIT_API_MAX', '5');       // General API limit
    vi.stubEnv('RATE_LIMIT_DOWNLOAD_MAX', '2');  // Download limit

    app = Fastify({ logger: false });

    const { rateLimitPlugin } = await import('../middleware/rateLimit.js');
    // Call the plugin function directly (not via app.register) so the onRequest
    // hook lives in the same scope as the test routes below.
    await rateLimitPlugin(app);

    // Test routes
    app.get('/api/health', async () => ({ status: 'ok' }));
    app.post('/api/vault', async () => ({ created: true }));
    app.get('/api/vault/test-id/download', async () => ({ data: 'ok' }));
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
});

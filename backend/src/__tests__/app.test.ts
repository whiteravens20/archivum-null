/**
 * Application-wiring integration tests.
 *
 * These build the app via `buildApp()` — the EXACT wiring the production server
 * uses — and assert that rate limiting is actually active end-to-end.
 *
 * Regression guard: rate limiting was previously wired with
 * `app.register(rateLimitPlugin)`, which encapsulated its global `onRequest`
 * hook in a child context so it never ran for the sibling-registered routes.
 * All rate limiting was silently disabled in production while the middleware's
 * own unit tests (which call the plugin in-scope) stayed green. A test that goes
 * through `buildApp()` is the only thing that catches that class of bug.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

describe('buildApp wiring — rate limiting is active end-to-end', () => {
  let app: FastifyInstance;
  let storageDir: string;

  beforeEach(async () => {
    vi.resetModules();

    storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'archivum-app-test-'));

    // Non-production so the dev pino-pretty transport is skipped and we don't
    // depend on a real proxy/CORS origin; rate-limit behaviour is independent.
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('STORAGE_PATH', storageDir);
    vi.stubEnv('RATE_LIMIT_WINDOW', '60');
    vi.stubEnv('RATE_LIMIT_API_MAX', '5');
    vi.stubEnv('RATE_LIMIT_ADMIN_MAX', '2');
    // Enable the admin panel so wrong/missing creds return 401 (a real
    // brute-force attempt) rather than the 403 "disabled" path.
    vi.stubEnv('ADMIN_PASSWORD', 'strong-test-password');

    const { buildApp } = await import('../app.js');
    app = await buildApp();
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    vi.unstubAllEnvs();
    fs.rmSync(storageDir, { recursive: true, force: true });
  });

  it('sets X-RateLimit-* headers on a real /api/ route (hook is global)', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
    // These were absent in production when the hook was encapsulated.
    expect(res.headers['x-ratelimit-limit']).toBeDefined();
    expect(res.headers['x-ratelimit-remaining']).toBeDefined();
    expect(res.headers['x-ratelimit-reset']).toBeDefined();
  });

  it('enforces the general API limit on real routes (429)', async () => {
    for (let i = 0; i < 5; i++) {
      const res = await app.inject({ method: 'GET', url: '/api/health' });
      expect(res.statusCode).toBe(200);
    }
    const limited = await app.inject({ method: 'GET', url: '/api/health' });
    expect(limited.statusCode).toBe(429);
    expect(limited.headers['retry-after']).toBeDefined();
  });

  it('enforces the admin brute-force limit before auth (429)', async () => {
    // The rate-limit onRequest hook runs before the basicAuth preHandler, so
    // unauthenticated requests still count toward the strict admin tier (2).
    for (let i = 0; i < 2; i++) {
      const res = await app.inject({ method: 'DELETE', url: '/api/admin/vaults/x' });
      expect(res.statusCode).toBe(401);
    }
    const limited = await app.inject({ method: 'DELETE', url: '/api/admin/vaults/x' });
    expect(limited.statusCode).toBe(429);
  });
});

/**
 * Regression guard for GHSA-3m5p-2c4r-xxw2: `request.ip` — and with it every per-IP
 * rate-limit bucket — may only come from X-Forwarded-For when the connecting peer is
 * a configured proxy. Observed through rate limiting (limit 1): a distinct client IP
 * gets a fresh bucket, the same IP does not.
 */
describe('buildApp wiring — client IP resolution behind TRUST_PROXY', () => {
  const PROXY = '10.8.0.2';
  let app: FastifyInstance;
  let storageDir: string;

  const get = (remoteAddress: string, forwardedFor: string) =>
    app.inject({
      method: 'GET',
      url: '/api/health',
      remoteAddress,
      headers: { 'x-forwarded-for': forwardedFor },
    });

  beforeEach(async () => {
    vi.resetModules();
    storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'archivum-app-test-'));
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('STORAGE_PATH', storageDir);
    vi.stubEnv('RATE_LIMIT_API_MAX', '1');
    vi.stubEnv('TRUST_PROXY', PROXY);

    const { buildApp } = await import('../app.js');
    app = await buildApp();
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    vi.unstubAllEnvs();
    fs.rmSync(storageDir, { recursive: true, force: true });
  });

  it('keys clients by X-Forwarded-For when the peer is a trusted proxy', async () => {
    expect((await get(PROXY, '203.0.113.1')).statusCode).toBe(200);
    expect((await get(PROXY, '203.0.113.2')).statusCode).toBe(200);
    expect((await get(PROXY, '203.0.113.1')).statusCode).toBe(429);
  });

  it('ignores X-Forwarded-For from an untrusted peer', async () => {
    expect((await get('198.51.100.7', '203.0.113.1')).statusCode).toBe(200);
    // A spoofed header must not buy the direct client a fresh bucket.
    expect((await get('198.51.100.7', '203.0.113.2')).statusCode).toBe(429);
  });
});

describe('request log serializer', () => {
  it('leaves the client address and port out of request logs', async () => {
    const { serializeRequest } = await import('../app.js');
    const logged = serializeRequest({
      method: 'GET',
      url: '/api/health',
      host: 'example.com',
      ip: '203.0.113.1',
      socket: { remotePort: 51234 },
    } as unknown as FastifyRequest);
    expect(logged).toEqual({ method: 'GET', url: '/api/health', host: 'example.com' });
  });
});

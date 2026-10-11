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

  it('refuses even the right password while the client is locked out', async () => {
    const wrong = { authorization: `Basic ${Buffer.from('admin:guess').toString('base64')}` };
    const right = { authorization: `Basic ${Buffer.from('admin:strong-test-password').toString('base64')}` };

    for (let i = 0; i < 2; i++) {
      const res = await app.inject({ method: 'GET', url: '/api/admin/stats', headers: wrong });
      expect(res.statusCode).toBe(401);
    }

    const locked = await app.inject({ method: 'GET', url: '/api/admin/stats', headers: right });
    expect(locked.statusCode).toBe(429);
    expect(locked.json().error).toContain('failed login attempts');
  });

  it('lets a signed-in admin poll past the admin limit', async () => {
    // Admin limit is 2: the panel alone makes more requests than that in ten seconds.
    // Only the general limit (5) applies to requests that carry valid credentials.
    const right = { authorization: `Basic ${Buffer.from('admin:strong-test-password').toString('base64')}` };

    for (let i = 0; i < 5; i++) {
      const res = await app.inject({ method: 'GET', url: '/api/admin/stats', headers: right });
      expect(res.statusCode).toBe(200);
    }
    const general = await app.inject({ method: 'GET', url: '/api/admin/stats', headers: right });
    expect(general.statusCode).toBe(429);
    expect(general.json().error).toContain('Too many requests');
  });
});

describe('buildApp wiring — request body limits', () => {
  let app: FastifyInstance;
  let storageDir: string;
  const boundary = '----BodyLimitBoundary';

  function multipart(fields: Record<string, string>, file: Buffer): Buffer {
    const head = Object.entries(fields)
      .map(([name, value]) => `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`)
      .join('');
    return Buffer.concat([
      Buffer.from(`${head}--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="f.bin"\r\nContent-Type: application/octet-stream\r\n\r\n`),
      file,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
  }

  beforeEach(async () => {
    vi.resetModules();
    storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'archivum-app-test-'));
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('STORAGE_PATH', storageDir);
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

  it('refuses a JSON body far larger than anything this API takes', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/vault/upload/init',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ totalSize: 200, padding: 'x'.repeat(100_000) }),
    });

    expect(res.statusCode).toBe(413);
  });

  it('still takes an upload far larger than the default limit', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/vault',
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: multipart({ ttl: '3600', maxDownloads: '1' }, Buffer.alloc(300_000, 7)),
    });

    expect(res.statusCode).toBe(201);
    expect(res.json().ciphertextSize).toBe(300_000);
  });

  it('still takes a chunk far larger than the default limit', async () => {
    const init = await app.inject({
      method: 'POST',
      url: '/api/vault/upload/init',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ totalSize: 300_000, ttl: 3600, maxDownloads: 1 }),
    });
    expect(init.statusCode).toBe(201);
    const { uploadId, sessionToken } = init.json();

    const chunk = await app.inject({
      method: 'POST',
      url: `/api/vault/upload/${uploadId}/chunk`,
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}`, 'x-session-token': sessionToken },
      payload: multipart({ chunkIndex: '0' }, Buffer.alloc(300_000, 7)),
    });

    expect(chunk.statusCode).toBe(200);
    expect(chunk.json().receivedBytes).toBe(300_000);
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
  it('leaves the client address, port and raw URL out of request logs', async () => {
    const { serializeRequest } = await import('../app.js');
    const logged = serializeRequest({
      method: 'GET',
      url: '/api/vault/abc123/download',
      routeOptions: { url: '/api/vault/:vaultId/download' },
      host: 'example.com',
      ip: '203.0.113.1',
      socket: { remotePort: 51234 },
    } as unknown as FastifyRequest);
    expect(logged).toEqual({ method: 'GET', route: '/api/vault/:vaultId/download', host: 'example.com' });
  });
});

/**
 * Vault routes — integration tests.
 *
 * Verifies:
 *  - POST /api/vault: success, missing file, 413, 507, 500 errors
 *  - GET /api/vault/:vaultId: found, not found
 *  - GET /api/vault/:vaultId/download: found (headers, streaming), not found
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify from 'fastify';
import multipart from '@fastify/multipart';
import type { FastifyInstance } from 'fastify';
import { Readable } from 'node:stream';

function makeMockVaultManager() {
  return {
    createVault: vi.fn(async () => ({
      vaultId: 'abc123',
      expiresAt: 9999999999,
      maxDownloads: 5,
      ciphertextSize: 42,
    })),
    getVault: vi.fn((id: string) => {
      if (id === 'abc123') {
        return {
          vaultId: 'abc123',
          ciphertextSize: 42,
          createdAt: 1000000,
          expiresAt: 9999999999,
          remainingDownloads: 3,
        };
      }
      return undefined;
    }),
    consumeDownload: vi.fn(async (id: string) => {
      if (id === 'abc123') {
        return {
          stream: Readable.from(Buffer.from('encrypted-data')),
          meta: { ciphertextSize: 14 },
        };
      }
      return null;
    }),
  };
}

/** Build a valid multipart/form-data Buffer with proper CRLF boundaries. */
function buildMultipart(
  boundary: string,
  fields: Record<string, string>,
  file?: { name: string; content: Buffer }
): Buffer {
  const parts: Buffer[] = [];
  const CRLF = '\r\n';

  for (const [name, value] of Object.entries(fields)) {
    parts.push(Buffer.from(
      `--${boundary}${CRLF}` +
      `Content-Disposition: form-data; name="${name}"${CRLF}${CRLF}` +
      `${value}${CRLF}`
    ));
  }

  if (file) {
    parts.push(Buffer.from(
      `--${boundary}${CRLF}` +
      `Content-Disposition: form-data; name="file"; filename="${file.name}"${CRLF}` +
      `Content-Type: application/octet-stream${CRLF}${CRLF}`
    ));
    parts.push(file.content);
    parts.push(Buffer.from(CRLF));
  }

  parts.push(Buffer.from(`--${boundary}--${CRLF}`));
  return Buffer.concat(parts);
}

describe('Vault routes', () => {
  let app: FastifyInstance;
  let mockManager: ReturnType<typeof makeMockVaultManager>;
  const boundary = '----TestBoundary123';

  beforeEach(async () => {
    vi.resetModules();

    // Disable turnstile so the preHandler passes immediately
    vi.stubEnv('TURNSTILE_SECRET', '');

    mockManager = makeMockVaultManager();
    vi.doMock('../vault/manager.js', () => ({ vaultManager: mockManager }));

    app = Fastify({ logger: false });
    await app.register(multipart);

    const { vaultRoutes } = await import('../routes/vault.js');
    await app.register(vaultRoutes);
    await app.ready();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await app.close();
  });

  // ------------------------------------------------------------------
  // POST /api/vault
  // ------------------------------------------------------------------

  it('POST /api/vault returns 201 on successful upload', async () => {
    const payload = buildMultipart(boundary,
      { ttl: '3600', maxDownloads: '5' },
      { name: 'encrypted.bin', content: Buffer.from('encrypted-content') }
    );

    const res = await app.inject({
      method: 'POST',
      url: '/api/vault',
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload,
    });

    expect(res.statusCode).toBe(201);
    const json = res.json();
    expect(json).toHaveProperty('vaultId', 'abc123');
    expect(json).toHaveProperty('expiresAt');
    expect(json).toHaveProperty('maxDownloads');
    expect(json).toHaveProperty('ciphertextSize');
    expect(mockManager.createVault).toHaveBeenCalledOnce();
  });

  it('POST /api/vault returns 413 when createVault throws statusCode 413', async () => {
    mockManager.createVault.mockRejectedValueOnce(
      Object.assign(new Error('File too large'), { statusCode: 413 })
    );

    const payload = buildMultipart(boundary, {},
      { name: 'big.bin', content: Buffer.from('x'.repeat(100)) }
    );

    const res = await app.inject({
      method: 'POST',
      url: '/api/vault',
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload,
    });

    expect(res.statusCode).toBe(413);
    expect(res.json()).toHaveProperty('error');
  });

  it('POST /api/vault returns 507 when createVault throws statusCode 507', async () => {
    mockManager.createVault.mockRejectedValueOnce(
      Object.assign(new Error('Storage quota exceeded'), { statusCode: 507 })
    );

    const payload = buildMultipart(boundary, {},
      { name: 'data.bin', content: Buffer.from('some-data') }
    );

    const res = await app.inject({
      method: 'POST',
      url: '/api/vault',
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload,
    });

    expect(res.statusCode).toBe(507);
    expect(res.json().error).toContain('quota');
  });

  it('POST /api/vault returns 500 on unexpected error', async () => {
    mockManager.createVault.mockRejectedValueOnce(new Error('disk failure'));

    const payload = buildMultipart(boundary, {},
      { name: 'data.bin', content: Buffer.from('some-data') }
    );

    const res = await app.inject({
      method: 'POST',
      url: '/api/vault',
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload,
    });

    expect(res.statusCode).toBe(500);
    expect(res.json().error).toBe('Internal server error');
  });

  it('POST /api/vault uses default TTL and maxDownloads when fields are missing', async () => {
    const payload = buildMultipart(boundary, {},
      { name: 'file.bin', content: Buffer.from('content') }
    );

    const res = await app.inject({
      method: 'POST',
      url: '/api/vault',
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload,
    });

    expect(res.statusCode).toBe(201);
    // createVault should be called with default config values
    expect(mockManager.createVault).toHaveBeenCalledWith(
      expect.anything(),
      86400,  // DEFAULT_TTL
      10      // DEFAULT_MAX_DOWNLOADS
    );
  });

  // ------------------------------------------------------------------
  // GET /api/vault/:vaultId
  // ------------------------------------------------------------------

  it('GET /api/vault/:vaultId returns vault info', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/vault/abc123',
    });

    expect(res.statusCode).toBe(200);
    const json = res.json();
    expect(json).toHaveProperty('vaultId', 'abc123');
    expect(json).toHaveProperty('ciphertextSize');
    expect(json).toHaveProperty('createdAt');
    expect(json).toHaveProperty('expiresAt');
    expect(json).toHaveProperty('remainingDownloads');
  });

  it('GET /api/vault/:vaultId returns 404 for unknown vault', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/vault/nonexistent',
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().error).toContain('not found');
  });

  // ------------------------------------------------------------------
  // GET /api/vault/:vaultId/download
  // ------------------------------------------------------------------

  it('GET /api/vault/:vaultId/download streams encrypted content', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/vault/abc123/download',
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/octet-stream');
    expect(res.headers['content-disposition']).toContain('encrypted.bin');
    expect(res.headers['cache-control']).toContain('no-store');
    expect(res.headers['pragma']).toBe('no-cache');
    expect(res.body).toBe('encrypted-data');
  });

  it('GET /api/vault/:vaultId/download returns 404 for unknown vault', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/vault/nonexistent/download',
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().error).toContain('not found');
  });
});

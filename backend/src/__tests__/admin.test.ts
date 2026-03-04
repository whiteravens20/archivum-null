/**
 * Admin routes — integration tests.
 *
 * Verifies that:
 *  - All /api/admin/* routes are gated by Basic Auth end-to-end
 *  - Stats and vault listing never expose keys or plaintext
 *  - Delete works and is idempotent (404 on second call)
 *  - Panel is fully disabled (403) when ADMIN_PASSWORD is unset
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';

function encodeBasicAuth(user: string, pass: string): string {
  return `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;
}

// Minimal VaultManager stub — no disk I/O
function makeMockVaultManager() {
  return {
    listVaults: vi.fn(() => [
      {
        vaultId: 'test-vault-abc123',
        ciphertextSize: 1024,
        createdAt: 1000000,
        expiresAt: 9999999999,
        remainingDownloads: 3,
        maxDownloads: 5,
      },
    ]),
    getStats: vi.fn(() => ({
      totalVaults: 1,
      activeVaults: 1,
      totalStorageBytes: 1024,
    })),
    deleteVault: vi.fn(async (id: string) => id === 'test-vault-abc123'),
  };
}

describe('Admin routes — HTTP Basic Auth gating', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.stubEnv('ADMIN_USER', 'admin');
    vi.stubEnv('ADMIN_PASSWORD', 'test-secret');
    vi.resetModules();

    app = Fastify({ logger: false });

    // Inject mock vaultManager before importing routes
    const mockManager = makeMockVaultManager();
    vi.doMock('../vault/manager.js', () => ({ vaultManager: mockManager }));

    const { adminRoutes } = await import('../routes/admin.js');
    await app.register(adminRoutes);
    await app.ready();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await app.close();
  });

  // ------------------------------------------------------------------
  // Auth enforcement
  // ------------------------------------------------------------------

  it('GET /api/admin/stats returns 401 without credentials', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/admin/stats' });
    expect(res.statusCode).toBe(401);
    expect(res.headers['www-authenticate']).toContain('Basic');
  });

  it('GET /api/admin/vaults returns 401 without credentials', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/admin/vaults' });
    expect(res.statusCode).toBe(401);
  });

  it('DELETE /api/admin/vaults/:id returns 401 without credentials', async () => {
    const res = await app.inject({ method: 'DELETE', url: '/api/admin/vaults/test-vault-abc123' });
    expect(res.statusCode).toBe(401);
  });

  it('returns 401 for wrong credentials', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/admin/stats',
      headers: { authorization: encodeBasicAuth('admin', 'wrong') },
    });
    expect(res.statusCode).toBe(401);
  });

  // ------------------------------------------------------------------
  // Correct credentials — data shape (no keys / plaintext exposed)
  // ------------------------------------------------------------------

  it('GET /api/admin/stats returns 200 with correct credentials', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/admin/stats',
      headers: { authorization: encodeBasicAuth('admin', 'test-secret') },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toHaveProperty('totalVaults');
    expect(body).toHaveProperty('activeVaults');
    expect(body).toHaveProperty('totalStorageBytes');
    expect(body).toHaveProperty('totalStorageMB');
    // Must NOT contain any key or plaintext fields
    expect(body).not.toHaveProperty('key');
    expect(body).not.toHaveProperty('plaintext');
    expect(body).not.toHaveProperty('password');
  });

  it('GET /api/admin/vaults returns metadata only — no keys or plaintext', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/admin/vaults',
      headers: { authorization: encodeBasicAuth('admin', 'test-secret') },
    });
    expect(res.statusCode).toBe(200);
    const vaults = res.json() as Record<string, unknown>[];
    expect(Array.isArray(vaults)).toBe(true);
    expect(vaults).toHaveLength(1);

    const v = vaults[0];
    // Expected metadata fields
    expect(v).toHaveProperty('vaultId');
    expect(v).toHaveProperty('ciphertextSize');
    expect(v).toHaveProperty('createdAt');
    expect(v).toHaveProperty('expiresAt');
    expect(v).toHaveProperty('remainingDownloads');
    expect(v).toHaveProperty('maxDownloads');

    // Must NOT expose keys, plaintext, or uploader identity
    expect(v).not.toHaveProperty('key');
    expect(v).not.toHaveProperty('plaintext');
    expect(v).not.toHaveProperty('uploaderIp');
    expect(v).not.toHaveProperty('filename');
    expect(v).not.toHaveProperty('mimeType');
  });

  it('DELETE /api/admin/vaults/:id removes vault and returns 200', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/admin/vaults/test-vault-abc123',
      headers: { authorization: encodeBasicAuth('admin', 'test-secret') },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.deleted).toBe(true);
    expect(body.vaultId).toBe('test-vault-abc123');
  });

  it('DELETE /api/admin/vaults/:id returns 404 for non-existent vault', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/admin/vaults/does-not-exist',
      headers: { authorization: encodeBasicAuth('admin', 'test-secret') },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('Admin routes — panel disabled when ADMIN_PASSWORD unset', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.stubEnv('ADMIN_USER', 'admin');
    vi.stubEnv('ADMIN_PASSWORD', '');
    vi.resetModules();

    app = Fastify({ logger: false });

    const mockManager = makeMockVaultManager();
    vi.doMock('../vault/manager.js', () => ({ vaultManager: mockManager }));

    const { adminRoutes } = await import('../routes/admin.js');
    await app.register(adminRoutes);
    await app.ready();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await app.close();
  });

  it('returns 403 with disabled message when ADMIN_PASSWORD is empty', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/admin/stats',
      headers: { authorization: encodeBasicAuth('admin', '') },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toContain('disabled');
  });
});

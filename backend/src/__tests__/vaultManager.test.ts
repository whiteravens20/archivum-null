/**
 * VaultManager tests — focus on correctness of the download counter under
 * concurrent access and the early size-enforcement path.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Readable } from 'node:stream';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type { VaultManager as VaultManagerType } from '../vault/manager.js';

// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------

function makeStream(data: string): Readable {
  return Readable.from(Buffer.from(data));
}

// ------------------------------------------------------------------
// Tests
// ------------------------------------------------------------------

describe('VaultManager — download counter atomicity', () => {
  let tempDir: string;
  // Fresh manager instance per test (avoids singleton bleed-over)
  let manager: VaultManagerType;

  beforeEach(async () => {
    tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'arch-manager-test-'));

    // Stub the config so the manager uses our temp directory and sensible limits
    vi.stubEnv('STORAGE_PATH', tempDir);
    vi.stubEnv('MAX_FILE_SIZE', String(10 * 1024 * 1024));
    vi.stubEnv('MAX_TTL', '604800');

    vi.resetModules(); // ensures LocalStorage picks up the new STORAGE_PATH
    const mod = await import('../vault/manager.js');
    manager = new mod.VaultManager();
    await manager.init();
  });

  afterEach(async () => {
    await manager.shutdown();
    vi.unstubAllEnvs();
    await fsp.rm(tempDir, { recursive: true, force: true });
  });

  // ------------------------------------------------------------------
  // Risk 1: atomicity — concurrent requests must not bypass maxDownloads
  // ------------------------------------------------------------------

  it('allows exactly maxDownloads=1 concurrent download (single winner)', async () => {
    const vault = await manager.createVault(makeStream('secret-payload'), 3600, 1);

    // Fire 5 concurrent download requests — Node's event loop is cooperative
    // so only the first synchronously-checked getVault() wins.
    const results = await Promise.all(
      Array.from({ length: 5 }, () => manager.consumeDownload(vault.vaultId))
    );

    const successes = results.filter(Boolean);
    expect(successes).toHaveLength(1);

    // Drain the stream so file handles are released
    for (const r of successes) {
      for await (const _ of r!.stream) { /* drain */ }
    }
  });

  it('allows exactly N successful downloads for maxDownloads=N', async () => {
    const N = 3;
    const vault = await manager.createVault(makeStream('payload'), 3600, N);

    const results = await Promise.all(
      Array.from({ length: N + 2 }, () => manager.consumeDownload(vault.vaultId))
    );

    const successes = results.filter(Boolean);
    expect(successes).toHaveLength(N);

    for (const r of successes) {
      for await (const _ of r!.stream) { /* drain */ }
    }
  });

  it('returns null for unknown vault ID', async () => {
    const result = await manager.consumeDownload('no-such-vault-id-xyz');
    expect(result).toBeNull();
  });

  it('returns null after vault is explicitly deleted', async () => {
    const vault = await manager.createVault(makeStream('data'), 3600, 5);
    await manager.deleteVault(vault.vaultId);
    const result = await manager.consumeDownload(vault.vaultId);
    expect(result).toBeNull();
  });

  // ------------------------------------------------------------------
  // Risk 4: vault is cleaned up when underlying file is missing; the
  // download slot is intentionally consumed (acceptable trade-off —
  // see comment in consumeDownload for the atomicity rationale).
  // ------------------------------------------------------------------

  it('deletes vault and returns null when underlying file is missing', async () => {
    const vault = await manager.createVault(makeStream('data'), 3600, 5);

    // Simulate storage corruption by removing the data file directly
    const dataFile = path.join(tempDir, vault.vaultId, 'data.enc');
    await fsp.rm(dataFile, { force: true });

    const result = await manager.consumeDownload(vault.vaultId);

    // Must return null and the vault must be gone
    expect(result).toBeNull();
    expect(manager.getVault(vault.vaultId)).toBeUndefined();
  });

  // ------------------------------------------------------------------
  // Risk 2: file size enforced during streaming (not after full write)
  // ------------------------------------------------------------------

  it('rejects vault creation when ciphertext exceeds MAX_FILE_SIZE', async () => {
    // Temporarily stub a very small limit for this test
    vi.resetModules();
    vi.stubEnv('MAX_FILE_SIZE', '10'); // 10 bytes
    const mod = await import('../vault/manager.js');
    const smallManager = new mod.VaultManager();
    await smallManager.init();

    const bigData = 'x'.repeat(2000); // 2000 bytes > 10 + calcEncryptionOverhead(10) = 38
    await expect(
      smallManager.createVault(makeStream(bigData), 3600, 1)
    ).rejects.toThrow();

    await smallManager.shutdown();

    // Vault directory must NOT be left behind after the failed write
    const entries = await fsp.readdir(tempDir).catch(() => []);
    expect(entries).toHaveLength(0);
  });

  // ------------------------------------------------------------------
  // Global storage quota enforcement
  // ------------------------------------------------------------------

  it('rejects vault creation when global storage quota is exceeded', async () => {
    vi.resetModules();
    // Set a tiny quota (30 bytes) so a second upload is rejected
    vi.stubEnv('MAX_TOTAL_STORAGE', '30');
    vi.stubEnv('STORAGE_PATH', tempDir);
    vi.stubEnv('MAX_FILE_SIZE', String(10 * 1024 * 1024));
    vi.stubEnv('MAX_TTL', '604800');
    const mod = await import('../vault/manager.js');
    const quotaManager = new mod.VaultManager();
    await quotaManager.init();

    // First upload: 40 bytes — exceeds the 30-byte quota check on next upload
    await quotaManager.createVault(makeStream('a'.repeat(40)), 3600, 5);

    // Second upload: total is now 40 >= 30 quota, so this must be rejected
    await expect(
      quotaManager.createVault(makeStream('b'.repeat(10)), 3600, 5)
    ).rejects.toThrow(/Storage quota exceeded/);

    await quotaManager.shutdown();
  });

  it('allows uploads when MAX_TOTAL_STORAGE is 0 (unlimited)', async () => {
    vi.resetModules();
    vi.stubEnv('MAX_TOTAL_STORAGE', '0');
    vi.stubEnv('STORAGE_PATH', tempDir);
    vi.stubEnv('MAX_FILE_SIZE', String(10 * 1024 * 1024));
    vi.stubEnv('MAX_TTL', '604800');
    const mod = await import('../vault/manager.js');
    const unlimitedManager = new mod.VaultManager();
    await unlimitedManager.init();

    // Should succeed regardless of size
    const vault = await unlimitedManager.createVault(makeStream('x'.repeat(1000)), 3600, 5);
    expect(vault.vaultId).toBeDefined();

    await unlimitedManager.shutdown();
  });

  // ------------------------------------------------------------------
  // Chunked upload protocol
  // ------------------------------------------------------------------

  it('completes a chunked upload with multiple chunks', async () => {
    const session = manager.initChunkedUpload(100, 3600, 5);
    expect(session.uploadId).toBeDefined();
    expect(session.receivedBytes).toBe(0);

    // Send two chunks of 50 bytes each
    await manager.appendChunk(session.uploadId, 0, makeStream('a'.repeat(50)));
    const s2 = await manager.appendChunk(session.uploadId, 1, makeStream('b'.repeat(50)));
    expect(s2.receivedBytes).toBe(100);

    const meta = await manager.completeChunkedUpload(session.uploadId);
    expect(meta.ciphertextSize).toBe(100);
    expect(meta.vaultId).toBeDefined();

    // Verify the vault is accessible
    const vault = manager.getVault(meta.vaultId);
    expect(vault).toBeDefined();
  });

  it('rejects out-of-order chunk index', async () => {
    const session = manager.initChunkedUpload(100, 3600, 5);

    // Sending chunk index 1 before 0 must fail
    await expect(
      manager.appendChunk(session.uploadId, 1, makeStream('data'))
    ).rejects.toThrow(/Expected chunk index 0/);

    await manager.abortChunkedUpload(session.uploadId);
  });

  it('rejects completing with no chunks', async () => {
    const session = manager.initChunkedUpload(100, 3600, 5);

    await expect(
      manager.completeChunkedUpload(session.uploadId)
    ).rejects.toThrow(/No chunks received/);
  });

  it('rejects init when totalSize exceeds MAX_FILE_SIZE', () => {
    expect(() => {
      manager.initChunkedUpload(999_999_999, 3600, 5);
    }).toThrow();
  });

  it('rejects chunk when session does not exist', async () => {
    await expect(
      manager.appendChunk('nonexistent-session-id', 0, makeStream('data'))
    ).rejects.toThrow(/not found/);
  });
});

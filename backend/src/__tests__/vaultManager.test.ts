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
    const vault = await manager.createVault(makeStream('secret-payload-'.repeat(4)), 3600, 1);

    // Fire 5 concurrent download requests — Node's event loop is cooperative
    // so only the first synchronously-checked getVault() wins.
    const results = await Promise.all(
      Array.from({ length: 5 }, () => manager.consumeDownload(vault.vaultId)),
    );

    const successes = results.filter(Boolean);
    expect(successes).toHaveLength(1);

    // Drain the stream so file handles are released
    for (const r of successes) {
      for await (const _ of r!.stream) {
        /* drain */
      }
    }
  });

  it('allows exactly N successful downloads for maxDownloads=N', async () => {
    const N = 3;
    const vault = await manager.createVault(makeStream('payload-'.repeat(8)), 3600, N);

    const results = await Promise.all(
      Array.from({ length: N + 2 }, () => manager.consumeDownload(vault.vaultId)),
    );

    const successes = results.filter(Boolean);
    expect(successes).toHaveLength(N);

    for (const r of successes) {
      for await (const _ of r!.stream) {
        /* drain */
      }
    }
  });

  it('returns null for unknown vault ID', async () => {
    const result = await manager.consumeDownload('no-such-vault-id-xyz');
    expect(result).toBeNull();
  });

  it('returns null after vault is explicitly deleted', async () => {
    const vault = await manager.createVault(makeStream('data-'.repeat(8)), 3600, 5);
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
    const vault = await manager.createVault(makeStream('data-'.repeat(8)), 3600, 5);

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
    await expect(smallManager.createVault(makeStream(bigData), 3600, 1)).rejects.toThrow();

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
    // Set a tiny quota (60 bytes) so a second upload is rejected
    vi.stubEnv('MAX_TOTAL_STORAGE', '60');
    vi.stubEnv('STORAGE_PATH', tempDir);
    vi.stubEnv('MAX_FILE_SIZE', String(10 * 1024 * 1024));
    vi.stubEnv('MAX_TTL', '604800');
    const mod = await import('../vault/manager.js');
    const quotaManager = new mod.VaultManager();
    await quotaManager.init();

    // First upload: 40 bytes, within the 60-byte quota
    const first = await quotaManager.createVault(makeStream('a'.repeat(40)), 3600, 5);

    // Second upload: 40 more would make 80. Nothing announced its size, so it is
    // refused once it has been written, and nothing of it is left on disk.
    await expect(
      quotaManager.createVault(makeStream('b'.repeat(40)), 3600, 5),
    ).rejects.toMatchObject({
      statusCode: 507,
      message: expect.stringMatching(/Storage quota exceeded/),
    });
    expect(await fsp.readdir(tempDir)).toEqual([first.vaultId]);

    await quotaManager.shutdown();
  });

  it('refuses an upload that declares more than the quota has left, before reading it', async () => {
    vi.resetModules();
    vi.stubEnv('MAX_TOTAL_STORAGE', '100');
    vi.stubEnv('STORAGE_PATH', tempDir);
    vi.stubEnv('MAX_FILE_SIZE', String(10 * 1024 * 1024));
    vi.stubEnv('MAX_TTL', '604800');
    const mod = await import('../vault/manager.js');
    const quotaManager = new mod.VaultManager();
    await quotaManager.init();

    const stream = makeStream('c'.repeat(200));
    await expect(quotaManager.createVault(stream, 3600, 5, undefined, 200)).rejects.toMatchObject({
      statusCode: 507,
    });

    expect(stream.readableEnded).toBe(false);
    expect(await fsp.readdir(tempDir)).toEqual([]);

    await quotaManager.shutdown();
  });

  it('holds the declared size of an upload while it is being written', async () => {
    vi.resetModules();
    vi.stubEnv('MAX_TOTAL_STORAGE', '100');
    vi.stubEnv('STORAGE_PATH', tempDir);
    vi.stubEnv('MAX_FILE_SIZE', String(10 * 1024 * 1024));
    vi.stubEnv('MAX_TTL', '604800');
    const mod = await import('../vault/manager.js');
    const quotaManager = new mod.VaultManager();
    await quotaManager.init();

    // An upload that declared 80 bytes and has not finished...
    const slow = new Readable({ read() {} });
    slow.push(Buffer.alloc(40, 'a'));
    const writing = quotaManager.createVault(slow, 3600, 5, undefined, 80);

    // ...leaves room for 20. One that declares 80 as well does not fit beside it.
    await expect(
      quotaManager.createVault(makeStream('b'.repeat(80)), 3600, 5, undefined, 80),
    ).rejects.toMatchObject({ statusCode: 507 });
    // Neither does a chunked upload of that size.
    expect(() => quotaManager.initChunkedUpload(80, 3600, 5)).toThrow(/Storage quota exceeded/);

    slow.push(null);
    const stored = await writing;
    expect(stored.ciphertextSize).toBe(40);

    // Once it is stored, only its real 40 bytes count
    await expect(
      quotaManager.createVault(makeStream('c'.repeat(60)), 3600, 5, undefined, 60),
    ).resolves.toMatchObject({ ciphertextSize: 60 });

    await quotaManager.shutdown();
  });

  it('accepts an upload that fills the quota exactly, and nothing after it', async () => {
    vi.resetModules();
    vi.stubEnv('MAX_TOTAL_STORAGE', '100');
    vi.stubEnv('STORAGE_PATH', tempDir);
    vi.stubEnv('MAX_FILE_SIZE', String(10 * 1024 * 1024));
    vi.stubEnv('MAX_TTL', '604800');
    const mod = await import('../vault/manager.js');
    const quotaManager = new mod.VaultManager();
    await quotaManager.init();

    await expect(
      quotaManager.createVault(makeStream('d'.repeat(100)), 3600, 5, undefined, 100),
    ).resolves.toMatchObject({ ciphertextSize: 100 });
    await expect(quotaManager.createVault(makeStream('e'), 3600, 5)).rejects.toMatchObject({
      statusCode: 507,
    });

    await quotaManager.shutdown();
  });

  it('lets two uploads that finish together fit only if both do', async () => {
    vi.resetModules();
    vi.stubEnv('MAX_TOTAL_STORAGE', '100');
    vi.stubEnv('STORAGE_PATH', tempDir);
    vi.stubEnv('MAX_FILE_SIZE', String(10 * 1024 * 1024));
    vi.stubEnv('MAX_TTL', '604800');
    const mod = await import('../vault/manager.js');
    const quotaManager = new mod.VaultManager();
    await quotaManager.init();

    // Neither announces a size, so both are judged on what they stored
    const results = await Promise.allSettled([
      quotaManager.createVault(makeStream('f'.repeat(60)), 3600, 5),
      quotaManager.createVault(makeStream('g'.repeat(60)), 3600, 5),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(quotaManager.getStats().totalStorageBytes).toBe(60);
    expect(await fsp.readdir(tempDir)).toHaveLength(1);

    await quotaManager.shutdown();
  });

  it('refuses an upload too small to be an encrypted file and keeps nothing of it', async () => {
    // 31 bytes: one short of an IV, a tag and an empty metadata header
    await expect(manager.createVault(makeStream('x'.repeat(31)), 3600, 5)).rejects.toMatchObject({
      statusCode: 400,
    });
    await expect(manager.createVault(makeStream(''), 3600, 5)).rejects.toMatchObject({
      statusCode: 400,
    });
    expect(await fsp.readdir(tempDir)).toEqual([]);

    await expect(manager.createVault(makeStream('x'.repeat(32)), 3600, 5)).resolves.toMatchObject({
      ciphertextSize: 32,
    });
  });

  it('refuses a chunked upload that declares less than an encrypted file needs', () => {
    expect(() => manager.initChunkedUpload(31, 3600, 5)).toThrow(/Invalid total size/);
    expect(() => manager.initChunkedUpload(32, 3600, 5)).not.toThrow();
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

    // Sending chunk index 1 before 0 must fail, and say which index is expected
    await expect(
      manager.appendChunk(session.uploadId, 1, makeStream('data')),
    ).rejects.toMatchObject({
      message: expect.stringMatching(/Expected chunk index 0/),
      statusCode: 400,
      expectedChunkIndex: 0,
    });

    await manager.abortChunkedUpload(session.uploadId);
  });

  it('rejects completing with no chunks', async () => {
    const session = manager.initChunkedUpload(100, 3600, 5);

    await expect(manager.completeChunkedUpload(session.uploadId)).rejects.toThrow(
      /No chunks received/,
    );
  });

  it('rejects init when totalSize exceeds MAX_FILE_SIZE', () => {
    expect(() => {
      manager.initChunkedUpload(999_999_999, 3600, 5);
    }).toThrow();
  });

  it('rejects init when totalSize is not an integer', () => {
    expect(() => manager.initChunkedUpload(1.5, 3600, 5)).toThrow(/Invalid total size/);
  });

  it('rejects chunk when session does not exist', async () => {
    await expect(
      manager.appendChunk('nonexistent-session-id', 0, makeStream('data')),
    ).rejects.toThrow(/not found/);
  });

  // ------------------------------------------------------------------
  // One write at a time per upload session
  // ------------------------------------------------------------------

  it('refuses a chunk while another one of the same upload is being written', async () => {
    const session = manager.initChunkedUpload(100, 3600, 5);

    // The first chunk's stream stays open, so its write is still running...
    const first = new Readable({ read() {} });
    first.push(Buffer.alloc(50, 'a'));
    const writing = manager.appendChunk(session.uploadId, 0, first);

    // ...when the next index arrives. It must not be written alongside it.
    await expect(
      manager.appendChunk(session.uploadId, 1, makeStream('b'.repeat(50))),
    ).rejects.toMatchObject({ statusCode: 409 });

    first.push(null);
    await writing;
    expect(session.receivedBytes).toBe(50);
    expect(session.nextChunkIndex).toBe(1);

    // The refused index is still the one expected, and the upload finishes normally
    await manager.appendChunk(session.uploadId, 1, makeStream('b'.repeat(50)));
    const meta = await manager.completeChunkedUpload(session.uploadId);
    expect(meta.ciphertextSize).toBe(100);
  });

  it('never stores more than the declared size, however many chunks arrive at once', async () => {
    const session = manager.initChunkedUpload(100, 3600, 5);

    const results = await Promise.allSettled(
      [0, 1, 2, 3].map((index) =>
        manager.appendChunk(session.uploadId, index, makeStream('x'.repeat(100))),
      ),
    );

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const stored = await fsp.stat(path.join(tempDir, '_uploads', session.uploadId, 'data.enc'));
    expect(stored.size).toBe(100);
    expect(session.receivedBytes).toBe(100);

    const meta = await manager.completeChunkedUpload(session.uploadId);
    expect(meta.ciphertextSize).toBe(100);
  });

  it('lets a failed chunk be sent again under the same index', async () => {
    const session = manager.initChunkedUpload(100, 3600, 5);

    // 150 bytes into a 100-byte upload: refused, and nothing of it is kept
    await expect(
      manager.appendChunk(session.uploadId, 0, makeStream('x'.repeat(150))),
    ).rejects.toMatchObject({ statusCode: 413 });
    expect(session.nextChunkIndex).toBe(0);
    expect(session.receivedBytes).toBe(0);

    await manager.appendChunk(session.uploadId, 0, makeStream('y'.repeat(100)));
    const meta = await manager.completeChunkedUpload(session.uploadId);
    expect(meta.ciphertextSize).toBe(100);
  });

  it('refuses to complete an upload while one of its chunks is being written', async () => {
    const session = manager.initChunkedUpload(100, 3600, 5);

    const first = new Readable({ read() {} });
    first.push(Buffer.alloc(100, 'a'));
    const writing = manager.appendChunk(session.uploadId, 0, first);

    // Not "no chunks received": the session and its data must survive this
    await expect(manager.completeChunkedUpload(session.uploadId)).rejects.toMatchObject({
      statusCode: 409,
    });

    first.push(null);
    await writing;
    const meta = await manager.completeChunkedUpload(session.uploadId);
    expect(meta.ciphertextSize).toBe(100);
  });

  it('creates one vault when an upload is completed twice at once', async () => {
    const session = manager.initChunkedUpload(100, 3600, 5);
    await manager.appendChunk(session.uploadId, 0, makeStream('z'.repeat(100)));

    const results = await Promise.allSettled([
      manager.completeChunkedUpload(session.uploadId),
      manager.completeChunkedUpload(session.uploadId),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((result) => result.status === 'rejected')).toMatchObject({
      reason: { statusCode: 409 },
    });
    // The vault, and the now-empty staging directory — nothing half-made beside them
    const entries = (await fsp.readdir(tempDir)).filter((name) => name !== '_uploads');
    expect(entries).toHaveLength(1);
  });

  it('caps concurrent open upload sessions per IP', async () => {
    vi.resetModules();
    vi.stubEnv('STORAGE_PATH', tempDir);
    vi.stubEnv('MAX_FILE_SIZE', String(10 * 1024 * 1024));
    vi.stubEnv('MAX_TTL', '604800');
    vi.stubEnv('MAX_UPLOAD_SESSIONS_PER_IP', '2');
    const mod = await import('../vault/manager.js');
    const capped = new mod.VaultManager();
    await capped.init();

    const ip = '203.0.113.7';
    capped.initChunkedUpload(100, 3600, 1, undefined, ip);
    capped.initChunkedUpload(100, 3600, 1, undefined, ip);

    // Third concurrent session from the same IP must be rejected
    expect(() => capped.initChunkedUpload(100, 3600, 1, undefined, ip)).toThrow(
      /Too many concurrent uploads/,
    );

    // A different IP is unaffected
    expect(() => capped.initChunkedUpload(100, 3600, 1, undefined, '198.51.100.9')).not.toThrow();

    await capped.shutdown();
  });

  it('frees the per-IP session slot when an upload completes', async () => {
    vi.resetModules();
    vi.stubEnv('STORAGE_PATH', tempDir);
    vi.stubEnv('MAX_FILE_SIZE', String(10 * 1024 * 1024));
    vi.stubEnv('MAX_TTL', '604800');
    vi.stubEnv('MAX_UPLOAD_SESSIONS_PER_IP', '1');
    const mod = await import('../vault/manager.js');
    const capped = new mod.VaultManager();
    await capped.init();

    const ip = '203.0.113.8';
    const s1 = capped.initChunkedUpload(50, 3600, 1, undefined, ip);
    await capped.appendChunk(s1.uploadId, 0, makeStream('x'.repeat(50)));
    await capped.completeChunkedUpload(s1.uploadId);

    // Slot must be released — a new session from the same IP now succeeds
    expect(() => capped.initChunkedUpload(50, 3600, 1, undefined, ip)).not.toThrow();

    await capped.shutdown();
  });

  // ------------------------------------------------------------------
  // Orphan cleanup on startup
  // ------------------------------------------------------------------

  it('deletes orphaned vault directories with missing meta.json on init', async () => {
    // Create a vault directory with data.enc but NO meta.json
    // (simulates a crash between writeFile and writeMetadata)
    const orphanId = 'orphan-no-meta-123456789';
    expect(orphanId).toHaveLength(24);
    const orphanDir = path.join(tempDir, orphanId);
    await fsp.mkdir(orphanDir, { recursive: true });
    await fsp.writeFile(path.join(orphanDir, 'data.enc'), 'leftover-data');

    // Re-init the manager — restoreMetadata should clean the orphan
    await manager.shutdown();
    vi.resetModules();
    vi.stubEnv('STORAGE_PATH', tempDir);
    vi.stubEnv('MAX_FILE_SIZE', String(10 * 1024 * 1024));
    vi.stubEnv('MAX_TTL', '604800');
    const mod = await import('../vault/manager.js');
    manager = new mod.VaultManager();
    await manager.init();

    // The orphan directory should have been removed
    await expect(fsp.access(orphanDir)).rejects.toThrow();
  });

  it('leaves directories it did not make alone, and says which', async () => {
    // What a shared directory or a careless bind mount would put next to the vaults
    await fsp.mkdir(path.join(tempDir, 'photos'));
    await fsp.writeFile(path.join(tempDir, 'photos', 'a.jpg'), 'not ours');
    await fsp.mkdir(path.join(tempDir, 'my-project', 'src'), { recursive: true });
    await fsp.writeFile(path.join(tempDir, 'my-project', 'src', 'main.c'), 'not ours');
    // An id-shaped name is not enough either, when the content is not a vault's
    const lookalike = 'abcdefghijklmnopqrstuvwx';
    await fsp.mkdir(path.join(tempDir, lookalike));
    await fsp.writeFile(path.join(tempDir, lookalike, 'notes.txt'), 'not ours');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await manager.shutdown();
    vi.resetModules();
    vi.stubEnv('STORAGE_PATH', tempDir);
    const mod = await import('../vault/manager.js');
    manager = new mod.VaultManager();
    await manager.init();

    await expect(fsp.readFile(path.join(tempDir, 'photos', 'a.jpg'), 'utf-8')).resolves.toBe(
      'not ours',
    );
    await expect(
      fsp.readFile(path.join(tempDir, 'my-project', 'src', 'main.c'), 'utf-8'),
    ).resolves.toBe('not ours');
    await expect(fsp.readFile(path.join(tempDir, lookalike, 'notes.txt'), 'utf-8')).resolves.toBe(
      'not ours',
    );
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0][0]).toContain('photos');
    expect(warn.mock.calls[0][0]).toContain('my-project');
    expect(warn.mock.calls[0][0]).toContain(lookalike);
  });

  it('does not take a meta.json it did not write for a vault', async () => {
    await fsp.mkdir(path.join(tempDir, 'other-tool'));
    await fsp.writeFile(
      path.join(tempDir, 'other-tool', 'meta.json'),
      JSON.stringify({ name: 'something else' }),
    );
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    await manager.shutdown();
    vi.resetModules();
    vi.stubEnv('STORAGE_PATH', tempDir);
    const mod = await import('../vault/manager.js');
    manager = new mod.VaultManager();
    await manager.init();

    expect(manager.getStats().totalVaults).toBe(0);
    expect(manager.hasVault('other-tool')).toBe(false);
    await expect(
      fsp.access(path.join(tempDir, 'other-tool', 'meta.json')),
    ).resolves.toBeUndefined();
  });

  it('restores its own vaults after a restart', async () => {
    const vault = await manager.createVault(makeStream('kept-across-restart-'.repeat(3)), 3600, 5);

    await manager.shutdown();
    vi.resetModules();
    vi.stubEnv('STORAGE_PATH', tempDir);
    const mod = await import('../vault/manager.js');
    manager = new mod.VaultManager();
    await manager.init();

    expect(manager.getVault(vault.vaultId)).toMatchObject({
      ciphertextSize: 60,
      remainingDownloads: 5,
    });
  });
});

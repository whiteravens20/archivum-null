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

    const bigData = 'x'.repeat(100); // 100 bytes > 10 byte limit
    await expect(
      smallManager.createVault(makeStream(bigData), 3600, 1)
    ).rejects.toThrow();

    await smallManager.shutdown();

    // Vault directory must NOT be left behind after the failed write
    const entries = await fsp.readdir(tempDir).catch(() => []);
    expect(entries).toHaveLength(0);
  });
});

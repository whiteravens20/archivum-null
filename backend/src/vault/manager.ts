import type { VaultMetadata } from './types.js';
import { config } from '../config.js';
import { LocalStorage } from '../storage/local.js';
import { nanoid } from 'nanoid';
import type { Readable } from 'node:stream';

const storage = new LocalStorage(config.STORAGE_PATH);
const vaults = new Map<string, VaultMetadata>();

// Cleanup interval — every 60 seconds, purge expired vaults
const CLEANUP_INTERVAL = 60_000;

export class VaultManager {
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  async init(): Promise<void> {
    await storage.init();
    // Restore metadata from disk
    await this.restoreMetadata();
    this.startCleanup();
  }

  private async restoreMetadata(): Promise<void> {
    try {
      const ids = await storage.listVaults();
      for (const vaultId of ids) {
        const meta = await storage.readMetadata(vaultId);
        if (meta) {
          // Check if expired
          if (meta.expiresAt <= Date.now() || meta.remainingDownloads <= 0) {
            await this.deleteVault(vaultId);
          } else {
            vaults.set(vaultId, meta);
          }
        }
      }
    } catch {
      // First run — no vaults exist yet
    }
  }

  private startCleanup(): void {
    this.cleanupTimer = setInterval(() => this.purgeExpired(), CLEANUP_INTERVAL);
    // Don't keep process alive just for cleanup
    if (this.cleanupTimer.unref) this.cleanupTimer.unref();
  }

  private async purgeExpired(): Promise<void> {
    const now = Date.now();
    for (const [id, meta] of vaults.entries()) {
      if (meta.expiresAt <= now || meta.remainingDownloads <= 0) {
        await this.deleteVault(id);
      }
    }
  }

  async createVault(
    stream: Readable,
    ttl: number,
    maxDownloads: number
  ): Promise<VaultMetadata> {
    // Enforce global storage quota before accepting a new upload
    if (config.MAX_TOTAL_STORAGE > 0) {
      const { totalStorageBytes } = this.getStats();
      if (totalStorageBytes >= config.MAX_TOTAL_STORAGE) {
        const err = Object.assign(
          new Error('Storage quota exceeded. Please try again later or contact the administrator.'),
          { statusCode: 507 }
        );
        throw err;
      }
    }

    const vaultId = nanoid(24);
    const now = Date.now();

    const clampedTtl = Math.min(Math.max(ttl, 60), config.MAX_TTL);
    const clampedDownloads = Math.min(Math.max(maxDownloads, 1), 1000);

    // Pass MAX_FILE_SIZE into writeFile so the stream is aborted early if the
    // limit is exceeded — avoids writing the full oversized blob to disk first.
    let size: number;
    try {
      size = await storage.writeFile(vaultId, stream, config.MAX_FILE_SIZE);
    } catch (err) {
      // Ensure the vault directory is fully removed on any write failure
      await storage.deleteVault(vaultId).catch(() => {});
      throw err;
    }

    const meta: VaultMetadata = {
      vaultId,
      ciphertextSize: size,
      createdAt: now,
      expiresAt: now + clampedTtl * 1000,
      remainingDownloads: clampedDownloads,
      maxDownloads: clampedDownloads,
    };

    await storage.writeMetadata(vaultId, meta);
    vaults.set(vaultId, meta);

    return meta;
  }

  getVault(vaultId: string): VaultMetadata | undefined {
    const meta = vaults.get(vaultId);
    if (!meta) return undefined;
    if (meta.expiresAt <= Date.now() || meta.remainingDownloads <= 0) {
      // Do NOT call deleteVault() here. A concurrent consumeDownload may have
      // just decremented remainingDownloads to 0 and is still opening / streaming
      // the file. Triggering an immediate rm() would race with that open, causing
      // ENOENT errors. Instead, rely on stream 'end' handlers and purgeExpired()
      // (every 60 s) for physical cleanup.
      return undefined;
    }
    return meta;
  }

  async consumeDownload(vaultId: string): Promise<{ stream: Readable; meta: VaultMetadata } | null> {
    const meta = this.getVault(vaultId);
    if (!meta) return null;

    // Decrement FIRST (synchronously, before the initial await) to maintain
    // atomicity in Node.js's cooperative scheduling model.  If we awaited anything
    // before this, concurrent requests in the same microtask batch could all pass
    // the getVault() guard with the same remainingDownloads value.
    //
    // Trade-off (Risk-4): if the underlying file is missing (storage corruption),
    // the slot has already been consumed.  That is acceptable — a corrupt vault
    // would be deleted regardless, and the damage is bounded to a single slot.
    meta.remainingDownloads -= 1;
    await storage.writeMetadata(vaultId, meta);

    const stream = await storage.readFile(vaultId);
    if (!stream) {
      // File missing despite valid metadata — storage is corrupt.
      // Delete the vault; we intentionally do NOT restore the counter because
      // the vault is irrecoverable and will never serve further downloads.
      await this.deleteVault(vaultId);
      return null;
    }

    // Schedule deletion if no downloads remain
    if (meta.remainingDownloads <= 0) {
      // Delete after stream ends
      stream.on('end', () => {
        this.deleteVault(vaultId).catch(() => {});
      });
      stream.on('error', () => {
        this.deleteVault(vaultId).catch(() => {});
      });
    }

    return { stream, meta };
  }

  async deleteVault(vaultId: string): Promise<boolean> {
    vaults.delete(vaultId);
    return storage.deleteVault(vaultId);
  }

  listVaults(): VaultMetadata[] {
    const now = Date.now();
    const result: VaultMetadata[] = [];
    for (const meta of vaults.values()) {
      if (meta.expiresAt > now && meta.remainingDownloads > 0) {
        result.push(meta);
      }
    }
    return result;
  }

  getStats(): { totalVaults: number; totalStorageBytes: number; activeVaults: number } {
    const now = Date.now();
    let totalStorage = 0;
    let active = 0;
    for (const meta of vaults.values()) {
      if (meta.expiresAt > now && meta.remainingDownloads > 0) {
        totalStorage += meta.ciphertextSize;
        active++;
      }
    }
    return {
      totalVaults: vaults.size,
      totalStorageBytes: totalStorage,
      activeVaults: active,
    };
  }

  async shutdown(): Promise<void> {
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
  }
}

export const vaultManager = new VaultManager();

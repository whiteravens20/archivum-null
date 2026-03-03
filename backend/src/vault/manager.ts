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
    const vaultId = nanoid(24);
    const now = Date.now();

    const clampedTtl = Math.min(Math.max(ttl, 60), config.MAX_TTL);
    const clampedDownloads = Math.min(Math.max(maxDownloads, 1), 1000);

    const size = await storage.writeFile(vaultId, stream);

    if (size > config.MAX_FILE_SIZE) {
      await storage.deleteVault(vaultId);
      throw Object.assign(new Error('File too large'), { statusCode: 413 });
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
      this.deleteVault(vaultId).catch(() => {});
      return undefined;
    }
    return meta;
  }

  async consumeDownload(vaultId: string): Promise<{ stream: Readable; meta: VaultMetadata } | null> {
    const meta = this.getVault(vaultId);
    if (!meta) return null;

    meta.remainingDownloads -= 1;
    await storage.writeMetadata(vaultId, meta);

    const stream = await storage.readFile(vaultId);
    if (!stream) {
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

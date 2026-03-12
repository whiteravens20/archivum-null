import type { StorageBackend } from './index.js';
import type { VaultMetadata } from '../vault/types.js';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

export class LocalStorage implements StorageBackend {
  constructor(private basePath: string) {}

  async init(): Promise<void> {
    await fsp.mkdir(this.basePath, { recursive: true });
  }

  private vaultDir(vaultId: string): string {
    // Sanitize vaultId to prevent path traversal
    const safe = vaultId.replace(/[^a-zA-Z0-9_-]/g, '');
    if (!safe || safe !== vaultId) throw new Error('Invalid vault ID');
    return path.join(this.basePath, safe);
  }

  private dataPath(vaultId: string): string {
    return path.join(this.vaultDir(vaultId), 'data.enc');
  }

  private metaPath(vaultId: string): string {
    return path.join(this.vaultDir(vaultId), 'meta.json');
  }

  async writeFile(vaultId: string, stream: Readable, maxSize?: number): Promise<number> {
    const dir = this.vaultDir(vaultId);
    await fsp.mkdir(dir, { recursive: true });

    const filePath = this.dataPath(vaultId);
    const writeStream = fs.createWriteStream(filePath);

    let size = 0;
    const counter = new Transform({
      transform(chunk, _encoding, callback) {
        size += chunk.length;
        if (maxSize !== undefined && size > maxSize) {
          // Abort immediately — avoid buffering excess data on disk
          callback(Object.assign(new Error('File too large'), { statusCode: 413 }));
          return;
        }
        this.push(chunk);
        callback();
      },
    });

    try {
      await pipeline(stream, counter, writeStream);
    } catch (err) {
      // Clean up partial file so no orphan data remains on disk
      await fsp.rm(filePath, { force: true }).catch(() => {});
      throw err;
    }
    return size;
  }

  async readFile(vaultId: string): Promise<Readable | null> {
    const filePath = this.dataPath(vaultId);
    try {
      await fsp.access(filePath);
      return fs.createReadStream(filePath);
    } catch {
      return null;
    }
  }

  async writeMetadata(vaultId: string, meta: VaultMetadata): Promise<void> {
    const dir = this.vaultDir(vaultId);
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(this.metaPath(vaultId), JSON.stringify(meta), 'utf-8');
  }

  async readMetadata(vaultId: string): Promise<VaultMetadata | null> {
    try {
      const raw = await fsp.readFile(this.metaPath(vaultId), 'utf-8');
      return JSON.parse(raw) as VaultMetadata;
    } catch {
      return null;
    }
  }

  async deleteVault(vaultId: string): Promise<boolean> {
    try {
      await fsp.rm(this.vaultDir(vaultId), { recursive: true, force: true });
      return true;
    } catch {
      return false;
    }
  }

  async listVaults(): Promise<string[]> {
    try {
      const entries = await fsp.readdir(this.basePath, { withFileTypes: true });
      return entries
        .filter((e) => e.isDirectory() && !e.name.startsWith('_'))
        .map((e) => e.name);
    } catch {
      return [];
    }
  }

  // ── Chunked upload helpers ─────────────────────────────────────────────────

  private uploadDir(uploadId: string): string {
    const safe = uploadId.replace(/[^a-zA-Z0-9_-]/g, '');
    if (!safe || safe !== uploadId) throw new Error('Invalid upload ID');
    return path.join(this.basePath, '_uploads', safe);
  }

  private uploadDataPath(uploadId: string): string {
    return path.join(this.uploadDir(uploadId), 'data.enc');
  }

  async appendChunk(
    uploadId: string,
    stream: Readable,
    maxTotalSize: number,
    currentSize: number
  ): Promise<number> {
    const dir = this.uploadDir(uploadId);
    await fsp.mkdir(dir, { recursive: true });

    const filePath = this.uploadDataPath(uploadId);
    // flags: 'a' = append; creates the file if it doesn't exist
    const writeStream = fs.createWriteStream(filePath, { flags: 'a' });

    let chunkBytes = 0;
    const counter = new Transform({
      transform(chunk, _encoding, callback) {
        chunkBytes += chunk.length;
        if (currentSize + chunkBytes > maxTotalSize) {
          callback(Object.assign(new Error('File too large'), { statusCode: 413 }));
          return;
        }
        this.push(chunk);
        callback();
      },
    });

    try {
      await pipeline(stream, counter, writeStream);
    } catch (err) {
      // On size overflow, clean up the partial chunk data that was appended.
      // We truncate back to the size before this chunk started.
      const filePath = this.uploadDataPath(uploadId);
      await fsp.truncate(filePath, currentSize).catch(() => {});
      throw err;
    }
    return chunkBytes;
  }

  async finalizeChunkedUpload(uploadId: string, vaultId: string): Promise<void> {
    const src = this.uploadDataPath(uploadId);
    const destDir = this.vaultDir(vaultId);
    await fsp.mkdir(destDir, { recursive: true });
    await fsp.rename(src, this.dataPath(vaultId));
    // Remove now-empty upload directory
    await fsp.rm(this.uploadDir(uploadId), { recursive: true, force: true }).catch(() => {});
  }

  async deleteChunkedUpload(uploadId: string): Promise<void> {
    await fsp.rm(this.uploadDir(uploadId), { recursive: true, force: true }).catch(() => {});
  }

  async purgeOrphanedUploads(activeUploadIds: Set<string>): Promise<void> {
    const uploadsDir = path.join(this.basePath, '_uploads');
    try {
      const entries = await fsp.readdir(uploadsDir, { withFileTypes: true });
      const orphans = entries
        .filter((e) => e.isDirectory() && !activeUploadIds.has(e.name))
        .map((e) =>
          fsp.rm(path.join(uploadsDir, e.name), { recursive: true, force: true }).catch(() => {})
        );
      await Promise.allSettled(orphans);
    } catch {
      // _uploads dir doesn't exist yet — nothing to purge
    }
  }
}

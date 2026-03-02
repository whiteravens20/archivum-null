import { StorageBackend } from './index.js';
import { VaultMetadata } from '../vault/types.js';
import { Readable } from 'node:stream';
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

  async writeFile(vaultId: string, stream: Readable): Promise<number> {
    const dir = this.vaultDir(vaultId);
    await fsp.mkdir(dir, { recursive: true });

    const filePath = this.dataPath(vaultId);
    const writeStream = fs.createWriteStream(filePath);

    let size = 0;
    const counter = new (await import('node:stream')).Transform({
      transform(chunk, _encoding, callback) {
        size += chunk.length;
        this.push(chunk);
        callback();
      },
    });

    await pipeline(stream, counter, writeStream);
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
      return entries.filter((e) => e.isDirectory()).map((e) => e.name);
    } catch {
      return [];
    }
  }
}

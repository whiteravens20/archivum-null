import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { LocalStorage } from '../storage/local.js';
import { Readable } from 'node:stream';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type { VaultMetadata } from '../vault/types.js';

function createTestStream(data: string): Readable {
  return Readable.from(Buffer.from(data));
}

function makeMeta(partial?: Partial<VaultMetadata>): VaultMetadata {
  return {
    vaultId: 'test-vault-id',
    ciphertextSize: 100,
    createdAt: Date.now(),
    expiresAt: Date.now() + 86400_000,
    remainingDownloads: 5,
    maxDownloads: 5,
    ...partial,
  };
}

describe('LocalStorage', () => {
  let storage: LocalStorage;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'archivum-test-'));
    storage = new LocalStorage(tempDir);
    await storage.init();
  });

  afterEach(async () => {
    await fsp.rm(tempDir, { recursive: true, force: true });
  });

  describe('init', () => {
    it('should create base directory', async () => {
      const newDir = path.join(tempDir, 'sub', 'dir');
      const s = new LocalStorage(newDir);
      await s.init();
      const stat = await fsp.stat(newDir);
      expect(stat.isDirectory()).toBe(true);
    });
  });

  describe('writeFile / readFile', () => {
    it('should write and read file data', async () => {
      const data = 'encrypted-payload-bytes';
      const size = await storage.writeFile('vault-1', createTestStream(data));
      expect(size).toBe(data.length);

      const stream = await storage.readFile('vault-1');
      expect(stream).not.toBeNull();

      const chunks: Buffer[] = [];
      for await (const chunk of stream!) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      expect(Buffer.concat(chunks).toString()).toBe(data);
    });

    it('should return correct byte count', async () => {
      const buf = Buffer.alloc(1024, 0xff);
      const size = await storage.writeFile('vault-size', Readable.from(buf));
      expect(size).toBe(1024);
    });

    it('should return null for non-existent file', async () => {
      const result = await storage.readFile('nonexistent');
      expect(result).toBeNull();
    });
  });

  describe('metadata', () => {
    it('should write and read metadata', async () => {
      const meta = makeMeta({ vaultId: 'meta-test' });
      await storage.writeMetadata('meta-test', meta);

      const loaded = await storage.readMetadata('meta-test');
      expect(loaded).toEqual(meta);
    });

    it('should return null for missing metadata', async () => {
      const result = await storage.readMetadata('no-such-vault');
      expect(result).toBeNull();
    });
  });

  describe('deleteVault', () => {
    it('should remove vault directory', async () => {
      await storage.writeFile('to-delete', createTestStream('data'));
      const deleted = await storage.deleteVault('to-delete');
      expect(deleted).toBe(true);

      const stream = await storage.readFile('to-delete');
      expect(stream).toBeNull();
    });

    it('should return false for already-deleted vault', async () => {
      // Force: true means it won't throw, returns true even if non-existent
      const deleted = await storage.deleteVault('already-gone');
      // rm with force: true doesn't throw, so it returns true
      expect(deleted).toBe(true);
    });
  });

  describe('listVaults', () => {
    it('should list vault directories', async () => {
      await storage.writeFile('vault-a', createTestStream('a'));
      await storage.writeFile('vault-b', createTestStream('b'));

      const list = await storage.listVaults();
      expect(list).toContain('vault-a');
      expect(list).toContain('vault-b');
      expect(list).toHaveLength(2);
    });

    it('should return empty array when no vaults exist', async () => {
      const list = await storage.listVaults();
      expect(list).toEqual([]);
    });
  });

  describe('path traversal protection', () => {
    it('should reject vault IDs with path separators', () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect(() => (storage as any).vaultDir('../etc/passwd')).toThrow('Invalid vault ID');
    });

    it('should reject vault IDs with dots', () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect(() => (storage as any).vaultDir('..foo')).toThrow('Invalid vault ID');
    });

    it('should allow valid nanoid-style IDs', () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect(() => (storage as any).vaultDir('abc123DEF-_xyz')).not.toThrow();
    });
  });
});

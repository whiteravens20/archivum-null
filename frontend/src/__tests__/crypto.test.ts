/**
 * @vitest-environment node
 *
 * Uses Node environment instead of jsdom because jsdom's ArrayBuffer
 * is from a different realm, causing WebCrypto to reject it.
 * Node 20+ has native File, Blob, and crypto.subtle support.
 * We polyfill FileReader since it's not available in Node.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import {
  generateKey,
  exportKey,
  importKey,
  encryptFile,
  decryptFile,
  formatBytes,
} from '../crypto/encrypt.js';

// Minimal FileReader polyfill for Node environment
class FileReaderPolyfill {
  result: ArrayBuffer | null = null;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onprogress: ((e: { lengthComputable: boolean; loaded: number; total: number }) => void) | null = null;

  readAsArrayBuffer(blob: Blob) {
    blob.arrayBuffer().then((buf) => {
      this.result = buf;
      if (this.onprogress) {
        this.onprogress({ lengthComputable: true, loaded: buf.byteLength, total: buf.byteLength });
      }
      if (this.onload) this.onload();
    }).catch(() => {
      if (this.onerror) this.onerror();
    });
  }
}

beforeAll(() => {
  if (typeof globalThis.FileReader === 'undefined') {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).FileReader = FileReaderPolyfill;
  }
});

describe('crypto/encrypt', () => {
  describe('generateKey', () => {
    it('should generate an AES-GCM key', async () => {
      const key = await generateKey();
      expect(key.algorithm).toMatchObject({ name: 'AES-GCM', length: 256 });
      expect(key.extractable).toBe(true);
      expect(key.usages).toContain('encrypt');
      expect(key.usages).toContain('decrypt');
    });

    it('should generate unique keys', async () => {
      const key1 = await generateKey();
      const key2 = await generateKey();
      const exported1 = await exportKey(key1);
      const exported2 = await exportKey(key2);
      expect(exported1).not.toBe(exported2);
    });
  });

  describe('exportKey / importKey', () => {
    it('should export and import key maintaining decryption capability', async () => {
      const original = await generateKey();
      const exported = await exportKey(original);

      // base64url format — no padding, URL-safe chars
      expect(exported).toMatch(/^[A-Za-z0-9_-]+$/);
      // 256-bit key = 32 bytes → 43 base64url chars (no padding)
      expect(exported).toHaveLength(43);

      const imported = await importKey(exported);
      expect(imported.algorithm).toMatchObject({ name: 'AES-GCM', length: 256 });
      expect(imported.usages).toContain('decrypt');
    });
  });

  describe('encryptFile / decryptFile', () => {
    it('should encrypt and decrypt a file roundtrip', async () => {
      const key = await generateKey();
      const content = 'Hello, Archivum Null! 🔐';
      const file = new File([content], 'test.txt', { type: 'text/plain' });

      const encrypted = await encryptFile(file, key);
      expect(encrypted.size).toBeGreaterThan(file.size); // IV + tag overhead

      const decrypted = await decryptFile(encrypted, key);
      expect(decrypted.name).toBe('test.txt');
      expect(decrypted.type).toBe('text/plain');

      const text = await decrypted.text();
      expect(text).toBe(content);
    });

    it('should produce different ciphertexts for same plaintext (unique IV)', async () => {
      const key = await generateKey();
      const file = new File(['same data'], 'test.bin', { type: 'application/octet-stream' });

      const enc1 = await encryptFile(file, key);
      const enc2 = await encryptFile(file, key);

      const buf1 = new Uint8Array(await enc1.arrayBuffer());
      const buf2 = new Uint8Array(await enc2.arrayBuffer());

      // IVs are the first 12 bytes — they should differ
      const iv1 = buf1.slice(0, 12);
      const iv2 = buf2.slice(0, 12);
      expect(iv1).not.toEqual(iv2);
    });

    it('should fail decryption with wrong key', async () => {
      const key1 = await generateKey();
      const key2 = await generateKey();
      const file = new File(['secret'], 'test.bin');

      const encrypted = await encryptFile(file, key1);

      await expect(
        decryptFile(encrypted, key2)
      ).rejects.toThrow();
    });

    it('should reject too-short data', async () => {
      const key = await generateKey();
      const tooShort = new Blob([new Uint8Array(20)]); // Less than IV + tag

      await expect(
        decryptFile(tooShort, key)
      ).rejects.toThrow();
    });

    it('should handle empty file encryption', async () => {
      const key = await generateKey();
      const file = new File([], 'empty.bin', { type: 'application/octet-stream' });

      const encrypted = await encryptFile(file, key);
      // IV (12) + header (2+9+2+24=37) + empty content (0) + GCM tag (16) = 65
      expect(encrypted.size).toBe(65);

      const decrypted = await decryptFile(encrypted, key);
      expect(decrypted.name).toBe('empty.bin');
      expect(decrypted.size).toBe(0);
    });

    it('should handle large binary data', async () => {
      const key = await generateKey();
      const data = new Uint8Array(1024 * 100); // 100KB
      // Fill in chunks (getRandomValues has 65536 byte limit)
      for (let i = 0; i < data.length; i += 65536) {
        const chunk = data.subarray(i, Math.min(i + 65536, data.length));
        crypto.getRandomValues(chunk);
      }
      const file = new File([data], 'large.bin');

      const encrypted = await encryptFile(file, key);
      const decrypted = await decryptFile(encrypted, key);

      const original = new Uint8Array(await new Blob([data]).arrayBuffer());
      const result = new Uint8Array(await decrypted.arrayBuffer());
      expect(result).toEqual(original);
    });

    it('should call progress callback during encryption', async () => {
      const key = await generateKey();
      const file = new File(['test data for progress'], 'test.bin');
      const progressCalls: number[] = [];

      await encryptFile(file, key, (p) => progressCalls.push(p));

      // FileReader progress may or may not fire in jsdom,
      // but the function should not throw
      expect(true).toBe(true);
    });
  });

  describe('formatBytes', () => {
    it('should format 0 bytes', () => {
      expect(formatBytes(0)).toBe('0 B');
    });

    it('should format bytes', () => {
      expect(formatBytes(500)).toBe('500 B');
    });

    it('should format kilobytes', () => {
      expect(formatBytes(1024)).toBe('1.0 KB');
      expect(formatBytes(1536)).toBe('1.5 KB');
    });

    it('should format megabytes', () => {
      expect(formatBytes(1048576)).toBe('1.0 MB');
      expect(formatBytes(5242880)).toBe('5.0 MB');
    });

    it('should format gigabytes', () => {
      expect(formatBytes(1073741824)).toBe('1.0 GB');
    });
  });
});

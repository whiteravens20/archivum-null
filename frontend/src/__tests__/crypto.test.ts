/**
 * @vitest-environment node
 *
 * Uses Node environment instead of jsdom because jsdom's ArrayBuffer
 * is from a different realm, causing WebCrypto to reject it.
 * Node 20+ has native File, Blob, and crypto.subtle support.
 */
import { describe, it, expect } from 'vitest';
import {
  generateKey,
  exportKey,
  importKey,
  encryptChunk,
  decryptChunk,
  buildMetadataHeader,
  parseMetadataHeader,
  calculateTotalEncryptedSize,
  countChunks,
  sanitizeFilename,
  IV_LENGTH,
  PER_CHUNK_OVERHEAD,
} from '../crypto/encrypt.js';

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

  describe('buildMetadataHeader / parseMetadataHeader', () => {
    it('should roundtrip filename and MIME type', () => {
      const header = buildMetadataHeader('photo.jpg', 'image/jpeg');
      const parsed = parseMetadataHeader(header);
      expect(parsed.filename).toBe('photo.jpg');
      expect(parsed.mimeType).toBe('image/jpeg');
      expect(parsed.contentOffset).toBe(header.length);
    });

    it('should handle empty filename', () => {
      const header = buildMetadataHeader('', 'text/plain');
      const parsed = parseMetadataHeader(header);
      expect(parsed.filename).toBe('file'); // sanitized fallback
      expect(parsed.mimeType).toBe('text/plain');
    });

    it('should handle empty MIME type', () => {
      const header = buildMetadataHeader('test.bin', '');
      const parsed = parseMetadataHeader(header);
      expect(parsed.filename).toBe('test.bin');
      expect(parsed.mimeType).toBe('application/octet-stream'); // fallback
    });

    it('should handle unicode filename', () => {
      const header = buildMetadataHeader('日本語ファイル.txt', 'text/plain');
      const parsed = parseMetadataHeader(header);
      expect(parsed.filename).toBe('日本語ファイル.txt');
    });

    it('should cut a name that is too long between two characters, never inside one', () => {
      // 130 four-byte characters are 520 bytes; the limit of 510 falls inside the 128th
      const header = buildMetadataHeader('😀'.repeat(130), 'text/plain');
      const parsed = parseMetadataHeader(header);

      expect(parsed.filename).toBe('😀'.repeat(127));
      expect(parsed.filename).not.toContain('\uFFFD');
      expect(parsed.mimeType).toBe('text/plain');
    });

    it('should sanitize path traversal in filename', () => {
      const header = buildMetadataHeader('../../../etc/passwd', 'text/plain');
      const parsed = parseMetadataHeader(header);
      // Path separators must be stripped; '..' without separators is harmless
      expect(parsed.filename).not.toContain('/');
      expect(parsed.filename).not.toContain('\\');
    });

    it('should parse header with trailing content bytes', () => {
      const header = buildMetadataHeader('test.txt', 'text/plain');
      const withContent = new Uint8Array(header.length + 10);
      withContent.set(header, 0);
      withContent.set(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]), header.length);

      const parsed = parseMetadataHeader(withContent);
      expect(parsed.filename).toBe('test.txt');
      expect(parsed.contentOffset).toBe(header.length);
    });

    it('should reject too-short header', () => {
      expect(() => parseMetadataHeader(new Uint8Array(3))).toThrow('too short');
    });
  });

  describe('encryptChunk / decryptChunk', () => {
    it('should encrypt and decrypt a chunk roundtrip', async () => {
      const key = await generateKey();
      const plaintext = new TextEncoder().encode('Hello, streaming encryption! 🔐');

      const encrypted = await encryptChunk(plaintext, key, 0, true);
      expect(encrypted.length).toBe(plaintext.length + PER_CHUNK_OVERHEAD);

      const decrypted = await decryptChunk(encrypted, key, 0, true);
      expect(decrypted).toEqual(plaintext);
    });

    it('should produce unique IVs for each chunk', async () => {
      const key = await generateKey();
      const plaintext = new Uint8Array([1, 2, 3]);

      const enc1 = await encryptChunk(plaintext, key, 0, false);
      const enc2 = await encryptChunk(plaintext, key, 1, true);

      const iv1 = enc1.slice(0, IV_LENGTH);
      const iv2 = enc2.slice(0, IV_LENGTH);
      expect(iv1).not.toEqual(iv2);
    });

    it('should fail decryption with wrong key', async () => {
      const key1 = await generateKey();
      const key2 = await generateKey();
      const plaintext = new Uint8Array([1, 2, 3]);

      const encrypted = await encryptChunk(plaintext, key1, 0, true);

      await expect(decryptChunk(encrypted, key2, 0, true)).rejects.toThrow();
    });

    it('should fail decryption with wrong chunkIndex (reorder protection)', async () => {
      const key = await generateKey();
      const plaintext = new Uint8Array([1, 2, 3]);

      const encrypted = await encryptChunk(plaintext, key, 0, true);

      // Decrypt with chunkIndex=1 instead of 0 — AAD mismatch → GCM auth failure
      await expect(decryptChunk(encrypted, key, 1, true)).rejects.toThrow();
    });

    it('should fail decryption with wrong isLast flag (truncation protection)', async () => {
      const key = await generateKey();
      const plaintext = new Uint8Array([1, 2, 3]);

      // Encrypted as a NON-final chunk; decrypting it as the final chunk (as a
      // truncating server would force) must fail authentication.
      const middle = await encryptChunk(plaintext, key, 0, false);
      await expect(decryptChunk(middle, key, 0, true)).rejects.toThrow();

      // And the inverse: a final chunk decrypted as non-final also fails.
      const last = await encryptChunk(plaintext, key, 0, true);
      await expect(decryptChunk(last, key, 0, false)).rejects.toThrow();
    });

    it('should reject too-short data', async () => {
      const key = await generateKey();
      const tooShort = new Uint8Array(20); // Less than IV + tag

      await expect(decryptChunk(tooShort, key, 0, true)).rejects.toThrow('too short');
    });

    it('should handle empty chunk', async () => {
      const key = await generateKey();
      const empty = new Uint8Array(0);

      const encrypted = await encryptChunk(empty, key, 0, true);
      expect(encrypted.length).toBe(PER_CHUNK_OVERHEAD); // just IV + tag

      const decrypted = await decryptChunk(encrypted, key, 0, true);
      expect(decrypted.length).toBe(0);
    });

    it('should handle single-byte chunk', async () => {
      const key = await generateKey();
      const single = new Uint8Array([42]);

      const encrypted = await encryptChunk(single, key, 0, true);
      const decrypted = await decryptChunk(encrypted, key, 0, true);
      expect(decrypted).toEqual(single);
    });

    it('should handle large chunk (100 KB)', async () => {
      const key = await generateKey();
      const data = new Uint8Array(102400);
      for (let i = 0; i < data.length; i += 65536) {
        crypto.getRandomValues(data.subarray(i, Math.min(i + 65536, data.length)));
      }

      const encrypted = await encryptChunk(data, key, 0, true);
      const decrypted = await decryptChunk(encrypted, key, 0, true);
      expect(decrypted).toEqual(data);
    });
  });

  describe('multi-chunk streaming flow', () => {
    it('should encrypt and decrypt a file split into multiple chunks', async () => {
      const key = await generateKey();
      const chunkSize = 64; // small chunk for testing

      // Build plaintext: header + file content
      const header = buildMetadataHeader('multi.bin', 'application/octet-stream');
      const fileContent = new Uint8Array(200);
      crypto.getRandomValues(fileContent);

      const fullPlaintext = new Uint8Array(header.length + fileContent.length);
      fullPlaintext.set(header, 0);
      fullPlaintext.set(fileContent, header.length);

      // Split into chunks and encrypt
      const encryptedChunks: Uint8Array[] = [];
      let offset = 0;
      let chunkIndex = 0;
      while (offset < fullPlaintext.length) {
        const end = Math.min(offset + chunkSize, fullPlaintext.length);
        const chunk = fullPlaintext.slice(offset, end);
        encryptedChunks.push(await encryptChunk(chunk, key, chunkIndex, end === fullPlaintext.length));
        offset = end;
        chunkIndex++;
      }

      // Decrypt all chunks
      const decryptedParts: Uint8Array[] = [];
      for (let i = 0; i < encryptedChunks.length; i++) {
        decryptedParts.push(await decryptChunk(encryptedChunks[i], key, i, i === encryptedChunks.length - 1));
      }

      // Reassemble
      const totalLen = decryptedParts.reduce((sum, p) => sum + p.length, 0);
      const reassembled = new Uint8Array(totalLen);
      let pos = 0;
      for (const part of decryptedParts) {
        reassembled.set(part, pos);
        pos += part.length;
      }

      // Parse header from reassembled plaintext
      const parsed = parseMetadataHeader(reassembled);
      expect(parsed.filename).toBe('multi.bin');
      expect(parsed.mimeType).toBe('application/octet-stream');

      const recoveredContent = reassembled.slice(parsed.contentOffset);
      expect(recoveredContent).toEqual(fileContent);
    });

    it('should detect chunk reordering in multi-chunk flow', async () => {
      const key = await generateKey();
      const chunk0 = await encryptChunk(new Uint8Array([1, 2, 3]), key, 0, false);
      const chunk1 = await encryptChunk(new Uint8Array([4, 5, 6]), key, 1, true);

      // Swapped: try to decrypt chunk1 as index 0 and vice versa
      await expect(decryptChunk(chunk1, key, 0, false)).rejects.toThrow();
      await expect(decryptChunk(chunk0, key, 1, true)).rejects.toThrow();

      // Correct order works
      await expect(decryptChunk(chunk0, key, 0, false)).resolves.toEqual(new Uint8Array([1, 2, 3]));
      await expect(decryptChunk(chunk1, key, 1, true)).resolves.toEqual(new Uint8Array([4, 5, 6]));
    });
  });

  describe('countChunks', () => {
    it('should count at least one chunk and round up', () => {
      expect(countChunks(0, 100)).toBe(1);
      expect(countChunks(100, 100)).toBe(1);
      expect(countChunks(101, 100)).toBe(2);
    });

    it('should refuse a chunk size that is not a positive integer', () => {
      for (const bad of [0, -1, 1.5, NaN, Infinity, undefined as unknown as number]) {
        expect(() => countChunks(100, bad)).toThrow('Invalid crypto chunk size');
        expect(() => calculateTotalEncryptedSize(100, bad)).toThrow('Invalid crypto chunk size');
      }
    });

    it('should refuse a plaintext size that is not a whole number of bytes', () => {
      for (const bad of [-1, 1.5, NaN, undefined as unknown as number]) {
        expect(() => countChunks(bad, 100)).toThrow('Invalid plaintext size');
      }
    });
  });

  describe('calculateTotalEncryptedSize', () => {
    it('should calculate size for single chunk', () => {
      const size = calculateTotalEncryptedSize(100, 5242880);
      // 1 chunk → 100 + 28 = 128
      expect(size).toBe(128);
    });

    it('should calculate size for multiple chunks', () => {
      // 10 MB plaintext, 5 MB chunk size = 2 chunks
      const size = calculateTotalEncryptedSize(10485760, 5242880);
      expect(size).toBe(10485760 + 2 * PER_CHUNK_OVERHEAD);
    });

    it('should calculate size at exact chunk boundary', () => {
      // Exactly 5 MB = 1 chunk (not 2)
      const size = calculateTotalEncryptedSize(5242880, 5242880);
      expect(size).toBe(5242880 + PER_CHUNK_OVERHEAD);
    });

    it('should handle zero plaintext', () => {
      const size = calculateTotalEncryptedSize(0, 5242880);
      // At least 1 chunk
      expect(size).toBe(PER_CHUNK_OVERHEAD);
    });
  });

  describe('sanitizeFilename', () => {
    it('should return a normal filename unchanged', () => {
      expect(sanitizeFilename('document.pdf')).toBe('document.pdf');
    });

    it('should replace path separators with underscores', () => {
      expect(sanitizeFilename('../../../etc/passwd')).not.toContain('/');
      expect(sanitizeFilename('..\\windows\\system32')).not.toContain('\\');
    });

    it('should strip ASCII control characters', () => {
      expect(sanitizeFilename('file\x00name\x1F.txt')).toBe('filename.txt');
      expect(sanitizeFilename('test\x7Ffile')).toBe('testfile');
    });

    it('should strip Unicode bidi override characters', () => {
      // U+202E (RLO) — can disguise .exe as .pdf
      expect(sanitizeFilename('document\u202Efdp.exe')).not.toContain('\u202E');
      // U+202A (LRE), U+202B (RLE), U+202C (PDF), U+202D (LRO)
      expect(sanitizeFilename('a\u202Ab\u202Bc\u202Cd\u202De')).toBe('abcde');
      // U+2066–U+2069 (LRI, RLI, FSI, PDI)
      expect(sanitizeFilename('x\u2066y\u2067z\u2068w\u2069v')).toBe('xyzwv');
    });

    it('should strip zero-width characters', () => {
      expect(sanitizeFilename('file\u200Bname.txt')).toBe('filename.txt'); // ZWSP
      expect(sanitizeFilename('file\u200Cname')).toBe('filename');         // ZWNJ
      expect(sanitizeFilename('file\u200Dname')).toBe('filename');         // ZWJ
      expect(sanitizeFilename('\uFEFFtest')).toBe('test');                 // BOM
    });

    it('should strip LRM and RLM marks', () => {
      expect(sanitizeFilename('file\u200Ename\u200F.txt')).toBe('filename.txt');
    });

    it('should strip the invisible characters a fixed list would miss', () => {
      const invisible = [
        '\u00AD', // soft hyphen
        '\u061C', // Arabic letter mark
        '\u180E', // Mongolian vowel separator
        '\u2028', // line separator
        '\u2029', // paragraph separator
        '\u2060', // word joiner
        '\u2064', // invisible plus
        '\u3164', // Hangul filler
        '\uFE0F', // variation selector
        '\uFFF9', // interlinear annotation anchor
        '\u{E0041}', // tag character
      ];
      for (const character of invisible) {
        expect(sanitizeFilename(`inv${character}oice.pdf`)).toBe('invoice.pdf');
      }
    });

    it('should not let whitespace hide leading dots', () => {
      expect(sanitizeFilename(' .hidden')).toBe('hidden');
      expect(sanitizeFilename('. .bashrc')).toBe('bashrc');
      expect(sanitizeFilename('\u200B.profile')).toBe('profile');
    });

    it('should strip leading dots', () => {
      expect(sanitizeFilename('.hidden')).toBe('hidden');
      expect(sanitizeFilename('...secret')).toBe('secret');
      expect(sanitizeFilename('.bashrc')).toBe('bashrc');
    });

    it('should trim whitespace', () => {
      expect(sanitizeFilename('  hello.txt  ')).toBe('hello.txt');
    });

    it('should truncate to 255 characters', () => {
      const long = 'x'.repeat(300);
      expect(sanitizeFilename(long)).toHaveLength(255);
    });

    it('should count the limit in characters and never cut one in half', () => {
      // Each of these is two UTF-16 units; a cut by units would leave half a character
      const result = sanitizeFilename('😀'.repeat(300));
      expect(Array.from(result)).toHaveLength(255);
      expect(result.isWellFormed()).toBe(true);
      expect(result).toBe('😀'.repeat(255));
    });

    it('should return "file" for empty string', () => {
      expect(sanitizeFilename('')).toBe('file');
    });

    it('should return "file" for whitespace-only input', () => {
      expect(sanitizeFilename('   ')).toBe('file');
    });

    it('should return "file" when all characters are stripped', () => {
      expect(sanitizeFilename('\x00\x01\x02')).toBe('file');
      expect(sanitizeFilename('...')).toBe('file');
    });

    it('should handle combined attack vectors', () => {
      // Path traversal + bidi + zero-width
      const malicious = '../\u202E\u200B.exe';
      const result = sanitizeFilename(malicious);
      expect(result).not.toContain('/');
      expect(result).not.toContain('\u202E');
      expect(result).not.toContain('\u200B');
    });

    it('should preserve unicode emoji and CJK characters', () => {
      expect(sanitizeFilename('報告書📊.xlsx')).toBe('報告書📊.xlsx');
    });

    it('should handle filename with only dots and extension', () => {
      expect(sanitizeFilename('...test.txt')).toBe('test.txt');
    });
  });
});

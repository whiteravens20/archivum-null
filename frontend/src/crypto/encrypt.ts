/**
 * Archivum Null — Client-side Zero-Knowledge Streaming Encryption
 *
 * Uses WebCrypto API exclusively:
 *   - AES-256-GCM (authenticated encryption)
 *   - 256-bit key from crypto.getRandomValues
 *   - Unique IV per chunk (96 bits, random)
 *   - Key NEVER leaves the browser (stored in URL fragment only)
 *
 * Streaming encryption format (v2):
 *   Each crypto chunk is encrypted independently:
 *     [IV (12 bytes)][AES-GCM ciphertext + 16-byte auth tag]
 *   Chunks are concatenated sequentially on disk:
 *     [chunk_0][chunk_1]...[chunk_N]
 *
 *   Additional Authenticated Data (AAD) = chunk index (uint32 BE) || isLast (uint8)
 *   The chunk index prevents reordering. The isLast flag marks the final chunk,
 *   so a server that drops trailing chunks (truncation) or appends extra ones
 *   (extension) leaves a chunk whose stored isLast no longer matches the value
 *   the client supplies during decryption — GCM authentication then fails.
 *
 * Plaintext layout (before per-chunk AES-GCM encryption):
 *   Chunk 0: [uint16 BE: nameLen][filename UTF-8][uint16 BE: mimeLen][MIME UTF-8][file bytes...]
 *   Chunk 1..N: [file bytes continued]
 *
 * The server never receives the filename or MIME type — they are
 * encrypted inside the first chunk's payload and recovered exclusively client-side.
 */

const ALGORITHM = 'AES-GCM';
const KEY_LENGTH = 256;
export const IV_LENGTH = 12; // 96 bits recommended for AES-GCM
const GCM_TAG_LENGTH = 16;

/** Per-chunk overhead: 12-byte IV + 16-byte GCM tag */
export const PER_CHUNK_OVERHEAD = IV_LENGTH + GCM_TAG_LENGTH; // 28

/** Maximum byte lengths accepted when encoding/decoding header fields */
const MAX_NAME_BYTES = 510; // ~255 chars worst-case UTF-8
const MAX_MIME_BYTES = 254;

/** Generate a 256-bit AES key */
export async function generateKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey(
    { name: ALGORITHM, length: KEY_LENGTH },
    true, // extractable — needed to export for URL fragment
    ['encrypt', 'decrypt']
  );
}

/** Export key to base64url string (for URL fragment) */
export async function exportKey(key: CryptoKey): Promise<string> {
  const raw = await crypto.subtle.exportKey('raw', key);
  return arrayBufferToBase64Url(raw);
}

/** Import key from base64url string */
export async function importKey(base64url: string): Promise<CryptoKey> {
  const raw = base64UrlToArrayBuffer(base64url);
  return crypto.subtle.importKey(
    'raw',
    raw,
    { name: ALGORITHM, length: KEY_LENGTH },
    false,
    ['decrypt']
  );
}

/**
 * Build the metadata header that is prepended to the first crypto chunk's plaintext.
 * Format: [uint16 BE: nameLen][filename UTF-8][uint16 BE: mimeLen][MIME UTF-8]
 */
export function buildMetadataHeader(filename: string, mimeType: string): Uint8Array {
  const encoder = new TextEncoder();
  const rawName = filename || 'file';
  // Encode first, then truncate by bytes (not characters) to respect MAX_*_BYTES limits
  const nameBytes = encoder.encode(rawName).slice(0, MAX_NAME_BYTES);
  const mimeBytes = encoder.encode(mimeType || 'application/octet-stream').slice(0, MAX_MIME_BYTES);

  const header = new Uint8Array(2 + nameBytes.length + 2 + mimeBytes.length);
  const view = new DataView(header.buffer);
  let offset = 0;

  view.setUint16(offset, nameBytes.length, false); offset += 2;
  header.set(nameBytes, offset);                   offset += nameBytes.length;
  view.setUint16(offset, mimeBytes.length, false); offset += 2;
  header.set(mimeBytes, offset);

  return header;
}

/**
 * Parse the metadata header from decrypted first-chunk plaintext.
 * Returns filename, MIME type, and the byte offset where file content begins.
 */
export function parseMetadataHeader(plaintext: Uint8Array): {
  filename: string;
  mimeType: string;
  contentOffset: number;
} {
  if (plaintext.length < 4) throw new Error('Decrypted payload header too short');
  const dv = new DataView(plaintext.buffer, plaintext.byteOffset, plaintext.byteLength);
  const decoder = new TextDecoder();
  let pos = 0;

  const nameLen = dv.getUint16(pos, false); pos += 2;
  if (pos + nameLen + 2 > plaintext.length) throw new Error('Corrupt payload: name out of bounds');
  const filename = sanitizeFilename(decoder.decode(plaintext.slice(pos, pos + nameLen)));
  pos += nameLen;

  const mimeLen = dv.getUint16(pos, false); pos += 2;
  if (pos + mimeLen > plaintext.length) throw new Error('Corrupt payload: mime out of bounds');
  const mimeType = decoder.decode(plaintext.slice(pos, pos + mimeLen)) || 'application/octet-stream';
  pos += mimeLen;

  return { filename, mimeType, contentOffset: pos };
}

/**
 * Build the per-chunk AAD: [uint32 BE chunkIndex][uint8 isLast].
 * Binds both ordering and the total chunk count (via the final-chunk marker)
 * into every chunk's authentication tag.
 */
function buildChunkAad(chunkIndex: number, isLast: boolean): ArrayBuffer {
  const aad = new ArrayBuffer(5);
  const view = new DataView(aad);
  view.setUint32(0, chunkIndex, false);
  view.setUint8(4, isLast ? 1 : 0);
  return aad;
}

/**
 * Encrypt a single plaintext chunk with AES-256-GCM.
 *
 * @param plaintext  Raw chunk bytes (≤ cryptoChunkSize)
 * @param key        AES-256-GCM CryptoKey
 * @param chunkIndex 0-based index, bound into AAD to prevent reordering
 * @param isLast     Whether this is the final chunk, bound into AAD to prevent truncation
 * @returns [IV (12 bytes) || ciphertext || GCM tag (16 bytes)]
 */
export async function encryptChunk(
  plaintext: BufferSource,
  key: CryptoKey,
  chunkIndex: number,
  isLast: boolean
): Promise<Uint8Array<ArrayBuffer>> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
  const aad = buildChunkAad(chunkIndex, isLast);

  const ciphertext = await crypto.subtle.encrypt(
    { name: ALGORITHM, iv, additionalData: aad },
    key,
    plaintext
  );

  const result = new Uint8Array(IV_LENGTH + ciphertext.byteLength);
  result.set(iv, 0);
  result.set(new Uint8Array(ciphertext), IV_LENGTH);
  return result;
}

/**
 * Decrypt a single ciphertext chunk with AES-256-GCM.
 *
 * @param chunk      [IV (12 bytes) || ciphertext || GCM tag (16 bytes)]
 * @param key        AES-256-GCM CryptoKey
 * @param chunkIndex Must match the index used during encryption (AAD)
 * @param isLast     Must match the final-chunk flag used during encryption (AAD)
 * @returns Decrypted plaintext bytes
 */
export async function decryptChunk(
  chunk: Uint8Array,
  key: CryptoKey,
  chunkIndex: number,
  isLast: boolean
): Promise<Uint8Array<ArrayBuffer>> {
  if (chunk.length < IV_LENGTH + GCM_TAG_LENGTH) {
    throw new Error('Invalid encrypted chunk: too short');
  }

  const iv = chunk.slice(0, IV_LENGTH);
  const ciphertext = chunk.slice(IV_LENGTH);
  const aad = buildChunkAad(chunkIndex, isLast);

  const plaintext = await crypto.subtle.decrypt(
    { name: ALGORITHM, iv, additionalData: aad },
    key,
    ciphertext
  );

  return new Uint8Array(plaintext);
}

/**
 * Calculate the total encrypted size for a file with metadata header.
 * Useful to determine totalSize before starting upload.
 */
export function calculateTotalEncryptedSize(
  plaintextSize: number,
  chunkPlaintextSize: number
): number {
  const numChunks = Math.max(1, Math.ceil(plaintextSize / chunkPlaintextSize));
  return plaintextSize + numChunks * PER_CHUNK_OVERHEAD;
}

/**
 * Sanitize a filename extracted from an encrypted payload to prevent
 * path-traversal or dangerous names when the browser triggers a download.
 * (The filename never leaves the client, but we sanitize defensively.)
 *
 * Also strips Unicode bidi overrides (e.g. U+202E RLO) that can visually
 * reverse filenames to disguise extensions, and zero-width characters that
 * can make two different names appear identical.
 */
export function sanitizeFilename(raw: string): string {
  return (
    raw
      // Strip path separators
      .replace(/[/\\]/g, '_')
      // Strip control characters (0x00–0x1F, 0x7F) and Unicode bidi overrides
      // (U+200E–U+200F, U+202A–U+202E, U+2066–U+2069) plus zero-width
      // characters (U+200B ZWSP, U+200C ZWNJ, U+200D ZWJ, U+FEFF BOM)
      .split('')
      .filter((c) => {
        const code = c.charCodeAt(0);
        if (code <= 31 || code === 127) return false;            // ASCII control
        if (code >= 0x200B && code <= 0x200F) return false;      // ZWSP, ZWNJ, ZWJ, LRM, RLM
        if (code >= 0x202A && code <= 0x202E) return false;      // LRE, RLE, PDF, LRO, RLO
        if (code >= 0x2066 && code <= 0x2069) return false;      // LRI, RLI, FSI, PDI
        if (code === 0xFEFF) return false;                       // BOM / ZWNBSP
        return true;
      })
      .join('')
      // Strip leading dots (hidden files on Unix)
      .replace(/^\.+/, '')
      // Trim whitespace
      .trim()
      // Limit to 255 characters
      .slice(0, 255) || 'file'
  );
}

/** ArrayBuffer → base64url (no padding) */
function arrayBufferToBase64Url(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** base64url → ArrayBuffer */
function base64UrlToArrayBuffer(base64url: string): ArrayBuffer {
  const base64 = base64url.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

/** Format bytes for display */
export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(i > 0 ? 1 : 0)} ${units[i]}`;
}

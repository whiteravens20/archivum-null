/**
 * Archivum Null — Client-side Zero-Knowledge Encryption
 *
 * Uses WebCrypto API exclusively:
 *   - AES-256-GCM (authenticated encryption)
 *   - 256-bit key from crypto.getRandomValues
 *   - Unique IV per encryption
 *   - Key NEVER leaves the browser (stored in URL fragment only)
 *
 * Payload format (plaintext before AES-GCM):
 *   [uint16 BE: nameLen][nameLen bytes: filename UTF-8]
 *   [uint16 BE: mimeLen][mimeLen bytes: MIME type UTF-8]
 *   [remaining bytes: file content]
 *
 * The server never receives the filename or MIME type — they are
 * encrypted inside the payload and recovered exclusively client-side.
 */

const ALGORITHM = 'AES-GCM';
const KEY_LENGTH = 256;
const IV_LENGTH = 12; // 96 bits recommended for AES-GCM

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
 * Encrypt a file.
 *
 * Plaintext layout before AES-GCM encryption:
 *   [uint16 BE: nameLen][filename UTF-8][uint16 BE: mimeLen][MIME UTF-8][file bytes]
 *
 * Wire format stored on server:
 *   IV (12 bytes) || AES-GCM ciphertext
 *
 * The server never receives (and never can read) the filename or MIME type.
 */
export async function encryptFile(
  file: File,
  key: CryptoKey,
  onProgress?: (progress: number) => void
): Promise<Blob> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));

  // Encode filename (capped) and MIME type into header bytes
  const encoder = new TextEncoder();
  const rawName = file.name || 'file';
  // Cap so the encoded form fits within MAX_NAME_BYTES
  const nameBytes = encoder.encode(rawName.slice(0, MAX_NAME_BYTES));
  const mimeBytes = encoder.encode((file.type || 'application/octet-stream').slice(0, MAX_MIME_BYTES));

  const fileBytes = await readFileAsArrayBuffer(file, onProgress);

  // Build header + content buffer
  const headerLen = 2 + nameBytes.length + 2 + mimeBytes.length;
  const plaintext = new Uint8Array(headerLen + fileBytes.byteLength);
  const view = new DataView(plaintext.buffer);
  let offset = 0;

  view.setUint16(offset, nameBytes.length, false); offset += 2;
  plaintext.set(nameBytes, offset);               offset += nameBytes.length;
  view.setUint16(offset, mimeBytes.length, false); offset += 2;
  plaintext.set(mimeBytes, offset);               offset += mimeBytes.length;
  plaintext.set(new Uint8Array(fileBytes), offset);

  const ciphertext = await crypto.subtle.encrypt({ name: ALGORITHM, iv }, key, plaintext);

  // Prepend IV to ciphertext
  const wire = new Uint8Array(IV_LENGTH + ciphertext.byteLength);
  wire.set(iv, 0);
  wire.set(new Uint8Array(ciphertext), IV_LENGTH);

  return new Blob([wire], { type: 'application/octet-stream' });
}

/**
 * Decrypt ciphertext and recover the original file with its original name and
 * MIME type — both extracted from the encrypted payload header.
 *
 * Expects wire format: IV (12 bytes) || AES-GCM ciphertext
 */
export async function decryptFile(
  encryptedBlob: Blob,
  key: CryptoKey,
): Promise<File> {
  const data = new Uint8Array(await encryptedBlob.arrayBuffer());

  // Minimum: IV + 4-byte header (2+2 empty name+mime) + 16-byte GCM tag
  if (data.length < IV_LENGTH + 4 + 16) {
    throw new Error('Invalid encrypted data: too short');
  }

  const iv = data.slice(0, IV_LENGTH);
  const ciphertext = data.slice(IV_LENGTH);

  const decrypted = new Uint8Array(
    await crypto.subtle.decrypt({ name: ALGORITHM, iv }, key, ciphertext)
  );

  // Parse header
  if (decrypted.length < 4) throw new Error('Decrypted payload header too short');
  const dv = new DataView(decrypted.buffer);
  let pos = 0;

  const nameLen = dv.getUint16(pos, false); pos += 2;
  if (pos + nameLen + 2 > decrypted.length) throw new Error('Corrupt payload: name out of bounds');
  const decoder = new TextDecoder();
  const fileName = sanitizeFilename(decoder.decode(decrypted.slice(pos, pos + nameLen)));
  pos += nameLen;

  const mimeLen = dv.getUint16(pos, false); pos += 2;
  if (pos + mimeLen > decrypted.length) throw new Error('Corrupt payload: mime out of bounds');
  const mimeType = decoder.decode(decrypted.slice(pos, pos + mimeLen)) || 'application/octet-stream';
  pos += mimeLen;

  const fileContent = decrypted.slice(pos);
  return new File([fileContent], fileName, { type: mimeType });
}

/**
 * Sanitize a filename extracted from an encrypted payload to prevent
 * path-traversal or dangerous names when the browser triggers a download.
 * (The filename never leaves the client, but we sanitize defensively.)
 */
function sanitizeFilename(raw: string): string {
  return (
    raw
      // Strip path separators
      .replace(/[/\\]/g, '_')
      // Strip control characters (0x00–0x1F, 0x7F) without control char regex literals
      .split('')
      .filter((c) => { const code = c.charCodeAt(0); return code > 31 && code !== 127; })
      .join('')
      // Strip leading dots (hidden files on Unix)
      .replace(/^\.+/, '')
      // Trim whitespace
      .trim()
      // Limit to 255 characters
      .slice(0, 255) || 'file'
  );
}

/** Read file to ArrayBuffer with progress tracking */
function readFileAsArrayBuffer(
  file: File,
  onProgress?: (progress: number) => void
): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = () => reject(new Error('Failed to read file'));
    if (onProgress) {
      reader.onprogress = (e) => {
        if (e.lengthComputable) {
          onProgress(e.loaded / e.total);
        }
      };
    }
    reader.readAsArrayBuffer(file);
  });
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

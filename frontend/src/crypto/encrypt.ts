/**
 * Archivum Null — Client-side Zero-Knowledge Encryption
 *
 * Uses WebCrypto API exclusively:
 *   - AES-256-GCM (authenticated encryption)
 *   - 256-bit key from crypto.getRandomValues
 *   - Unique IV per encryption
 *   - Key NEVER leaves the browser (stored in URL fragment only)
 */

const ALGORITHM = 'AES-GCM';
const KEY_LENGTH = 256;
const IV_LENGTH = 12; // 96 bits recommended for AES-GCM

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
 * Returns: IV (12 bytes) || ciphertext
 * The IV is prepended to the ciphertext for self-contained decryption.
 */
export async function encryptFile(
  file: File,
  key: CryptoKey,
  onProgress?: (progress: number) => void
): Promise<Blob> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));

  // Read file as ArrayBuffer
  const plaintext = await readFileAsArrayBuffer(file, onProgress);

  const ciphertext = await crypto.subtle.encrypt(
    { name: ALGORITHM, iv },
    key,
    plaintext
  );

  // Prepend IV to ciphertext
  const combined = new Uint8Array(IV_LENGTH + ciphertext.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(ciphertext), IV_LENGTH);

  return new Blob([combined], { type: 'application/octet-stream' });
}

/**
 * Decrypt ciphertext.
 * Expects: IV (12 bytes) || ciphertext
 */
export async function decryptFile(
  encryptedBlob: Blob,
  key: CryptoKey,
  originalName: string,
  mimeType: string
): Promise<File> {
  const data = new Uint8Array(await encryptedBlob.arrayBuffer());

  if (data.length < IV_LENGTH + 16) {
    // AES-GCM tag is 16 bytes minimum
    throw new Error('Invalid encrypted data: too short');
  }

  const iv = data.slice(0, IV_LENGTH);
  const ciphertext = data.slice(IV_LENGTH);

  const plaintext = await crypto.subtle.decrypt(
    { name: ALGORITHM, iv },
    key,
    ciphertext
  );

  return new File([plaintext], originalName, { type: mimeType });
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

import {
  encryptChunk,
  buildMetadataHeader,
  calculateTotalEncryptedSize,
  PER_CHUNK_OVERHEAD,
} from '../crypto/encrypt.ts';

const API_BASE = '/api';

export interface VaultCreateResponse {
  vaultId: string;
  expiresAt: number;
  maxDownloads: number;
  ciphertextSize: number;
}

export interface VaultInfo {
  vaultId: string;
  ciphertextSize: number;
  chunkPlaintextSize: number;
  createdAt: number;
  expiresAt: number;
  remainingDownloads: number;
}

interface ChunkInitResponse {
  uploadId: string;
  chunkSize: number;
  expiresAt: number;
  sessionToken: string;
}

// ── Virtual plaintext stream ────────────────────────────────────────────────
// Composed of [metadata header | file bytes].  Allows reading arbitrary ranges
// across the boundary without materialising the entire plaintext in memory.

async function readVirtualRange(
  header: Uint8Array,
  file: File,
  start: number,
  end: number,
): Promise<Uint8Array> {
  const result = new Uint8Array(end - start);
  let offset = 0;

  if (start < header.length) {
    const headerEnd = Math.min(header.length, end);
    result.set(header.subarray(start, headerEnd), offset);
    offset += headerEnd - start;
  }

  if (end > header.length) {
    const fileStart = Math.max(0, start - header.length);
    const fileEnd = end - header.length;
    const ab = await file.slice(fileStart, fileEnd).arrayBuffer();
    result.set(new Uint8Array(ab), offset);
  }

  return result;
}

// ── Single-request upload ───────────────────────────────────────────────────

/**
 * Upload a file using single-request protocol with streaming encryption.
 * Crypto chunks are produced first, then the combined ciphertext is sent
 * in a single XHR for upload progress tracking.
 */
export async function uploadVault(
  file: File,
  key: CryptoKey,
  chunkPlaintextSize: number,
  ttl: number,
  maxDownloads: number,
  turnstileToken?: string,
  onProgress?: (progress: number) => void,
  signal?: AbortSignal,
): Promise<VaultCreateResponse> {
  const header = buildMetadataHeader(file.name, file.type);
  const totalPlaintext = header.length + file.size;
  const numCryptoChunks = Math.max(1, Math.ceil(totalPlaintext / chunkPlaintextSize));

  // Encrypt all crypto chunks. Each ciphertext chunk is wrapped in a Blob right
  // away so the JS heap holds one chunk at a time rather than the whole encrypted
  // file; the browser manages the accumulated Blob parts.
  const encryptedParts: BlobPart[] = [];
  for (let i = 0; i < numCryptoChunks; i++) {
    signal?.throwIfAborted();
    const start = i * chunkPlaintextSize;
    const end = Math.min(start + chunkPlaintextSize, totalPlaintext);
    const plaintext = await readVirtualRange(header, file, start, end);
    const encrypted = await encryptChunk(plaintext as Uint8Array<ArrayBuffer>, key, i, i === numCryptoChunks - 1);
    encryptedParts.push(new Blob([encrypted]));
    onProgress?.(((i + 1) / numCryptoChunks) * 0.3);
  }

  signal?.throwIfAborted();
  const encryptedBlob = new Blob(encryptedParts);

  const formData = new FormData();
  // Text fields must come before the file — @fastify/multipart only exposes
  // fields already parsed before the file stream starts (data.fields).
  formData.append('ttl', String(ttl));
  formData.append('maxDownloads', String(maxDownloads));
  formData.append('chunkPlaintextSize', String(chunkPlaintextSize));
  formData.append('file', encryptedBlob, 'encrypted.bin');

  const headers: Record<string, string> = {};
  if (turnstileToken) headers['x-turnstile-token'] = turnstileToken;

  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${API_BASE}/vault`);
    Object.entries(headers).forEach(([k, v]) => xhr.setRequestHeader(k, v));

    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) {
        onProgress(0.3 + (e.loaded / e.total) * 0.7);
      }
    };

    xhr.onload = () => {
      if (xhr.status === 201) {
        try { resolve(JSON.parse(xhr.responseText)); }
        catch { reject(new Error('Invalid response from server after upload')); }
      } else {
        try {
          const err = JSON.parse(xhr.responseText);
          reject(new Error(err.error || `Upload failed (${xhr.status})`));
        } catch { reject(new Error(`Upload failed (${xhr.status}) – backend unreachable`)); }
      }
    };

    xhr.onerror = () => reject(new Error('Network error during upload'));

    if (signal) {
      signal.addEventListener('abort', () => {
        xhr.abort();
        reject(signal.reason ?? new DOMException('Upload cancelled', 'AbortError'));
      });
    }

    xhr.send(formData);
  });
}

export async function getVaultInfo(vaultId: string): Promise<VaultInfo> {
  const res = await fetch(`${API_BASE}/vault/${encodeURIComponent(vaultId)}`);
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Request failed' }));
    throw new Error(err.error || `Failed to get vault info (${res.status})`);
  }
  return res.json();
}

export async function downloadVault(vaultId: string): Promise<Blob> {
  const res = await fetch(`${API_BASE}/vault/${encodeURIComponent(vaultId)}/download`);
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Download failed' }));
    throw new Error(err.error || `Download failed (${res.status})`);
  }
  return res.blob();
}

// ── Chunked upload ──────────────────────────────────────────────────────────
// Interleaves encryption with upload: for each HTTP chunk, encrypt a batch
// of crypto chunks, concatenate them, and upload via the init → chunk × N →
// complete protocol.

/** Ask the server to abort a chunked upload session and delete partial data. */
async function abortUploadSession(uploadId: string, sessionToken: string): Promise<void> {
  await fetch(
    `${API_BASE}/vault/upload/${encodeURIComponent(uploadId)}`,
    { method: 'DELETE', headers: { 'x-session-token': sessionToken } },
  );
}

/**
 * Upload a file using the chunked upload protocol with streaming encryption.
 * Crypto chunks are grouped into HTTP-sized batches and uploaded sequentially.
 */
export async function uploadVaultChunked(
  file: File,
  key: CryptoKey,
  chunkPlaintextSize: number,
  ttl: number,
  maxDownloads: number,
  turnstileToken?: string,
  onProgress?: (progress: number) => void,
  signal?: AbortSignal,
): Promise<VaultCreateResponse> {
  const header = buildMetadataHeader(file.name, file.type);
  const totalPlaintext = header.length + file.size;
  const totalEncrypted = calculateTotalEncryptedSize(totalPlaintext, chunkPlaintextSize);
  const numCryptoChunks = Math.max(1, Math.ceil(totalPlaintext / chunkPlaintextSize));

  // 1. Init session
  const initHeaders: Record<string, string> = { 'Content-Type': 'application/json' };
  if (turnstileToken) initHeaders['x-turnstile-token'] = turnstileToken;

  const initRes = await fetch(`${API_BASE}/vault/upload/init`, {
    method: 'POST',
    headers: initHeaders,
    body: JSON.stringify({ totalSize: totalEncrypted, ttl, maxDownloads, chunkPlaintextSize }),
    signal,
  });

  if (!initRes.ok) {
    const err = await initRes.json().catch(() => ({ error: 'Upload init failed' }));
    throw new Error(err.error || `Upload init failed (${initRes.status})`);
  }

  const { uploadId, chunkSize: httpChunkSize, sessionToken } = (await initRes.json()) as ChunkInitResponse;

  // 2. Encrypt + upload crypto chunks grouped into HTTP chunks
  const encryptedChunkSize = chunkPlaintextSize + PER_CHUNK_OVERHEAD;
  const cryptoChunksPerHttp = Math.max(1, Math.floor(httpChunkSize / encryptedChunkSize));
  let cryptoIdx = 0;
  let httpChunkIdx = 0;

  try {
    while (cryptoIdx < numCryptoChunks) {
      signal?.throwIfAborted();
      const batchEnd = Math.min(cryptoIdx + cryptoChunksPerHttp, numCryptoChunks);
      const parts: BlobPart[] = [];

      for (let i = cryptoIdx; i < batchEnd; i++) {
        signal?.throwIfAborted();
        const start = i * chunkPlaintextSize;
        const end = Math.min(start + chunkPlaintextSize, totalPlaintext);
        const plaintext = await readVirtualRange(header, file, start, end);
        parts.push(await encryptChunk(plaintext as Uint8Array<ArrayBuffer>, key, i, i === numCryptoChunks - 1));
      }

      const form = new FormData();
      form.append('chunkIndex', String(httpChunkIdx));
      form.append('file', new Blob(parts), 'chunk.bin');

      const chunkRes = await fetch(
        `${API_BASE}/vault/upload/${encodeURIComponent(uploadId)}/chunk`,
        { method: 'POST', body: form, signal, headers: { 'x-session-token': sessionToken } },
      );

      if (!chunkRes.ok) {
        const err = await chunkRes.json().catch(() => ({ error: 'Chunk upload failed' }));
        throw new Error(err.error || `Chunk ${httpChunkIdx} upload failed (${chunkRes.status})`);
      }

      cryptoIdx = batchEnd;
      httpChunkIdx++;
      onProgress?.(cryptoIdx / numCryptoChunks);
    }
  } catch (err) {
    // On any failure (including abort), tell the server to clean up partial data
    await abortUploadSession(uploadId, sessionToken).catch(() => {});
    throw err;
  }

  // 3. Complete
  const completeRes = await fetch(
    `${API_BASE}/vault/upload/${encodeURIComponent(uploadId)}/complete`,
    { method: 'POST', signal, headers: { 'x-session-token': sessionToken } },
  );

  if (!completeRes.ok) {
    const err = await completeRes.json().catch(() => ({ error: 'Upload finalization failed' }));
    throw new Error(err.error || `Upload finalization failed (${completeRes.status})`);
  }

  return (await completeRes.json()) as VaultCreateResponse;
}

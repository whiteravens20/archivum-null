import {
  encryptChunk,
  buildMetadataHeader,
  calculateTotalEncryptedSize,
  countChunks,
  PER_CHUNK_OVERHEAD,
} from '../crypto/encrypt.ts';
import { ApiError } from './errors.ts';

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

/**
 * fetch, with a request that got no answer at all reported as an ApiError without a
 * status. A cancelled request is passed on as it is.
 */
async function request(...args: Parameters<typeof fetch>): Promise<Response> {
  try {
    return await fetch(...args);
  } catch (err) {
    if (args[1]?.signal?.aborted) throw err;
    throw new ApiError(null, err instanceof Error ? err.message : 'Network error');
  }
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
  const numCryptoChunks = countChunks(totalPlaintext, chunkPlaintextSize);

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
        catch { reject(new ApiError(xhr.status, 'Invalid response from server after upload')); }
      } else {
        try {
          const err = JSON.parse(xhr.responseText);
          reject(new ApiError(xhr.status, err.error || `Upload failed (${xhr.status})`));
        } catch { reject(new ApiError(xhr.status, `Upload failed (${xhr.status}) – backend unreachable`)); }
      }
    };

    xhr.onerror = () => reject(new ApiError(null, 'Network error during upload'));

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
  const res = await request(`${API_BASE}/vault/${encodeURIComponent(vaultId)}`);
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Request failed' }));
    throw new ApiError(res.status, err.error || `Failed to get vault info (${res.status})`);
  }
  return res.json();
}

export async function downloadVault(vaultId: string): Promise<Blob> {
  const res = await request(`${API_BASE}/vault/${encodeURIComponent(vaultId)}/download`);
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Download failed' }));
    throw new ApiError(res.status, err.error || `Download failed (${res.status})`);
  }
  return res.blob();
}

// ── Chunked upload ──────────────────────────────────────────────────────────
// Interleaves encryption with upload: for each HTTP chunk, encrypt a batch
// of crypto chunks, concatenate them, and upload via the init → chunk × N →
// complete protocol.

/** How often one chunk is sent before the upload gives up. */
const CHUNK_ATTEMPTS = 4;
/** The pause before the second attempt; it doubles with every further one. */
const RETRY_BASE_MS = 1000;
/** No pause is longer than this, whatever the server asks for. */
const RETRY_MAX_MS = 60_000;

/** A pause that ends early, by rejecting, when the upload is cancelled. */
function pause(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** How long to wait before sending a chunk again: what the server asks for, or a growing pause. */
function retryDelay(response: Response | null, attempt: number): number {
  const retryAfter = Number(response?.headers.get('Retry-After'));
  const wanted = Number.isFinite(retryAfter) && retryAfter > 0
    ? retryAfter * 1000
    : RETRY_BASE_MS * 2 ** (attempt - 1);
  return Math.min(wanted, RETRY_MAX_MS);
}

/**
 * Send one HTTP chunk, again when the failure is one another attempt can get past: the
 * network, a rate limit, a busy session, a server error. Resolves once the server has
 * the chunk.
 */
async function sendChunk(
  uploadId: string,
  sessionToken: string,
  chunkIndex: number,
  data: Blob,
  signal?: AbortSignal,
): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    signal?.throwIfAborted();

    let response: Response | null = null;
    let networkError: unknown;
    try {
      const form = new FormData();
      form.append('chunkIndex', String(chunkIndex));
      form.append('file', data, 'chunk.bin');
      response = await request(
        `${API_BASE}/vault/upload/${encodeURIComponent(uploadId)}/chunk`,
        { method: 'POST', body: form, signal, headers: { 'x-session-token': sessionToken } },
      );
    } catch (err) {
      if (signal?.aborted) throw err;
      networkError = err;
    }

    if (response?.ok) return;

    if (response?.status === 400) {
      // The body is whatever the server sent; only the one field is looked at.
      const body = (await response.json().catch(() => null)) as { error?: string; expectedChunkIndex?: number } | null;
      // The server expects the chunk after this one: it stored this chunk on an earlier
      // attempt, and only the response to that attempt was lost.
      if (attempt > 1 && body?.expectedChunkIndex === chunkIndex + 1) return;
      throw new ApiError(400, body?.error || `Chunk ${chunkIndex} upload failed (400)`);
    }

    const retryable =
      response === null || response.status === 409 || response.status === 429 || response.status >= 500;
    if (!retryable || attempt === CHUNK_ATTEMPTS) {
      if (response === null) throw networkError;
      const body = await response.json().catch(() => ({ error: 'Chunk upload failed' }));
      throw new ApiError(response.status, body.error || `Chunk ${chunkIndex} upload failed (${response.status})`);
    }

    await pause(retryDelay(response, attempt), signal);
  }
}

/** Ask the server to abort a chunked upload session and delete partial data. */
async function abortUploadSession(uploadId: string, sessionToken: string): Promise<void> {
  await fetch(
    `${API_BASE}/vault/upload/${encodeURIComponent(uploadId)}`,
    { method: 'DELETE', headers: { 'x-session-token': sessionToken } },
  );
}

/**
 * Upload a file using the chunked upload protocol with streaming encryption.
 * Crypto chunks are grouped into HTTP-sized batches and uploaded sequentially;
 * a batch that fails to arrive is sent again (see sendChunk).
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
  const numCryptoChunks = countChunks(totalPlaintext, chunkPlaintextSize);

  // 1. Init session
  const initHeaders: Record<string, string> = { 'Content-Type': 'application/json' };
  if (turnstileToken) initHeaders['x-turnstile-token'] = turnstileToken;

  const initRes = await request(`${API_BASE}/vault/upload/init`, {
    method: 'POST',
    headers: initHeaders,
    body: JSON.stringify({ totalSize: totalEncrypted, ttl, maxDownloads, chunkPlaintextSize }),
    signal,
  });

  if (!initRes.ok) {
    const err = await initRes.json().catch(() => ({ error: 'Upload init failed' }));
    throw new ApiError(initRes.status, err.error || `Upload init failed (${initRes.status})`);
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

      await sendChunk(uploadId, sessionToken, httpChunkIdx, new Blob(parts), signal);

      cryptoIdx = batchEnd;
      httpChunkIdx++;
      onProgress?.(cryptoIdx / numCryptoChunks);
    }

    // 3. Complete
    const completeRes = await request(
      `${API_BASE}/vault/upload/${encodeURIComponent(uploadId)}/complete`,
      { method: 'POST', signal, headers: { 'x-session-token': sessionToken } },
    );

    if (!completeRes.ok) {
      const err = await completeRes.json().catch(() => ({ error: 'Upload finalization failed' }));
      throw new ApiError(completeRes.status, err.error || `Upload finalization failed (${completeRes.status})`);
    }

    return (await completeRes.json()) as VaultCreateResponse;
  } catch (err) {
    // On any failure (including abort), tell the server to clean up partial data.
    // That covers a failed completion too: without it the session and what it holds
    // would stay until the session expires.
    await abortUploadSession(uploadId, sessionToken).catch(() => {});
    throw err;
  }
}

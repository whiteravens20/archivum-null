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
  createdAt: number;
  expiresAt: number;
  remainingDownloads: number;
}

export async function uploadVault(
  encryptedBlob: Blob,
  ttl: number,
  maxDownloads: number,
  turnstileToken?: string,
  onProgress?: (progress: number) => void
): Promise<VaultCreateResponse> {
  const formData = new FormData();
  // Text fields must come before the file — @fastify/multipart only exposes
  // fields already parsed before the file stream starts (data.fields).
  formData.append('ttl', String(ttl));
  formData.append('maxDownloads', String(maxDownloads));
  formData.append('file', encryptedBlob, 'encrypted.bin');

  const headers: Record<string, string> = {};
  if (turnstileToken) {
    headers['x-turnstile-token'] = turnstileToken;
  }

  // Use XMLHttpRequest for upload progress
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${API_BASE}/vault`);

    Object.entries(headers).forEach(([k, v]) => xhr.setRequestHeader(k, v));

    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) {
        onProgress(e.loaded / e.total);
      }
    };

    xhr.onload = () => {
      if (xhr.status === 201) {
        try {
          resolve(JSON.parse(xhr.responseText));
        } catch {
          reject(new Error('Invalid response from server after upload'));
        }
      } else {
        try {
          const err = JSON.parse(xhr.responseText);
          reject(new Error(err.error || `Upload failed (${xhr.status})`));
        } catch {
          reject(new Error(`Upload failed (${xhr.status}) – backend unreachable`));
        }
      }
    };

    xhr.onerror = () => reject(new Error('Network error during upload'));
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
// Splits the encrypted blob into chunks that individually stay below a size
// limit (e.g. Cloudflare's 100 MB per-request cap) and uploads them through
// an init → chunk × N → complete flow.

interface ChunkInitResponse {
  uploadId: string;
  chunkSize: number;
  expiresAt: number;
}

/**
 * Upload an encrypted blob using the chunked upload protocol.
 * Falls back to single-request upload if the blob is small enough.
 */
export async function uploadVaultChunked(
  encryptedBlob: Blob,
  ttl: number,
  maxDownloads: number,
  turnstileToken?: string,
  onProgress?: (progress: number) => void,
): Promise<VaultCreateResponse> {
  // 1. Init session
  const initHeaders: Record<string, string> = { 'Content-Type': 'application/json' };
  if (turnstileToken) initHeaders['x-turnstile-token'] = turnstileToken;

  const initRes = await fetch(`${API_BASE}/vault/upload/init`, {
    method: 'POST',
    headers: initHeaders,
    body: JSON.stringify({ totalSize: encryptedBlob.size, ttl, maxDownloads }),
  });

  if (!initRes.ok) {
    const err = await initRes.json().catch(() => ({ error: 'Upload init failed' }));
    throw new Error(err.error || `Upload init failed (${initRes.status})`);
  }

  const { uploadId, chunkSize } = (await initRes.json()) as ChunkInitResponse;

  // 2. Upload chunks sequentially
  const totalChunks = Math.ceil(encryptedBlob.size / chunkSize);
  for (let i = 0; i < totalChunks; i++) {
    const start = i * chunkSize;
    const end = Math.min(start + chunkSize, encryptedBlob.size);
    const chunkBlob = encryptedBlob.slice(start, end);

    const form = new FormData();
    form.append('chunkIndex', String(i));
    form.append('file', chunkBlob, 'chunk.bin');

    const chunkRes = await fetch(`${API_BASE}/vault/upload/${encodeURIComponent(uploadId)}/chunk`, {
      method: 'POST',
      body: form,
    });

    if (!chunkRes.ok) {
      const err = await chunkRes.json().catch(() => ({ error: 'Chunk upload failed' }));
      throw new Error(err.error || `Chunk ${i} upload failed (${chunkRes.status})`);
    }

    onProgress?.((i + 1) / totalChunks);
  }

  // 3. Complete
  const completeRes = await fetch(`${API_BASE}/vault/upload/${encodeURIComponent(uploadId)}/complete`, {
    method: 'POST',
  });

  if (!completeRes.ok) {
    const err = await completeRes.json().catch(() => ({ error: 'Upload finalization failed' }));
    throw new Error(err.error || `Upload finalization failed (${completeRes.status})`);
  }

  return (await completeRes.json()) as VaultCreateResponse;
}

const API_BASE = '/api';

export interface VaultCreateResponse {
  vaultId: string;
  expiresAt: number;
  maxDownloads: number;
  ciphertextSize: number;
}

export interface VaultInfo {
  vaultId: string;
  originalName: string;
  mimeType: string;
  ciphertextSize: number;
  createdAt: number;
  expiresAt: number;
  remainingDownloads: number;
}

export async function uploadVault(
  encryptedBlob: Blob,
  _originalName: string,
  ttl: number,
  maxDownloads: number,
  turnstileToken?: string,
  onProgress?: (progress: number) => void
): Promise<VaultCreateResponse> {
  const formData = new FormData();
  formData.append('file', encryptedBlob, 'encrypted.bin');
  formData.append('ttl', String(ttl));
  formData.append('maxDownloads', String(maxDownloads));

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

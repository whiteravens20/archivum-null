export interface VaultMetadata {
  vaultId: string;
  ciphertextSize: number;
  createdAt: number;
  expiresAt: number;
  remainingDownloads: number;
  maxDownloads: number;
}

export interface CreateVaultRequest {
  ttl?: number;
  maxDownloads?: number;
}

export interface VaultPublicInfo {
  vaultId: string;
  ciphertextSize: number;
  createdAt: number;
  expiresAt: number;
  remainingDownloads: number;
}

/** Tracks an in-progress chunked upload before it is finalized into a vault. */
export interface ChunkedUploadSession {
  uploadId: string;
  /** Expected total ciphertext size declared by the client. */
  totalSize: number;
  /** Bytes received so far. */
  receivedBytes: number;
  /** Next expected chunk index (0-based). */
  nextChunkIndex: number;
  /** Vault config supplied at init time. */
  ttl: number;
  maxDownloads: number;
  /** Absolute timestamp (ms) after which the session is garbage-collected. */
  expiresAt: number;
}

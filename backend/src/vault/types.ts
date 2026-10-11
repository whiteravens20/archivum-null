export interface VaultMetadata {
  vaultId: string;
  ciphertextSize: number;
  /** Per-chunk plaintext size used for client-side streaming AES-GCM encryption. */
  chunkPlaintextSize: number;
  createdAt: number;
  expiresAt: number;
  remainingDownloads: number;
  maxDownloads: number;
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
  /** Per-chunk plaintext size for streaming AES-GCM encryption. */
  chunkPlaintextSize: number;
  /** Absolute timestamp (ms) after which the session is garbage-collected. */
  expiresAt: number;
  /** Client IP that opened the session — used to cap concurrent sessions per IP. */
  clientIp?: string;
  /** Set while a chunk is being written or the upload is being finalised. */
  writing?: boolean;
}

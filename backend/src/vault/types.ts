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
  /** The wider network of that client, when it has one: it shares a cap as well. */
  clientNetwork?: string | null;
  /** When the session was opened, or a chunk last finished (ms). */
  lastActivityAt: number;
  /** Set while a chunk is being written or the upload is being finalised. */
  writing?: boolean;
  /**
   * Set while the session holds its quota reservation and its slot in the count of what
   * its client has running. Cleared when they are given back, so that they are given
   * back once and no other upload loses them.
   */
  accounted?: boolean;
}

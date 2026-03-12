import type { Readable } from 'node:stream';
import type { VaultMetadata } from '../vault/types.js';

export interface StorageBackend {
  init(): Promise<void>;
  writeFile(vaultId: string, stream: Readable, maxSize?: number): Promise<number>;
  readFile(vaultId: string): Promise<Readable | null>;
  writeMetadata(vaultId: string, meta: VaultMetadata): Promise<void>;
  readMetadata(vaultId: string): Promise<VaultMetadata | null>;
  deleteVault(vaultId: string): Promise<boolean>;
  listVaults(): Promise<string[]>;
  /** Append a chunk to an in-progress upload identified by uploadId. Returns total bytes written so far. */
  appendChunk(uploadId: string, stream: Readable, maxTotalSize: number, currentSize: number): Promise<number>;
  /** Move the assembled chunk file into a finalized vault directory. */
  finalizeChunkedUpload(uploadId: string, vaultId: string): Promise<void>;
  /** Remove temporary chunk directory (cleanup on abort / timeout). */
  deleteChunkedUpload(uploadId: string): Promise<void>;
  /** Remove all _uploads directories that have no matching in-memory session (orphan cleanup on restart). */
  purgeOrphanedUploads(activeUploadIds: Set<string>): Promise<void>;
}

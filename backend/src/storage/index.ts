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
}

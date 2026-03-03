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

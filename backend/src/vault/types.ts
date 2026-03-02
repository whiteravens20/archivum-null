export interface VaultMetadata {
  vaultId: string;
  ciphertextSize: number;
  originalName: string;
  mimeType: string;
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
  originalName: string;
  mimeType: string;
  ciphertextSize: number;
  createdAt: number;
  expiresAt: number;
  remainingDownloads: number;
}

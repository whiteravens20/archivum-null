import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

// Mock crypto and API modules
vi.mock('../crypto/encrypt.js', () => ({
  importKey: vi.fn(),
  decryptFile: vi.fn(),
  formatBytes: (n: number) => `${n} B`,
}));

const mockGetVaultInfo = vi.fn();
const mockDownloadVault = vi.fn();
vi.mock('../api/vault.js', () => ({
  getVaultInfo: (...args: unknown[]) => mockGetVaultInfo(...args),
  downloadVault: (...args: unknown[]) => mockDownloadVault(...args),
}));

function renderVault(vaultId: string, hash = '') {
  // Set hash before render
  window.location.hash = hash;

  return render(
    <MemoryRouter initialEntries={[`/vault/${vaultId}`]}>
      <Routes>
        <Route path="/vault/:vaultId" element={<VaultPage />} />
      </Routes>
    </MemoryRouter>
  );
}

// Lazily imported so mocks are already in place
let VaultPage: React.ComponentType;

describe('Vault page', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    window.location.hash = '';
    const mod = await import('../pages/Vault.js');
    VaultPage = mod.default;
  });

  it('should show loading state while fetching vault info', () => {
    mockGetVaultInfo.mockReturnValue(new Promise(() => {})); // never resolves
    renderVault('abc123');
    expect(screen.getByText('Loading vault...')).toBeInTheDocument();
  });

  it('should show error when vault is not found', async () => {
    mockGetVaultInfo.mockRejectedValue(new Error('Vault not found'));
    renderVault('bad-id');
    await waitFor(() => {
      expect(screen.getByText('Vault unavailable')).toBeInTheDocument();
    });
    expect(screen.getByText('Vault not found')).toBeInTheDocument();
  });

  it('should show vault info when loaded', async () => {
    mockGetVaultInfo.mockResolvedValue({
      vaultId: 'abc',
      ciphertextSize: 2048,
      createdAt: Date.now(),
      expiresAt: Date.now() + 3600_000,
      remainingDownloads: 3,
    });
    renderVault('abc', '#somekey43chars1234567890AB');

    await waitFor(() => {
      expect(screen.getByText('2048 B')).toBeInTheDocument();
    });
    expect(screen.getByText('3')).toBeInTheDocument();
    expect(screen.getByText('Decrypt & Download')).toBeInTheDocument();
  });

  it('should show key warning when no key in fragment', async () => {
    mockGetVaultInfo.mockResolvedValue({
      vaultId: 'abc',
      ciphertextSize: 100,
      createdAt: Date.now(),
      expiresAt: Date.now() + 3600_000,
      remainingDownloads: 1,
    });
    renderVault('abc', '');

    await waitFor(() => {
      expect(
        screen.getByText(/No decryption key found in URL/)
      ).toBeInTheDocument();
    });
  });

  it('should render the branding', () => {
    mockGetVaultInfo.mockReturnValue(new Promise(() => {}));
    renderVault('x');
    expect(screen.getByText('Archivum Null')).toBeInTheDocument();
    expect(screen.getByText('Vault retrieval')).toBeInTheDocument();
  });
});

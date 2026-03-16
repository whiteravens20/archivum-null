import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

// Mock crypto and API modules
const mockImportKey = vi.fn();
const mockDecryptChunk = vi.fn();
const mockParseMetadataHeader = vi.fn();

vi.mock('../crypto/encrypt.js', () => ({
  importKey: (...args: unknown[]) => mockImportKey(...args),
  decryptChunk: (...args: unknown[]) => mockDecryptChunk(...args),
  parseMetadataHeader: (...args: unknown[]) => mockParseMetadataHeader(...args),
  sanitizeFilename: (name: string) => name,
  PER_CHUNK_OVERHEAD: 28,
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
      chunkPlaintextSize: 5242880,
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
      chunkPlaintextSize: 5242880,
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

  describe('filename mismatch warning', () => {
    const fakeKey = 'A'.repeat(43);

    function encodeFragmentFilename(name: string): string {
      const bytes = new TextEncoder().encode(name);
      let bin = '';
      bytes.forEach((b) => (bin += String.fromCharCode(b)));
      return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    }

    function mockDownloadFlow(decryptedFilename: string) {
      mockDownloadVault.mockResolvedValue(new Blob([new Uint8Array(128)]));
      mockImportKey.mockResolvedValue('fake-key');
      mockDecryptChunk.mockResolvedValue(new Uint8Array(100));
      mockParseMetadataHeader.mockReturnValue({
        filename: decryptedFilename,
        mimeType: 'application/octet-stream',
        contentOffset: 10,
      });
    }

    beforeEach(() => {
      globalThis.URL.createObjectURL = vi.fn(() => 'blob:test');
      globalThis.URL.revokeObjectURL = vi.fn();
    });

    it('should show warning when decrypted filename differs from fragment filename', async () => {
      const encodedName = encodeFragmentFilename('test.txt');

      mockGetVaultInfo.mockResolvedValue({
        vaultId: 'abc',
        ciphertextSize: 128,
        chunkPlaintextSize: 100,
        createdAt: Date.now(),
        expiresAt: Date.now() + 3600_000,
        remainingDownloads: 3,
      });

      renderVault('abc', `#${fakeKey}.${encodedName}`);

      await waitFor(() => {
        expect(screen.getByText('Decrypt & Download')).toBeInTheDocument();
      });

      // Fragment should display "test.txt" in vault metadata
      expect(screen.getByText('test.txt')).toBeInTheDocument();

      mockDownloadFlow('malicious.exe');
      fireEvent.click(screen.getByText('Decrypt & Download'));

      await waitFor(() => {
        expect(screen.getByText(/Filename mismatch detected/)).toBeInTheDocument();
      });
      expect(screen.getByText(/malicious\.exe/)).toBeInTheDocument();
    });

    it('should not show warning when filenames match', async () => {
      const encodedName = encodeFragmentFilename('secret.pdf');

      mockGetVaultInfo.mockResolvedValue({
        vaultId: 'abc',
        ciphertextSize: 128,
        chunkPlaintextSize: 100,
        createdAt: Date.now(),
        expiresAt: Date.now() + 3600_000,
        remainingDownloads: 3,
      });

      renderVault('abc', `#${fakeKey}.${encodedName}`);

      await waitFor(() => {
        expect(screen.getByText('Decrypt & Download')).toBeInTheDocument();
      });

      mockDownloadFlow('secret.pdf');
      fireEvent.click(screen.getByText('Decrypt & Download'));

      await waitFor(() => {
        expect(screen.getByText('Download again')).toBeInTheDocument();
      });

      expect(screen.queryByText(/Filename mismatch detected/)).not.toBeInTheDocument();
    });

    it('should not show warning when fragment has no filename', async () => {
      mockGetVaultInfo.mockResolvedValue({
        vaultId: 'abc',
        ciphertextSize: 128,
        chunkPlaintextSize: 100,
        createdAt: Date.now(),
        expiresAt: Date.now() + 3600_000,
        remainingDownloads: 3,
      });

      renderVault('abc', `#${fakeKey}`); // no dot → no fragment filename

      await waitFor(() => {
        expect(screen.getByText('Decrypt & Download')).toBeInTheDocument();
      });

      mockDownloadFlow('anything.bin');
      fireEvent.click(screen.getByText('Decrypt & Download'));

      await waitFor(() => {
        expect(screen.getByText('Download again')).toBeInTheDocument();
      });

      expect(screen.queryByText(/Filename mismatch detected/)).not.toBeInTheDocument();
    });
  });
});

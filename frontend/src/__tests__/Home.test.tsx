import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

// Mock heavy dependencies so Home renders without them
vi.mock('../crypto/encrypt.js', () => ({
  generateKey: vi.fn(),
  exportKey: vi.fn(),
  buildMetadataHeader: vi.fn(() => new Uint8Array(8)),
  calculateTotalEncryptedSize: vi.fn((_size: number) => 100),
}));

vi.mock('../api/vault.js', () => ({
  uploadVault: vi.fn(),
  uploadVaultChunked: vi.fn(),
}));

vi.mock('../components/Turnstile.js', () => ({
  default: () => null,
}));

const mockConfig = {
  maxFileSize: 104857600,
  chunkSize: 10485760,
  cryptoChunkSize: 5242880,
  defaultTtl: 86400,
  defaultMaxDownloads: 10,
  turnstileSiteKey: '0x0000000000000000000000',
  turnstileEnabled: false,
};

describe('Home', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      json: () => Promise.resolve(mockConfig),
    }));
  });

  it('should render the heading', async () => {
    const { default: Home } = await import('../pages/Home.js');
    render(
      <MemoryRouter>
        <Home />
      </MemoryRouter>
    );
    expect(screen.getByText('Archivum Null')).toBeInTheDocument();
  });

  it('should render the tagline', async () => {
    const { default: Home } = await import('../pages/Home.js');
    render(
      <MemoryRouter>
        <Home />
      </MemoryRouter>
    );
    expect(screen.getByText('Zero trust file relay')).toBeInTheDocument();
  });

  it('should render the privacy tags', async () => {
    const { default: Home } = await import('../pages/Home.js');
    render(
      <MemoryRouter>
        <Home />
      </MemoryRouter>
    );
    expect(screen.getByText('No accounts')).toBeInTheDocument();
    expect(screen.getByText('No cookies')).toBeInTheDocument();
    expect(screen.getByText('No tracking')).toBeInTheDocument();
    expect(screen.getByText('Zero-knowledge')).toBeInTheDocument();
  });

  it('should render the drop zone', async () => {
    const { default: Home } = await import('../pages/Home.js');
    render(
      <MemoryRouter>
        <Home />
      </MemoryRouter>
    );
    expect(screen.getByText(/drop file or click to select/i)).toBeInTheDocument();
  });

  it('should render "How it works" section', async () => {
    const { default: Home } = await import('../pages/Home.js');
    render(
      <MemoryRouter>
        <Home />
      </MemoryRouter>
    );
    expect(screen.getByText('How it works')).toBeInTheDocument();
    expect(screen.getByText(/AES-256-GCM/)).toBeInTheDocument();
  });

  describe('CAPTCHA timeout', () => {
    const enabledConfig = { ...mockConfig, turnstileEnabled: true, turnstileSiteKey: '0xABC123' };

    beforeEach(() => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        json: () => Promise.resolve(enabledConfig),
      }));
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('should show timeout error after 10s when CAPTCHA is not verified', async () => {
      const { default: Home } = await import('../pages/Home.js');
      const { container } = render(
        <MemoryRouter>
          <Home />
        </MemoryRouter>
      );

      await waitFor(() => {
        expect(screen.getByText(/drop file or click to select/i)).toBeInTheDocument();
      });

      const fileInput = container.querySelector('input[type="file"]')!;
      await act(async () => {
        fireEvent.change(fileInput, { target: { files: [new File(['x'], 'test.txt')] } });
      });

      expect(screen.getByText('Waiting for CAPTCHA...')).toBeInTheDocument();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000);
      });

      expect(screen.getByText(/CAPTCHA verification timed out/)).toBeInTheDocument();
    });

    it('should disable upload button while waiting for CAPTCHA', async () => {
      const { default: Home } = await import('../pages/Home.js');
      const { container } = render(
        <MemoryRouter>
          <Home />
        </MemoryRouter>
      );

      await waitFor(() => {
        expect(screen.getByText(/drop file or click to select/i)).toBeInTheDocument();
      });

      const fileInput = container.querySelector('input[type="file"]')!;
      await act(async () => {
        fireEvent.change(fileInput, { target: { files: [new File(['x'], 'test.txt')] } });
      });

      const button = screen.getByRole('button', { name: /Waiting for CAPTCHA/i });
      expect(button).toBeDisabled();
    });
  });
});

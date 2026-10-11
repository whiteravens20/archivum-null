import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { setBrandingTags } from '../test/brandingTags.js';

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

// The widget itself is not rendered; what the page handed it is kept, so a test can
// answer the way Cloudflare's script would.
const turnstile = vi.hoisted(() => ({
  props: null as null | { onVerify: (token: string) => void; onError?: () => void; onExpire?: () => void },
}));

vi.mock('../components/Turnstile.js', () => ({
  default: (props: NonNullable<typeof turnstile.props>) => {
    turnstile.props = props;
    return null;
  },
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
      ok: true,
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

  it('should render the configured name and tagline', async () => {
    setBrandingTags({ 'application-name': 'Acme Drop', 'brand-tagline': 'Files, sealed' });
    const { default: Home } = await import('../pages/Home.js');
    render(
      <MemoryRouter>
        <Home />
      </MemoryRouter>
    );
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Acme Drop');
    expect(screen.getByText('Files, sealed')).toBeInTheDocument();
    expect(screen.queryByText('Archivum Null')).not.toBeInTheDocument();
  });

  it('should render markup in a configured name as text', async () => {
    setBrandingTags({ 'application-name': '<img src=x onerror=alert(1)>' });
    const { default: Home } = await import('../pages/Home.js');
    const { container } = render(
      <MemoryRouter>
        <Home />
      </MemoryRouter>
    );
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('<img src=x onerror=alert(1)>');
    expect(container.querySelector('h1 img')).toBeNull();
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

  describe('runtime configuration', () => {
    async function renderWithConfigResponse(response: unknown) {
      const fetchMock = vi.fn().mockResolvedValue(response);
      vi.stubGlobal('fetch', fetchMock);
      const { default: Home } = await import('../pages/Home.js');
      const view = render(
        <MemoryRouter>
          <Home />
        </MemoryRouter>
      );
      // Let the response be read and applied, or ignored
      await act(async () => { await Promise.resolve(); await Promise.resolve(); });
      expect(fetchMock).toHaveBeenCalledWith('/api/config');
      return view;
    }

    it('should apply the limits the server reports', async () => {
      await renderWithConfigResponse({
        ok: true,
        json: () => Promise.resolve({ ...mockConfig, maxFileSize: 20 * 1024 * 1024 }),
      });
      await waitFor(() => {
        expect(screen.getByText(/Max size: 20 MB/)).toBeInTheDocument();
      });
    });

    it('should keep the built-in limits when the server answers with an error', async () => {
      // What the rate limiter sends: valid JSON, but not a configuration
      await renderWithConfigResponse({
        ok: false,
        status: 429,
        json: () => Promise.resolve({ error: 'Too many requests. Try again later.', retryAfter: 30 }),
      });
      expect(screen.getByText(/Max size: 100 MB/)).toBeInTheDocument();
      expect(screen.queryByText(/undefined/)).not.toBeInTheDocument();
    });

    it('should keep the built-in limits when the body is not a configuration', async () => {
      await renderWithConfigResponse({
        ok: true,
        json: () => Promise.resolve({ ...mockConfig, cryptoChunkSize: 'big' }),
      });
      expect(screen.getByText(/Max size: 100 MB/)).toBeInTheDocument();
    });
  });

  describe('CAPTCHA timeout', () => {
    const enabledConfig = { ...mockConfig, turnstileEnabled: true, turnstileSiteKey: '0xABC123' };

    beforeEach(() => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(enabledConfig),
      }));
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    async function selectFile() {
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
    }

    it('should say after 10s that the CAPTCHA is still pending, and keep waiting', async () => {
      await selectFile();

      expect(screen.getByText('Waiting for CAPTCHA...')).toBeInTheDocument();
      expect(screen.queryByText(/Still waiting for the CAPTCHA/)).not.toBeInTheDocument();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000);
      });

      expect(screen.getByText(/Still waiting for the CAPTCHA/)).toBeInTheDocument();
      // Not a failure: nothing tells the visitor to give up, and the form still waits
      expect(screen.queryByText(/timed out/)).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: /Waiting for CAPTCHA/i })).toBeDisabled();
    });

    it('should drop the hint and allow the upload once the CAPTCHA verifies late', async () => {
      await selectFile();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000);
      });
      expect(screen.getByText(/Still waiting for the CAPTCHA/)).toBeInTheDocument();

      await act(async () => {
        turnstile.props?.onVerify('late-token');
      });

      expect(screen.queryByText(/Still waiting for the CAPTCHA/)).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Encrypt & Upload' })).toBeEnabled();
    });

    it('should show an error, and no hint beside it, when the widget reports a failure', async () => {
      await selectFile();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000);
      });

      await act(async () => {
        turnstile.props?.onError?.();
      });

      expect(screen.getByText(/CAPTCHA verification failed/)).toBeInTheDocument();
      expect(screen.queryByText(/Still waiting for the CAPTCHA/)).not.toBeInTheDocument();
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

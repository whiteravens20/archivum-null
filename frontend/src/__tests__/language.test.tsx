import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import I18nProvider from '../i18n/I18nProvider.js';
import Footer from '../components/Footer.js';
import Home from '../pages/Home.js';
import { uploadVault } from '../api/vault.js';
import { detectLanguage, localeFor } from '../i18n/i18n.js';

vi.mock('../crypto/encrypt.js', () => ({
  generateKey: vi.fn(async () => ({})),
  exportKey: vi.fn(async () => 'K'.repeat(43)),
  buildMetadataHeader: vi.fn(() => new Uint8Array(8)),
  calculateTotalEncryptedSize: vi.fn(() => 100),
}));

// An upload that goes on until the test lets it finish
const upload = vi.hoisted(() => ({ finish: (_result: unknown) => {} }));
vi.mock('../api/vault.js', () => ({
  uploadVault: vi.fn(() => new Promise((resolve) => { upload.finish = resolve; })),
  uploadVaultChunked: vi.fn(),
}));

function browserLanguages(list: string[]) {
  vi.spyOn(navigator, 'languages', 'get').mockReturnValue(list);
}

function chooseLanguage(current: string, lang: string) {
  fireEvent.change(screen.getByRole('combobox', { name: current }), { target: { value: lang } });
}

describe('detectLanguage', () => {
  it("should take the first of the browser's languages the interface has", () => {
    expect(detectLanguage(['pl-PL', 'en'])).toBe('pl');
    expect(detectLanguage(['en-US', 'pl'])).toBe('en');
    expect(detectLanguage(['de-DE', 'pl'])).toBe('pl');
    expect(detectLanguage(['PL'])).toBe('pl');
  });

  it('should fall back to English', () => {
    expect(detectLanguage(['de-DE', 'fr'])).toBe('en');
    expect(detectLanguage([])).toBe('en');
    expect(detectLanguage([''])).toBe('en');
  });
});

describe('localeFor', () => {
  it("should keep the visitor's own variant of the language", () => {
    expect(localeFor('en', ['en-GB', 'en'])).toBe('en-GB');
    expect(localeFor('pl', ['de-DE', 'pl-PL'])).toBe('pl-PL');
  });

  it('should use the language itself when the browser names no usable variant of it', () => {
    expect(localeFor('pl', ['en-GB'])).toBe('pl');
    expect(localeFor('en', ['en-x-'])).toBe('en');
  });
});

describe('the interface language', () => {
  function renderFooter() {
    return render(
      <I18nProvider>
        <MemoryRouter>
          <Footer />
        </MemoryRouter>
      </I18nProvider>
    );
  }

  afterEach(() => {
    window.location.hash = '';
  });

  it("should follow the browser's", () => {
    browserLanguages(['pl-PL', 'en']);
    renderFooter();
    expect(screen.getByText('Regulamin')).toBeInTheDocument();
    expect(document.documentElement.lang).toBe('pl');
  });

  it('should be English for a browser that asks for none the interface has', () => {
    browserLanguages(['de-DE']);
    renderFooter();
    expect(screen.getByText('Terms of Service')).toBeInTheDocument();
    expect(document.documentElement.lang).toBe('en');
  });

  it('should change when the visitor picks another, and leave no trace of the choice', () => {
    browserLanguages(['en-US']);
    window.location.hash = '#key.name';
    const href = window.location.href;
    const historyLength = window.history.length;
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    renderFooter();

    chooseLanguage('Language', 'pl');

    expect(screen.getByText('Regulamin')).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Język' })).toHaveValue('pl');
    expect(document.documentElement.lang).toBe('pl');
    // Not in the address, not in storage, not in a cookie
    expect(window.location.href).toBe(href);
    expect(window.history.length).toBe(historyLength);
    expect(setItem).not.toHaveBeenCalled();
    expect(localStorage.length + sessionStorage.length).toBe(0);
    expect(document.cookie).toBe('');
  });
});

describe('a change of language on the upload page', () => {
  const config = {
    maxFileSize: 104857600,
    chunkSize: 10485760,
    cryptoChunkSize: 5242860,
    defaultTtl: 86400,
    defaultMaxDownloads: 10,
    turnstileSiteKey: '0x0000000000000000000000',
    turnstileEnabled: false,
  };

  function serveConfig(overrides: Partial<typeof config> = {}) {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ ...config, ...overrides }) }));
  }

  async function openAndChooseFile() {
    const view = render(
      <I18nProvider>
        <MemoryRouter>
          <Home />
          <Footer />
        </MemoryRouter>
      </I18nProvider>
    );
    // The configuration arrives
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    await act(async () => {
      fireEvent.change(view.container.querySelector('input[type="file"]')!, {
        target: { files: [new File(['x'], 'report.pdf')] },
      });
    });
  }

  beforeEach(() => {
    browserLanguages(['en-US']);
    vi.mocked(uploadVault).mockClear();
  });

  afterEach(() => {
    delete window.turnstile;
  });

  it('should keep an upload under way going, and show its result in the new language', async () => {
    serveConfig();
    await openAndChooseFile();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Encrypt & Upload' }));
    });
    expect(screen.getByText('Encrypting & uploading...')).toBeInTheDocument();

    chooseLanguage('Language', 'pl');

    // The same upload, described in Polish
    expect(screen.getByText('Szyfrowanie i przesyłanie...')).toBeInTheDocument();
    expect(screen.getByText('report.pdf')).toBeInTheDocument();

    await act(async () => {
      upload.finish({ vaultId: 'v-1', expiresAt: 0, maxDownloads: 1, ciphertextSize: 1 });
    });

    expect(await screen.findByText('Sejf utworzony')).toBeInTheDocument();
    expect(screen.getByRole('textbox')).toHaveValue(
      `${window.location.origin}/vault/v-1#${'K'.repeat(43)}.${btoa('report.pdf').replace(/=+$/, '')}`
    );
    expect(uploadVault).toHaveBeenCalledOnce();
  });

  it('should keep a solved CAPTCHA, and translate an error already on screen', async () => {
    const widget = { render: vi.fn().mockReturnValue('widget-1'), remove: vi.fn(), reset: vi.fn() };
    window.turnstile = widget;
    serveConfig({ turnstileEnabled: true, turnstileSiteKey: '0xABC123' });
    await openAndChooseFile();

    // The component looks for the script every 100 ms
    await waitFor(() => expect(widget.render).toHaveBeenCalledOnce());
    const options = widget.render.mock.calls[0][1];
    act(() => options.callback('token-1'));
    expect(screen.getByRole('button', { name: 'Encrypt & Upload' })).toBeEnabled();

    chooseLanguage('Language', 'pl');

    // The widget was neither removed nor drawn again, so its token still counts
    expect(widget.render).toHaveBeenCalledOnce();
    expect(widget.remove).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Zaszyfruj i prześlij' })).toBeEnabled();

    act(() => options['error-callback']());
    expect(screen.getByText(/Weryfikacja CAPTCHA nie powiodła się/)).toBeInTheDocument();

    chooseLanguage('Język', 'en');
    expect(screen.getByText(/CAPTCHA verification failed/)).toBeInTheDocument();
    expect(widget.render).toHaveBeenCalledOnce();
  });
});

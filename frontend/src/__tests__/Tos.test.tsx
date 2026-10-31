import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ReactNode } from 'react';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import Tos from '../pages/Tos.js';
import Footer from '../components/Footer.js';
import I18nProvider from '../i18n/I18nProvider.js';
import { createTranslator, I18nContext, type Language } from '../i18n/i18n.js';

/** The server's answer: TOS.md, and the translations beside it. */
const mockFetch = (
  terms: string,
  ok = true,
  status = 200,
  translations: Record<string, unknown> = {},
) => {
  const fetchMock = vi.fn().mockResolvedValue({
    ok,
    status,
    json: () => Promise.resolve({ terms, translations }),
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
};

function inLanguage(lang: Language) {
  return ({ children }: { children: ReactNode }) => (
    <I18nContext.Provider value={createTranslator(lang, lang, () => {})}>
      {children}
    </I18nContext.Provider>
  );
}

describe('Tos page', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it('shows loading state initially', () => {
    // fetch never resolves during this assertion
    vi.stubGlobal('fetch', vi.fn().mockReturnValue(new Promise(() => {})));
    render(<Tos />);
    expect(screen.getByText(/loading/i)).toBeInTheDocument();
  });

  it('shows the terms as the formatted HTML the server sends', async () => {
    mockFetch(
      '<h1>Terms of Service</h1>\n<p>Use <strong>responsibly</strong>.</p>\n<ul><li>one</li><li>two</li></ul>',
    );
    render(<Tos />);

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Terms of Service' }),
    ).toBeInTheDocument();
    expect(screen.getByText('responsibly').tagName).toBe('STRONG');
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
  });

  it('puts the terms into the styled article', async () => {
    mockFetch('<h2>Privacy</h2>');
    const { container } = render(<Tos />);

    await screen.findByRole('heading', { level: 2, name: 'Privacy' });
    const article = container.querySelector('article');
    expect(article).toHaveClass('prose');
    expect(article?.querySelector('h2')).not.toBeNull();
  });

  it('calls /api/tos endpoint', async () => {
    const fetchMock = mockFetch('<h1>TOS</h1>');
    render(<Tos />);

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/api/tos');
    });
  });

  it('shows error message when fetch fails (non-ok response)', async () => {
    mockFetch('', false, 404);
    render(<Tos />);

    await waitFor(() => {
      expect(screen.getByText(/failed to load terms of service/i)).toBeInTheDocument();
    });
  });

  it('shows error message when network request throws', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Network Error')));
    render(<Tos />);

    await waitFor(() => {
      expect(screen.getByText(/failed to load terms of service/i)).toBeInTheDocument();
    });
  });

  it('renders a back-to-home link', () => {
    // Keep fetch pending so no async state update fires during the assertion.
    vi.stubGlobal('fetch', vi.fn().mockReturnValue(new Promise(() => {})));
    render(<Tos />);

    const homeLink = screen.getByRole('link', { name: /home/i });
    expect(homeLink).toBeInTheDocument();
    expect(homeLink).toHaveAttribute('href', '/');
  });

  describe('in the interface language', () => {
    it('shows the translation the operator made for it', async () => {
      mockFetch('<h1>Terms of Service</h1>', true, 200, { pl: '<h1>Regulamin</h1>' });
      render(<Tos />, { wrapper: inLanguage('pl') });

      expect(
        await screen.findByRole('heading', { level: 1, name: 'Regulamin' }),
      ).toBeInTheDocument();
      expect(screen.queryByText('Terms of Service')).not.toBeInTheDocument();
    });

    it('shows TOS.md when there is no translation for it', async () => {
      mockFetch('<h1>Terms of Service</h1>', true, 200, { de: '<h1>Nutzungsbedingungen</h1>' });
      render(<Tos />, { wrapper: inLanguage('pl') });

      expect(
        await screen.findByRole('heading', { level: 1, name: 'Terms of Service' }),
      ).toBeInTheDocument();
    });

    it('takes nothing but text for a translation', async () => {
      mockFetch('<h1>Terms of Service</h1>', true, 200, { pl: { html: '<h1>Regulamin</h1>' } });
      render(<Tos />, { wrapper: inLanguage('pl') });

      expect(
        await screen.findByRole('heading', { level: 1, name: 'Terms of Service' }),
      ).toBeInTheDocument();
    });

    it('switches with the language, without asking the server again', async () => {
      vi.spyOn(navigator, 'languages', 'get').mockReturnValue(['pl-PL']);
      const fetchMock = mockFetch('<h1>Terms of Service</h1>', true, 200, {
        pl: '<h1>Regulamin</h1>',
      });
      render(
        <I18nProvider>
          <MemoryRouter>
            <Tos />
            <Footer />
          </MemoryRouter>
        </I18nProvider>,
      );
      expect(
        await screen.findByRole('heading', { level: 1, name: 'Regulamin' }),
      ).toBeInTheDocument();

      fireEvent.change(screen.getByRole('combobox', { name: 'Język' }), {
        target: { value: 'en' },
      });

      expect(
        screen.getByRole('heading', { level: 1, name: 'Terms of Service' }),
      ).toBeInTheDocument();
      expect(fetchMock).toHaveBeenCalledOnce();
    });
  });

  it('shows the error message for an answer that is not terms', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve(['<h1>TOS</h1>']),
      }),
    );
    render(<Tos />);

    expect(await screen.findByText(/failed to load terms of service/i)).toBeInTheDocument();
  });
});

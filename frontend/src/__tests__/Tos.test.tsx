import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import Tos from '../pages/Tos.js';

const mockFetch = (body: string, ok = true, status = 200) => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok,
      status,
      text: () => Promise.resolve(body),
    }),
  );
};

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
    mockFetch('<h1>Terms of Service</h1>\n<p>Use <strong>responsibly</strong>.</p>\n<ul><li>one</li><li>two</li></ul>');
    render(<Tos />);

    expect(await screen.findByRole('heading', { level: 1, name: 'Terms of Service' })).toBeInTheDocument();
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
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: () => Promise.resolve('<h1>TOS</h1>'),
    });
    vi.stubGlobal('fetch', fetchMock);
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
});

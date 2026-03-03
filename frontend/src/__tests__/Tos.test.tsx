import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import Tos from '../pages/Tos.js';

// Mock react-markdown to avoid ESM/transform issues in tests and keep
// assertions simple — we only care about the raw text reaching the DOM.
vi.mock('react-markdown', () => ({
  default: ({ children }: { children: string }) => <div data-testid="markdown">{children}</div>,
}));

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

  it('renders markdown content after successful fetch', async () => {
    mockFetch('# Terms of Service\n\nUse responsibly.');
    render(<Tos />);

    await waitFor(() => {
      expect(screen.getByTestId('markdown')).toBeInTheDocument();
    });

    expect(screen.getByTestId('markdown').textContent).toContain('Terms of Service');
    expect(screen.getByTestId('markdown').textContent).toContain('Use responsibly.');
  });

  it('calls /api/tos endpoint', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: () => Promise.resolve('# TOS'),
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

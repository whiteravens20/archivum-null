import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';

// Mock formatBytes before importing Admin
vi.mock('../format.js', () => ({
  formatBytes: (n: number) => `${n} B`,
}));

describe('Admin page', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('should render login form when not authenticated', async () => {
    const { default: Admin } = await import('../pages/Admin.js');
    render(<Admin />);

    expect(screen.getByText('Admin Panel')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Username')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Password')).toBeInTheDocument();
    expect(screen.getByText('Login')).toBeInTheDocument();
  });

  it('should submit login and fetch data', async () => {
    const mockStats = {
      totalVaults: 10,
      activeVaults: 3,
      totalStorageBytes: 5000,
      totalStorageMB: 0.005,
      storageQuotaBytes: 0,
    };

    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve(mockStats),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve([]),
      });

    const { default: Admin } = await import('../pages/Admin.js');
    render(<Admin />);

    fireEvent.change(screen.getByPlaceholderText('Username'), {
      target: { value: 'admin' },
    });
    fireEvent.change(screen.getByPlaceholderText('Password'), {
      target: { value: 'secret' },
    });
    fireEvent.click(screen.getByText('Login'));

    await waitFor(() => {
      expect(screen.getByText('3')).toBeInTheDocument();
    });
    expect(screen.getByText('● Online')).toBeInTheDocument();
  });

  it('should show error when auth fails (401)', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      json: () => Promise.resolve({}),
    });

    const { default: Admin } = await import('../pages/Admin.js');
    render(<Admin />);

    fireEvent.change(screen.getByPlaceholderText('Username'), {
      target: { value: 'admin' },
    });
    fireEvent.change(screen.getByPlaceholderText('Password'), {
      target: { value: 'wrong' },
    });
    fireEvent.click(screen.getByText('Login'));

    await waitFor(() => {
      expect(screen.getByText('Authentication failed')).toBeInTheDocument();
    });
  });

  it('should show admin-disabled error on 403', async () => {
    // First call (stats) returns 403, second call (vaults) returns ok
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 403,
        json: () => Promise.resolve({}),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve([]),
      });

    const { default: Admin } = await import('../pages/Admin.js');
    render(<Admin />);

    fireEvent.change(screen.getByPlaceholderText('Username'), {
      target: { value: 'admin' },
    });
    fireEvent.change(screen.getByPlaceholderText('Password'), {
      target: { value: 'test' },
    });
    fireEvent.click(screen.getByText('Login'));

    await waitFor(() => {
      expect(
        screen.getByText(/Admin panel is disabled/)
      ).toBeInTheDocument();
    });
  });

  it('should show "No active vaults" when vault list is empty', async () => {
    const mockStats = {
      totalVaults: 0,
      activeVaults: 0,
      totalStorageBytes: 0,
      totalStorageMB: 0,
      storageQuotaBytes: 0,
    };

    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve(mockStats),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve([]),
      });

    const { default: Admin } = await import('../pages/Admin.js');
    render(<Admin />);

    fireEvent.change(screen.getByPlaceholderText('Username'), {
      target: { value: 'admin' },
    });
    fireEvent.change(screen.getByPlaceholderText('Password'), {
      target: { value: 'pass' },
    });
    fireEvent.click(screen.getByText('Login'));

    await waitFor(() => {
      expect(screen.getByText('No active vaults')).toBeInTheDocument();
    });
  });
});

/**
 * Version reporting in the admin panel.
 *
 * This exists because the public demo ran v0.16.4 for five months while seven
 * releases shipped, and nothing in the panel said so. The banner is the fix, so
 * these tests pin the three states an operator can be in — behind, current, and
 * unable to tell — and that the panel survives the check failing.
 */
describe('Admin page — rate limited by the server', () => {
  const stats = {
    totalVaults: 1,
    activeVaults: 7,
    totalStorageBytes: 1000,
    totalStorageMB: 0.001,
    storageQuotaBytes: 0,
  };

  function ok(body: unknown) {
    return Promise.resolve({ ok: true, status: 200, headers: new Headers(), json: () => Promise.resolve(body) });
  }

  function tooMany(error: string, retryAfter: number) {
    return Promise.resolve({
      ok: false,
      status: 429,
      headers: new Headers({ 'Retry-After': String(retryAfter) }),
      json: () => Promise.resolve({ error, retryAfter }),
    });
  }

  async function login() {
    const { default: Admin } = await import('../pages/Admin.js');
    render(<Admin />);
    fireEvent.change(screen.getByPlaceholderText('Username'), { target: { value: 'admin' } });
    fireEvent.change(screen.getByPlaceholderText('Password'), { target: { value: 'pass' } });
    fireEvent.click(screen.getByText('Login'));
  }

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('keeps the last figures on screen while a poll is refused, and says so', async () => {
    let limited = false;
    globalThis.fetch = vi.fn((url: string) => {
      if (url.startsWith('/api/admin/version')) return Promise.reject(new Error('not needed'));
      if (limited) return tooMany('Too many requests. Try again later.', 25);
      return url.startsWith('/api/admin/stats') ? ok(stats) : ok([]);
    }) as unknown as typeof fetch;

    await login();
    expect(await screen.findByText('7')).toBeInTheDocument();

    // The next poll, ten seconds later, is refused
    limited = true;
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });

    expect(screen.getByText(/rate limiting this panel/)).toBeInTheDocument();
    expect(screen.getByText(/about 25 s/)).toBeInTheDocument();
    expect(screen.getByText('7')).toBeInTheDocument();
    expect(screen.queryByText(/Backend unavailable/)).not.toBeInTheDocument();

    // And the one after that goes through again
    limited = false;
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });

    expect(screen.queryByText(/rate limiting this panel/)).not.toBeInTheDocument();
    expect(screen.getByText('7')).toBeInTheDocument();
  });

  it('goes back to the login form with the reason when the login itself is locked out', async () => {
    globalThis.fetch = vi.fn(() =>
      tooMany('Too many failed login attempts. Try again later.', 42)
    ) as unknown as typeof fetch;

    await login();

    expect(await screen.findByText('Too many failed login attempts. Try again in 42 s.')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Password')).toBeInTheDocument();
    expect(screen.queryByText(/Backend unavailable/)).not.toBeInTheDocument();
  });
});

describe('Admin page — version and update notice', () => {
  const stats = {
    totalVaults: 1,
    activeVaults: 1,
    totalStorageBytes: 1000,
    totalStorageMB: 0.001,
    storageQuotaBytes: 0,
  };

  const baseVersion = {
    current: 'v0.16.4',
    latest: null as string | null,
    updateAvailable: null as boolean | null,
    releaseUrl: null as string | null,
    compareUrl: null as string | null,
    publishedAt: null as string | null,
    checkedAt: null as number | null,
    enabled: true,
    error: null as string | null,
    uptime: 1244994,
  };

  /** Route by URL — the panel fires stats, vaults and version independently. */
  function mockApi(version: unknown) {
    globalThis.fetch = vi.fn((url: string) => {
      if (url.startsWith('/api/admin/version')) {
        return version === null
          ? Promise.reject(new Error('network'))
          : Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(version) });
      }
      if (url.startsWith('/api/admin/stats')) {
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(stats) });
      }
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve([]) });
    }) as unknown as typeof fetch;
  }

  async function login() {
    const { default: Admin } = await import('../pages/Admin.js');
    render(<Admin />);
    fireEvent.change(screen.getByPlaceholderText('Username'), { target: { value: 'admin' } });
    fireEvent.change(screen.getByPlaceholderText('Password'), { target: { value: 'pass' } });
    fireEvent.click(screen.getByText('Login'));
  }

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('announces a newer release and links to what changed', async () => {
    mockApi({
      ...baseVersion,
      latest: 'v2.0.0',
      updateAvailable: true,
      releaseUrl: 'https://github.com/whiteravens20/archivum-null/releases/tag/v2.0.0',
      compareUrl: 'https://github.com/whiteravens20/archivum-null/compare/v0.16.4...v2.0.0',
      publishedAt: '2026-07-31T12:31:45Z',
    });
    await login();

    expect(await screen.findByText('Update available — v2.0.0')).toBeInTheDocument();
    expect(screen.getByText(/This instance runs v0\.16\.4/)).toBeInTheDocument();

    const changes = screen.getByText('View changes →');
    expect(changes).toHaveAttribute(
      'href',
      'https://github.com/whiteravens20/archivum-null/compare/v0.16.4...v2.0.0'
    );
    expect(changes).toHaveAttribute('rel', 'noopener noreferrer');
    expect(screen.getByText('Release notes')).toHaveAttribute(
      'href',
      'https://github.com/whiteravens20/archivum-null/releases/tag/v2.0.0'
    );
  });

  it('shows the running version and uptime without nagging when current', async () => {
    mockApi({ ...baseVersion, current: 'v2.0.0', latest: 'v2.0.0', updateAvailable: false });
    await login();

    expect(await screen.findByText('v2.0.0')).toBeInTheDocument();
    expect(screen.getByText('Up to date')).toBeInTheDocument();
    expect(screen.getByText(/● Online · up 14d 9h/)).toBeInTheDocument();
    expect(screen.queryByText(/Update available/)).not.toBeInTheDocument();
  });

  it('says how to turn the check on when it is disabled', async () => {
    mockApi({ ...baseVersion, enabled: false });
    await login();

    expect(await screen.findByText('v0.16.4')).toBeInTheDocument();
    expect(screen.getByText(/Update check off/)).toBeInTheDocument();
    expect(screen.queryByText(/Update available/)).not.toBeInTheDocument();
  });

  it('surfaces a blocked egress as a note, not a broken panel', async () => {
    mockApi({ ...baseVersion, error: 'Could not reach api.github.com — outbound access may be blocked' });
    await login();

    expect(await screen.findByText(/outbound access may be blocked/)).toBeInTheDocument();
    // Vault management is unaffected.
    expect(screen.getByText('No active vaults')).toBeInTheDocument();
  });

  it('keeps the panel usable when the version request itself fails', async () => {
    mockApi(null);
    await login();

    expect(await screen.findByText('No active vaults')).toBeInTheDocument();
    expect(screen.getByText('● Online')).toBeInTheDocument();
  });
});

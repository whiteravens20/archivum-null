import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// Mock formatBytes before importing Admin
vi.mock('../crypto/encrypt.js', () => ({
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

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

// Mock heavy dependencies so Home renders without them
vi.mock('../crypto/encrypt.js', () => ({
  generateKey: vi.fn(),
  exportKey: vi.fn(),
  encryptFile: vi.fn(),
}));

vi.mock('../api/vault.js', () => ({
  uploadVault: vi.fn(),
}));

describe('Home', () => {
  beforeEach(() => {
    vi.resetModules();
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
});

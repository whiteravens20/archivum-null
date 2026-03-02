import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import VaultConfig from '../components/VaultConfig.js';

describe('VaultConfig', () => {
  const defaultProps = {
    ttl: 86400,
    maxDownloads: 10,
    onTtlChange: vi.fn(),
    onMaxDownloadsChange: vi.fn(),
  };

  it('should render TTL and download selects', () => {
    render(<VaultConfig {...defaultProps} />);
    expect(screen.getByText(/expires after/i)).toBeInTheDocument();
    expect(screen.getByText(/max downloads/i)).toBeInTheDocument();
  });

  it('should show all TTL options', () => {
    render(<VaultConfig {...defaultProps} />);
    expect(screen.getByText('5 min')).toBeInTheDocument();
    expect(screen.getByText('30 min')).toBeInTheDocument();
    expect(screen.getByText('1 hour')).toBeInTheDocument();
    expect(screen.getByText('24 hours')).toBeInTheDocument();
    expect(screen.getByText('7 days')).toBeInTheDocument();
  });

  it('should show download options', () => {
    render(<VaultConfig {...defaultProps} />);
    expect(screen.getByText('1 download')).toBeInTheDocument();
    expect(screen.getByText('10 downloads')).toBeInTheDocument();
    expect(screen.getByText('100 downloads')).toBeInTheDocument();
  });

  it('should call onTtlChange when TTL changes', () => {
    const onTtlChange = vi.fn();
    render(<VaultConfig {...defaultProps} onTtlChange={onTtlChange} />);

    const selects = screen.getAllByRole('combobox');
    fireEvent.change(selects[0], { target: { value: '3600' } });

    expect(onTtlChange).toHaveBeenCalledWith(3600);
  });

  it('should call onMaxDownloadsChange when downloads change', () => {
    const onMaxDownloadsChange = vi.fn();
    render(<VaultConfig {...defaultProps} onMaxDownloadsChange={onMaxDownloadsChange} />);

    const selects = screen.getAllByRole('combobox');
    fireEvent.change(selects[1], { target: { value: '5' } });

    expect(onMaxDownloadsChange).toHaveBeenCalledWith(5);
  });

  it('should disable selects when disabled prop is set', () => {
    render(<VaultConfig {...defaultProps} disabled />);
    const selects = screen.getAllByRole('combobox');
    expect(selects[0]).toBeDisabled();
    expect(selects[1]).toBeDisabled();
  });
});

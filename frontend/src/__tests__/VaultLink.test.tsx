import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import VaultLink from '../components/VaultLink.js';

describe('VaultLink', () => {
  const testUrl = 'https://example.com/vault/abc123#keybase64';

  it('should render vault link input with URL', () => {
    render(<VaultLink url={testUrl} />);
    const input = screen.getByRole('textbox') as HTMLInputElement;
    expect(input.value).toBe(testUrl);
    expect(input.readOnly).toBe(true);
  });

  it('should show copy button', () => {
    render(<VaultLink url={testUrl} />);
    expect(screen.getByText('Copy')).toBeInTheDocument();
  });

  it('should show key warning', () => {
    render(<VaultLink url={testUrl} />);
    expect(screen.getByText(/encryption key/i)).toBeInTheDocument();
    expect(screen.getByText(/never sent to the server/i)).toBeInTheDocument();
  });

  it('should copy URL to clipboard on button click', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });

    render(<VaultLink url={testUrl} />);
    await act(async () => {
      fireEvent.click(screen.getByText('Copy'));
    });

    expect(writeText).toHaveBeenCalledWith(testUrl);
  });

  it('should show label about vault link containing decryption key', () => {
    render(<VaultLink url={testUrl} />);
    expect(screen.getByText(/vault link.*decryption key/i)).toBeInTheDocument();
  });
});

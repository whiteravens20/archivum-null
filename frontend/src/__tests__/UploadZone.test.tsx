import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import UploadZone from '../components/UploadZone.js';

describe('UploadZone', () => {
  const defaultProps = {
    onFileSelect: vi.fn(),
    maxSize: 100 * 1024 * 1024, // 100MB
  };

  it('should render upload instructions', () => {
    render(<UploadZone {...defaultProps} />);
    expect(screen.getByText(/drop file or click to select/i)).toBeInTheDocument();
  });

  it('should show max file size', () => {
    render(<UploadZone {...defaultProps} />);
    expect(screen.getByText(/Max size: 100 MB/)).toBeInTheDocument();
  });

  it('should have a hidden file input', () => {
    const { container } = render(<UploadZone {...defaultProps} />);
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    expect(input).toBeTruthy();
    expect(input.className).toContain('hidden');
  });

  it('should show error for empty file', () => {
    render(<UploadZone {...defaultProps} />);
    const { container } = render(<UploadZone {...defaultProps} />);
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;

    const emptyFile = new File([], 'empty.txt', { type: 'text/plain' });
    Object.defineProperty(emptyFile, 'size', { value: 0 });

    fireEvent.change(input, { target: { files: [emptyFile] } });
    expect(screen.getByText(/file is empty/i)).toBeInTheDocument();
  });

  it('should show error for oversized file', () => {
    const { container } = render(<UploadZone {...defaultProps} maxSize={1024} />);
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;

    const bigFile = new File(['x'], 'big.bin');
    Object.defineProperty(bigFile, 'size', { value: 2048 });

    fireEvent.change(input, { target: { files: [bigFile] } });
    expect(screen.getByText(/exceeds maximum size/i)).toBeInTheDocument();
  });

  it('should call onFileSelect for valid file', () => {
    const onFileSelect = vi.fn();
    const { container } = render(
      <UploadZone onFileSelect={onFileSelect} maxSize={1024 * 1024} />
    );
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;

    const file = new File(['content'], 'test.txt', { type: 'text/plain' });
    fireEvent.change(input, { target: { files: [file] } });

    expect(onFileSelect).toHaveBeenCalledWith(file);
  });

  it('should not trigger file input when disabled', () => {
    const { container } = render(<UploadZone {...defaultProps} disabled />);
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    expect(input.disabled).toBe(true);
  });
});

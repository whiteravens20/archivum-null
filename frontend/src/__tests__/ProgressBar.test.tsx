import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import ProgressBar from '../components/ProgressBar.js';

describe('ProgressBar', () => {
  it('should render with label and percentage', () => {
    render(<ProgressBar progress={0.5} label="Encrypting" />);
    expect(screen.getByText('Encrypting')).toBeInTheDocument();
    expect(screen.getByText('50%')).toBeInTheDocument();
  });

  it('should render without label', () => {
    const { container } = render(<ProgressBar progress={0.75} />);
    // Should have the progress bar div but no label text
    const bar = container.querySelector('[style]');
    expect(bar).toBeTruthy();
  });

  it('should clamp progress to 0-100%', () => {
    render(<ProgressBar progress={1.5} label="Over" />);
    expect(screen.getByText('100%')).toBeInTheDocument();
  });

  it('should show 0% for zero progress', () => {
    render(<ProgressBar progress={0} label="Starting" />);
    expect(screen.getByText('0%')).toBeInTheDocument();
  });

  it('should clamp negative values to 0%', () => {
    render(<ProgressBar progress={-0.5} label="Underflow" />);
    expect(screen.getByText('0%')).toBeInTheDocument();
  });

  it('should set correct width style on progress bar', () => {
    const { container } = render(<ProgressBar progress={0.3} />);
    const inner = container.querySelector('[style*="width"]') as HTMLElement;
    expect(inner.style.width).toBe('30%');
  });
});

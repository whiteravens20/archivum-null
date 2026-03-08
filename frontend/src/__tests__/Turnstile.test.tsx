import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, act } from '@testing-library/react';
import Turnstile from '../components/Turnstile.js';

describe('Turnstile', () => {
  beforeEach(() => {
    delete window.turnstile;
  });

  it('should return null when siteKey is empty', () => {
    const { container } = render(
      <Turnstile siteKey="" onVerify={vi.fn()} />
    );
    expect(container.innerHTML).toBe('');
  });

  it('should return null when siteKey is the disabled sentinel', () => {
    const { container } = render(
      <Turnstile siteKey="0x0000000000000000000000" onVerify={vi.fn()} />
    );
    expect(container.innerHTML).toBe('');
  });

  it('should render a container div when siteKey is valid', () => {
    const { container } = render(
      <Turnstile siteKey="0xABC123" onVerify={vi.fn()} />
    );
    expect(container.querySelector('div')).toBeTruthy();
  });

  it('should call turnstile.render once script is loaded', async () => {
    vi.useFakeTimers();

    const renderFn = vi.fn().mockReturnValue('widget-1');
    const onVerify = vi.fn();

    render(<Turnstile siteKey="0xABC123" onVerify={onVerify} />);

    // Simulate Turnstile script loading after a delay
    window.turnstile = {
      render: renderFn,
      remove: vi.fn(),
      reset: vi.fn(),
    };

    // Advance timer so the polling interval fires, wrapped in act for state updates
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });

    expect(renderFn).toHaveBeenCalledTimes(1);
    expect(renderFn).toHaveBeenCalledWith(
      expect.any(HTMLElement),
      expect.objectContaining({
        sitekey: '0xABC123',
        theme: 'dark',
        size: 'normal',
      })
    );

    vi.useRealTimers();
  });

  it('should clean up widget on unmount', async () => {
    vi.useFakeTimers();

    const removeFn = vi.fn();
    window.turnstile = {
      render: vi.fn().mockReturnValue('widget-99'),
      remove: removeFn,
      reset: vi.fn(),
    };

    const { unmount } = render(
      <Turnstile siteKey="0xABC123" onVerify={vi.fn()} />
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });

    unmount();
    expect(removeFn).toHaveBeenCalledWith('widget-99');

    vi.useRealTimers();
  });
});

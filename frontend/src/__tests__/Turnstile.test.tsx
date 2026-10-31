import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, act } from '@testing-library/react';
import Turnstile from '../components/Turnstile.js';

describe('Turnstile', () => {
  beforeEach(() => {
    delete window.turnstile;
  });

  it('should return null when siteKey is empty', () => {
    const { container } = render(<Turnstile siteKey="" onVerify={vi.fn()} />);
    expect(container.innerHTML).toBe('');
  });

  it('should return null when siteKey is the disabled sentinel', () => {
    const { container } = render(
      <Turnstile siteKey="0x0000000000000000000000" onVerify={vi.fn()} />,
    );
    expect(container.innerHTML).toBe('');
  });

  describe('loading the script', () => {
    const SCRIPT = 'script[src="https://challenges.cloudflare.com/turnstile/v0/api.js"]';

    it('should request the Turnstile script when a challenge is about to be shown', () => {
      render(<Turnstile siteKey="0xABC123" onVerify={vi.fn()} />);

      const script = document.head.querySelector<HTMLScriptElement>(SCRIPT);
      expect(script).not.toBeNull();
      expect(script!.async).toBe(true);
    });

    it.each(['', '0x0000000000000000000000'])(
      'should not contact Cloudflare for the disabled site key %j',
      (siteKey) => {
        render(<Turnstile siteKey={siteKey} onVerify={vi.fn()} />);

        expect(document.querySelector('script[src*="cloudflare"]')).toBeNull();
      },
    );

    it('should request the script once, however often the widget is shown', () => {
      const first = render(<Turnstile siteKey="0xABC123" onVerify={vi.fn()} />);
      first.unmount();
      render(<Turnstile siteKey="0xABC123" onVerify={vi.fn()} />);
      render(<Turnstile siteKey="0xABC123" onVerify={vi.fn()} />);

      expect(document.querySelectorAll(SCRIPT)).toHaveLength(1);
    });

    it('should not request the script again once it has loaded', () => {
      window.turnstile = {
        render: vi.fn().mockReturnValue('widget-1'),
        remove: vi.fn(),
        reset: vi.fn(),
      };

      render(<Turnstile siteKey="0xABC123" onVerify={vi.fn()} />);

      expect(document.querySelector(SCRIPT)).toBeNull();
    });
  });

  it('should render a container div when siteKey is valid', () => {
    const { container } = render(<Turnstile siteKey="0xABC123" onVerify={vi.fn()} />);
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
      }),
    );

    vi.useRealTimers();
  });

  it.each(['light', 'auto'] as const)(
    'should render the widget in the %s theme of the page',
    async (theme) => {
      vi.useFakeTimers();
      document.documentElement.dataset.theme = theme;

      const renderFn = vi.fn().mockReturnValue('widget-1');
      window.turnstile = { render: renderFn, remove: vi.fn(), reset: vi.fn() };

      render(<Turnstile siteKey="0xABC123" onVerify={vi.fn()} />);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(200);
      });

      expect(renderFn).toHaveBeenCalledWith(
        expect.any(HTMLElement),
        expect.objectContaining({ theme }),
      );

      vi.useRealTimers();
    },
  );

  it('should clean up widget on unmount', async () => {
    vi.useFakeTimers();

    const removeFn = vi.fn();
    window.turnstile = {
      render: vi.fn().mockReturnValue('widget-99'),
      remove: removeFn,
      reset: vi.fn(),
    };

    const { unmount } = render(<Turnstile siteKey="0xABC123" onVerify={vi.fn()} />);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });

    unmount();
    expect(removeFn).toHaveBeenCalledWith('widget-99');

    vi.useRealTimers();
  });

  it('should pass onError callback to turnstile.render', async () => {
    vi.useFakeTimers();

    const renderFn = vi.fn().mockReturnValue('widget-2');
    const onError = vi.fn();

    render(<Turnstile siteKey="0xABC123" onVerify={vi.fn()} onError={onError} />);

    window.turnstile = {
      render: renderFn,
      remove: vi.fn(),
      reset: vi.fn(),
    };

    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });

    expect(renderFn).toHaveBeenCalledWith(
      expect.any(HTMLElement),
      expect.objectContaining({
        'error-callback': onError,
      }),
    );

    vi.useRealTimers();
  });

  it('should pass onExpire callback to turnstile.render', async () => {
    vi.useFakeTimers();

    const renderFn = vi.fn().mockReturnValue('widget-3');
    const onExpire = vi.fn();

    render(<Turnstile siteKey="0xABC123" onVerify={vi.fn()} onExpire={onExpire} />);

    window.turnstile = {
      render: renderFn,
      remove: vi.fn(),
      reset: vi.fn(),
    };

    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });

    expect(renderFn).toHaveBeenCalledWith(
      expect.any(HTMLElement),
      expect.objectContaining({
        'expired-callback': onExpire,
      }),
    );

    vi.useRealTimers();
  });
});

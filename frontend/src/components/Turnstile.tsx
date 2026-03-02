import { useCallback, useEffect, useRef, useState } from 'react';

interface TurnstileProps {
  siteKey: string;
  onVerify: (token: string) => void;
  onError?: () => void;
}

declare global {
  interface Window {
    turnstile?: {
      render: (
        container: HTMLElement,
        options: {
          sitekey: string;
          callback: (token: string) => void;
          'error-callback'?: () => void;
          theme?: 'dark' | 'light' | 'auto';
          size?: 'normal' | 'compact';
        }
      ) => string;
      remove: (widgetId: string) => void;
      reset: (widgetId: string) => void;
    };
  }
}

export default function Turnstile({ siteKey, onVerify, onError }: TurnstileProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const widgetIdRef = useRef<string | null>(null);
  const [ready, setReady] = useState(false);

  // Wait for Turnstile script to load
  useEffect(() => {
    const check = setInterval(() => {
      if (window.turnstile) {
        setReady(true);
        clearInterval(check);
      }
    }, 100);
    return () => clearInterval(check);
  }, []);

  const handleVerify = useCallback(
    (token: string) => onVerify(token),
    [onVerify]
  );

  useEffect(() => {
    if (!ready || !containerRef.current || !window.turnstile) return;

    // Clean up previous widget
    if (widgetIdRef.current) {
      window.turnstile.remove(widgetIdRef.current);
    }

    widgetIdRef.current = window.turnstile.render(containerRef.current, {
      sitekey: siteKey,
      callback: handleVerify,
      'error-callback': onError,
      theme: 'dark',
      size: 'normal',
    });

    return () => {
      if (widgetIdRef.current && window.turnstile) {
        window.turnstile.remove(widgetIdRef.current);
        widgetIdRef.current = null;
      }
    };
  }, [ready, siteKey, handleVerify, onError]);

  if (!siteKey || siteKey === '0x0000000000000000000000') {
    return null; // Turnstile disabled
  }

  return <div ref={containerRef} className="flex justify-center my-4" />;
}

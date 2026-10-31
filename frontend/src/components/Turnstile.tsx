import { useCallback, useEffect, useRef, useState } from 'react';
import { getBranding } from '../branding.ts';

interface TurnstileProps {
  siteKey: string;
  onVerify: (token: string) => void;
  onError?: () => void;
  onExpire?: () => void;
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
          'expired-callback'?: () => void;
          theme?: 'dark' | 'light' | 'auto';
          size?: 'normal' | 'compact';
        },
      ) => string;
      remove: (widgetId: string) => void;
      reset: (widgetId: string) => void;
    };
  }
}

const SCRIPT_URL = 'https://challenges.cloudflare.com/turnstile/v0/api.js';
/** The placeholder site key of an instance that has Turnstile switched off. */
const DISABLED_SITE_KEY = '0x0000000000000000000000';

/**
 * Add the Turnstile script to the page, once.
 *
 * It is requested from here and not from index.html, so a visitor's browser contacts
 * Cloudflare only when a challenge is about to be shown: never on an instance without
 * Turnstile, and on one with it only on the upload form, not on every page.
 */
function loadTurnstileScript(): void {
  if (window.turnstile || document.querySelector(`script[src="${SCRIPT_URL}"]`)) return;
  const script = document.createElement('script');
  script.src = SCRIPT_URL;
  script.async = true;
  document.head.appendChild(script);
}

export default function Turnstile({ siteKey, onVerify, onError, onExpire }: TurnstileProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const widgetIdRef = useRef<string | null>(null);
  const [ready, setReady] = useState(false);
  const enabled = Boolean(siteKey) && siteKey !== DISABLED_SITE_KEY;

  // Request the script, then wait for it to load
  useEffect(() => {
    if (!enabled) return;
    loadTurnstileScript();
    const check = setInterval(() => {
      if (window.turnstile) {
        setReady(true);
        clearInterval(check);
      }
    }, 100);
    return () => clearInterval(check);
  }, [enabled]);

  const handleVerify = useCallback((token: string) => onVerify(token), [onVerify]);

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
      'expired-callback': onExpire,
      theme: getBranding().theme,
      size: 'normal',
    });

    return () => {
      if (widgetIdRef.current && window.turnstile) {
        window.turnstile.remove(widgetIdRef.current);
        widgetIdRef.current = null;
      }
    };
  }, [ready, siteKey, handleVerify, onError, onExpire]);

  if (!enabled) {
    return null; // Turnstile disabled
  }

  return <div ref={containerRef} className="flex justify-center my-4" />;
}

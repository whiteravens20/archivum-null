/**
 * Branding of this instance, as the server wrote it into index.html
 * (backend/src/static/branding.ts). The fallbacks are what the Vite dev server and
 * the tests show, where no backend has touched the page.
 */

/** `auto` follows the visitor's system setting. */
export type Theme = 'dark' | 'light' | 'auto';

export interface Branding {
  name: string;
  tagline: string;
  theme: Theme;
}

function meta(name: string): string | undefined {
  return document.querySelector<HTMLMetaElement>(`meta[name="${name}"]`)?.content || undefined;
}

export function getBranding(): Branding {
  const theme = document.documentElement.dataset.theme;
  return {
    name: meta('application-name') ?? 'Archivum Null',
    tagline: meta('brand-tagline') ?? 'Zero trust file relay',
    theme: theme === 'light' || theme === 'auto' ? theme : 'dark',
  };
}

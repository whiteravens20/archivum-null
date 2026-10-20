/**
 * Branding of this instance, as the server wrote it into index.html
 * (backend/src/static/branding.ts). The fallbacks are what the Vite dev server and
 * the tests show, where no backend has touched the page.
 */

import { en } from './i18n/messages/en.ts';

/**
 * The tagline of an instance whose operator sets none, the same as the server's. The
 * pages show it in the visitor's language; a tagline of the operator's own is shown as
 * they wrote it.
 */
export const DEFAULT_TAGLINE = en['brand.tagline'];

/** `auto` follows the visitor's system setting. */
export type Theme = 'dark' | 'light' | 'auto';

export interface Branding {
  name: string;
  tagline: string;
  theme: Theme;
  /** URL of the mark for the dark theme: the operator's own, or the built-in one. */
  logo: string;
  /** The same for the light theme. */
  logoLight: string;
}

function meta(name: string): string | undefined {
  return document.querySelector<HTMLMetaElement>(`meta[name="${name}"]`)?.content || undefined;
}

/**
 * Whether the instance has terms of service. The server marks a page it serves without
 * them (backend/src/static/terms.ts), and the footer then leaves out its link.
 */
export function hasTerms(): boolean {
  return meta('terms') !== 'none';
}

export function getBranding(): Branding {
  const theme = document.documentElement.dataset.theme;
  return {
    name: meta('application-name') ?? 'Archivum Null',
    tagline: meta('brand-tagline') ?? DEFAULT_TAGLINE,
    theme: theme === 'light' || theme === 'auto' ? theme : 'dark',
    logo: meta('brand-logo') ?? '/logo-symbol.webp',
    logoLight: meta('brand-logo-light') ?? '/logo-symbol-light.webp',
  };
}

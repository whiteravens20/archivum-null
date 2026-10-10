/**
 * Branding of this instance, as the server wrote it into index.html
 * (backend/src/static/branding.ts). The fallbacks are what the Vite dev server and
 * the tests show, where no backend has touched the page.
 */

export interface Branding {
  name: string;
  tagline: string;
}

function meta(name: string): string | undefined {
  return document.querySelector<HTMLMetaElement>(`meta[name="${name}"]`)?.content || undefined;
}

export function getBranding(): Branding {
  return {
    name: meta('application-name') ?? 'Archivum Null',
    tagline: meta('brand-tagline') ?? 'Zero trust file relay',
  };
}

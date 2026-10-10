/**
 * Operator branding — what an instance shows in place of the built-in defaults.
 *
 * The values are written into index.html once, at startup, on top of what the asset
 * cloak produced; nothing here runs per request. Branding is cosmetic by construction:
 * no setting takes a URL, so it cannot make the page load anything from another
 * origin, and this module sets no header and reads no request.
 */

/** `auto` follows the visitor's system setting, in CSS alone. */
export type Theme = 'dark' | 'light' | 'auto';

export interface Branding {
  name: string;
  tagline: string;
  /** `#rrggbb`, or null to keep the accent built into the stylesheet. */
  accentColor: string | null;
  theme: Theme;
}

/** The values as they come from the environment, not yet checked. */
export interface BrandingInput {
  name: string;
  tagline: string;
  accentColor: string;
  theme: string;
}

const THEMES: readonly string[] = ['dark', 'light', 'auto'];

function isTheme(value: string): value is Theme {
  return THEMES.includes(value);
}

const NAME_MAX_LENGTH = 64;
const TAGLINE_MAX_LENGTH = 120;

/** Control characters (C0, DEL, C1) and the two Unicode line separators. */
const UNPRINTABLE = /\p{Cc}|[\u2028\u2029]/u;

function isDisplayText(value: string, maxLength: number): boolean {
  // Counted in code points, so an emoji or an accented letter is one character.
  const length = [...value].length;
  return length >= 1 && length <= maxLength && !UNPRINTABLE.test(value);
}

/**
 * Check the configured branding. Throws naming the variable at fault, so a bad value
 * stops the server at startup instead of producing a broken page.
 */
export function parseBranding(input: BrandingInput): Branding {
  if (!isDisplayText(input.name, NAME_MAX_LENGTH)) {
    throw new Error(`BRAND_NAME must be 1 to ${NAME_MAX_LENGTH} characters with no control characters`);
  }
  if (!isDisplayText(input.tagline, TAGLINE_MAX_LENGTH)) {
    throw new Error(`BRAND_TAGLINE must be 1 to ${TAGLINE_MAX_LENGTH} characters with no control characters`);
  }
  // The colour is written into a <style> element, so nothing but six hex digits
  // gets through: no names, no rgb(), no url().
  if (input.accentColor !== '' && !/^#[0-9a-f]{6}$/i.test(input.accentColor)) {
    throw new Error('BRAND_ACCENT_COLOR must be a six-digit hex colour such as #60A5FA');
  }
  if (!isTheme(input.theme)) {
    throw new Error('BRAND_THEME must be one of: dark, light, auto');
  }
  return {
    name: input.name,
    tagline: input.tagline,
    accentColor: input.accentColor === '' ? null : input.accentColor.toLowerCase(),
    theme: input.theme,
  };
}

/** Page background of each theme — `--color-vault-bg` in frontend/src/index.css. */
export const THEME_BACKGROUND = { dark: '#0b0f19', light: '#f8fafc' } as const;
/** The two colours a label on an accent fill can take. */
const INK = '#0b0f19';
const WHITE = '#ffffff';

function linear(channel: number): number {
  const value = channel / 255;
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

function luminance(hex: string): number {
  const rgb = parseInt(hex.slice(1), 16);
  return 0.2126 * linear(rgb >> 16) + 0.7152 * linear((rgb >> 8) & 0xff) + 0.0722 * linear(rgb & 0xff);
}

/** WCAG 2 contrast ratio of two `#rrggbb` colours, from 1 (same) to 21 (black on white). */
export function contrastRatio(a: string, b: string): number {
  const [lighter, darker] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (lighter + 0.05) / (darker + 0.05);
}

/**
 * The colour of text on an accent-coloured button: the dark ink or white, whichever
 * reads better. Without it a dark accent would get dark labels and a light one white.
 */
export function onAccentColor(accent: string): string {
  return contrastRatio(accent, INK) >= contrastRatio(accent, WHITE) ? INK : WHITE;
}

/** Below this the accent, which is also the colour of links, is hard to read as text. */
const MIN_TEXT_CONTRAST = 3;

/** Choices that work but will look wrong — reported at startup, never fatal. */
export function brandingWarnings(branding: Branding): string[] {
  // The light theme darkens the accent for text by itself, so only the dark page,
  // which shows it as it is, can end up unreadable.
  if (branding.accentColor === null || branding.theme === 'light') return [];
  const contrast = contrastRatio(branding.accentColor, THEME_BACKGROUND.dark);
  if (contrast >= MIN_TEXT_CONTRAST) return [];
  return [
    `BRAND_ACCENT_COLOR ${branding.accentColor} has a contrast of ${contrast.toFixed(1)}:1 against the dark page background; links and highlighted text will be hard to read (aim for 3:1 or more).`,
  ];
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function describePage(branding: Branding): string {
  const lead = /[\p{L}\p{N}]$/u.test(branding.tagline) ? `${branding.tagline}.` : branding.tagline;
  return `${branding.name} — ${lead} Anonymous, zero-knowledge encrypted file sharing with expiring vaults.`;
}

/** Colours the browser's own UI around the page; `auto` gets one per colour scheme. */
function themeColorTags(theme: Theme): string[] {
  if (theme === 'auto') {
    return [
      `<meta name="theme-color" content="${THEME_BACKGROUND.dark}" media="(prefers-color-scheme: dark)" />`,
      `<meta name="theme-color" content="${THEME_BACKGROUND.light}" media="(prefers-color-scheme: light)" />`,
    ];
  }
  return [`<meta name="theme-color" content="${THEME_BACKGROUND[theme]}" />`];
}

const HEAD_END = /[ \t]*<\/head>/i;

/**
 * Write the branding into an index.html.
 *
 * The page's own <title> and description are replaced. Everything else is added as
 * tags, which is also how the SPA learns the values (frontend/src/branding.ts): the
 * Content-Security-Policy allows no inline script, so there is no script to put them in.
 */
export function applyBranding(indexHtml: string, branding: Branding): string {
  // No </head>, nowhere to put the tags — leave such a page as it is.
  if (!HEAD_END.test(indexHtml)) return indexHtml;

  const name = escapeHtml(branding.name);
  const tags = [
    `<title>${name}</title>`,
    `<meta name="application-name" content="${name}" />`,
    `<meta name="description" content="${escapeHtml(describePage(branding))}" />`,
    `<meta name="brand-tagline" content="${escapeHtml(branding.tagline)}" />`,
    ...themeColorTags(branding.theme),
  ];
  if (branding.accentColor !== null) {
    // Unlayered, so it wins over the defaults the stylesheet keeps in @layer theme.
    tags.push(
      `<style>:root{--color-vault-accent:${branding.accentColor};--color-vault-on-accent:${onAccentColor(branding.accentColor)}}</style>`
    );
  }
  const block = tags.map((tag) => `    ${tag}\n`).join('');

  return (
    indexHtml
      .replace(/<title>[\s\S]*?<\/title>\s*/i, '')
      .replace(/<meta\s+name="description"[^>]*>\s*/i, '')
      // The stylesheet picks its palette from this attribute.
      .replace(/<html\b/i, `<html data-theme="${branding.theme}"`)
      // A function, not a string: in a replacement string `$&` and `$1` are
      // expanded, and a name such as "Cash $& Carry" would be mangled.
      .replace(HEAD_END, () => `${block}  </head>`)
  );
}

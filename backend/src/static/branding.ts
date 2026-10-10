/**
 * Operator branding — what an instance shows in place of the built-in defaults.
 *
 * The values are written into index.html once, at startup, on top of what the asset
 * cloak produced; nothing here runs per request. Branding is cosmetic by construction:
 * no setting takes a URL, so it cannot make the page load anything from another
 * origin, and this module sets no header and reads no request.
 */

export interface Branding {
  name: string;
  tagline: string;
}

/** The values as they come from the environment, not yet checked. */
export interface BrandingInput {
  name: string;
  tagline: string;
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
  return { name: input.name, tagline: input.tagline };
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
  ];
  const block = tags.map((tag) => `    ${tag}\n`).join('');

  return (
    indexHtml
      .replace(/<title>[\s\S]*?<\/title>\s*/i, '')
      .replace(/<meta\s+name="description"[^>]*>\s*/i, '')
      // A function, not a string: in a replacement string `$&` and `$1` are
      // expanded, and a name such as "Cash $& Carry" would be mangled.
      .replace(HEAD_END, () => `${block}  </head>`)
  );
}

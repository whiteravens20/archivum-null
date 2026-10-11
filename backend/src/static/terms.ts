import { Marked } from 'marked';
import { escapeHtml } from './branding.js';

/**
 * The operator's terms of service, converted from Markdown to HTML.
 *
 * Converted on the server, once at startup, so that the page in the browser needs no
 * Markdown parser. Everything in that bundle runs beside the encryption key, and a
 * parser brought more third-party packages into it than the rest of the app together.
 *
 * The result is put into the page as HTML, so two things a Markdown file can carry are
 * taken out here:
 *   - raw HTML is shown as the text it is, not interpreted;
 *   - a link or an image keeps its address only when that plainly is a web or mail
 *     address, or a path on this site.
 * The Content-Security-Policy would not run a script from the terms either way. This
 * keeps the page to what Markdown formatting can express.
 */

/**
 * Whether an address may be used as it stands. Judged by how it begins, because that
 * alone decides what a browser makes of it: a web or mail scheme spelled out, or a
 * character that can only start a path, a query or a fragment on this site.
 *
 * Everything else is refused, without an attempt to work out which scheme it hides.
 * An address can spell `javascript:` with entities, control characters and mixed case
 * in more ways than a check could list, and a relative name that begins with a letter
 * is not worth telling apart from them.
 */
function isSafeUrl(href: string): boolean {
  return /^(https?:\/\/|mailto:|[/#?]|\.\.?\/)/i.test(href);
}

const marked = new Marked({
  gfm: true,
  renderer: {
    html({ text }) {
      return escapeHtml(text);
    },
    // `false` hands the token back to the default renderer.
    link({ href, tokens }) {
      return isSafeUrl(href) ? false : this.parser.parseInline(tokens);
    },
    image({ href, text }) {
      return isSafeUrl(href) ? false : escapeHtml(text);
    },
  },
});

export function renderTerms(markdown: string): string {
  return marked.parse(markdown, { async: false });
}

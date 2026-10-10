/**
 * Branding — unit and end-to-end tests.
 *
 * Branding is operator-supplied text that ends up inside index.html. The unit blocks
 * pin what is accepted and how it is escaped. The end-to-end block goes through
 * buildApp(), because what matters is the page that is actually served — and that no
 * security header moves when branding is switched on.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  applyBranding,
  brandingWarnings,
  contrastRatio,
  escapeHtml,
  onAccentColor,
  parseBranding,
} from '../static/branding.js';

/** What the environment holds when nothing is configured, and what that parses to. */
const INPUT = { name: 'Archivum Null', tagline: 'Zero trust file relay', accentColor: '' };
const DEFAULTS = { name: 'Archivum Null', tagline: 'Zero trust file relay', accentColor: null };

/** The page the frontend build starts from — the anchors applyBranding relies on live here. */
const SOURCE_PAGE = fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'frontend', 'index.html'),
  'utf-8'
);

const count = (haystack: string, needle: RegExp): number => (haystack.match(needle) ?? []).length;

describe('parseBranding', () => {
  it('accepts the defaults', () => {
    expect(parseBranding(INPUT)).toEqual(DEFAULTS);
  });

  it('counts length in characters, not in UTF-16 units', () => {
    // 64 emoji are 128 UTF-16 units — still 64 characters.
    expect(() => parseBranding({ ...INPUT, name: '🗄'.repeat(64) })).not.toThrow();
    expect(() => parseBranding({ ...INPUT, name: '🗄'.repeat(65) })).toThrow('BRAND_NAME');
    expect(parseBranding({ ...INPUT, name: 'Skarbiec Żółwia' }).name).toBe('Skarbiec Żółwia');
  });

  it.each([
    ['empty', ''],
    ['too long', 'a'.repeat(65)],
    ['a line break', 'two\nlines'],
    ['a tab', 'tab\there'],
    ['a NUL byte', 'nul\u0000byte'],
    ['a C1 control character', 'c1\u0085control'],
    ['a Unicode line separator', 'line\u2028separator'],
  ])('rejects a name that is %s', (_what, name) => {
    expect(() => parseBranding({ ...INPUT, name })).toThrow(/^BRAND_NAME must be/);
  });

  it('holds the tagline to its own limit and names it in the error', () => {
    expect(() => parseBranding({ ...INPUT, tagline: 'a'.repeat(120) })).not.toThrow();
    expect(() => parseBranding({ ...INPUT, tagline: 'a'.repeat(121) })).toThrow(/^BRAND_TAGLINE must be/);
    expect(() => parseBranding({ ...INPUT, tagline: 'two\nlines' })).toThrow(/^BRAND_TAGLINE must be/);
  });

  it('accepts a six-digit hex accent and lower-cases it', () => {
    expect(parseBranding({ ...INPUT, accentColor: '#F97316' }).accentColor).toBe('#f97316');
  });

  it.each([
    ['a colour name', 'orange'],
    ['three digits', '#f90'],
    ['eight digits', '#f97316ff'],
    ['no hash', 'f97316'],
    ['a non-hex digit', '#f9731g'],
    ['a function', 'rgb(249 115 22)'],
    ['a CSS escape from the declaration', '#f97316;}body{display:none'],
    ['a url()', 'url(https://evil.example/x)'],
    ['a closing style tag', '#f97316</style><script>alert(1)</script>'],
  ])('rejects an accent that is %s', (_what, accentColor) => {
    expect(() => parseBranding({ ...INPUT, accentColor })).toThrow(/^BRAND_ACCENT_COLOR must be/);
  });
});

describe('contrastRatio', () => {
  it('matches the WCAG reference values', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 5);
    expect(contrastRatio('#ffffff', '#ffffff')).toBeCloseTo(1, 5);
    // #767676 on white is the textbook 4.54:1.
    expect(contrastRatio('#767676', '#ffffff')).toBeCloseTo(4.54, 2);
    expect(contrastRatio('#ffffff', '#767676')).toBe(contrastRatio('#767676', '#ffffff'));
  });
});

describe('onAccentColor', () => {
  it('puts dark ink on a light accent and white on a dark one', () => {
    expect(onAccentColor('#60a5fa')).toBe('#0b0f19');
    expect(onAccentColor('#facc15')).toBe('#0b0f19');
    expect(onAccentColor('#1e3a8a')).toBe('#ffffff');
    expect(onAccentColor('#7c3aed')).toBe('#ffffff');
  });

  it('agrees with the label colour the stylesheet ships for its own accent', () => {
    const css = fs.readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'frontend', 'src', 'index.css'),
      'utf-8'
    );
    const token = (name: string): string => {
      const match = new RegExp(`--color-vault-${name}:\\s*(#[0-9a-fA-F]{6});`).exec(css);
      if (!match) throw new Error(`--color-vault-${name} is not a hex colour in index.css`);
      return match[1].toLowerCase();
    };

    // The injected <style> overrides exactly these two variables; if the stylesheet
    // renamed either, a configured accent would silently stop applying.
    expect(onAccentColor(token('accent'))).toBe(token('on-accent'));
  });
});

describe('brandingWarnings', () => {
  it('says nothing about the built-in accent or a readable one', () => {
    expect(brandingWarnings(DEFAULTS)).toEqual([]);
    expect(brandingWarnings({ ...DEFAULTS, accentColor: '#f97316' })).toEqual([]);
  });

  it('warns about an accent that cannot be read on the dark page', () => {
    const [warning, ...rest] = brandingWarnings({ ...DEFAULTS, accentColor: '#1e3a8a' });

    expect(rest).toEqual([]);
    expect(warning).toContain('BRAND_ACCENT_COLOR #1e3a8a');
    // Navy on the near-black page: well under the 3:1 the warning asks for.
    expect(warning).toMatch(/contrast of 1\.[0-9]:1/);
  });
});

describe('escapeHtml', () => {
  it('escapes every character that can end text or an attribute value', () => {
    expect(escapeHtml(`<a href="x" title='y'>&</a>`)).toBe(
      '&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;'
    );
  });
});

describe('applyBranding', () => {
  it('replaces the title and description of the real index.html, once each', () => {
    const page = applyBranding(SOURCE_PAGE, { ...DEFAULTS, name: 'Acme Drop', tagline: 'Files, sealed' });

    expect(count(page, /<title>/g)).toBe(1);
    expect(page).toContain('<title>Acme Drop</title>');
    expect(count(page, /<meta name="description"/g)).toBe(1);
    expect(page).toContain(
      '<meta name="description" content="Acme Drop — Files, sealed. Anonymous, zero-knowledge encrypted file sharing with expiring vaults." />'
    );
    expect(page).not.toContain('Archivum Null');
  });

  it('adds the tags the SPA reads the values from', () => {
    const page = applyBranding(SOURCE_PAGE, { ...DEFAULTS, name: 'Acme Drop', tagline: 'Files, sealed' });

    expect(page).toContain('<meta name="application-name" content="Acme Drop" />');
    expect(page).toContain('<meta name="brand-tagline" content="Files, sealed" />');
    // Inside the head, not after it.
    expect(page.indexOf('brand-tagline')).toBeLessThan(page.indexOf('</head>'));
  });

  it('leaves the rest of the page as it was', () => {
    const page = applyBranding(SOURCE_PAGE, DEFAULTS);

    for (const line of SOURCE_PAGE.split('\n')) {
      if (/<title>|name="description"|<\/head>/.test(line)) continue;
      expect(page).toContain(line);
    }
  });

  it('cannot be used to inject markup through the name', () => {
    const page = applyBranding(SOURCE_PAGE, { ...DEFAULTS, name: '</title><script>alert(1)</script>' });

    expect(page).not.toContain('<script>alert(1)</script>');
    expect(page).toContain('<title>&lt;/title&gt;&lt;script&gt;alert(1)&lt;/script&gt;</title>');
    // Still exactly the scripts the page shipped with.
    expect(count(page, /<script\b/g)).toBe(count(SOURCE_PAGE, /<script\b/g));
  });

  it('cannot be used to break out of an attribute through the tagline', () => {
    const page = applyBranding(SOURCE_PAGE, {
      ...DEFAULTS,
      tagline: 'x" /><meta http-equiv="refresh" content="0;url=https://evil.example',
    });

    expect(page).not.toContain('<meta http-equiv');
    expect(page).toContain('content="x&quot; /&gt;&lt;meta http-equiv=&quot;refresh&quot;');
  });

  it('inserts replacement patterns in a name literally', () => {
    const page = applyBranding(SOURCE_PAGE, { ...DEFAULTS, name: 'Cash $& Carry $1 $$ $`' });

    expect(page).toContain('<title>Cash $&amp; Carry $1 $$ $`</title>');
  });

  it('ends the tagline with a full stop in the description only when it has none', () => {
    const plain = applyBranding(SOURCE_PAGE, { ...DEFAULTS, name: 'A', tagline: 'Share safely' });
    const punctuated = applyBranding(SOURCE_PAGE, { ...DEFAULTS, name: 'A', tagline: 'Share safely!' });

    expect(plain).toContain('content="A — Share safely. Anonymous');
    expect(punctuated).toContain('content="A — Share safely! Anonymous');
  });

  it('adds no style element while the accent is the built-in one', () => {
    expect(applyBranding(SOURCE_PAGE, DEFAULTS)).not.toContain('<style');
  });

  it('overrides the accent and its label colour for a configured accent', () => {
    const light = applyBranding(SOURCE_PAGE, { ...DEFAULTS, accentColor: '#f97316' });
    const dark = applyBranding(SOURCE_PAGE, { ...DEFAULTS, accentColor: '#1e3a8a' });

    expect(light).toContain('<style>:root{--color-vault-accent:#f97316;--color-vault-on-accent:#0b0f19}</style>');
    expect(dark).toContain('<style>:root{--color-vault-accent:#1e3a8a;--color-vault-on-accent:#ffffff}</style>');
    // After the stylesheet link, inside the head.
    expect(light.indexOf('<style>')).toBeLessThan(light.indexOf('</head>'));
  });

  it('adds a title to a page that had none', () => {
    const page = applyBranding('<html><head><meta charset="UTF-8" /></head><body></body></html>', DEFAULTS);

    expect(page).toContain('<title>Archivum Null</title>');
    expect(page.indexOf('<title>')).toBeLessThan(page.indexOf('</head>'));
  });

  it('leaves a page without a head alone', () => {
    expect(applyBranding('<html>bare</html>', DEFAULTS)).toBe('<html>bare</html>');
  });
});

describe('buildApp — branding on the served page', () => {
  const SECURITY_HEADERS = [
    'content-security-policy',
    'strict-transport-security',
    'x-content-type-options',
    'x-frame-options',
    'x-xss-protection',
    'referrer-policy',
    'permissions-policy',
    'cache-control',
  ];

  let app: FastifyInstance | undefined;
  let storageDir: string | undefined;

  async function start(env: Record<string, string> = {}): Promise<FastifyInstance> {
    vi.resetModules();
    storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'archivum-branding-app-'));
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('STORAGE_PATH', storageDir);
    vi.stubEnv('ADMIN_PASSWORD', 'strong-test-password');
    for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);

    const { buildApp } = await import('../app.js');
    app = await buildApp();
    await app.ready();
    return app;
  }

  async function stop(): Promise<void> {
    await app?.close();
    app = undefined;
    vi.unstubAllEnvs();
    if (storageDir) fs.rmSync(storageDir, { recursive: true, force: true });
    storageDir = undefined;
  }

  afterEach(stop);

  it('serves the built-in name and tagline when nothing is configured', async () => {
    const res = await (await start()).inject({ method: 'GET', url: '/' });

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('<title>Archivum Null</title>');
    expect(res.body).toContain('<meta name="application-name" content="Archivum Null" />');
    expect(res.body).toContain('<meta name="brand-tagline" content="Zero trust file relay" />');
  });

  it('serves the configured name and tagline, escaped', async () => {
    const res = await (
      await start({ BRAND_NAME: 'Acme <Drop> & "Co"', BRAND_TAGLINE: "Files, sealed — it's yours" })
    ).inject({ method: 'GET', url: '/' });

    expect(res.body).toContain('<title>Acme &lt;Drop&gt; &amp; &quot;Co&quot;</title>');
    expect(res.body).toContain('<meta name="brand-tagline" content="Files, sealed — it&#39;s yours" />');
    expect(res.body).not.toContain('<Drop>');
  });

  it('serves the configured accent as an override of the stylesheet variables', async () => {
    const res = await (await start({ BRAND_ACCENT_COLOR: '#F97316' })).inject({ method: 'GET', url: '/' });

    expect(res.body).toContain('--color-vault-accent:#f97316;--color-vault-on-accent:#0b0f19');
  });

  it('serves the same branded page on SPA routes', async () => {
    const res = await (await start({ BRAND_NAME: 'Acme Drop' })).inject({ method: 'GET', url: '/vault/abc123' });

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('<title>Acme Drop</title>');
  });

  it('sends the same security headers with branding as without', async () => {
    const plain = await (await start()).inject({ method: 'GET', url: '/' });
    await stop();
    const branded = await (
      await start({ BRAND_NAME: 'Acme Drop', BRAND_TAGLINE: 'Files, sealed', BRAND_ACCENT_COLOR: '#f97316' })
    ).inject({ method: 'GET', url: '/' });

    for (const header of SECURITY_HEADERS) {
      expect(plain.headers[header], header).toBeDefined();
      expect(branded.headers[header], header).toBe(plain.headers[header]);
    }
  });

  it('refuses to start on a name it cannot show safely', async () => {
    await expect(start({ BRAND_NAME: 'two\nlines' })).rejects.toThrow(/^BRAND_NAME must be/);
  });

  it('refuses to start on an accent that is not a plain hex colour', async () => {
    await expect(start({ BRAND_ACCENT_COLOR: 'red;}*{display:none' })).rejects.toThrow(
      /^BRAND_ACCENT_COLOR must be/
    );
  });
});

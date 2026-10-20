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
import type * as Terms from '../static/terms.js';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  applyBranding,
  brandingWarnings,
  buildManifest,
  contrastRatio,
  escapeHtml,
  onAccentColor,
  parseBranding,
  THEME_BACKGROUND,
} from '../static/branding.js';

/** What the environment holds when nothing is configured, and what that parses to. */
const INPUT = { name: 'Archivum Null', tagline: 'Anonymous encrypted file sharing', accentColor: '', theme: 'dark' };
const DEFAULTS = {
  name: 'Archivum Null',
  tagline: 'Anonymous encrypted file sharing',
  accentColor: null,
  theme: 'dark',
} as const;

/** The page the frontend build starts from — the anchors applyBranding relies on live here. */
const SOURCE_PAGE = fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'frontend', 'index.html'),
  'utf-8'
);

/** The stylesheet whose variables the injected values have to line up with. */
const STYLESHEET = fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'frontend', 'src', 'index.css'),
  'utf-8'
);

/** Every hex value the stylesheet gives a token, in source order: the dark default first. */
function tokenValues(name: string): string[] {
  const values = [...STYLESHEET.matchAll(new RegExp(`--color-vault-${name}:\\s*(#[0-9a-fA-F]{6});`, 'g'))];
  if (values.length === 0) throw new Error(`--color-vault-${name} is not a hex colour in index.css`);
  return values.map((match) => match[1].toLowerCase());
}

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

  it.each(['dark', 'light', 'auto'] as const)('accepts the %s theme', (theme) => {
    expect(parseBranding({ ...INPUT, theme }).theme).toBe(theme);
  });

  it.each(['', 'Dark', 'system', 'light dark', 'dark" onload="x'])('rejects the theme %j', (theme) => {
    expect(() => parseBranding({ ...INPUT, theme })).toThrow('BRAND_THEME must be one of: dark, light, auto');
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
    // The injected <style> overrides exactly these two variables; if the stylesheet
    // renamed either, a configured accent would silently stop applying.
    expect(onAccentColor(tokenValues('accent')[0])).toBe(tokenValues('on-accent')[0]);
  });
});

describe('brandingWarnings', () => {
  it('says nothing about the built-in accent or a readable one', () => {
    expect(brandingWarnings(DEFAULTS)).toEqual([]);
    expect(brandingWarnings({ ...DEFAULTS, accentColor: '#f97316' })).toEqual([]);
  });

  it('does not warn in the light theme, which darkens the accent for text itself', () => {
    expect(brandingWarnings({ ...DEFAULTS, accentColor: '#1e3a8a', theme: 'light' })).toEqual([]);
    // `auto` still shows the dark page to visitors who ask for it.
    expect(brandingWarnings({ ...DEFAULTS, accentColor: '#1e3a8a', theme: 'auto' })).toHaveLength(1);
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
      if (/<html\b|<title>|name="description"|<\/head>/.test(line)) continue;
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

  it('does not say the same thing twice in the description when the tagline is the built-in one', () => {
    const page = applyBranding(SOURCE_PAGE, DEFAULTS);

    expect(page).toContain(
      '<meta name="description" content="Archivum Null — anonymous, zero-knowledge encrypted file sharing with expiring vaults." />'
    );
  });

  it('marks the page with the theme and tints the browser UI to match', () => {
    const dark = applyBranding(SOURCE_PAGE, DEFAULTS);
    const light = applyBranding(SOURCE_PAGE, { ...DEFAULTS, theme: 'light' });

    expect(dark).toContain('<html data-theme="dark" lang="en">');
    expect(dark).toContain('<meta name="theme-color" content="#0b0f19" />');
    expect(light).toContain('<html data-theme="light" lang="en">');
    expect(light).toContain('<meta name="theme-color" content="#f8fafc" />');
    expect(count(light, /name="theme-color"/g)).toBe(1);
  });

  it('gives the auto theme one browser-UI colour per colour scheme', () => {
    const page = applyBranding(SOURCE_PAGE, { ...DEFAULTS, theme: 'auto' });

    expect(page).toContain('<html data-theme="auto" lang="en">');
    expect(page).toContain('<meta name="theme-color" content="#0b0f19" media="(prefers-color-scheme: dark)" />');
    expect(page).toContain('<meta name="theme-color" content="#f8fafc" media="(prefers-color-scheme: light)" />');
  });

  it('uses the page backgrounds the stylesheet defines', () => {
    // First the dark default in @theme, then the light override.
    expect(tokenValues('bg')).toEqual([THEME_BACKGROUND.dark, THEME_BACKGROUND.light]);
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

  it('links the web app manifest, once', () => {
    const page = applyBranding(SOURCE_PAGE, DEFAULTS);

    expect(count(page, /rel="manifest"/g)).toBe(1);
    expect(page).toContain('<link rel="manifest" href="/manifest.webmanifest" />');
  });

  it('names the operator logos for the SPA when there are any', () => {
    const none = applyBranding(SOURCE_PAGE, DEFAULTS);
    const both = applyBranding(SOURCE_PAGE, DEFAULTS, { logo: '/brand/logo.svg', logoLight: '/brand/logo-light.png' });
    const lightOnly = applyBranding(SOURCE_PAGE, DEFAULTS, { logoLight: '/brand/logo-light.png' });

    expect(none).not.toContain('brand-logo');
    expect(both).toContain('<meta name="brand-logo" content="/brand/logo.svg" />');
    expect(both).toContain('<meta name="brand-logo-light" content="/brand/logo-light.png" />');
    expect(lightOnly).not.toContain('name="brand-logo" ');
    expect(lightOnly).toContain('<meta name="brand-logo-light" content="/brand/logo-light.png" />');
  });

  it('leaves the page free of URLs to other origins, whatever is configured', () => {
    const page = applyBranding(
      SOURCE_PAGE,
      { name: 'Acme https://evil.example', tagline: 'Files, sealed', accentColor: '#f97316', theme: 'auto' },
      { logo: '/brand/logo.svg', logoLight: '/brand/logo-light.png' }
    );

    // The name is text and may say anything; nothing that the browser fetches may.
    const fetched = [...page.matchAll(/\b(?:src|href|content)\s*=\s*"([^"]*)"/g)]
      .map((match) => match[1])
      .filter((value) => /^(?:[a-z][a-z0-9+.-]*:)?\/\//i.test(value));
    expect(fetched).toEqual([]);
    expect(page).not.toContain('url(');
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

describe('buildManifest', () => {
  const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'frontend', 'public');

  it('carries the configured name and tagline', () => {
    const manifest = JSON.parse(buildManifest({ ...DEFAULTS, name: 'Acme Drop', tagline: 'Files, sealed' }));

    expect(manifest).toMatchObject({
      name: 'Acme Drop',
      description: 'Files, sealed',
      start_url: '/',
      scope: '/',
      display: 'standalone',
    });
  });

  it('stays valid JSON whatever the name contains', () => {
    const name = 'Acme "Drop" \\ </script> 🗄';

    expect(JSON.parse(buildManifest({ ...DEFAULTS, name })).name).toBe(name);
  });

  it('takes its colours from the theme, with the dark pair for auto', () => {
    const colours = (theme: 'dark' | 'light' | 'auto') => {
      const { background_color, theme_color } = JSON.parse(buildManifest({ ...DEFAULTS, theme }));
      return [background_color, theme_color];
    };

    expect(colours('dark')).toEqual(['#0b0f19', '#0b0f19']);
    expect(colours('light')).toEqual(['#f8fafc', '#f8fafc']);
    expect(colours('auto')).toEqual(['#0b0f19', '#0b0f19']);
  });

  it('names only icons the frontend ships, at the sizes it claims for them', () => {
    const { icons } = JSON.parse(buildManifest(DEFAULTS)) as {
      icons: { src: string; sizes: string; type: string; purpose?: string }[];
    };

    expect(icons.map((icon) => icon.src)).toEqual(['/icon-192.png', '/icon-512.png', '/icon-maskable-512.png']);
    for (const icon of icons) {
      const png = fs.readFileSync(path.join(PUBLIC_DIR, icon.src));
      // A PNG states its width and height as two big-endian integers right after the IHDR tag.
      expect(png.subarray(1, 4).toString('latin1'), icon.src).toBe('PNG');
      expect(`${png.readUInt32BE(16)}x${png.readUInt32BE(20)}`, icon.src).toBe(icon.sizes);
      expect(icon.type).toBe('image/png');
      // Every origin-relative: a manifest that pointed elsewhere would load a third-party image.
      expect(icon.src.startsWith('/') && !icon.src.startsWith('//')).toBe(true);
    }
  });

  it('declares no service worker and nothing that would need one', () => {
    const manifest = JSON.parse(buildManifest(DEFAULTS));

    expect(Object.keys(manifest).sort()).toEqual(
      ['background_color', 'description', 'display', 'icons', 'name', 'scope', 'start_url', 'theme_color'].sort()
    );
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
    // An empty directory, so a branding/ folder in the checkout cannot leak into the page.
    vi.stubEnv('BRANDING_PATH', storageDir);
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
    expect(res.body).toContain('<meta name="brand-tagline" content="Anonymous encrypted file sharing" />');
  });

  it('marks the page when there are no terms, for the footer to leave out its link', async () => {
    vi.doMock('../static/terms.js', async (importOriginal) => ({
      ...(await importOriginal<typeof Terms>()),
      loadTerms: () => null,
    }));
    try {
      const res = await (await start()).inject({ method: 'GET', url: '/' });

      expect(res.body).toContain('<meta name="terms" content="none" />');
      expect(res.body.indexOf('name="terms"')).toBeLessThan(res.body.indexOf('</head>'));
    } finally {
      vi.doUnmock('../static/terms.js');
    }
  });

  it('leaves a page with terms unmarked', async () => {
    const res = await (await start()).inject({ method: 'GET', url: '/' });

    expect(res.body).not.toContain('name="terms"');
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

  it('serves the dark theme unless another one is configured', async () => {
    const dark = await (await start()).inject({ method: 'GET', url: '/' });
    await stop();
    const auto = await (await start({ BRAND_THEME: 'auto' })).inject({ method: 'GET', url: '/' });

    expect(dark.body).toContain('<html data-theme="dark"');
    expect(auto.body).toContain('<html data-theme="auto"');
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
      await start({
        BRAND_NAME: 'Acme Drop',
        BRAND_TAGLINE: 'Files, sealed',
        BRAND_ACCENT_COLOR: '#f97316',
        BRAND_THEME: 'light',
      })
    ).inject({ method: 'GET', url: '/' });

    for (const header of SECURITY_HEADERS) {
      expect(plain.headers[header], header).toBeDefined();
      expect(branded.headers[header], header).toBe(plain.headers[header]);
    }
  });

  it('serves a manifest that carries the configured name', async () => {
    const res = await (
      await start({ BRAND_NAME: 'Acme Drop', BRAND_THEME: 'light' })
    ).inject({ method: 'GET', url: '/manifest.webmanifest' });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/manifest+json; charset=utf-8');
    expect(res.headers['cache-control']).toBe('public, max-age=0, must-revalidate');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.json()).toMatchObject({ name: 'Acme Drop', theme_color: '#f8fafc' });
  });

  it('refuses to start on a name it cannot show safely', async () => {
    await expect(start({ BRAND_NAME: 'two\nlines' })).rejects.toThrow(/^BRAND_NAME must be/);
  });

  it('refuses to start on an unknown theme', async () => {
    await expect(start({ BRAND_THEME: 'sepia' })).rejects.toThrow('BRAND_THEME must be one of');
  });

  it('refuses to start on an accent that is not a plain hex colour', async () => {
    await expect(start({ BRAND_ACCENT_COLOR: 'red;}*{display:none' })).rejects.toThrow(
      /^BRAND_ACCENT_COLOR must be/
    );
  });
});

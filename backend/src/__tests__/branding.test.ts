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

import { applyBranding, escapeHtml, parseBranding } from '../static/branding.js';

const DEFAULTS = { name: 'Archivum Null', tagline: 'Zero trust file relay' };

/** The page the frontend build starts from — the anchors applyBranding relies on live here. */
const SOURCE_PAGE = fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'frontend', 'index.html'),
  'utf-8'
);

const count = (haystack: string, needle: RegExp): number => (haystack.match(needle) ?? []).length;

describe('parseBranding', () => {
  it('accepts the defaults', () => {
    expect(parseBranding(DEFAULTS)).toEqual(DEFAULTS);
  });

  it('counts length in characters, not in UTF-16 units', () => {
    // 64 emoji are 128 UTF-16 units — still 64 characters.
    expect(() => parseBranding({ ...DEFAULTS, name: '🗄'.repeat(64) })).not.toThrow();
    expect(() => parseBranding({ ...DEFAULTS, name: '🗄'.repeat(65) })).toThrow('BRAND_NAME');
    expect(parseBranding({ ...DEFAULTS, name: 'Skarbiec Żółwia' }).name).toBe('Skarbiec Żółwia');
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
    expect(() => parseBranding({ ...DEFAULTS, name })).toThrow(/^BRAND_NAME must be/);
  });

  it('holds the tagline to its own limit and names it in the error', () => {
    expect(() => parseBranding({ ...DEFAULTS, tagline: 'a'.repeat(120) })).not.toThrow();
    expect(() => parseBranding({ ...DEFAULTS, tagline: 'a'.repeat(121) })).toThrow(/^BRAND_TAGLINE must be/);
    expect(() => parseBranding({ ...DEFAULTS, tagline: 'two\nlines' })).toThrow(/^BRAND_TAGLINE must be/);
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
    const page = applyBranding(SOURCE_PAGE, { name: 'Acme Drop', tagline: 'Files, sealed' });

    expect(count(page, /<title>/g)).toBe(1);
    expect(page).toContain('<title>Acme Drop</title>');
    expect(count(page, /<meta name="description"/g)).toBe(1);
    expect(page).toContain(
      '<meta name="description" content="Acme Drop — Files, sealed. Anonymous, zero-knowledge encrypted file sharing with expiring vaults." />'
    );
    expect(page).not.toContain('Archivum Null');
  });

  it('adds the tags the SPA reads the values from', () => {
    const page = applyBranding(SOURCE_PAGE, { name: 'Acme Drop', tagline: 'Files, sealed' });

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
    const page = applyBranding(SOURCE_PAGE, {
      name: '</title><script>alert(1)</script>',
      tagline: DEFAULTS.tagline,
    });

    expect(page).not.toContain('<script>alert(1)</script>');
    expect(page).toContain('<title>&lt;/title&gt;&lt;script&gt;alert(1)&lt;/script&gt;</title>');
    // Still exactly the scripts the page shipped with.
    expect(count(page, /<script\b/g)).toBe(count(SOURCE_PAGE, /<script\b/g));
  });

  it('cannot be used to break out of an attribute through the tagline', () => {
    const page = applyBranding(SOURCE_PAGE, {
      name: DEFAULTS.name,
      tagline: 'x" /><meta http-equiv="refresh" content="0;url=https://evil.example',
    });

    expect(page).not.toContain('<meta http-equiv');
    expect(page).toContain('content="x&quot; /&gt;&lt;meta http-equiv=&quot;refresh&quot;');
  });

  it('inserts replacement patterns in a name literally', () => {
    const page = applyBranding(SOURCE_PAGE, { name: 'Cash $& Carry $1 $$ $`', tagline: DEFAULTS.tagline });

    expect(page).toContain('<title>Cash $&amp; Carry $1 $$ $`</title>');
  });

  it('ends the tagline with a full stop in the description only when it has none', () => {
    const plain = applyBranding(SOURCE_PAGE, { name: 'A', tagline: 'Share safely' });
    const punctuated = applyBranding(SOURCE_PAGE, { name: 'A', tagline: 'Share safely!' });

    expect(plain).toContain('content="A — Share safely. Anonymous');
    expect(punctuated).toContain('content="A — Share safely! Anonymous');
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

  it('serves the same branded page on SPA routes', async () => {
    const res = await (await start({ BRAND_NAME: 'Acme Drop' })).inject({ method: 'GET', url: '/vault/abc123' });

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('<title>Acme Drop</title>');
  });

  it('sends the same security headers with branding as without', async () => {
    const plain = await (await start()).inject({ method: 'GET', url: '/' });
    await stop();
    const branded = await (
      await start({ BRAND_NAME: 'Acme Drop', BRAND_TAGLINE: 'Files, sealed' })
    ).inject({ method: 'GET', url: '/' });

    for (const header of SECURITY_HEADERS) {
      expect(plain.headers[header], header).toBeDefined();
      expect(branded.headers[header], header).toBe(plain.headers[header]);
    }
  });

  it('refuses to start on a name it cannot show safely', async () => {
    await expect(start({ BRAND_NAME: 'two\nlines' })).rejects.toThrow(/^BRAND_NAME must be/);
  });
});

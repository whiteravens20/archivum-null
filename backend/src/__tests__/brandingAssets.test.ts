/**
 * Operator-supplied logo and icons — unit and end-to-end tests.
 *
 * The branding directory is the one place where an operator's files are served as
 * they are, so the tests are mostly about what is NOT served: anything outside the
 * fixed list of names, anything oversized, anything that is not a file. The
 * end-to-end block goes through buildApp() because the override only works if the
 * exact routes win over the static plugin's wildcard — a property of the wiring.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

import { loadBrandingAssets, MAX_ASSET_BYTES } from '../static/brandingAssets.js';

const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><rect width="8" height="8"/></svg>';

describe('loadBrandingAssets', () => {
  let dir: string;
  let warnings: string[];
  const load = () => loadBrandingAssets(dir, (message) => warnings.push(message));
  const put = (name: string, content: string | Buffer = SVG) => fs.writeFileSync(path.join(dir, name), content);

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'archivum-branding-'));
    warnings = [];
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('yields nothing, quietly, when the directory does not exist', () => {
    const assets = loadBrandingAssets(path.join(dir, 'missing'), (message) => warnings.push(message));

    expect(assets.files.size).toBe(0);
    expect(assets.logo).toBeUndefined();
    expect(assets.logoLight).toBeUndefined();
    expect(warnings).toEqual([]);
  });

  it('serves each icon at the URL of the built-in file it replaces', () => {
    put('favicon.svg');
    put('favicon.ico', Buffer.from([0, 0, 1, 0]));
    put('apple-touch-icon.png', Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    const assets = load();

    expect([...assets.files.keys()].sort()).toEqual(['/apple-touch-icon.png', '/favicon.ico', '/favicon.svg']);
    expect(assets.files.get('/favicon.svg')).toEqual({ body: Buffer.from(SVG), contentType: 'image/svg+xml' });
    expect(assets.files.get('/favicon.ico')?.contentType).toBe('image/vnd.microsoft.icon');
    expect(assets.files.get('/apple-touch-icon.png')?.contentType).toBe('image/png');
    expect(warnings).toEqual([]);
  });

  it('lets the icons of the web app manifest be replaced too', () => {
    for (const name of ['icon-192.png', 'icon-512.png', 'icon-maskable-512.png']) put(name, Buffer.from([0x89, 0x50]));

    const assets = load();

    expect([...assets.files.keys()].sort()).toEqual(['/icon-192.png', '/icon-512.png', '/icon-maskable-512.png']);
    expect(warnings).toEqual([]);
  });

  it('takes the type from the file name, not from the content', () => {
    put('apple-touch-icon.png', '<script>alert(1)</script>');

    expect(load().files.get('/apple-touch-icon.png')?.contentType).toBe('image/png');
  });

  it.each([
    ['logo.svg', 'image/svg+xml'],
    ['logo.webp', 'image/webp'],
    ['logo.png', 'image/png'],
  ])('serves %s under its own extension', (name, contentType) => {
    put(name);

    const assets = load();

    expect(assets.logo).toBe(`/brand/${name}`);
    expect(assets.files.get(`/brand/${name}`)?.contentType).toBe(contentType);
  });

  it('prefers svg over webp over png when several logos are present', () => {
    put('logo.png');
    put('logo.webp');
    expect(load().logo).toBe('/brand/logo.webp');

    put('logo.svg');
    const assets = load();

    expect(assets.logo).toBe('/brand/logo.svg');
    // The ones that lost are not served at all.
    expect(assets.files.has('/brand/logo.webp')).toBe(false);
    expect(assets.files.has('/brand/logo.png')).toBe(false);
    expect(warnings).toEqual([]);
  });

  it('uses a single logo in both themes', () => {
    put('logo.svg');

    const assets = load();

    expect(assets.logo).toBe('/brand/logo.svg');
    expect(assets.logoLight).toBe('/brand/logo.svg');
  });

  it('uses a separate light-theme logo when there is one', () => {
    put('logo.svg');
    put('logo-light.png');

    const assets = load();

    expect(assets.logo).toBe('/brand/logo.svg');
    expect(assets.logoLight).toBe('/brand/logo-light.png');
  });

  it('keeps the built-in dark-theme logo when only a light one is supplied', () => {
    put('logo-light.svg');

    const assets = load();

    expect(assets.logo).toBeUndefined();
    expect(assets.logoLight).toBe('/brand/logo-light.svg');
  });

  it('skips a file over the size limit and says so', () => {
    put('favicon.svg', Buffer.alloc(MAX_ASSET_BYTES + 1));
    put('logo.png', Buffer.alloc(MAX_ASSET_BYTES));

    const assets = load();

    expect(assets.files.has('/favicon.svg')).toBe(false);
    expect(assets.files.get('/brand/logo.png')?.body).toHaveLength(MAX_ASSET_BYTES);
    expect(warnings).toEqual(['Branding: favicon.svg is larger than 1024 KiB and was skipped']);
  });

  it('skips a directory that has the name of a file', () => {
    fs.mkdirSync(path.join(dir, 'favicon.svg'));

    expect(load().files.size).toBe(0);
    expect(warnings).toEqual(['Branding: favicon.svg is not a file and was skipped']);
  });

  // Node has no mkfifo of its own, and Windows has no named pipes of this kind.
  it.skipIf(process.platform === 'win32')('skips a named pipe without waiting on it', () => {
    execFileSync('mkfifo', [path.join(dir, 'favicon.svg')]);

    // A blocking open would hang here until something wrote to the pipe.
    expect(load().files.size).toBe(0);
    expect(warnings).toEqual(['Branding: favicon.svg is not a file and was skipped']);
  });

  it('holds each file in a buffer of its own size', () => {
    put('favicon.svg');

    const body = load().files.get('/favicon.svg')!.body;

    expect(body.toString()).toBe(SVG);
    // Not a view into the megabyte it was read into.
    expect(body.buffer.byteLength).toBeLessThan(MAX_ASSET_BYTES);
  });

  it('follows a symbolic link to a file, as a mounted ConfigMap presents one', () => {
    const target = path.join(dir, '..data-favicon');
    fs.writeFileSync(target, SVG);
    fs.symlinkSync(target, path.join(dir, 'favicon.svg'));

    expect(load().files.get('/favicon.svg')?.body.toString()).toBe(SVG);
    expect(warnings).toEqual([]);
  });

  it('serves nothing it does not know by name, and points out what it ignored', () => {
    put('Logo.SVG');
    put('index.html', '<script>alert(1)</script>');
    put('notes.txt', 'private');
    put('.hidden', 'kept quiet');

    const assets = load();

    expect(assets.files.size).toBe(0);
    expect(warnings).toHaveLength(3);
    expect(warnings.every((warning) => warning.includes('is not a file name this server uses'))).toBe(true);
    expect(warnings.join('\n')).not.toContain('.hidden');
  });
});

describe('buildApp — operator files replace the built-in images', () => {
  let app: FastifyInstance | undefined;
  let scratch: string;

  async function start(files: Record<string, string | Buffer>): Promise<FastifyInstance> {
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'archivum-branding-app-'));
    const brandingDir = path.join(scratch, 'branding');
    fs.mkdirSync(brandingDir);
    for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(brandingDir, name), content);
    fs.mkdirSync(path.join(scratch, 'vaults'));

    vi.resetModules();
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('STORAGE_PATH', path.join(scratch, 'vaults'));
    vi.stubEnv('ADMIN_PASSWORD', 'strong-test-password');
    vi.stubEnv('BRANDING_PATH', brandingDir);

    const { buildApp } = await import('../app.js');
    app = await buildApp();
    await app.ready();
    return app;
  }

  afterEach(async () => {
    await app?.close();
    app = undefined;
    vi.unstubAllEnvs();
    fs.rmSync(scratch, { recursive: true, force: true });
  });

  it('serves the operator favicon in place of the built-in one', async () => {
    const res = await (await start({ 'favicon.svg': SVG })).inject({ method: 'GET', url: '/favicon.svg' });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('image/svg+xml');
    expect(res.body).toBe(SVG);
  });

  it('sends an operator file with the headers of every other response', async () => {
    const res = await (await start({ 'logo.svg': SVG })).inject({ method: 'GET', url: '/brand/logo.svg' });

    expect(res.statusCode).toBe(200);
    // An SVG opened on its own is a document: the policy that forbids inline script
    // has to come with it, and the type must not be open to sniffing.
    expect(res.headers['content-security-policy']).toContain("script-src 'self' https://challenges.cloudflare.com");
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['cache-control']).toBe('public, max-age=0, must-revalidate');
    // Same rule as for the built-in files: nothing that dates the deployment.
    expect(res.headers).not.toHaveProperty('last-modified');
    expect(res.headers).not.toHaveProperty('etag');
  });

  it('tells the page where the operator logo is', async () => {
    const res = await (
      await start({ 'logo.webp': Buffer.from('RIFF'), 'logo-light.svg': SVG })
    ).inject({ method: 'GET', url: '/' });

    expect(res.body).toContain('<meta name="brand-logo" content="/brand/logo.webp" />');
    expect(res.body).toContain('<meta name="brand-logo-light" content="/brand/logo-light.svg" />');
  });

  it('names no logo in the page when the operator supplied none', async () => {
    const res = await (await start({ 'favicon.svg': SVG })).inject({ method: 'GET', url: '/' });

    expect(res.body).not.toContain('brand-logo');
  });

  it('does not serve other files from the directory', async () => {
    const instance = await start({ 'notes.txt': 'private notes', 'logo.svg': SVG });

    for (const url of ['/notes.txt', '/brand/notes.txt', '/brand/../notes.txt', '/brand/%2e%2e/notes.txt']) {
      const res = await instance.inject({ method: 'GET', url });
      expect(res.body, url).not.toContain('private notes');
    }
  });

  it('does not serve a logo in a format the operator did not supply', async () => {
    const res = await (await start({ 'logo.svg': SVG })).inject({ method: 'GET', url: '/brand/logo.png' });

    // Falls through to the SPA like any unknown path; what matters is that it is not the SVG.
    expect(res.headers['content-type']).not.toBe('image/svg+xml');
    expect(res.body).not.toBe(SVG);
  });
});

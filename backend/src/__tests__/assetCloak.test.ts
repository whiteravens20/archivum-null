/**
 * Asset-name cloaking — unit and end-to-end tests.
 *
 * Regression guard for a real finding: the public demo served
 * `/assets/index-Qld3srqp.js`, and rebuilding each published tag reproduced that
 * filename byte-for-byte, so an unauthenticated GET of `/` identified the exact
 * release. `Last-Modified` and the mtime-derived weak `ETag` dated the same build
 * independently. Both are version oracles and both are asserted dead here.
 *
 * The end-to-end block goes through `buildApp()` because the leak lives in the
 * @fastify/static *options*, not in any function a unit test would reach — flipping
 * `etag` back to its default would leave every unit test green.
 */

import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import { buildAssetCloak } from '../static/assetCloak.js';

const HASHED_JS = 'index-Qld3srqp.js';
const HASHED_CSS = 'index-Da10O7nR.css';

function writeDist(root: string, indexHtml: string): void {
  fs.mkdirSync(path.join(root, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(root, 'index.html'), indexHtml);
  fs.writeFileSync(path.join(root, 'assets', HASHED_JS), 'console.log(1);');
  fs.writeFileSync(path.join(root, 'assets', HASHED_CSS), 'body{color:red}');
}

const INDEX_HTML = [
  '<!DOCTYPE html><html><head>',
  `<script type="module" crossorigin src="/assets/${HASHED_JS}"></script>`,
  `<link rel="stylesheet" crossorigin href="/assets/${HASHED_CSS}">`,
  '</head><body><div id="root"></div></body></html>',
].join('\n');

describe('buildAssetCloak', () => {
  let distRoot: string;

  beforeEach(() => {
    distRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'archivum-cloak-'));
    writeDist(distRoot, INDEX_HTML);
  });

  afterEach(() => {
    fs.rmSync(distRoot, { recursive: true, force: true });
  });

  it('removes every reproducible asset name from the served index.html', () => {
    const cloak = buildAssetCloak(distRoot);

    expect(cloak).not.toBeNull();
    expect(cloak!.indexHtml).not.toContain(HASHED_JS);
    expect(cloak!.indexHtml).not.toContain(HASHED_CSS);
    // The Vite content hash itself must be gone, not merely the full filename.
    expect(cloak!.indexHtml).not.toContain('Qld3srqp');
    expect(cloak!.indexHtml).not.toContain('Da10O7nR');
  });

  it('emits a different name for the same bytes on every boot', () => {
    const first = buildAssetCloak(distRoot)!;
    const second = buildAssetCloak(distRoot)!;

    // Identical input, so a build-time salt would collide here. Only a per-boot
    // salt survives this assertion — which is the point: release images are public
    // on ghcr.io, so anything baked into one is knowable by the attacker.
    expect(first.indexHtml).not.toBe(second.indexHtml);
  });

  it('keeps the cloaked names resolvable, with the extension intact', () => {
    const cloak = buildAssetCloak(distRoot)!;

    const referenced = [...cloak.indexHtml.matchAll(/\/assets\/([^"']+)/g)].map((m) => m[1]);
    expect(referenced).toHaveLength(2);

    for (const name of referenced) {
      expect(cloak.get(name)).toBeDefined();
    }
    expect(referenced.some((n) => n.endsWith('.js'))).toBe(true);
    expect(referenced.some((n) => n.endsWith('.css'))).toBe(true);
  });

  it('does not resolve the real on-disk names', () => {
    const cloak = buildAssetCloak(distRoot)!;

    expect(cloak.get(HASHED_JS)).toBeUndefined();
    expect(cloak.get(HASHED_CSS)).toBeUndefined();
  });

  it('rewrites asset-to-asset references so cloaking cannot break the page', () => {
    // Vite emits /assets/… URLs inside CSS for anything it does not inline. If those
    // were left alone the cloaked names would 404 the moment a build has one.
    fs.writeFileSync(
      path.join(distRoot, 'assets', HASHED_CSS),
      `body{background:url("/assets/${HASHED_JS}")}`
    );

    const cloak = buildAssetCloak(distRoot)!;
    const cssName = [...cloak.indexHtml.matchAll(/\/assets\/([^"']+\.css)/g)][0][1];
    const css = cloak.get(cssName)!;

    expect(css.body).not.toBeNull();
    const rendered = css.body!.toString('utf-8');
    expect(rendered).not.toContain(HASHED_JS);
    expect(rendered).toMatch(/\/assets\/[0-9a-f]{16}\.js/);
  });

  it('holds nothing in memory for assets that reference nothing', () => {
    const cloak = buildAssetCloak(distRoot)!;
    const jsName = [...cloak.indexHtml.matchAll(/\/assets\/([^"']+\.js)/g)][0][1];

    // Nothing to rewrite, so the file is streamed from disk rather than buffered.
    expect(cloak.get(jsName)!.body).toBeNull();
  });

  it('cloaks nested assets, which the static plugin would otherwise make unreachable', () => {
    // A custom Vite `assetFileNames` can nest. Anything skipped here is not merely
    // left uncloaked — /assets/ is refused wholesale by the static plugin, so a
    // missed file 404s and the page breaks.
    fs.mkdirSync(path.join(distRoot, 'assets', 'fonts'), { recursive: true });
    fs.writeFileSync(path.join(distRoot, 'assets', 'fonts', 'mono-AbCd1234.woff2'), 'font');
    fs.writeFileSync(
      path.join(distRoot, 'assets', HASHED_CSS),
      '@font-face{src:url("/assets/fonts/mono-AbCd1234.woff2")}'
    );

    const cloak = buildAssetCloak(distRoot)!;
    const cssName = [...cloak.indexHtml.matchAll(/\/assets\/([^"']+\.css)/g)][0][1];
    const css = cloak.get(cssName)!.body!.toString('utf-8');

    expect(css).not.toContain('mono-AbCd1234');
    const fontName = /\/assets\/([0-9a-f]{16}\.woff2)/.exec(css)![1];
    // Nesting collapses — a cloaked name carries no directory structure either.
    expect(fontName).not.toContain('/');
    expect(cloak.get(fontName)).toBeDefined();
  });

  it('does not mangle a name that is a prefix of another', () => {
    // Replacing `app.js` first would rewrite the `app.js` inside `app.js.map` and
    // leave a broken `/assets/<cloak>.map` behind.
    fs.writeFileSync(path.join(distRoot, 'assets', 'app.js'), 'x');
    fs.writeFileSync(path.join(distRoot, 'assets', 'app.js.map'), 'y');
    fs.writeFileSync(
      path.join(distRoot, 'assets', HASHED_CSS),
      '/*! /assets/app.js.map and /assets/app.js */'
    );

    const cloak = buildAssetCloak(distRoot)!;
    const cssName = [...cloak.indexHtml.matchAll(/\/assets\/([^"']+\.css)/g)][0][1];
    const css = cloak.get(cssName)!.body!.toString('utf-8');

    const referenced = [...css.matchAll(/\/assets\/([^\s*]+)/g)].map((m) => m[1]);
    expect(referenced).toHaveLength(2);
    // Both still resolve — a mangled `<cloak>.map` would not be in the map at all.
    for (const name of referenced) {
      expect(cloak.get(name)).toBeDefined();
    }
    expect(new Set(referenced).size).toBe(2);
    // Extension is whatever `path.extname` sees, so `app.js.map` cloaks to `<hex>.map`.
    expect(referenced.some((n) => /^[0-9a-f]{16}\.map$/.test(n))).toBe(true);
    expect(referenced.some((n) => /^[0-9a-f]{16}\.js$/.test(n))).toBe(true);
  });

  it('returns null when there is no bundled frontend', () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'archivum-cloak-empty-'));
    try {
      expect(buildAssetCloak(empty)).toBeNull();
    } finally {
      fs.rmSync(empty, { recursive: true, force: true });
    }
  });

  it('serves index.html unchanged when a build has no assets directory', () => {
    const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'archivum-cloak-bare-'));
    try {
      fs.writeFileSync(path.join(bare, 'index.html'), '<html>bare</html>');
      expect(buildAssetCloak(bare)!.indexHtml).toBe('<html>bare</html>');
    } finally {
      fs.rmSync(bare, { recursive: true, force: true });
    }
  });
});

describe('buildApp — static serving does not disclose the running version', () => {
  // buildApp resolves the bundle at <backend>/../frontend/dist. The backend test job
  // never builds the frontend, so provision a stand-in when one is not already there
  // and remove exactly what we created.
  const distRoot = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    '..',
    '..',
    'frontend',
    'dist'
  );
  let provisioned = false;
  let app: FastifyInstance;
  let storageDir: string;

  beforeAll(() => {
    if (!fs.existsSync(path.join(distRoot, 'index.html'))) {
      writeDist(distRoot, INDEX_HTML);
      provisioned = true;
    }
  });

  afterAll(() => {
    if (provisioned) fs.rmSync(distRoot, { recursive: true, force: true });
  });

  beforeEach(async () => {
    vi.resetModules();
    storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'archivum-cloak-app-'));
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('STORAGE_PATH', storageDir);
    vi.stubEnv('ADMIN_PASSWORD', 'strong-test-password');

    const { buildApp } = await import('../app.js');
    app = await buildApp();
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    vi.unstubAllEnvs();
    fs.rmSync(storageDir, { recursive: true, force: true });
  });

  it('serves an index.html that names no reproducible asset', async () => {
    const res = await app.inject({ method: 'GET', url: '/' });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.body).toMatch(/\/assets\/[0-9a-f]{16}\.js/);
    expect(res.body).not.toMatch(/index-[A-Za-z0-9_-]{8}\.js/);
  });

  it('404s the real asset name even though the file is on disk', async () => {
    const res = await app.inject({ method: 'GET', url: `/assets/${HASHED_JS}` });

    expect(res.statusCode).toBe(404);
  });

  it('serves the cloaked asset with immutable caching', async () => {
    const index = await app.inject({ method: 'GET', url: '/' });
    const cloakedJs = /\/assets\/[0-9a-f]{16}\.js/.exec(index.body)![0];

    const res = await app.inject({ method: 'GET', url: cloakedJs });

    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toContain('immutable');
  });

  it('sends no mtime-derived headers with an asset', async () => {
    const index = await app.inject({ method: 'GET', url: '/' });
    const cloakedJs = /\/assets\/[0-9a-f]{16}\.js/.exec(index.body)![0];

    const res = await app.inject({ method: 'GET', url: cloakedJs });

    // Both dated the build to the second and pinned it to a release.
    expect(res.headers).not.toHaveProperty('last-modified');
    expect(res.headers).not.toHaveProperty('etag');
  });

  it('sends no mtime-derived headers with an unhashed public file', async () => {
    const res = await app.inject({ method: 'GET', url: '/' });

    expect(res.statusCode).toBe(200);
    expect(res.headers).not.toHaveProperty('last-modified');
    expect(res.headers).not.toHaveProperty('etag');
    // index.html points at names that change every boot — never store it.
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('still falls back to index.html for SPA routes', async () => {
    const res = await app.inject({ method: 'GET', url: '/some/client/route' });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
  });

  it('still 404s unknown API routes as JSON', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/nope' });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: 'Not found' });
  });
});

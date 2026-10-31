/**
 * The stand-in frontend bundle that the tests serve.
 *
 * buildApp resolves the bundle at <repo>/frontend/dist, and the backend test job never
 * builds the frontend. Vitest runs setup() once per run, before any test file: it writes
 * a stand-in when no real build is there, and teardown() removes exactly what was
 * written. This happens once per run and not in each test file because test files run
 * in parallel, and one file removing the directory would pull it from under another.
 */

import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

export const HASHED_JS = 'index-Qld3srqp.js';
export const HASHED_CSS = 'index-Da10O7nR.css';

export const INDEX_HTML = [
  '<!DOCTYPE html><html lang="en"><head>',
  '<meta name="description" content="Archivum Null — anonymous, zero-knowledge encrypted file sharing with expiring vaults." />',
  '<title>Archivum Null</title>',
  `<script type="module" crossorigin src="/assets/${HASHED_JS}"></script>`,
  `<link rel="stylesheet" crossorigin href="/assets/${HASHED_CSS}">`,
  '</head><body><div id="root"></div></body></html>',
].join('\n');

export function writeDist(root: string, indexHtml: string): void {
  fs.mkdirSync(path.join(root, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(root, 'index.html'), indexHtml);
  fs.writeFileSync(path.join(root, 'assets', HASHED_JS), 'console.log(1);');
  fs.writeFileSync(path.join(root, 'assets', HASHED_CSS), 'body{color:red}');
}

const distRoot = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'frontend',
  'dist',
);
let provisioned = false;

export function setup(): void {
  if (!fs.existsSync(path.join(distRoot, 'index.html'))) {
    writeDist(distRoot, INDEX_HTML);
    provisioned = true;
  }
}

export function teardown(): void {
  if (provisioned) fs.rmSync(distRoot, { recursive: true, force: true });
}

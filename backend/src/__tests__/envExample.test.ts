/**
 * The example environment file is what a new deployment starts from: copied to .env
 * and loaded by the Compose files and by the LXC installer. Every value it sets has to
 * be one the server accepts, or a fresh install does not start.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const examplePath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '.env.example');

/** KEY=value lines that are not commented out. */
function readExample(): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of fs.readFileSync(examplePath, 'utf-8').split('\n')) {
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    if (match) values[match[1]] = match[2];
  }
  return values;
}

describe('.env.example', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('should set only values the server starts with', async () => {
    const example = readExample();
    // Guards the test itself: a parser that found nothing would pass anything
    expect(Object.keys(example).length).toBeGreaterThan(15);
    for (const [key, value] of Object.entries(example)) vi.stubEnv(key, value);

    const { validateConfig } = await import('../config.js');
    expect(() => validateConfig()).not.toThrow();
  });

  it('should leave the reverse proxy address to the default instead of a placeholder', () => {
    // A placeholder here is refused at startup, and the way to find the real address,
    // one request through the proxy and a look at the log, needs a server that starts.
    expect(readExample()).not.toHaveProperty('TRUST_PROXY');
  });
});

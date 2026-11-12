/**
 * A limit follows the route a request reaches, however its path is written.
 *
 * The router decodes a path, cuts it at `?` and `#`, and takes an absolute URL, so every
 * route has many spellings, and a limit that compared text would miss them. These tests
 * go through buildApp() and over a real socket, because app.inject() can tidy a URL up
 * before the router sees it. Nothing is mocked. Each client is an address of its own in
 * X-Forwarded-For, from a peer the app is told to trust.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const ID = 'A'.repeat(24);
const PASSWORD = 'strong-test-password';
const wrongLogin = {
  authorization: `Basic ${Buffer.from('admin:guess').toString('base64')}`,
};
const rightLogin = {
  authorization: `Basic ${Buffer.from(`admin:${PASSWORD}`).toString('base64')}`,
};

const ADMIN_ROUTES: [string, string][] = [
  ['GET', '/api/admin/stats'],
  ['GET', '/api/admin/version'],
  ['GET', '/api/admin/vaults'],
  ['DELETE', `/api/admin/vaults/${ID}`],
];
const GENERAL_ROUTES: [string, string][] = [
  ['GET', '/api/config'],
  ['GET', '/api/health'],
  ['GET', '/api/tos'],
  ['GET', `/api/vault/${ID}`],
  ['HEAD', `/api/vault/${ID}`],
  ['DELETE', `/api/vault/upload/${ID}`],
  ['POST', `/api/vault/upload/${ID}/chunk`],
  ['POST', `/api/vault/upload/${ID}/complete`],
  ...ADMIN_ROUTES,
];
const UPLOAD_ROUTES: [string, string][] = [
  ['POST', '/api/vault'],
  ['POST', '/api/vault/upload/init'],
];
const DOWNLOAD_ROUTES: [string, string][] = [['GET', `/api/vault/${ID}/download`]];

/** Ways to write a path that the router reads as that path. */
function spellings(route: string): string[] {
  const encode = (char: string) => `%${char.charCodeAt(0).toString(16)}`;
  // The first letter of each segment on its own: every comparison starts at one of them.
  const oneLetter = [...route.matchAll(/\/[a-zA-Z]/g)].map((match) => {
    const at = match.index + 1;
    return route.slice(0, at) + encode(route[at]) + route.slice(at + 1);
  });
  return [
    ...oneLetter,
    route.replace(/[a-zA-Z]/g, encode),
    route.replace(/[a-zA-Z]/g, (char) => encode(char).toUpperCase()),
    `${route}?x=1`,
    `${route}?`,
    `${route}#x`,
    `${route}?x=1#y`,
    `http://test${route}`,
    `https://test:443${route}`,
    `http://user:pass@test${route}`,
    `http://test?x=${route}`,
  ];
}

interface Answer {
  status: number;
  headers: Record<string, string>;
  body: string;
}

let port = 0;

/** One request written out by hand, with the target exactly as given. */
function send(
  method: string,
  target: string,
  client: string,
  headers: Record<string, string> = {},
): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1');
    let raw = '';
    socket.setEncoding('utf8');
    socket.on('connect', () => {
      const lines = Object.entries({
        host: 'test',
        connection: 'close',
        'x-forwarded-for': client,
        ...headers,
      }).map(([name, value]) => `${name}: ${value}`);
      socket.write(`${method} ${target} HTTP/1.1\r\n${lines.join('\r\n')}\r\n\r\n`);
    });
    socket.on('data', (data) => (raw += data));
    socket.on('end', () => {
      const [head, ...body] = raw.split('\r\n\r\n');
      const [statusLine, ...headerLines] = head.split('\r\n');
      resolve({
        status: Number(statusLine.split(' ')[1]),
        headers: Object.fromEntries(
          headerLines.map((line) => {
            const colon = line.indexOf(':');
            return [line.slice(0, colon).toLowerCase(), line.slice(colon + 1).trim()];
          }),
        ),
        body: body.join('\r\n\r\n'),
      });
    });
    socket.on('error', reject);
  });
}

let clients = 0;
/** An address no other test has used: its buckets are all empty. */
const newClient = () => `198.51.${clients >> 8}.${clients++ & 0xff}`;

async function startApp(limits: Record<string, string>): Promise<() => Promise<void>> {
  vi.resetModules();
  const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'archivum-spelling-test-'));
  vi.stubEnv('NODE_ENV', 'test');
  vi.stubEnv('STORAGE_PATH', storageDir);
  vi.stubEnv('ADMIN_PASSWORD', PASSWORD);
  vi.stubEnv('TRUST_PROXY', '127.0.0.1');
  vi.stubEnv('RATE_LIMIT_WINDOW', '3600');
  for (const [name, value] of Object.entries(limits)) vi.stubEnv(name, value);

  const { buildApp } = await import('../app.js');
  const app: FastifyInstance = await buildApp();
  await app.listen({ host: '127.0.0.1', port: 0 });
  port = (app.server.address() as AddressInfo).port;

  return async () => {
    await app.close();
    vi.unstubAllEnvs();
    fs.rmSync(storageDir, { recursive: true, force: true });
  };
}

describe('every spelling of a route counts in the tier of that route', () => {
  const GENERAL = 50_000;
  const UPLOAD = 300;
  const DOWNLOAD = 400;
  let stop: () => Promise<void>;

  beforeAll(async () => {
    stop = await startApp({
      RATE_LIMIT_API_MAX: String(GENERAL),
      RATE_LIMIT_MAX: String(UPLOAD),
      RATE_LIMIT_DOWNLOAD_MAX: String(DOWNLOAD),
      RATE_LIMIT_ADMIN_MAX: String(GENERAL),
    });
  });
  afterAll(() => stop());

  it.each([
    ...GENERAL_ROUTES.map(([method, route]) => [method, route, GENERAL] as const),
    ...UPLOAD_ROUTES.map(([method, route]) => [method, route, UPLOAD] as const),
    ...DOWNLOAD_ROUTES.map(([method, route]) => [method, route, DOWNLOAD] as const),
  ])('%s %s', async (method, route, limit) => {
    const plain = await send(method, route, newClient());
    expect(plain.headers['x-ratelimit-limit']).toBe(String(limit));

    for (const spelling of spellings(route)) {
      const res = await send(method, spelling, newClient());
      // The same answer says it reached the same route; the header says where it counted.
      expect([spelling, res.status]).toEqual([spelling, plain.status]);
      expect([spelling, res.headers['x-ratelimit-limit']]).toEqual([spelling, String(limit)]);
      expect([spelling, res.headers['x-ratelimit-remaining']]).toEqual([
        spelling,
        String(limit - 1),
      ]);
    }
  });

  it.each([
    ['GET', '/api/nothing', GENERAL],
    ['GET', '/%61pi/nothing', GENERAL],
    ['GET', 'http://test/api/nothing', GENERAL],
    ['POST', '/api/nothing', GENERAL],
    ['POST', '/%61pi/nothing', GENERAL],
    // Only GET is routed here. Another method still counts where a download would.
    ['POST', `/api/vault/${ID}/download`, DOWNLOAD],
    ['POST', `/%61pi/vault/${ID}/%64ownload`, DOWNLOAD],
    ['POST', `/api/vault/${ID}/download#x`, DOWNLOAD],
    ['POST', `/api/vault/${ID}/download?x=1`, DOWNLOAD],
    ['HEAD', `/api/vault/${ID}/%64ownload`, DOWNLOAD],
  ])('%s %s reaches no API route and still counts', async (method, target, limit) => {
    const res = await send(method, target, newClient());
    expect(res.headers['x-ratelimit-limit']).toBe(String(limit));
    // Refused one way or another: the static plugin takes an absolute URL for no file of its.
    expect([403, 404]).toContain(res.status);
  });

  it.each(['/', '/vault/abc', '/tos', '/%2561pi/health', '/API/health'])(
    'does not count %s, which is a page and not the API',
    async (target) => {
      const res = await send('GET', target, newClient());
      expect(res.status).toBe(200);
      expect(res.headers['x-ratelimit-limit']).toBeUndefined();
      expect(res.headers['content-type']).toContain('text/html');
    },
  );

  it.each(['/api/nothing', '/%61pi/nothing', '/api/%6eothing'])(
    'answers an unknown API path %s as the API does, not with the page',
    async (target) => {
      const res = await send('GET', target, newClient());
      expect(res.status).toBe(404);
      expect(JSON.parse(res.body)).toEqual({ error: 'Not found' });
    },
  );

  it('refuses a path that cannot be decoded before anything counts it', async () => {
    const res = await send('GET', '/api/%E0%A4%A', newClient());
    expect(res.status).toBe(400);
  });
});

describe('every spelling of a route is refused once its limit is reached', () => {
  const GENERAL = 40;
  const UPLOAD = 2;
  const DOWNLOAD = 2;
  const ADMIN = 2;
  let stop: () => Promise<void>;

  beforeAll(async () => {
    stop = await startApp({
      RATE_LIMIT_API_MAX: String(GENERAL),
      RATE_LIMIT_MAX: String(UPLOAD),
      RATE_LIMIT_DOWNLOAD_MAX: String(DOWNLOAD),
      RATE_LIMIT_ADMIN_MAX: String(ADMIN),
    });
  });
  afterAll(() => stop());

  it.each([
    ...UPLOAD_ROUTES.map(([method, route]) => [method, route, UPLOAD] as const),
    ...DOWNLOAD_ROUTES.map(([method, route]) => [method, route, DOWNLOAD] as const),
    ['GET', '/api/health', GENERAL] as const,
  ])('%s %s', async (method, route, limit) => {
    const client = newClient();
    for (let i = 0; i < limit; i++) await send(method, route, client);
    expect((await send(method, route, client)).status).toBe(429);

    for (const spelling of spellings(route)) {
      const res = await send(method, spelling, client);
      expect([spelling, res.status]).toEqual([spelling, 429]);
      expect(res.headers['retry-after']).toBeDefined();
    }
  });

  it.each(ADMIN_ROUTES)('%s %s keeps a locked-out client out', async (method, route) => {
    const client = newClient();
    for (let i = 0; i < ADMIN; i++) {
      expect((await send(method, route, client, wrongLogin)).status).toBe(401);
    }

    for (const spelling of spellings(route)) {
      for (const login of [wrongLogin, rightLogin]) {
        const res = await send(method, spelling, client, login);
        expect([spelling, res.status]).toEqual([spelling, 429]);
        expect(res.body).toContain('failed login attempts');
      }
    }
  });

  it('counts wrong passwords sent under any spelling towards the lockout', async () => {
    const client = newClient();
    const [spelled] = spellings('/api/admin/stats');
    for (let i = 0; i < ADMIN; i++) {
      expect((await send('GET', spelled, client, wrongLogin)).status).toBe(401);
    }

    const res = await send('GET', '/api/admin/stats', client, rightLogin);
    expect(res.status).toBe(429);
  });
});

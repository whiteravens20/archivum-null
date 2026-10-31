/**
 * The size limit of one upload request, through the assembled app and real storage.
 *
 * The multipart parser does not fail a file part that is over its limit: it cuts the
 * part off there and ends the stream as if it were complete. These tests are about
 * what the routes make of that. They need the real parser, the real vault manager and
 * a real directory, so nothing here is mocked.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { AddressInfo } from 'node:net';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const CHUNK_SIZE = 1024 * 1024;
/** What one upload request may carry: a chunk, plus room for the multipart framing. */
const LIMIT = CHUNK_SIZE + 64 * 1024;
const BOUNDARY = '----uploadLimitTest';

function multipart(fields: Record<string, string>, file: Buffer): Buffer {
  const head = Object.entries(fields)
    .map(
      ([name, value]) =>
        `--${BOUNDARY}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
    )
    .join('');
  return Buffer.concat([
    Buffer.from(
      `${head}--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="encrypted.bin"\r\n` +
        'Content-Type: application/octet-stream\r\n\r\n',
    ),
    file,
    Buffer.from(`\r\n--${BOUNDARY}--\r\n`),
  ]);
}

describe('upload request size limit', () => {
  let app: FastifyInstance;
  let storageDir: string;

  const headers = { 'content-type': `multipart/form-data; boundary=${BOUNDARY}` };
  const upload = (file: Buffer) =>
    app.inject({
      method: 'POST',
      url: '/api/vault',
      headers,
      payload: multipart({ ttl: '3600', maxDownloads: '1' }, file),
    });
  const sendChunk = (uploadId: string, sessionToken: string, index: number, file: Buffer) =>
    app.inject({
      method: 'POST',
      url: `/api/vault/upload/${uploadId}/chunk`,
      headers: { ...headers, 'x-session-token': sessionToken },
      payload: multipart({ chunkIndex: String(index) }, file),
    });
  /** Vault directories on disk; the staging directory of chunked uploads is not one. */
  const vaultsOnDisk = () => fs.readdirSync(storageDir).filter((name) => name !== '_uploads');

  /** Build the app with a storage quota in bytes; 0 for none. */
  async function start(quota: number): Promise<void> {
    vi.stubEnv('MAX_TOTAL_STORAGE', String(quota));
    const { buildApp } = await import('../app.js');
    app = await buildApp();
    await app.ready();
  }

  beforeEach(() => {
    vi.resetModules();
    storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'archivum-limit-test-'));
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('STORAGE_PATH', storageDir);
    vi.stubEnv('CHUNK_SIZE', String(CHUNK_SIZE));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(async () => {
    await app.close();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    fs.rmSync(storageDir, { recursive: true, force: true });
  });

  it('should store a single-request upload of exactly the limit', async () => {
    await start(0);
    const res = await upload(Buffer.alloc(LIMIT, 7));
    expect(res.statusCode).toBe(201);
    expect(res.json().ciphertextSize).toBe(LIMIT);
  });

  it('should refuse a single-request upload over the limit instead of storing what fits', async () => {
    await start(0);
    const res = await upload(Buffer.alloc(LIMIT + 1, 7));
    expect(res.statusCode).toBe(413);
    expect(res.json().error).toBe('File exceeds maximum allowed size');
    expect(vaultsOnDisk()).toEqual([]);
  });

  it('should hold nothing of the quota for an upload it refused', async () => {
    // Just above one request's worth: if the refused upload went on holding any of
    // it, the next one would not fit.
    await start(LIMIT + 1000);
    expect((await upload(Buffer.alloc(LIMIT + 1, 7))).statusCode).toBe(413);

    const next = await upload(Buffer.alloc(LIMIT, 7));
    expect(next.statusCode).toBe(201);
    expect(vaultsOnDisk()).toHaveLength(1);
  });

  it('should stay up when an upload refused before it is read also turns out to be over the limit', async () => {
    // The quota refuses this one on its declared size, before a byte is read. The
    // body is then drained, and only there does the parser reach its limit.
    await start(1000);
    const res = await upload(Buffer.alloc(LIMIT + 1, 7));
    expect(res.statusCode).toBe(507);

    const health = await app.inject({ method: 'GET', url: '/api/health' });
    expect(health.statusCode).toBe(200);
    expect(vaultsOnDisk()).toEqual([]);
  });

  it('should refuse a chunk over the limit and leave the session where it was', async () => {
    await start(0);
    const init = await app.inject({
      method: 'POST',
      url: '/api/vault/upload/init',
      payload: { totalSize: 3 * CHUNK_SIZE, ttl: 3600, maxDownloads: 1 },
    });
    expect(init.statusCode).toBe(201);
    const { uploadId, sessionToken } = init.json();

    const tooBig = await sendChunk(uploadId, sessionToken, 0, Buffer.alloc(LIMIT + 1, 1));
    expect(tooBig.statusCode).toBe(413);
    const staged = path.join(storageDir, '_uploads', uploadId, 'data.enc');
    expect(fs.existsSync(staged) ? fs.statSync(staged).size : 0).toBe(0);

    // The same index is still the one expected, and a chunk of a proper size takes it.
    const ok = await sendChunk(uploadId, sessionToken, 0, Buffer.alloc(CHUNK_SIZE, 1));
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ receivedBytes: CHUNK_SIZE, nextChunkIndex: 1 });
    expect(fs.statSync(staged).size).toBe(CHUNK_SIZE);
  });

  describe('uploads in progress', () => {
    /** A request that has sent its head and all of `payload` but its last bytes. */
    async function holdUpload(payload: Buffer) {
      await app.listen({ host: '127.0.0.1', port: 0 });
      const { port } = app.server.address() as AddressInfo;
      const socket = net.connect(port, '127.0.0.1');
      let answer = '';
      socket.setEncoding('utf8');
      socket.on('data', (data) => (answer += data));
      socket.on('error', () => {});
      const closed = new Promise((resolve) => socket.once('close', resolve));
      await new Promise((resolve) => socket.once('connect', resolve));
      socket.write(
        `POST /api/vault HTTP/1.1\r\nhost: test\r\nconnection: close\r\n` +
          `content-type: ${headers['content-type']}\r\ncontent-length: ${payload.length}\r\n\r\n`,
      );
      socket.write(payload.subarray(0, payload.length - 100));
      // Under way once it has a directory, and it has its slot from before that. Until
      // then the next upload could get there first, and this one would be the one refused.
      await vi.waitFor(() => expect(vaultsOnDisk()).toHaveLength(1));
      return { socket, closed, answer: () => answer };
    }

    async function expectRefused(): Promise<void> {
      const res = await upload(Buffer.alloc(100, 7));
      expect(res.statusCode).toBe(429);
      expect(res.json().error).toContain('Too many concurrent uploads');
    }

    beforeEach(() => {
      // One wait below asks repeatedly, and 429 has to mean the uploads, not the rate.
      vi.stubEnv('RATE_LIMIT_MAX', '100000');
      vi.stubEnv('RATE_LIMIT_API_MAX', '100000');
      vi.stubEnv('MAX_UPLOAD_SESSIONS_PER_IP', '1');
    });

    it('should count one still being sent against what a client may have running', async () => {
      await start(0);
      const payload = multipart({ ttl: '3600', maxDownloads: '1' }, Buffer.alloc(1000, 7));
      const held = await holdUpload(payload);
      await expectRefused();

      // A chunked upload counts in the same place.
      const init = await app.inject({
        method: 'POST',
        url: '/api/vault/upload/init',
        payload: { totalSize: 1000, ttl: 3600, maxDownloads: 1 },
      });
      expect(init.statusCode).toBe(429);

      // Someone else is not affected.
      const other = await app.inject({
        method: 'POST',
        url: '/api/vault',
        remoteAddress: '198.51.100.9',
        headers,
        payload: multipart({ ttl: '3600', maxDownloads: '1' }, Buffer.alloc(100, 7)),
      });
      expect(other.statusCode).toBe(201);

      // The first one finishes normally, and with it the slot comes free. Not with end():
      // the server takes a client that closes its side for one that has gone.
      held.socket.write(payload.subarray(payload.length - 100));
      await held.closed;
      expect(held.answer()).toContain('201 Created');
      expect((await upload(Buffer.alloc(100, 7))).statusCode).toBe(201);
    });

    it('should give the slot and the reservation back when a client goes mid-upload', async () => {
      await start(CHUNK_SIZE);
      const payload = multipart(
        { ttl: '3600', maxDownloads: '1' },
        Buffer.alloc(CHUNK_SIZE / 2, 7),
      );
      const held = await holdUpload(payload);
      await expectRefused();

      held.socket.destroy();

      // As large as the first was, so it fits only with that one's reservation returned.
      await vi.waitFor(async () => {
        expect((await upload(Buffer.alloc(CHUNK_SIZE / 2, 7))).statusCode).toBe(201);
      });
      expect(vaultsOnDisk()).toHaveLength(1);
    });
  });
});

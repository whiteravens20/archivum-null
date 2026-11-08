/**
 * The address a connection came from stays readable after the connection has closed.
 *
 * A request can still be handled then, and it has to count against the client that
 * sent it. These tests use real sockets: app.inject() has no connection to close.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

/** Connect to a server, and close the socket it accepted for that connection. */
async function acceptAndClose(server: net.Server, port: number): Promise<net.Socket> {
  const accepted = new Promise<net.Socket>((resolve) => server.once('connection', resolve));
  const client = net.connect(port, '127.0.0.1');
  client.on('error', () => {});
  const socket = await accepted;
  const closed = new Promise((resolve) => socket.once('close', resolve));
  socket.destroy();
  client.destroy();
  await closed;
  return socket;
}

describe('peer address', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('stays on a socket after it has closed', async () => {
    const { pinPeerAddress } = await import('../middleware/peerAddress.js');
    const server = net.createServer();
    server.on('connection', pinPeerAddress);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

    const socket = await acceptAndClose(server, (server.address() as AddressInfo).port);
    expect(socket.remoteAddress).toBe('127.0.0.1');

    await new Promise((resolve) => server.close(resolve));
  });

  it('is kept for every connection the app accepts', async () => {
    vi.resetModules();
    const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'archivum-peer-test-'));
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('STORAGE_PATH', storageDir);
    const { buildApp } = await import('../app.js');
    const app = await buildApp();
    await app.listen({ host: '127.0.0.1', port: 0 });

    // This listener comes after the app's own, so it sees the socket as the app left it.
    const socket = await acceptAndClose(app.server, (app.server.address() as AddressInfo).port);
    expect(socket.remoteAddress).toBe('127.0.0.1');

    await app.close();
    fs.rmSync(storageDir, { recursive: true, force: true });
  });
});

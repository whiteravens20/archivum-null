import type { Socket } from 'node:net';

/**
 * Keep the address a connection came from readable for as long as its requests are
 * handled.
 *
 * `remoteAddress` is a getter that asks the open socket. If nothing asked while the
 * socket was open, it has no answer once the socket has closed, and a request still
 * being handled then has no client: it counts in the rate-limit bucket that every
 * client without an address shares, and the proxy hint warns about a proxy that is not
 * there. Read when the connection is accepted, the address stays on the socket for its
 * whole life, so `request.ip` and the trust chain behind it read what really connected.
 */
export function pinPeerAddress(socket: Socket): void {
  const address = socket.remoteAddress;
  if (address === undefined) return;
  Object.defineProperty(socket, 'remoteAddress', { value: address, enumerable: true });
}

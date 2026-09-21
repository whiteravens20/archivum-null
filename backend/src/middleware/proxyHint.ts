import { BlockList } from 'node:net';
import type { FastifyRequest } from 'fastify';

// Where a reverse proxy can plausibly connect from: loopback, RFC 1918, CGNAT
// (Tailscale and similar tunnels), link-local and IPv6 ULA.
const privateRanges = new BlockList();
privateRanges.addSubnet('127.0.0.0', 8, 'ipv4');
privateRanges.addSubnet('10.0.0.0', 8, 'ipv4');
privateRanges.addSubnet('172.16.0.0', 12, 'ipv4');
privateRanges.addSubnet('192.168.0.0', 16, 'ipv4');
privateRanges.addSubnet('100.64.0.0', 10, 'ipv4');
privateRanges.addSubnet('169.254.0.0', 16, 'ipv4');
privateRanges.addAddress('::1', 'ipv6');
privateRanges.addSubnet('fc00::', 7, 'ipv6');
privateRanges.addSubnet('fe80::', 10, 'ipv6');

function isPrivate(address: string): boolean {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  if (mapped) return privateRanges.check(mapped[1], 'ipv4');
  return privateRanges.check(address, address.includes(':') ? 'ipv6' : 'ipv4');
}

/**
 * Build an onRequest hook that logs, once per process, the address of a private
 * peer whose X-Forwarded-For was ignored because it is not in TRUST_PROXY.
 *
 * Request logs carry no client addresses (see `app.ts`), so this is how an operator
 * finds the address to put in TRUST_PROXY. Public peers are never logged: a peer on
 * a public address is a client, not the reverse proxy.
 */
export function buildProxyHint(): (request: FastifyRequest) => Promise<void> {
  let reported = false;
  return async (request) => {
    if (reported || request.headers['x-forwarded-for'] === undefined) return;
    const peer = request.socket.remoteAddress;
    // A trusted proxy makes request.ip the forwarded client, so it differs from the peer.
    if (!peer || request.ip !== peer || !isPrivate(peer)) return;
    reported = true;
    request.log.warn(
      { peer },
      'Ignored X-Forwarded-For from a peer not in TRUST_PROXY — add this address if it is your reverse proxy'
    );
  };
}

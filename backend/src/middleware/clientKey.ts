import { isIP } from 'node:net';

/**
 * What a client counts as when `request.ip` holds no address: a trusted proxy can pass on
 * whatever a client wrote in X-Forwarded-For. All of them share this key, so that nobody
 * gets a bucket of their own, or fills the memory, by writing a different string each time.
 */
export const UNKNOWN_CLIENT = 'unknown';

/** The eight groups of an IPv6 address, as numbers. */
function ipv6Groups(ip: string): number[] {
  const address = ip.split('%', 1)[0].toLowerCase();

  // An embedded IPv4 tail (`64:ff9b::192.0.2.1`) fills two groups, not one.
  const hexAddress = address.replace(
    /(\d+)\.(\d+)\.(\d+)\.(\d+)$/,
    (_m, a, b, c, d) => `${((+a << 8) | +b).toString(16)}:${((+c << 8) | +d).toString(16)}`,
  );
  const [head, tail] = hexAddress.split('::');
  const headGroups = head ? head.split(':') : [];
  const tailGroups = tail ? tail.split(':') : [];
  const groups =
    tail === undefined
      ? headGroups
      : [
          ...headGroups,
          ...Array<string>(8 - headGroups.length - tailGroups.length).fill('0'),
          ...tailGroups,
        ];

  return groups.map((group) => parseInt(group, 16));
}

/** `::ffff:0:0/96`, an IPv4 address written as an IPv6 one. */
function isIpv4Mapped(groups: number[]): boolean {
  return groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff;
}

/**
 * Key that per-client limits are counted against.
 *
 * IPv4 addresses are used as-is. IPv6 addresses collapse to their /64: that is the
 * smallest block an ISP or host hands a single subscriber, and anyone holding one
 * can rotate through 2^64 addresses — keying on the full address would give each
 * request a fresh rate-limit bucket and upload-session slot. IPv4-mapped IPv6, written
 * `::ffff:192.0.2.1` or `::ffff:c000:201`, is reduced to the IPv4 address so a dual-stack
 * socket does not split one client across two keys.
 */
export function clientKey(ip: string): string {
  const family = isIP(ip);
  if (family === 4) return ip;
  if (family !== 6) return UNKNOWN_CLIENT;

  const groups = ipv6Groups(ip);
  if (isIpv4Mapped(groups)) {
    const [high, low] = [groups[6], groups[7]];
    return `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`;
  }
  return `${groups
    .slice(0, 4)
    .map((group) => group.toString(16))
    .join(':')}::/64`;
}

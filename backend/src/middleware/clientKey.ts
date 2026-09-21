import { isIP } from 'node:net';

/**
 * Key that per-client limits are counted against.
 *
 * IPv4 addresses are used as-is. IPv6 addresses collapse to their /64: that is the
 * smallest block an ISP or host hands a single subscriber, and anyone holding one
 * can rotate through 2^64 addresses — keying on the full address would give each
 * request a fresh rate-limit bucket and upload-session slot. IPv4-mapped IPv6
 * (`::ffff:192.0.2.1`) is reduced to the IPv4 address so a dual-stack socket does
 * not split one client across two keys.
 */
export function clientKey(ip: string): string {
  if (isIP(ip) !== 6) return ip;

  const address = ip.split('%', 1)[0].toLowerCase();
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(address);
  if (mapped) return mapped[1];

  // An embedded IPv4 tail (`64:ff9b::192.0.2.1`) fills two groups, not one.
  const hexAddress = address.replace(/(\d+)\.(\d+)\.(\d+)\.(\d+)$/, (_m, a, b, c, d) =>
    `${((+a << 8) | +b).toString(16)}:${((+c << 8) | +d).toString(16)}`
  );
  const [head, tail] = hexAddress.split('::');
  const headGroups = head ? head.split(':') : [];
  const tailGroups = tail ? tail.split(':') : [];
  const groups =
    tail === undefined
      ? headGroups
      : [...headGroups, ...Array<string>(8 - headGroups.length - tailGroups.length).fill('0'), ...tailGroups];

  return `${groups.slice(0, 4).map((group) => parseInt(group, 16).toString(16)).join(':')}::/64`;
}

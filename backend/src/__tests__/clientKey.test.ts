import { describe, it, expect } from 'vitest';
import { clientKey, networkKey, UNKNOWN_CLIENT } from '../middleware/clientKey.js';

describe('clientKey', () => {
  it.each([
    ['203.0.113.7', '203.0.113.7'],
    ['::ffff:203.0.113.7', '203.0.113.7'],
    ['::FFFF:203.0.113.7', '203.0.113.7'],
    ['::ffff:cb00:7107', '203.0.113.7'],
    ['0:0:0:0:0:ffff:cb00:7107', '203.0.113.7'],
    ['2001:db8:1:2:aaaa:bbbb:cccc:dddd', '2001:db8:1:2::/64'],
    ['2001:DB8:0001:0002::1', '2001:db8:1:2::/64'],
    ['2001:db8::1', '2001:db8:0:0::/64'],
    ['::1', '0:0:0:0::/64'],
    ['fe80::1%eth0', 'fe80:0:0:0::/64'],
    ['1::2:3:4:5:192.0.2.1', '1:0:2:3::/64'],
  ])('%s -> %s', (ip, key) => {
    expect(clientKey(ip)).toBe(key);
  });

  it('gives every address in one /64 the same key', () => {
    expect(clientKey('2001:db8:1:2::a')).toBe(clientKey('2001:db8:1:2:ffff:ffff:ffff:ffff'));
    expect(clientKey('2001:db8:1:2::a')).not.toBe(clientKey('2001:db8:1:3::a'));
  });

  // A trusted proxy can pass on anything a client wrote. If each string were a key, each
  // would be a fresh bucket, and up to a whole header's worth of memory, for the asking.
  it.each([
    ['not-an-ip'],
    [''],
    ['203.0.113.7:51234'],
    ['[2001:db8::1]:51234'],
    ['203.0.113.256'],
    ['x'.repeat(8192)],
  ])('gives %j, which is no address, no key of its own', (value) => {
    expect(clientKey(value)).toBe(UNKNOWN_CLIENT);
  });

  it('has an answer for a request whose address is gone', () => {
    expect(clientKey(undefined as unknown as string)).toBe(UNKNOWN_CLIENT);
  });
});

describe('networkKey', () => {
  it.each([
    ['2001:db8:1:2:aaaa:bbbb:cccc:dddd', '2001:db8:1::/48'],
    ['2001:DB8:0001:ffff::1', '2001:db8:1::/48'],
    ['2001:db8::1', '2001:db8:0::/48'],
    ['fe80::1%eth0', 'fe80:0:0::/48'],
  ])('%s -> %s', (ip, key) => {
    expect(networkKey(ip)).toBe(key);
  });

  it('gives all /64s of one /48 the same key', () => {
    expect(networkKey('2001:db8:1:2::a')).toBe(networkKey('2001:db8:1:ffff::a'));
    expect(networkKey('2001:db8:1:2::a')).not.toBe(networkKey('2001:db8:2:2::a'));
  });

  it.each([['203.0.113.7'], ['::ffff:203.0.113.7'], ['::ffff:cb00:7107'], ['not-an-ip']])(
    'gives %s, which is not IPv6, none',
    (value) => {
      expect(networkKey(value)).toBeNull();
    },
  );

  it('cannot be confused with a client key', () => {
    expect(networkKey('2001:db8:1:2::a')).not.toBe(clientKey('2001:db8:1:2::a'));
  });
});

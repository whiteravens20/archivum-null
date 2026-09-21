import { describe, it, expect } from 'vitest';
import { clientKey } from '../middleware/clientKey.js';

describe('clientKey', () => {
  it.each([
    ['203.0.113.7', '203.0.113.7'],
    ['::ffff:203.0.113.7', '203.0.113.7'],
    ['2001:db8:1:2:aaaa:bbbb:cccc:dddd', '2001:db8:1:2::/64'],
    ['2001:DB8:0001:0002::1', '2001:db8:1:2::/64'],
    ['2001:db8::1', '2001:db8:0:0::/64'],
    ['::1', '0:0:0:0::/64'],
    ['fe80::1%eth0', 'fe80:0:0:0::/64'],
    ['1::2:3:4:5:192.0.2.1', '1:0:2:3::/64'],
    ['not-an-ip', 'not-an-ip'],
  ])('%s -> %s', (ip, key) => {
    expect(clientKey(ip)).toBe(key);
  });

  it('gives every address in one /64 the same key', () => {
    expect(clientKey('2001:db8:1:2::a')).toBe(clientKey('2001:db8:1:2:ffff:ffff:ffff:ffff'));
    expect(clientKey('2001:db8:1:2::a')).not.toBe(clientKey('2001:db8:1:3::a'));
  });
});

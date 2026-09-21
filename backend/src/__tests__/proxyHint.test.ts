import { describe, it, expect, vi } from 'vitest';
import type { FastifyRequest } from 'fastify';
import { buildProxyHint } from '../middleware/proxyHint.js';

function fakeRequest(peer: string, ip: string, forwardedFor?: string) {
  const warn = vi.fn();
  const request = {
    headers: forwardedFor === undefined ? {} : { 'x-forwarded-for': forwardedFor },
    socket: { remoteAddress: peer },
    ip,
    log: { warn },
  } as unknown as FastifyRequest;
  return { request, warn };
}

describe('buildProxyHint', () => {
  it('logs an untrusted private peer that sent X-Forwarded-For', async () => {
    const hint = buildProxyHint();
    const { request, warn } = fakeRequest('172.18.0.1', '172.18.0.1', '203.0.113.1');
    await hint(request);
    expect(warn).toHaveBeenCalledWith({ peer: '172.18.0.1' }, expect.stringContaining('TRUST_PROXY'));
  });

  it('logs only once per process', async () => {
    const hint = buildProxyHint();
    const first = fakeRequest('10.8.0.2', '10.8.0.2', '203.0.113.1');
    const second = fakeRequest('10.8.0.3', '10.8.0.3', '203.0.113.1');
    await hint(first.request);
    await hint(second.request);
    expect(first.warn).toHaveBeenCalledOnce();
    expect(second.warn).not.toHaveBeenCalled();
  });

  it.each([
    ['a public peer', '198.51.100.7', '198.51.100.7', '203.0.113.1'],
    ['a trusted proxy', '10.8.0.2', '203.0.113.1', '203.0.113.1'],
    ['a request without X-Forwarded-For', '10.8.0.2', '10.8.0.2', undefined],
  ])('stays quiet for %s', async (_name, peer, ip, forwardedFor) => {
    const hint = buildProxyHint();
    const { request, warn } = fakeRequest(peer, ip, forwardedFor);
    await hint(request);
    expect(warn).not.toHaveBeenCalled();
  });

  it('recognises IPv4-mapped and IPv6 private peers', async () => {
    for (const peer of ['::ffff:172.18.0.1', 'fd00::2']) {
      const hint = buildProxyHint();
      const { request, warn } = fakeRequest(peer, peer, '203.0.113.1');
      await hint(request);
      expect(warn).toHaveBeenCalledOnce();
    }
  });
});

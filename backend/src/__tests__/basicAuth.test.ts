import { describe, it, expect, vi, beforeEach } from 'vitest';

/* eslint-disable @typescript-eslint/no-explicit-any */
function createMockRequest(authorization?: string, ip = '203.0.113.5') {
  return {
    headers: authorization ? { authorization } : {},
    ip,
  } as any;
}

function createMockReply() {
  const reply: any = {
    statusCode: 200,
    headers: {} as Record<string, string>,
    body: null as any,
    status(code: number) {
      reply.statusCode = code;
      return reply;
    },
    send(body: any) {
      reply.body = body;
      return reply;
    },
    header(key: string, value: string) {
      reply.headers[key] = value;
      return reply;
    },
  };
  return reply;
}

function encodeBasicAuth(user: string, pass: string): string {
  return 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
}

describe('basicAuth', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });

  it('should return 403 when ADMIN_PASSWORD is not set', async () => {
    vi.stubEnv('ADMIN_PASSWORD', '');
    // Need to re-import config to pick up env change
    vi.resetModules();
    const { basicAuth: freshAuth } = await import('../middleware/basicAuth.js');

    const req = createMockRequest();
    const reply = createMockReply();
    await freshAuth(req, reply);

    expect(reply.statusCode).toBe(403);
    expect(reply.body.error).toContain('disabled');
  });

  it('should return 401 when no authorization header is present', async () => {
    vi.stubEnv('ADMIN_PASSWORD', 'secret123');
    vi.stubEnv('ADMIN_USER', 'admin');
    vi.resetModules();
    const { basicAuth: freshAuth } = await import('../middleware/basicAuth.js');

    const req = createMockRequest();
    const reply = createMockReply();
    await freshAuth(req, reply);

    expect(reply.statusCode).toBe(401);
    expect(reply.headers['WWW-Authenticate']).toContain('Basic');
  });

  it('should return 401 for wrong credentials', async () => {
    vi.stubEnv('ADMIN_PASSWORD', 'secret123');
    vi.stubEnv('ADMIN_USER', 'admin');
    vi.resetModules();
    const { basicAuth: freshAuth } = await import('../middleware/basicAuth.js');

    const req = createMockRequest(encodeBasicAuth('admin', 'wrongpass'));
    const reply = createMockReply();
    await freshAuth(req, reply);

    expect(reply.statusCode).toBe(401);
    expect(reply.body.error).toContain('Invalid');
  });

  it('should pass with correct credentials', async () => {
    vi.stubEnv('ADMIN_PASSWORD', 'correct-pass');
    vi.stubEnv('ADMIN_USER', 'admin');
    vi.resetModules();
    const { basicAuth: freshAuth } = await import('../middleware/basicAuth.js');

    const req = createMockRequest(encodeBasicAuth('admin', 'correct-pass'));
    const reply = createMockReply();
    await freshAuth(req, reply);

    // Should NOT set error status
    expect(reply.statusCode).toBe(200);
    expect(reply.body).toBeNull();
  });

  it('should handle passwords containing colons', async () => {
    vi.stubEnv('ADMIN_PASSWORD', 'pass:with:colons');
    vi.stubEnv('ADMIN_USER', 'admin');
    vi.resetModules();
    const { basicAuth: freshAuth } = await import('../middleware/basicAuth.js');

    const req = createMockRequest(encodeBasicAuth('admin', 'pass:with:colons'));
    const reply = createMockReply();
    await freshAuth(req, reply);

    expect(reply.statusCode).toBe(200);
    expect(reply.body).toBeNull();
  });

  it('should return 401 for invalid base64', async () => {
    vi.stubEnv('ADMIN_PASSWORD', 'secret');
    vi.stubEnv('ADMIN_USER', 'admin');
    vi.resetModules();
    const { basicAuth: freshAuth } = await import('../middleware/basicAuth.js');

    const req = createMockRequest('Basic !!!invalid-base64!!!');
    const reply = createMockReply();
    await freshAuth(req, reply);

    expect(reply.statusCode).toBe(401);
  });

  it('should reject credentials that differ from the expected ones only in length', async () => {
    vi.stubEnv('ADMIN_PASSWORD', 'secret123');
    vi.stubEnv('ADMIN_USER', 'admin');
    vi.resetModules();
    const { basicAuth: freshAuth } = await import('../middleware/basicAuth.js');

    for (const [user, pass] of [
      ['admin', 'secret12'],
      ['admin', 'secret1234'],
      ['admi', 'secret123'],
      ['admin', ''],
      ['adminadmin', 'secret123'],
      // The comparison pads a short value with zero bytes; sending them must not help
      ['admin', 'secret12\0'],
      ['admin', 'secret123\0'],
      ['admin\0', 'secret123'],
    ]) {
      const reply = createMockReply();
      await freshAuth(createMockRequest(encodeBasicAuth(user, pass)), reply);
      expect(reply.statusCode).toBe(401);
    }
  });

  it('should compare credentials outside ASCII byte for byte', async () => {
    vi.stubEnv('ADMIN_PASSWORD', 'zażółć gęślą jaźń');
    vi.stubEnv('ADMIN_USER', 'admin');
    vi.resetModules();
    const { basicAuth: freshAuth } = await import('../middleware/basicAuth.js');

    const ok = createMockReply();
    await freshAuth(createMockRequest(encodeBasicAuth('admin', 'zażółć gęślą jaźń')), ok);
    expect(ok.statusCode).toBe(200);

    // As many characters, fewer bytes; and the same bytes cut short inside a character
    const cut = Buffer.from('zażółć gęślą jaźń').subarray(0, -1);
    for (const header of [
      encodeBasicAuth('admin', 'zazolc gesla jazn'),
      'Basic ' + Buffer.concat([Buffer.from('admin:'), cut]).toString('base64'),
    ]) {
      const reply = createMockReply();
      await freshAuth(createMockRequest(header), reply);
      expect(reply.statusCode).toBe(401);
    }
  });

  describe('failed logins are counted against the client', () => {
    const recordAdminAuthFailure = vi.fn();

    async function loadAuth() {
      vi.stubEnv('ADMIN_PASSWORD', 'secret123');
      vi.stubEnv('ADMIN_USER', 'admin');
      vi.resetModules();
      recordAdminAuthFailure.mockClear();
      vi.doMock('../middleware/rateLimit.js', () => ({ recordAdminAuthFailure }));
      return (await import('../middleware/basicAuth.js')).basicAuth;
    }

    it('should count a wrong password', async () => {
      const auth = await loadAuth();
      await auth(createMockRequest(encodeBasicAuth('admin', 'wrong')), createMockReply());
      expect(recordAdminAuthFailure).toHaveBeenCalledExactlyOnceWith('203.0.113.5');
    });

    it('should count a request that brings no credentials', async () => {
      const auth = await loadAuth();
      await auth(createMockRequest(), createMockReply());
      expect(recordAdminAuthFailure).toHaveBeenCalledExactlyOnceWith('203.0.113.5');
    });

    it('should count IPv6 clients by their /64, like every other limit', async () => {
      const auth = await loadAuth();
      await auth(createMockRequest(encodeBasicAuth('admin', 'wrong'), '2001:db8:1:2:aaaa:bbbb:cccc:dddd'), createMockReply());
      expect(recordAdminAuthFailure).toHaveBeenCalledExactlyOnceWith('2001:db8:1:2::/64');
    });

    it('should not count a successful login', async () => {
      const auth = await loadAuth();
      const reply = createMockReply();
      await auth(createMockRequest(encodeBasicAuth('admin', 'secret123')), reply);
      expect(reply.statusCode).toBe(200);
      expect(recordAdminAuthFailure).not.toHaveBeenCalled();
    });

    it('should not count requests while the panel is disabled', async () => {
      await loadAuth();
      vi.stubEnv('ADMIN_PASSWORD', '');
      vi.resetModules();
      vi.doMock('../middleware/rateLimit.js', () => ({ recordAdminAuthFailure }));
      const { basicAuth: disabled } = await import('../middleware/basicAuth.js');

      const reply = createMockReply();
      await disabled(createMockRequest(encodeBasicAuth('admin', 'anything')), reply);
      expect(reply.statusCode).toBe(403);
      expect(recordAdminAuthFailure).not.toHaveBeenCalled();
    });
  });

  it('should reject CHANGE_ME_IMMEDIATELY password', async () => {
    vi.stubEnv('ADMIN_PASSWORD', 'CHANGE_ME_IMMEDIATELY');
    vi.resetModules();
    const { basicAuth: freshAuth } = await import('../middleware/basicAuth.js');

    const req = createMockRequest();
    const reply = createMockReply();
    await freshAuth(req, reply);

    expect(reply.statusCode).toBe(403);
  });
});

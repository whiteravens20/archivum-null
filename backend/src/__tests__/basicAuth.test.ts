import { describe, it, expect, vi, beforeEach } from 'vitest';

/* eslint-disable @typescript-eslint/no-explicit-any */
function createMockRequest(authorization?: string) {
  return {
    headers: authorization ? { authorization } : {},
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

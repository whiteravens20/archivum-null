import { describe, it, expect, vi, beforeEach } from 'vitest';

/* eslint-disable @typescript-eslint/no-explicit-any */
function createMockRequest(overrides: Record<string, unknown> = {}) {
  return {
    headers: {},
    body: {},
    ip: '127.0.0.1',
    log: {
      warn: vi.fn(),
      error: vi.fn(),
    },
    ...overrides,
  } as any;
}

function createMockReply() {
  const reply: any = {
    statusCode: 200,
    body: null as any,
    status(code: number) {
      reply.statusCode = code;
      return reply;
    },
    send(body: any) {
      reply.body = body;
      return reply;
    },
  };
  return reply;
}

describe('verifyTurnstile', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('should pass through when turnstile is disabled', async () => {
    vi.stubEnv('TURNSTILE_SECRET', '');
    const { verifyTurnstile } = await import('../middleware/turnstile.js');

    const req = createMockRequest();
    const reply = createMockReply();
    await verifyTurnstile(req, reply);

    expect(reply.statusCode).toBe(200);
    expect(reply.body).toBeNull();
  });

  it('should return 403 when token is missing and turnstile is enabled', async () => {
    vi.stubEnv('TURNSTILE_SECRET', 'real-secret-key');
    const { verifyTurnstile } = await import('../middleware/turnstile.js');

    const req = createMockRequest();
    const reply = createMockReply();
    await verifyTurnstile(req, reply);

    expect(reply.statusCode).toBe(403);
    expect(reply.body.error).toContain('captcha');
  });

  it('should accept token from x-turnstile-token header', async () => {
    vi.stubEnv('TURNSTILE_SECRET', 'real-secret-key');

    const mockFetch = vi.fn().mockResolvedValue({
      json: () => Promise.resolve({ success: true }),
    });
    vi.stubGlobal('fetch', mockFetch);

    const { verifyTurnstile } = await import('../middleware/turnstile.js');

    const req = createMockRequest({
      headers: { 'x-turnstile-token': 'valid-token-123' },
    });
    const reply = createMockReply();
    await verifyTurnstile(req, reply);

    expect(reply.statusCode).toBe(200);
    expect(mockFetch).toHaveBeenCalledOnce();
  });

  it('should return 403 on failed verification', async () => {
    vi.stubEnv('TURNSTILE_SECRET', 'real-secret-key');

    const mockFetch = vi.fn().mockResolvedValue({
      json: () => Promise.resolve({ success: false, 'error-codes': ['invalid-input-response'] }),
    });
    vi.stubGlobal('fetch', mockFetch);

    const { verifyTurnstile } = await import('../middleware/turnstile.js');

    const req = createMockRequest({
      headers: { 'x-turnstile-token': 'bad-token' },
    });
    const reply = createMockReply();
    await verifyTurnstile(req, reply);

    expect(reply.statusCode).toBe(403);
    expect(reply.body.error).toContain('Captcha verification failed');
  });

  it('should return 500 on network error', async () => {
    vi.stubEnv('TURNSTILE_SECRET', 'real-secret-key');

    const mockFetch = vi.fn().mockRejectedValue(new Error('Network failure'));
    vi.stubGlobal('fetch', mockFetch);

    const { verifyTurnstile } = await import('../middleware/turnstile.js');

    const req = createMockRequest({
      headers: { 'x-turnstile-token': 'any-token' },
    });
    const reply = createMockReply();
    await verifyTurnstile(req, reply);

    expect(reply.statusCode).toBe(500);
    expect(reply.body.error).toContain('unavailable');
  });

  it('should accept token from body', async () => {
    vi.stubEnv('TURNSTILE_SECRET', 'real-secret-key');

    const mockFetch = vi.fn().mockResolvedValue({
      json: () => Promise.resolve({ success: true }),
    });
    vi.stubGlobal('fetch', mockFetch);

    const { verifyTurnstile } = await import('../middleware/turnstile.js');

    const req = createMockRequest({
      body: { turnstileToken: 'body-token-456' },
    });
    const reply = createMockReply();
    await verifyTurnstile(req, reply);

    expect(reply.statusCode).toBe(200);
  });

  it('should pass when hostname matches TURNSTILE_HOSTNAME', async () => {
    vi.stubEnv('TURNSTILE_SECRET', 'real-secret-key');
    vi.stubEnv('TURNSTILE_HOSTNAME', 'example.com');

    const mockFetch = vi.fn().mockResolvedValue({
      json: () => Promise.resolve({ success: true, hostname: 'example.com' }),
    });
    vi.stubGlobal('fetch', mockFetch);

    const { verifyTurnstile } = await import('../middleware/turnstile.js');

    const req = createMockRequest({
      headers: { 'x-turnstile-token': 'valid-token' },
    });
    const reply = createMockReply();
    await verifyTurnstile(req, reply);

    expect(reply.statusCode).toBe(200);
  });

  it('should return 403 when hostname does not match TURNSTILE_HOSTNAME', async () => {
    vi.stubEnv('TURNSTILE_SECRET', 'real-secret-key');
    vi.stubEnv('TURNSTILE_HOSTNAME', 'example.com');

    const mockFetch = vi.fn().mockResolvedValue({
      json: () => Promise.resolve({ success: true, hostname: 'evil.com' }),
    });
    vi.stubGlobal('fetch', mockFetch);

    const { verifyTurnstile } = await import('../middleware/turnstile.js');

    const req = createMockRequest({
      headers: { 'x-turnstile-token': 'spoofed-token' },
    });
    const reply = createMockReply();
    await verifyTurnstile(req, reply);

    expect(reply.statusCode).toBe(403);
    expect(reply.body.error).toContain('Captcha verification failed');
  });

  it('should skip hostname check when TURNSTILE_HOSTNAME is not set', async () => {
    vi.stubEnv('TURNSTILE_SECRET', 'real-secret-key');
    vi.stubEnv('TURNSTILE_HOSTNAME', '');

    const mockFetch = vi.fn().mockResolvedValue({
      json: () => Promise.resolve({ success: true, hostname: 'any-host.com' }),
    });
    vi.stubGlobal('fetch', mockFetch);

    const { verifyTurnstile } = await import('../middleware/turnstile.js');

    const req = createMockRequest({
      headers: { 'x-turnstile-token': 'valid-token' },
    });
    const reply = createMockReply();
    await verifyTurnstile(req, reply);

    expect(reply.statusCode).toBe(200);
  });
});

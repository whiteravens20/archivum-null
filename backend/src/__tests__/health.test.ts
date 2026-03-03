import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type * as NodeFs from 'node:fs';
import Fastify from 'fastify';

describe('healthRoutes', () => {
  let app: ReturnType<typeof Fastify>;

  beforeEach(async () => {
    vi.resetModules();
    app = Fastify({ logger: false });
    const { healthRoutes } = await import('../routes/health.js');
    await app.register(healthRoutes);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it('should return status ok', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/health',
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe('ok');
    expect(body.timestamp).toBeTypeOf('number');
    expect(body.uptime).toBeTypeOf('number');
  });
});

describe('GET /api/tos', () => {
  afterEach(() => {
    vi.doUnmock('node:fs');
    vi.resetModules();
  });

  it('should return TOS content as text/plain when file exists', async () => {
    // TOS.md exists in the repo — load the real file, no mocking needed.
    vi.resetModules();
    const app = Fastify({ logger: false });
    const { healthRoutes } = await import('../routes/health.js');
    await app.register(healthRoutes);
    await app.ready();

    const res = await app.inject({ method: 'GET', url: '/api/tos' });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/plain/);
    expect(res.body.length).toBeGreaterThan(0);

    await app.close();
  });

  it('should return 404 when TOS file is missing', async () => {
    // Use vi.doMock (NOT hoisted) so the mock is active when the module loads.
    vi.doMock('node:fs', async (importOriginal) => {
      const actual = await importOriginal<typeof NodeFs>();
      return {
        default: {
          ...actual,
          readFileSync: vi.fn().mockImplementation(() => {
            throw new Error('ENOENT: no such file or directory');
          }),
        },
      };
    });

    vi.resetModules();
    const app = Fastify({ logger: false });
    const { healthRoutes } = await import('../routes/health.js');
    await app.register(healthRoutes);
    await app.ready();

    const res = await app.inject({ method: 'GET', url: '/api/tos' });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: 'TOS not found' });

    await app.close();
  });
});

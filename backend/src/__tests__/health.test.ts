import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import Fastify from 'fastify';
import { healthRoutes } from '../routes/health.js';

describe('healthRoutes', () => {
  let app: ReturnType<typeof Fastify>;

  beforeEach(async () => {
    app = Fastify({ logger: false });
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
  let app: ReturnType<typeof Fastify>;

  beforeEach(async () => {
    app = Fastify({ logger: false });
    await app.register(healthRoutes);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it('should return TOS content as text/plain when file exists', async () => {
    const mockContent = '# Terms of Service\n\nPlaceholder.';
    vi.spyOn(fs, 'readFileSync').mockReturnValue(mockContent);

    const res = await app.inject({
      method: 'GET',
      url: '/api/tos',
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/plain/);
    expect(res.body).toBe(mockContent);
  });

  it('should return 404 when TOS file is missing', async () => {
    vi.spyOn(fs, 'readFileSync').mockImplementation(() => {
      throw new Error('ENOENT: no such file or directory');
    });

    const res = await app.inject({
      method: 'GET',
      url: '/api/tos',
    });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: 'TOS not found' });
  });
});

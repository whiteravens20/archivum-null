import { describe, it, expect, beforeEach, afterEach } from 'vitest';
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

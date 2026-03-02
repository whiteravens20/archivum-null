import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { config } from '../config.js';

/**
 * In-memory rate limiter. IP addresses are NOT persisted.
 * Map entries are automatically cleaned up.
 */
interface RateBucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, RateBucket>();

// Cleanup stale entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of buckets.entries()) {
    if (bucket.resetAt <= now) buckets.delete(key);
  }
}, 300_000).unref();

function getClientIp(request: FastifyRequest): string {
  // Trust X-Forwarded-For only behind known proxy
  const xff = request.headers['x-forwarded-for'];
  if (xff) {
    const first = Array.isArray(xff) ? xff[0] : xff.split(',')[0];
    return first.trim();
  }
  return request.ip;
}

export async function rateLimitPlugin(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    // Only rate-limit upload endpoints
    if (!request.url.startsWith('/api/vault') || request.method !== 'POST') return;

    const ip = getClientIp(request);
    const now = Date.now();
    const windowMs = config.RATE_LIMIT_WINDOW * 1000;

    let bucket = buckets.get(ip);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + windowMs };
      buckets.set(ip, bucket);
    }

    bucket.count++;

    reply.header('X-RateLimit-Limit', config.RATE_LIMIT_MAX);
    reply.header('X-RateLimit-Remaining', Math.max(0, config.RATE_LIMIT_MAX - bucket.count));
    reply.header('X-RateLimit-Reset', Math.ceil(bucket.resetAt / 1000));

    if (bucket.count > config.RATE_LIMIT_MAX) {
      reply.status(429).send({
        error: 'Too many requests. Try again later.',
        retryAfter: Math.ceil((bucket.resetAt - now) / 1000),
      });
    }
  });
}

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { config } from '../config.js';

/**
 * In-memory rate limiter. IP addresses are NOT persisted.
 * Map entries are automatically cleaned up.
 *
 * Two tiers:
 *   - General  : all /api/ routes  — RATE_LIMIT_API_MAX per window (default 120)
 *   - Upload   : POST /api/vault   — RATE_LIMIT_MAX per window (default 10)
 *
 * `request.ip` is used directly — Fastify resolves it correctly from
 * X-Forwarded-For according to the `trustProxy` setting. Do NOT re-read
 * X-Forwarded-For manually; that would bypass the trust chain and allow
 * clients to spoof their IP.
 */
interface RateBucket {
  count: number;
  resetAt: number;
}

const apiBuckets = new Map<string, RateBucket>();
const uploadBuckets = new Map<string, RateBucket>();

function cleanupMap(map: Map<string, RateBucket>): void {
  const now = Date.now();
  for (const [key, bucket] of map.entries()) {
    if (bucket.resetAt <= now) map.delete(key);
  }
}

// Cleanup stale entries every 5 minutes
setInterval(() => {
  cleanupMap(apiBuckets);
  cleanupMap(uploadBuckets);
}, 300_000).unref();

function checkLimit(
  map: Map<string, RateBucket>,
  ip: string,
  max: number,
  windowMs: number,
  reply: FastifyReply
): boolean {
  const now = Date.now();
  let bucket = map.get(ip);
  if (!bucket || bucket.resetAt <= now) {
    bucket = { count: 0, resetAt: now + windowMs };
    map.set(ip, bucket);
  }
  bucket.count++;

  reply.header('X-RateLimit-Limit', max);
  reply.header('X-RateLimit-Remaining', Math.max(0, max - bucket.count));
  reply.header('X-RateLimit-Reset', Math.ceil(bucket.resetAt / 1000));

  if (bucket.count > max) {
    reply.status(429).send({
      error: 'Too many requests. Try again later.',
      retryAfter: Math.ceil((bucket.resetAt - now) / 1000),
    });
    return false;
  }
  return true;
}

export async function rateLimitPlugin(app: FastifyInstance): Promise<void> {
  const windowMs = config.RATE_LIMIT_WINDOW * 1000;

  app.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.url.startsWith('/api/')) return;

    // `request.ip` is already resolved via Fastify's trustProxy chain.
    const ip = request.ip;

    // Tier 1 — general API limit (guards /api/tos file I/O, vault GET, etc.)
    if (!checkLimit(apiBuckets, ip, config.RATE_LIMIT_API_MAX, windowMs, reply)) return;

    // Tier 2 — stricter upload limit
    if (request.url.startsWith('/api/vault') && request.method === 'POST') {
      checkLimit(uploadBuckets, ip, config.RATE_LIMIT_MAX, windowMs, reply);
    }
  });
}

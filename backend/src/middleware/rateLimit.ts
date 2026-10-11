import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { config } from '../config.js';
import { clientKey } from './clientKey.js';

/**
 * In-memory rate limiter. IP addresses are NOT persisted.
 * Map entries are automatically cleaned up.
 *
 * Four tiers:
 *   - General  : all /api/ routes                — RATE_LIMIT_API_MAX per window (default 120)
 *   - Admin    : failed logins on /api/admin/    — RATE_LIMIT_ADMIN_MAX per window (default 10)
 *   - Upload   : POST /api/vault and upload init — RATE_LIMIT_MAX per window (default 10)
 *   - Download : /api/vault/:id/download         — RATE_LIMIT_DOWNLOAD_MAX per window (default 30)
 *
 * `request.ip` is used directly — Fastify resolves it correctly from
 * X-Forwarded-For according to the `trustProxy` setting. Do NOT re-read
 * X-Forwarded-For manually; that would bypass the trust chain and allow
 * clients to spoof their IP. Buckets are keyed by `clientKey()`, which groups
 * IPv6 clients by /64 so rotating addresses inside one allocation gains nothing.
 */
interface RateBucket {
  count: number;
  resetAt: number;
}

const apiBuckets = new Map<string, RateBucket>();
const uploadBuckets = new Map<string, RateBucket>();
const downloadBuckets = new Map<string, RateBucket>();
const adminBuckets = new Map<string, RateBucket>();

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
  cleanupMap(downloadBuckets);
  cleanupMap(adminBuckets);
}, 300_000).unref();

/** The bucket for this client in the current window, started afresh when the last one ended. */
function currentBucket(map: Map<string, RateBucket>, ip: string, windowMs: number, now: number): RateBucket {
  let bucket = map.get(ip);
  if (!bucket || bucket.resetAt <= now) {
    bucket = { count: 0, resetAt: now + windowMs };
    map.set(ip, bucket);
  }
  return bucket;
}

function tooManyRequests(reply: FastifyReply, bucket: RateBucket, now: number, error: string): void {
  const retryAfter = Math.ceil((bucket.resetAt - now) / 1000);
  reply.header('Retry-After', retryAfter);
  reply.status(429).send({ error, retryAfter });
}

function checkLimit(
  map: Map<string, RateBucket>,
  ip: string,
  max: number,
  windowMs: number,
  reply: FastifyReply
): boolean {
  const now = Date.now();
  const bucket = currentBucket(map, ip, windowMs, now);
  bucket.count++;

  reply.header('X-RateLimit-Limit', max);
  reply.header('X-RateLimit-Remaining', Math.max(0, max - bucket.count));
  reply.header('X-RateLimit-Reset', Math.ceil(bucket.resetAt / 1000));

  if (bucket.count > max) {
    tooManyRequests(reply, bucket, now, 'Too many requests. Try again later.');
    return false;
  }
  return true;
}

/**
 * Count one failed admin login against a client. Called by basicAuth, the only place
 * that knows a login failed. `ip` is the client key, as produced by `clientKey()`.
 */
export function recordAdminAuthFailure(ip: string): void {
  currentBucket(adminBuckets, ip, config.RATE_LIMIT_WINDOW * 1000, Date.now()).count++;
}

export async function rateLimitPlugin(app: FastifyInstance): Promise<void> {
  const windowMs = config.RATE_LIMIT_WINDOW * 1000;

  app.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    // Match on the pathname only — never the raw URL. `request.url` includes the
    // query string, so matching it directly would let a client append `?x=1` to a
    // sensitive path and slip past the stricter upload/download tiers, falling back
    // to the looser general limit.
    const pathname = request.url.split('?', 1)[0];
    if (!pathname.startsWith('/api/')) return;

    // `request.ip` is already resolved via Fastify's trustProxy chain.
    const ip = clientKey(request.ip);

    // Tier 1 — general API limit (guards /api/tos file I/O, vault GET, etc.)
    if (!checkLimit(apiBuckets, ip, config.RATE_LIMIT_API_MAX, windowMs, reply)) return;

    // Tier 2a — admin routes: a limit on failed logins, not on requests. basicAuth adds
    // to the bucket when credentials are missing or wrong, so a signed-in panel may
    // poll as often as the general tier allows. Once the failures reach the limit,
    // every admin request from that client is refused until the window ends, a correct
    // password included: guessing must not go on, or learn anything, while locked out.
    if (pathname.startsWith('/api/admin')) {
      const now = Date.now();
      const failures = adminBuckets.get(ip);
      if (failures && failures.resetAt > now && failures.count >= config.RATE_LIMIT_ADMIN_MAX) {
        tooManyRequests(reply, failures, now, 'Too many failed login attempts. Try again later.');
        return;
      }
    }

    // Tier 2b — stricter upload limit (single-request upload OR chunked upload init only).
    // Individual chunk requests (/chunk, /complete) are NOT counted here — a single large
    // file upload generates N+2 POST requests and would exhaust the limit mid-upload.
    const isNewUpload =
      (pathname === '/api/vault' && request.method === 'POST') ||
      (pathname === '/api/vault/upload/init' && request.method === 'POST');
    if (isNewUpload) {
      if (!checkLimit(uploadBuckets, ip, config.RATE_LIMIT_MAX, windowMs, reply)) return;
    }

    // Tier 3 — download limit (prevents bulk enumeration / download exhaustion).
    // Whatever the method: only GET is routed, but a request made with another one is
    // still counted where a download would be, not in the looser general tier.
    if (/^\/api\/vault\/[^/]+\/download$/.test(pathname)) {
      checkLimit(downloadBuckets, ip, config.RATE_LIMIT_DOWNLOAD_MAX, windowMs, reply);
    }
  });
}

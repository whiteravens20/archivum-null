import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { config } from '../config.js';
import { clientKey, UNKNOWN_CLIENT } from './clientKey.js';
import { requestPath } from './requestPath.js';

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
 * Which tiers a request counts in is decided from `requestPath()`, the route the router
 * matched. Do NOT compare `request.url` with a path here: one route can be written in many
 * ways, and every spelling a comparison misses is a way past the limit.
 *
 * `request.ip` is used directly — Fastify resolves it correctly from
 * X-Forwarded-For according to the `trustProxy` setting. Do NOT re-read
 * X-Forwarded-For manually; that would bypass the trust chain and allow
 * clients to spoof their IP. Buckets are keyed by `clientKey()`, which groups
 * IPv6 clients by /64 so rotating addresses inside one allocation gains nothing.
 */
export interface RateBucket {
  count: number;
  resetAt: number;
}

/**
 * Most clients one tier keeps count of, about 20 MB at a little over 200 bytes each. Every
 * bucket is a few bytes of memory that a client with many addresses makes the server spend,
 * so there has to be an end to them. The oldest go first: they are the closest to their end
 * anyway, and whoever holds this many addresses has no need to clear a count of their own.
 */
export const MAX_TRACKED_CLIENTS = 100_000;

const apiBuckets = new Map<string, RateBucket>();
const uploadBuckets = new Map<string, RateBucket>();
const downloadBuckets = new Map<string, RateBucket>();
const adminBuckets = new Map<string, RateBucket>();

/**
 * Drop the buckets whose window has ended. Every bucket of a process lasts as long as the
 * next and `currentBucket` adds them in order, so those are all at the front of the map.
 */
export function forgetExpired(map: Map<string, RateBucket>, now: number): void {
  for (const [key, bucket] of map) {
    if (bucket.resetAt > now) return;
    map.delete(key);
  }
}

// A client's address stays in memory no longer than a minute past the end of its window.
setInterval(() => {
  const now = Date.now();
  for (const map of [apiBuckets, uploadBuckets, downloadBuckets, adminBuckets]) {
    forgetExpired(map, now);
  }
}, 60_000).unref();

/** The bucket for this client in the current window, started afresh when the last one ended. */
export function currentBucket(
  map: Map<string, RateBucket>,
  ip: string,
  windowMs: number,
  now: number,
): RateBucket {
  const running = map.get(ip);
  if (running && running.resetAt > now) return running;

  // Out and back in, not overwritten: the map has to stay in the order the buckets started.
  map.delete(ip);
  if (map.size >= MAX_TRACKED_CLIENTS) {
    forgetExpired(map, now);
    if (map.size >= MAX_TRACKED_CLIENTS) {
      const oldest = map.keys().next().value;
      if (oldest !== undefined) map.delete(oldest);
    }
  }
  const bucket = { count: 0, resetAt: now + windowMs };
  map.set(ip, bucket);
  return bucket;
}

function tooManyRequests(
  reply: FastifyReply,
  bucket: RateBucket,
  now: number,
  error: string,
): void {
  const retryAfter = Math.ceil((bucket.resetAt - now) / 1000);
  reply.header('Retry-After', retryAfter);
  reply.status(429).send({ error, retryAfter });
}

function checkLimit(
  map: Map<string, RateBucket>,
  ip: string,
  max: number,
  windowMs: number,
  reply: FastifyReply,
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
  let reportedUnknownClient = false;

  app.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    const pathname = requestPath(request);
    if (!pathname.startsWith('/api/')) return;

    // `request.ip` is already resolved via Fastify's trustProxy chain.
    const ip = clientKey(request.ip);

    // Without the value: it is whatever a client wrote. A proxy that adds a port to the
    // address would otherwise put all visitors in one bucket with nothing to say why.
    if (ip === UNKNOWN_CLIENT && !reportedUnknownClient) {
      reportedUnknownClient = true;
      request.log.warn(
        'A client address that came through the proxy is not an IP address, and such clients share one rate-limit bucket. Check what the reverse proxy sends in X-Forwarded-For.',
      );
    }

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

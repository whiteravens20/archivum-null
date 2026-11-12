import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { config, SHARED_LIMIT_FACTOR } from '../config.js';
import { clientKey, networkKey, UNKNOWN_CLIENT } from './clientKey.js';
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
 * On top of that a whole /48 shares a higher limit, see `networkKey()`, and failed admin
 * logins from all clients together have one too.
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

/** The bucket of failed admin logins from all clients together. No client key looks like it. */
const ALL_CLIENTS = 'all';

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
  client: string,
  network: string | null,
  max: number,
  windowMs: number,
  reply: FastifyReply,
): boolean {
  const now = Date.now();
  const bucket = currentBucket(map, client, windowMs, now);
  bucket.count++;

  reply.header('X-RateLimit-Limit', max);
  reply.header('X-RateLimit-Remaining', Math.max(0, max - bucket.count));
  reply.header('X-RateLimit-Reset', Math.ceil(bucket.resetAt / 1000));

  if (bucket.count > max) {
    tooManyRequests(reply, bucket, now, 'Too many requests. Try again later.');
    return false;
  }

  // Counted only once the client's own limit has let the request through: what one client
  // sends after it has been refused must not use up what its neighbours share.
  if (network !== null) {
    const shared = currentBucket(map, network, windowMs, now);
    shared.count++;
    if (shared.count > max * SHARED_LIMIT_FACTOR) {
      reply.header('X-RateLimit-Remaining', 0);
      tooManyRequests(reply, shared, now, 'Too many requests. Try again later.');
      return false;
    }
  }
  return true;
}

/**
 * Count one failed admin login against a client and against all clients together. Called
 * by basicAuth, the only place that knows a login failed. `ip` is the client key, as
 * produced by `clientKey()`. The limit for all clients is also the most a /48 can reach,
 * so a /48 needs no count of its own here. Returns whether this failure closed the panel
 * for everyone, which happens once per window.
 */
export function recordAdminAuthFailure(ip: string): boolean {
  const now = Date.now();
  const windowMs = config.RATE_LIMIT_WINDOW * 1000;
  currentBucket(adminBuckets, ip, windowMs, now).count++;

  const all = currentBucket(adminBuckets, ALL_CLIENTS, windowMs, now);
  all.count++;
  return all.count === config.RATE_LIMIT_ADMIN_MAX * SHARED_LIMIT_FACTOR;
}

/** The bucket that keeps this client out of the admin routes at the moment, if one does. */
function adminLockout(client: string, now: number): RateBucket | undefined {
  const own = adminBuckets.get(client);
  if (own && own.resetAt > now && own.count >= config.RATE_LIMIT_ADMIN_MAX) return own;

  const all = adminBuckets.get(ALL_CLIENTS);
  const ceiling = config.RATE_LIMIT_ADMIN_MAX * SHARED_LIMIT_FACTOR;
  if (all && all.resetAt > now && all.count >= ceiling) return all;

  return undefined;
}

export async function rateLimitPlugin(app: FastifyInstance): Promise<void> {
  const windowMs = config.RATE_LIMIT_WINDOW * 1000;
  let reportedUnknownClient = false;

  app.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    const pathname = requestPath(request);
    if (!pathname.startsWith('/api/')) return;

    // `request.ip` is already resolved via Fastify's trustProxy chain.
    const client = clientKey(request.ip);
    const network = networkKey(request.ip);

    // Without the value: it is whatever a client wrote. A proxy that adds a port to the
    // address would otherwise put all visitors in one bucket with nothing to say why.
    if (client === UNKNOWN_CLIENT && !reportedUnknownClient) {
      reportedUnknownClient = true;
      request.log.warn(
        'A client address that came through the proxy is not an IP address, and such clients share one rate-limit bucket. Check what the reverse proxy sends in X-Forwarded-For.',
      );
    }

    // Tier 1 — general API limit (guards /api/tos file I/O, vault GET, etc.)
    const generalMax = config.RATE_LIMIT_API_MAX;
    if (!checkLimit(apiBuckets, client, network, generalMax, windowMs, reply)) return;

    // Tier 2a — admin routes: a limit on failed logins, not on requests. basicAuth adds
    // to the bucket when credentials are missing or wrong, so a signed-in panel may
    // poll as often as the general tier allows. Once the failures reach the limit,
    // every admin request from that client is refused until the window ends, a correct
    // password included: guessing must not go on, or learn anything, while locked out.
    // Failures from all clients together have a higher limit, which closes the panel for
    // everyone: a password can be guessed from many addresses as well as from one.
    if (pathname.startsWith('/api/admin')) {
      const now = Date.now();
      const lockout = adminLockout(client, now);
      if (lockout) {
        tooManyRequests(reply, lockout, now, 'Too many failed login attempts. Try again later.');
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
      const uploadMax = config.RATE_LIMIT_MAX;
      if (!checkLimit(uploadBuckets, client, network, uploadMax, windowMs, reply)) return;
    }

    // Tier 3 — download limit (prevents bulk enumeration / download exhaustion).
    // Whatever the method: only GET is routed, but a request made with another one is
    // still counted where a download would be, not in the looser general tier.
    if (/^\/api\/vault\/[^/]+\/download$/.test(pathname)) {
      const downloadMax = config.RATE_LIMIT_DOWNLOAD_MAX;
      checkLimit(downloadBuckets, client, network, downloadMax, windowMs, reply);
    }
  });
}

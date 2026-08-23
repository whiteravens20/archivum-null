import { config } from './config.js';
import { APP_VERSION, isNewer } from './version.js';

/**
 * Compares the running version against the newest published GitHub release.
 *
 * Off by default, and deliberately so. `docs/HARDENING.md` tells operators to cut
 * all container egress except Cloudflare Turnstile, and the TOS promises no
 * phoning home — an update check that reached out on its own would quietly
 * contradict both. Turning it on is the operator's decision, taken once in the
 * environment file.
 *
 * When enabled the request carries no identifying data: no token, no cookies, no
 * version in the User-Agent (that would tell GitHub exactly which release this
 * deployment runs). GitHub still sees the server's IP, which is why this is opt-in.
 *
 * The check never blocks or breaks the admin panel: it is cached, time-limited, and
 * every failure is reported as a message beside a version number that is always
 * available.
 */

export interface UpdateStatus {
  /** Version this instance runs — `unknown` when the build was not stamped. */
  current: string;
  latest: string | null;
  /** null when the comparison could not be made (check off, failed, or unstamped). */
  updateAvailable: boolean | null;
  releaseUrl: string | null;
  /** GitHub compare view: what actually changed between the two versions. */
  compareUrl: string | null;
  publishedAt: string | null;
  /** Epoch ms of the last successful check. */
  checkedAt: number | null;
  enabled: boolean;
  error: string | null;
}

interface GitHubRelease {
  tag_name?: unknown;
  html_url?: unknown;
  published_at?: unknown;
}

interface CacheEntry {
  status: UpdateStatus;
  expiresAt: number;
}

// A failed check is cached far more briefly than a successful one — an operator who
// has just opened egress should not wait out the full interval to see it work.
const FAILURE_CACHE_MS = 15 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 5000;
// A release payload from GitHub is a few kilobytes. The abort above bounds how long
// the request may take, not how much it may send — without a byte cap, anything
// sitting on the operator's egress path could stream an unbounded body straight into
// memory and stay well inside the timeout doing it.
const MAX_RESPONSE_BYTES = 256 * 1024;

let cache: CacheEntry | null = null;
let inFlight: Promise<UpdateStatus> | null = null;

/** Reset module state. Test seam — not used at runtime. */
export function resetUpdateCheckCache(): void {
  cache = null;
  inFlight = null;
}

function baseStatus(): UpdateStatus {
  return {
    current: APP_VERSION,
    latest: null,
    updateAvailable: null,
    releaseUrl: null,
    compareUrl: null,
    publishedAt: null,
    checkedAt: null,
    enabled: config.UPDATE_CHECK_ENABLED,
    error: null,
  };
}

/** Reads a body, giving up the moment it goes past `limit` bytes. */
async function readCapped(
  body: ReadableStream<Uint8Array>,
  limit: number
): Promise<string | null> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;

      total += value.length;
      if (total > limit) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  return Buffer.concat(chunks).toString('utf-8');
}

function repoUrl(path: string): string {
  return `https://github.com/${config.UPDATE_CHECK_REPO}${path}`;
}

async function fetchLatestRelease(): Promise<UpdateStatus> {
  const status = baseStatus();

  let release: GitHubRelease;
  try {
    const response = await fetch(
      `https://api.github.com/repos/${config.UPDATE_CHECK_REPO}/releases/latest`,
      {
        headers: {
          Accept: 'application/vnd.github+json',
          // GitHub rejects requests without a User-Agent. Version deliberately
          // omitted so the request does not disclose what this instance runs.
          'User-Agent': 'archivum-null',
        },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        redirect: 'error',
      }
    );

    if (!response.ok) {
      status.error =
        response.status === 403 || response.status === 429
          ? 'GitHub rate limit reached — try again later'
          : `GitHub API returned ${response.status}`;
      return status;
    }

    if (!response.body) {
      status.error = 'GitHub API returned an empty response';
      return status;
    }

    const body = await readCapped(response.body, MAX_RESPONSE_BYTES);
    if (body === null) {
      status.error = 'GitHub API response was larger than expected — discarded';
      return status;
    }

    try {
      release = JSON.parse(body) as GitHubRelease;
    } catch {
      // A captive portal or an intercepting proxy answers 200 with HTML.
      status.error = 'GitHub API returned a response that is not JSON';
      return status;
    }
  } catch (err) {
    // Egress containment is the most likely cause, so name it: the operator sees
    // the reason without having to go read the container logs.
    status.error =
      err instanceof Error && err.name === 'TimeoutError'
        ? 'Update check timed out — outbound access to api.github.com may be blocked'
        : 'Could not reach api.github.com — outbound access may be blocked';
    return status;
  }

  if (typeof release.tag_name !== 'string' || !release.tag_name) {
    status.error = 'GitHub API returned no release tag';
    return status;
  }

  status.latest = release.tag_name;
  status.checkedAt = Date.now();
  status.publishedAt =
    typeof release.published_at === 'string' ? release.published_at : null;
  status.releaseUrl =
    typeof release.html_url === 'string'
      ? release.html_url
      : repoUrl(`/releases/tag/${release.tag_name}`);

  status.updateAvailable = isNewer(APP_VERSION, release.tag_name);
  if (status.updateAvailable === null) {
    status.error =
      APP_VERSION === 'unknown'
        ? 'Running version is unknown — set APP_VERSION to enable comparison'
        : 'Running version is not a release tag — comparison unavailable';
  }
  // The compare view only renders for two real tags.
  if (status.updateAvailable) {
    status.compareUrl = repoUrl(`/compare/${APP_VERSION}...${release.tag_name}`);
  }

  return status;
}

/**
 * Current update status, served from cache when fresh.
 *
 * Concurrent callers share one in-flight request — the admin panel polls, and a
 * slow or hanging GitHub should never fan out into a pile of open sockets.
 */
export async function getUpdateStatus(): Promise<UpdateStatus> {
  if (!config.UPDATE_CHECK_ENABLED) {
    return baseStatus();
  }

  const now = Date.now();
  if (cache && cache.expiresAt > now) {
    return cache.status;
  }

  inFlight ??= fetchLatestRelease()
    .then((status) => {
      // Keyed on whether the fetch itself worked, not on `error` — a build that
      // cannot be compared (unstamped, or a snapshot) sets an error too, and
      // re-asking GitHub every 15 minutes would not change that answer.
      cache = {
        status,
        expiresAt:
          Date.now() +
          (status.latest ? config.UPDATE_CHECK_INTERVAL * 1000 : FAILURE_CACHE_MS),
      };
      return status;
    })
    .finally(() => {
      inFlight = null;
    });

  return inFlight;
}

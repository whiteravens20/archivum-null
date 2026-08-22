/**
 * Update check — unit tests.
 *
 * The check is opt-in because docs/HARDENING.md tells operators to cut all container
 * egress and the TOS states the service does not phone home. The first block below
 * is the guard on that promise: with the flag unset, nothing may leave the process.
 *
 * The rest covers the failure modes an operator will actually hit — blocked egress,
 * GitHub rate limiting, an unstamped build — because each one has to degrade into a
 * readable line in the admin panel rather than a broken page.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { parseSemver, isNewer } from '../version.js';

const LATEST_RELEASE = {
  tag_name: 'v2.0.0',
  html_url: 'https://github.com/whiteravens20/archivum-null/releases/tag/v2.0.0',
  published_at: '2026-07-31T12:31:45Z',
};

/** Load updateCheck with a fresh module registry so config/APP_VERSION re-read env. */
async function loadUpdateCheck() {
  vi.resetModules();
  const mod = await import('../updateCheck.js');
  mod.resetUpdateCheckCache();
  return mod;
}

function mockGitHub(response: Partial<Response> & { json?: () => Promise<unknown> }) {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => LATEST_RELEASE,
    ...response,
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('version comparison', () => {
  it('parses release tags with and without the v prefix', () => {
    expect(parseSemver('v2.0.0')).toEqual([2, 0, 0]);
    expect(parseSemver('2.0.0')).toEqual([2, 0, 0]);
    expect(parseSemver('v0.16.4')).toEqual([0, 16, 4]);
  });

  it('refuses to guess at anything that is not a semver tag', () => {
    expect(parseSemver('unknown')).toBeNull();
    expect(parseSemver('edge-9f2c1ab')).toBeNull();
    expect(parseSemver('')).toBeNull();
  });

  it('compares each component numerically, not lexically', () => {
    // The bug this guards: '0.16.4' < '0.9.7' as strings, so a string compare would
    // report the newest 0.x release as older than one from five months earlier.
    expect(isNewer('v0.9.7', 'v0.16.4')).toBe(true);
    expect(isNewer('v0.16.4', 'v0.9.7')).toBe(false);
    expect(isNewer('v0.16.4', 'v2.0.0')).toBe(true);
    expect(isNewer('v2.0.0', 'v2.0.0')).toBe(false);
    expect(isNewer('v2.0.1', 'v2.0.0')).toBe(false);
  });

  it('reports "cannot tell" rather than a guess for an uncomparable build', () => {
    expect(isNewer('unknown', 'v2.0.0')).toBeNull();
    expect(isNewer('edge-9f2c1ab', 'v2.0.0')).toBeNull();
  });
});

describe('getUpdateStatus', () => {
  beforeEach(() => {
    vi.stubEnv('APP_VERSION', 'v0.16.4');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('makes no outbound request when the check is not enabled', async () => {
    vi.stubEnv('UPDATE_CHECK_ENABLED', '');
    const fetchMock = mockGitHub({});

    const { getUpdateStatus } = await loadUpdateCheck();
    const status = await getUpdateStatus();

    // The whole point of the default: nothing leaves the process.
    expect(fetchMock).not.toHaveBeenCalled();
    expect(status.enabled).toBe(false);
    expect(status.latest).toBeNull();
    expect(status.updateAvailable).toBeNull();
    // The running version is still reported — that part needs no network.
    expect(status.current).toBe('v0.16.4');
  });

  it('reports an available update with links to the changes', async () => {
    vi.stubEnv('UPDATE_CHECK_ENABLED', 'true');
    mockGitHub({});

    const { getUpdateStatus } = await loadUpdateCheck();
    const status = await getUpdateStatus();

    expect(status.updateAvailable).toBe(true);
    expect(status.latest).toBe('v2.0.0');
    expect(status.releaseUrl).toBe(LATEST_RELEASE.html_url);
    expect(status.compareUrl).toBe(
      'https://github.com/whiteravens20/archivum-null/compare/v0.16.4...v2.0.0'
    );
    expect(status.publishedAt).toBe(LATEST_RELEASE.published_at);
    expect(status.error).toBeNull();
  });

  it('sends nothing that identifies the deployment', async () => {
    vi.stubEnv('UPDATE_CHECK_ENABLED', 'true');
    const fetchMock = mockGitHub({});

    const { getUpdateStatus } = await loadUpdateCheck();
    await getUpdateStatus();

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.github.com/repos/whiteravens20/archivum-null/releases/latest');
    // A version in the User-Agent would tell GitHub exactly what this host runs.
    expect(init.headers['User-Agent']).toBe('archivum-null');
    expect(JSON.stringify(init.headers)).not.toContain('0.16.4');
    expect(init.headers).not.toHaveProperty('Authorization');
  });

  it('omits the compare link when already on the latest release', async () => {
    vi.stubEnv('UPDATE_CHECK_ENABLED', 'true');
    vi.stubEnv('APP_VERSION', 'v2.0.0');
    mockGitHub({});

    const { getUpdateStatus } = await loadUpdateCheck();
    const status = await getUpdateStatus();

    expect(status.updateAvailable).toBe(false);
    expect(status.compareUrl).toBeNull();
  });

  it('explains a blocked egress instead of failing the panel', async () => {
    vi.stubEnv('UPDATE_CHECK_ENABLED', 'true');
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')));

    const { getUpdateStatus } = await loadUpdateCheck();
    const status = await getUpdateStatus();

    expect(status.error).toMatch(/outbound access may be blocked/);
    expect(status.updateAvailable).toBeNull();
    // Still answers the question the operator can always be told.
    expect(status.current).toBe('v0.16.4');
  });

  it('names a timeout as a likely egress block', async () => {
    vi.stubEnv('UPDATE_CHECK_ENABLED', 'true');
    const timeout = Object.assign(new Error('timed out'), { name: 'TimeoutError' });
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(timeout));

    const { getUpdateStatus } = await loadUpdateCheck();

    expect((await getUpdateStatus()).error).toMatch(/timed out/);
  });

  it('distinguishes GitHub rate limiting from other API errors', async () => {
    vi.stubEnv('UPDATE_CHECK_ENABLED', 'true');
    mockGitHub({ ok: false, status: 403 });

    const { getUpdateStatus } = await loadUpdateCheck();

    expect((await getUpdateStatus()).error).toMatch(/rate limit/);
  });

  it('says so when the build was never stamped', async () => {
    vi.stubEnv('UPDATE_CHECK_ENABLED', 'true');
    vi.stubEnv('APP_VERSION', '');
    mockGitHub({});

    const { getUpdateStatus } = await loadUpdateCheck();
    const status = await getUpdateStatus();

    expect(status.current).toBe('unknown');
    expect(status.updateAvailable).toBeNull();
    expect(status.error).toMatch(/set APP_VERSION/);
  });

  it('does not pass a snapshot build off as a release', async () => {
    vi.stubEnv('UPDATE_CHECK_ENABLED', 'true');
    vi.stubEnv('APP_VERSION', 'edge-9f2c1ab');
    mockGitHub({});

    const { getUpdateStatus } = await loadUpdateCheck();
    const status = await getUpdateStatus();

    expect(status.current).toBe('edge-9f2c1ab');
    expect(status.updateAvailable).toBeNull();
    expect(status.error).toMatch(/not a release tag/);
  });

  it('caches a successful check instead of asking on every panel poll', async () => {
    vi.stubEnv('UPDATE_CHECK_ENABLED', 'true');
    const fetchMock = mockGitHub({});

    const { getUpdateStatus } = await loadUpdateCheck();
    await getUpdateStatus();
    await getUpdateStatus();
    await getUpdateStatus();

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('collapses concurrent callers onto one in-flight request', async () => {
    vi.stubEnv('UPDATE_CHECK_ENABLED', 'true');
    const fetchMock = mockGitHub({});

    const { getUpdateStatus } = await loadUpdateCheck();
    await Promise.all([getUpdateStatus(), getUpdateStatus(), getUpdateStatus()]);

    // The panel polls; a hanging GitHub must not fan out into open sockets.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('config validation', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('rejects an UPDATE_CHECK_REPO that could steer the request off GitHub', async () => {
    vi.stubEnv('UPDATE_CHECK_ENABLED', 'true');
    vi.stubEnv('ADMIN_PASSWORD', 'strong-test-password');
    vi.stubEnv('UPDATE_CHECK_REPO', 'evil.test/x/../../attack');
    vi.resetModules();

    const { validateConfig } = await import('../config.js');

    expect(() => validateConfig()).toThrow(/owner\/repo/);
  });

  it('rejects a poll interval that would burn the GitHub rate limit', async () => {
    vi.stubEnv('UPDATE_CHECK_ENABLED', 'true');
    vi.stubEnv('ADMIN_PASSWORD', 'strong-test-password');
    vi.stubEnv('UPDATE_CHECK_INTERVAL', '10');
    vi.resetModules();

    const { validateConfig } = await import('../config.js');

    expect(() => validateConfig()).toThrow(/at least 300 seconds/);
  });

  it('ignores update-check settings entirely when the check is off', async () => {
    vi.stubEnv('UPDATE_CHECK_ENABLED', '');
    vi.stubEnv('ADMIN_PASSWORD', 'strong-test-password');
    vi.stubEnv('UPDATE_CHECK_INTERVAL', '10');
    vi.resetModules();

    const { validateConfig } = await import('../config.js');

    expect(() => validateConfig()).not.toThrow();
  });
});

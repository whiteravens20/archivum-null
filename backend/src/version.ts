/**
 * The version this instance is running.
 *
 * Baked in at image build time from the release tag (`ARG APP_VERSION` in the
 * Dockerfile). There is deliberately no fallback to `package.json`: the workspace
 * manifests are not bumped by the tag-triggered release workflow, so reading them
 * would confidently report a version that is not the one running. `unknown` is the
 * honest answer for a build that was not stamped — a dev run, or an image built by
 * hand without `--build-arg APP_VERSION`.
 *
 * Exposed only through the authenticated admin API. It is never bundled into the
 * frontend or returned from a public route, because that would hand an
 * unauthenticated caller the exact thing `static/assetCloak.ts` exists to withhold.
 */
export const APP_VERSION: string = normaliseVersion(process.env.APP_VERSION);

function normaliseVersion(raw: string | undefined): string {
  const trimmed = raw?.trim();
  if (!trimmed) return 'unknown';
  // Accept both `2.0.0` (docker/metadata-action output) and `v2.0.0` (git tag).
  // Anything else — an `edge-<sha>` snapshot, a distro package string — is shown
  // verbatim rather than dressed up as a tag it is not.
  return /^\d+\.\d+\.\d+/.test(trimmed) ? `v${trimmed}` : trimmed;
}

/** Parsed semver triple, or null when the string is not a plain `vX.Y.Z`. */
export function parseSemver(version: string): [number, number, number] | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version.trim());
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/**
 * True when `latest` is strictly newer than `current`.
 * Returns null when either side is not comparable (e.g. an unstamped build).
 */
export function isNewer(current: string, latest: string): boolean | null {
  const a = parseSemver(current);
  const b = parseSemver(latest);
  if (!a || !b) return null;
  for (let i = 0; i < 3; i++) {
    if (b[i] > a[i]) return true;
    if (b[i] < a[i]) return false;
  }
  return false;
}

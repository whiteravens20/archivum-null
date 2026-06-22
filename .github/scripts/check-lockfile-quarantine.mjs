// Blocking quarantine gate: fails if any package version ADDED or CHANGED in the
// PR's lockfiles (vs the base branch) is younger than QUARANTINE_DAYS.
//
// This enforces the .npmrc `min-release-age` policy at merge time. `npm ci`
// installs the exact versions already pinned in the lockfile WITHOUT re-checking
// their age, so a too-new version committed by Dependabot (or a human) can
// otherwise sail through the required test jobs and only blow up later in steps
// that re-resolve (e.g. `npm audit signatures`). This gate closes that hole.
//
// Usage:  node check-lockfile-quarantine.mjs <base-ref>     (e.g. origin/dev)
// Env:    QUARANTINE_DAYS (default 7)
// Exit:   0 = clean, 1 = violation(s) found

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const base = process.argv[2] || 'origin/dev';
const QUARANTINE_DAYS = parseInt(process.env.QUARANTINE_DAYS || '7', 10);
const cutoff = Date.now() - QUARANTINE_DAYS * 86_400_000;

function lockVersions(json) {
  const map = new Map(); // "name@version" -> { name, version }
  let obj;
  try { obj = JSON.parse(json); } catch { return map; }
  for (const [path, entry] of Object.entries(obj.packages || {})) {
    const i = path.lastIndexOf('node_modules/');
    if (i === -1 || !entry.version) continue;
    const name = path.slice(i + 'node_modules/'.length);
    map.set(`${name}@${entry.version}`, { name, version: entry.version });
  }
  return map;
}

function publishTime(name, version) {
  try {
    const out = execFileSync('npm', ['view', `${name}@${version}`, 'time', '--json'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        // read the real publish date regardless of the repo's own quarantine,
        // and keep npm from printing config warnings into our output
        npm_config_min_release_age: '',
        npm_config_loglevel: 'error',
      },
    });
    return JSON.parse(out)[version] || null;
  } catch {
    return null;
  }
}

const violations = [];
for (const ws of ['backend', 'frontend']) {
  const lockPath = `${ws}/package-lock.json`;
  let baseJson = '{}';
  try { baseJson = execFileSync('git', ['show', `${base}:${lockPath}`], { encoding: 'utf8' }); } catch {}
  let headJson;
  try { headJson = readFileSync(lockPath, 'utf8'); } catch { continue; }

  const baseVersions = lockVersions(baseJson);
  const headVersions = lockVersions(headJson);
  const checked = new Set();

  for (const [key, info] of headVersions) {
    if (baseVersions.has(key) || checked.has(key)) continue; // unchanged or already seen
    checked.add(key);
    const published = publishTime(info.name, info.version);
    if (!published) {
      violations.push(`${ws}: ${info.name}@${info.version} — publish date unknown (treated as blocked)`);
      continue;
    }
    if (new Date(published).getTime() > cutoff) {
      const ageDays = Math.floor((Date.now() - new Date(published).getTime()) / 86_400_000);
      violations.push(`${ws}: ${info.name}@${info.version} — ${ageDays}d old (needs ${QUARANTINE_DAYS}d), published ${published}`);
    }
  }
}

if (violations.length) {
  console.error(`min-release-age quarantine violation — newly introduced packages younger than ${QUARANTINE_DAYS} days:\n`);
  for (const v of violations) console.error(`  - ${v}`);
  console.error(`\nWait for these versions to age past ${QUARANTINE_DAYS} days, or pin an older release.`);
  process.exit(1);
}
console.log(`All added/changed packages satisfy the ${QUARANTINE_DAYS}-day min-release-age policy.`);

import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Per-boot randomisation of built asset filenames.
 *
 * Vite names every bundle after a hash of its own content — `index-Qld3srqp.js`.
 * That hash is deterministic, so anyone can build each published tag, compare the
 * filenames served by a deployment, and read off the exact version it runs. The
 * check is passive, needs one unauthenticated GET of `/`, and is trivial to
 * automate across a whole subnet.
 *
 * Salting the hash at *build* time does not fix this: release images are public on
 * ghcr.io, so pulling `archivum-null:2.0.0` hands the attacker that release's
 * filenames anyway. The salt has to be per deployment, so it is generated here, at
 * container start. Files keep their real names on disk; only the public URL changes,
 * so the image stays read-only and no rewrite step is needed at build time.
 *
 * What this does NOT hide: the bundle *contents*. Client-side code is delivered to
 * the browser by definition, so anyone willing to download it and diff it against a
 * rebuilt tag can still identify the version. That is unavoidable for an SPA — see
 * "Version disclosure" in SECURITY.md. This removes the cheap, scannable signal and
 * leaves only the expensive, targeted one.
 */

const ASSET_DIR = 'assets';

/**
 * Asset types whose contents can reference *other* assets by URL (Vite emits
 * `/assets/…` for images and fonts pulled in from CSS). These have to be rewritten
 * alongside index.html, or the cloaked names break the references.
 */
const REWRITABLE_TYPES: Record<string, string> = {
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

interface CloakedAsset {
  /** Rewritten bytes — only set when the asset referenced other assets. */
  body: Buffer | null;
  contentType: string | null;
  /** Path relative to the dist root, for `reply.sendFile()`. */
  relativePath: string;
}

export interface AssetCloak {
  /** index.html with every `/assets/` reference pointing at its cloaked name. */
  indexHtml: string;
  /** Resolve a cloaked public filename back to what should be served. */
  get(publicName: string): CloakedAsset | undefined;
}

/**
 * Build the cloak for a Vite `dist` directory.
 *
 * Returns null when there is no index.html to serve — the caller treats that as
 * "no frontend bundled" and skips static serving entirely.
 */
export function buildAssetCloak(distRoot: string): AssetCloak | null {
  let rawIndex: string;
  try {
    rawIndex = fs.readFileSync(path.join(distRoot, 'index.html'), 'utf-8');
  } catch {
    return null;
  }

  const assetsDir = path.join(distRoot, ASSET_DIR);
  let originalNames: string[] = [];
  try {
    // Recursive: Vite emits a flat assets/ by default, but a custom
    // `assetFileNames` can nest. An asset missed here would be unreachable rather
    // than merely uncloaked, since the static plugin refuses /assets/ entirely.
    originalNames = fs
      .readdirSync(assetsDir, { withFileTypes: true, recursive: true })
      .filter((entry) => entry.isFile())
      .map((entry) =>
        path.posix.join(
          path.relative(assetsDir, entry.parentPath).split(path.sep).join('/'),
          entry.name
        )
      );
  } catch {
    // No assets/ directory — nothing to cloak, index.html is served as-is.
  }

  // 8 random bytes per file, regenerated on every boot. The extension is kept so
  // content-type detection still works for assets served straight off disk. Any
  // directory nesting collapses — a cloaked name carries no structure either.
  const cloakedNames = new Map<string, string>(
    originalNames.map((name) => [
      name,
      `${randomBytes(8).toString('hex')}${path.extname(name)}`,
    ])
  );

  // Longest first, so a name that is a prefix of another (`app.js` vs `app.js.map`)
  // cannot be replaced inside it and leave a mangled reference behind.
  const byDescendingLength = [...cloakedNames].sort((a, b) => b[0].length - a[0].length);

  const rewriteReferences = (source: string): string => {
    let out = source;
    for (const [original, cloaked] of byDescendingLength) {
      out = out.split(`/${ASSET_DIR}/${original}`).join(`/${ASSET_DIR}/${cloaked}`);
    }
    return out;
  };

  const assets = new Map<string, CloakedAsset>();
  for (const [original, cloaked] of cloakedNames) {
    const relativePath = path.posix.join(ASSET_DIR, original);
    const contentType = REWRITABLE_TYPES[path.extname(original).toLowerCase()];

    let body: Buffer | null = null;
    if (contentType) {
      // Hold a rewritten copy in memory only when the file actually points at
      // another asset. In a typical build nothing does, so this costs nothing and
      // the file is streamed from disk by @fastify/static as before.
      try {
        const source = fs.readFileSync(path.join(distRoot, relativePath), 'utf-8');
        const rewritten = rewriteReferences(source);
        if (rewritten !== source) body = Buffer.from(rewritten, 'utf-8');
      } catch {
        // Unreadable asset — fall through to sendFile, which will 404 it.
      }
    }

    assets.set(cloaked, {
      body,
      contentType: body ? (contentType ?? null) : null,
      relativePath,
    });
  }

  return {
    indexHtml: rewriteReferences(rawIndex),
    get: (publicName: string) => assets.get(publicName),
  };
}

/**
 * Operator-supplied logo and icons.
 *
 * An operator puts files with fixed names into one directory and each replaces a
 * built-in image (docs/BRANDING.md lists them). Everything is decided at startup: the
 * directory is read once, the files are held in memory, and requests are answered
 * from there. No path from a request reaches the file system, and nothing outside the
 * names below can be served from the directory, whatever else is put into it.
 */

import fs from 'node:fs';
import path from 'node:path';

/** Far more than an icon needs, and small enough to hold a handful of in memory. */
export const MAX_ASSET_BYTES = 1024 * 1024;

/** The type is taken from the file name, never from the content. */
const CONTENT_TYPES: Record<string, string> = {
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.png': 'image/png',
  '.ico': 'image/vnd.microsoft.icon',
};

/** Icons replace the built-in file of the same name, at the same URL. */
const ICON_FILES = ['favicon.ico', 'favicon.svg', 'apple-touch-icon.png'];

/** A logo may come in any of these formats; the first one found is used. */
const LOGO_EXTENSIONS = ['.svg', '.webp', '.png'];
const LOGO_NAMES = ['logo', 'logo-light'];

const KNOWN_FILES = new Set([
  ...ICON_FILES,
  ...LOGO_NAMES.flatMap((name) => LOGO_EXTENSIONS.map((extension) => name + extension)),
]);

export interface BrandingAsset {
  body: Buffer;
  contentType: string;
}

export interface BrandingAssets {
  /** What to serve, keyed by URL path. */
  files: Map<string, BrandingAsset>;
  /** URL of the operator's logo for the dark theme, when there is one. */
  logo?: string;
  /** The same for the light theme. A single logo.* serves both. */
  logoLight?: string;
}

/**
 * Read the operator's files from `dir`. A missing directory is the normal case and
 * yields nothing; a file that cannot be used is skipped with a warning, so one bad
 * image never keeps the server from starting.
 */
export function loadBrandingAssets(dir: string, warn: (message: string) => void): BrandingAssets {
  const assets: BrandingAssets = { files: new Map() };

  let present: Set<string>;
  try {
    present = new Set(fs.readdirSync(dir));
  } catch {
    return assets;
  }

  // `name` only ever comes from the lists above — never from the directory listing
  // and never from a request — so the path cannot leave `dir`.
  const read = (name: string): BrandingAsset | undefined => {
    if (!present.has(name)) return undefined;
    try {
      const file = path.join(dir, name);
      const stat = fs.statSync(file);
      if (!stat.isFile()) {
        warn(`Branding: ${name} is not a file and was skipped`);
        return undefined;
      }
      if (stat.size > MAX_ASSET_BYTES) {
        warn(`Branding: ${name} is larger than ${MAX_ASSET_BYTES / 1024} KiB and was skipped`);
        return undefined;
      }
      return { body: fs.readFileSync(file), contentType: CONTENT_TYPES[path.extname(name)] };
    } catch {
      warn(`Branding: ${name} could not be read and was skipped`);
      return undefined;
    }
  };

  for (const name of ICON_FILES) {
    const asset = read(name);
    if (asset) assets.files.set(`/${name}`, asset);
  }

  // A logo keeps its extension in the URL, so the URL says what the file is.
  const logo = (name: string): string | undefined => {
    for (const extension of LOGO_EXTENSIONS) {
      const asset = read(name + extension);
      if (asset) {
        const url = `/brand/${name}${extension}`;
        assets.files.set(url, asset);
        return url;
      }
    }
    return undefined;
  };
  assets.logo = logo('logo');
  assets.logoLight = logo('logo-light') ?? assets.logo;

  for (const name of present) {
    // Dot entries are how Kubernetes lays out a mounted ConfigMap; not a typo.
    if (!KNOWN_FILES.has(name) && !name.startsWith('.')) {
      warn(`Branding: ${name} is not a file name this server uses and was ignored (see docs/BRANDING.md)`);
    }
  }

  return assets;
}

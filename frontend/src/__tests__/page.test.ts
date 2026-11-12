/**
 * The page a visitor receives must not make their browser contact anyone but this
 * server. A script, stylesheet, font or image tag pointing at another origin would
 * hand every visitor's address to a third party on every page load, before any code
 * of ours has run and whatever the instance is configured to do.
 */

import { describe, it, expect } from 'vitest';
import page from '../../index.html?raw';

describe('index.html', () => {
  it('loads nothing from another origin', () => {
    const references = [...page.matchAll(/\b(?:src|href)\s*=\s*"([^"]*)"/g)].map(
      (match) => match[1],
    );

    // The entry script and the icons: an empty list would mean the pattern stopped matching.
    expect(references).toContain('/src/main.tsx');
    expect(references).toContain('/favicon.svg');
    // Absolute and protocol-relative URLs both leave the origin.
    expect(references.filter((url) => /^(?:[a-z][a-z0-9+.-]*:)?\/\//i.test(url))).toEqual([]);
  });
});

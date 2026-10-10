/**
 * Components take their colours from the theme tokens in index.css. A palette class
 * written straight into a component (`text-gray-500`, `bg-red-500/10`) keeps its
 * colour in every theme and ignores the configured accent, and nothing else would
 * notice: the page still renders, just wrongly in the theme nobody was looking at.
 */

import { describe, it, expect } from 'vitest';

const sources = import.meta.glob<string>(
  ['../**/*.tsx', '../index.css', '../../index.html', '!../__tests__/**'],
  { query: '?raw', import: 'default', eager: true },
);

const PALETTE =
  'slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|white|black';
const UTILITY =
  'bg|text|border|divide|ring|outline|fill|stroke|from|via|to|decoration|placeholder|caret|accent|shadow';
const PALETTE_CLASS = new RegExp(`(?<![\\w-])(?:${UTILITY})-(?:${PALETTE})(?:-\\d{2,3})?(?![\\w-])`, 'g');
/** An arbitrary value that is a colour: `bg-[#0B0F19]`, `text-[rgb(…)]`. */
const ARBITRARY_COLOUR = /-\[(?:#|rgb|hsl|oklch)[^\]]*\]/g;

describe('theme tokens', () => {
  it('finds the sources it is meant to check', () => {
    const files = Object.keys(sources);

    // An empty glob would make every check below pass without checking anything.
    expect(files).toContain('../index.css');
    expect(files).toContain('../../index.html');
    expect(files).toContain('../pages/Home.tsx');
    expect(files.some((file) => file.includes('__tests__'))).toBe(false);
  });

  it.each(Object.entries(sources))('%s names no palette colour directly', (_file, source) => {
    expect(source.match(PALETTE_CLASS) ?? []).toEqual([]);
    expect(source.match(ARBITRARY_COLOUR) ?? []).toEqual([]);
  });

  it('would catch the classes it exists to catch', () => {
    const offending = 'text-gray-500 hover:bg-red-500/10 border-white bg-[#0B0F19]';

    expect(offending.match(PALETTE_CLASS)).toEqual(['text-gray-500', 'bg-red-500', 'border-white']);
    expect(offending.match(ARBITRARY_COLOUR)).toEqual(['-[#0B0F19]']);
    expect('text-vault-muted bg-vault-accent/10 text-[10px] border-transparent'.match(PALETTE_CLASS)).toBeNull();
  });
});

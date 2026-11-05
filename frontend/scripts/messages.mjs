// Writes src/i18n/placeholders.ts from src/i18n/messages/en.json: for each message with
// `{placeholders}`, their names in the order the message has them. TypeScript reads every
// text of a JSON file as a plain string, so the translator's types take the names from
// that file instead. Run it after adding, removing or renaming a placeholder in en.json:
//
//   npm run messages
//
// The frontend tests fail while the file differs from what en.json gives.
import { readFileSync, writeFileSync } from 'node:fs';

const source = new URL('../src/i18n/messages/en.json', import.meta.url);
const target = new URL('../src/i18n/placeholders.ts', import.meta.url);

// A form of a message that depends on a number. It takes the count alone, which
// plural() puts in, so it is left out.
const PLURAL_FORM = /_(zero|one|two|few|many|other)$/;

const lines = [];
for (const [key, text] of Object.entries(JSON.parse(readFileSync(source, 'utf8')))) {
  if (PLURAL_FORM.test(key)) continue;
  const names = new Set(Array.from(text.matchAll(/\{(\w+)\}/g), (match) => match[1]));
  if (names.size === 0) continue;
  lines.push(`  '${key}': [${[...names].map((name) => `'${name}'`).join(', ')}],`);
}

writeFileSync(
  target,
  [
    '// Written by `npm run messages` from messages/en.json. Do not edit it by hand.',
    '',
    '/** The names of the values each message takes, from its `{placeholders}`. */',
    'export const PLACEHOLDERS = {',
    ...lines,
    '} as const;',
    '',
  ].join('\n'),
);

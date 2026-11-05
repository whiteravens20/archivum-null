import { describe, it, expect } from 'vitest';
import { LANGUAGES } from '../i18n/i18n.js';
import { PLACEHOLDERS } from '../i18n/placeholders.js';

// Every file in messages/ as its text: the languages offered, and any translation still in
// progress, which the app does not load. No type argument: Vitest keeps a test file out of
// its module cache only when the file reads `import.meta.glob(`, and a cached copy would
// not see a file added to the folder.
const files: Record<string, unknown> = import.meta.glob('../i18n/messages/*.json', {
  query: '?raw',
  import: 'default',
  eager: true,
});
const sources = new Map(
  Object.entries(files).map(([file, text]) => [file.replace(/^.*\/|\.json$/g, ''), String(text)]),
);

/** A form of a message that depends on a number: `<key>_<category>`. */
const PLURAL_FORM = /^(.+)_(zero|one|two|few|many|other)$/;
const PLACEHOLDER = /\{(\w+)\}/g;

/** The names of a text's `{placeholders}`, each once, in the order the text has them. */
const placeholders = (text: string) => [
  ...new Set(Array.from(text.matchAll(PLACEHOLDER), (match) => match[1])),
];

/**
 * A file's messages by key. A plain message has its text under `''`, one that depends on a
 * number a text for each plural category it has.
 */
function read(code: string): Map<string, Map<string, string>> {
  const data: unknown = JSON.parse(sources.get(code)!);
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    throw new Error(`${code}.json holds no object`);
  }
  const messages = new Map<string, Map<string, string>>();
  for (const [name, text] of Object.entries(data)) {
    if (typeof text !== 'string') throw new Error(`${name} in ${code}.json is no text`);
    const [, key, category] = PLURAL_FORM.exec(name) ?? [name, name, ''];
    messages.set(key, (messages.get(key) ?? new Map()).set(category, text));
  }
  return messages;
}

const kind = (forms: Map<string, string>) =>
  !forms.has('') ? 'plural' : forms.size === 1 ? 'plain' : 'plain and plural';

/**
 * The plural categories whole numbers fall into in a language: the forms a count can take.
 * CLDR's rules test no more than the last six digits of a number, so 0 to 1000 and a
 * million reach every category. Polish has `one`, `few` and `many`; its `other` is for
 * fractions, which no count here is.
 */
function wholeNumberCategories(code: string): string[] {
  const rules = new Intl.PluralRules(code.replace('_', '-'));
  return [...new Set([...Array(1001).keys(), 1_000_000].map((n) => rules.select(n)))].sort();
}

const english = read('en');

describe('the message files', () => {
  it('should include one for each language offered', () => {
    expect(LANGUAGES.filter((lang) => !sources.has(lang))).toEqual([]);
  });
});

describe('the English messages', () => {
  it('should name each message with dotted words', () => {
    const word = /^[a-z][A-Za-z0-9]*(\.[a-z][A-Za-z0-9]*)*$/;
    expect([...english.keys()].filter((key) => !word.test(key))).toEqual([]);
  });

  it('should give a message that depends on a number the count alone', () => {
    for (const [key, forms] of english) {
      if (kind(forms) !== 'plural') continue;
      for (const [category, text] of forms) {
        expect(placeholders(text), `${key}_${category}`).toEqual(['count']);
      }
    }
  });

  it('should take the placeholders placeholders.ts lists, which npm run messages writes', () => {
    const listed: Record<string, string[]> = {};
    for (const [key, forms] of english) {
      const names = forms.has('') ? placeholders(forms.get('')!) : [];
      if (kind(forms) === 'plain' && names.length > 0) listed[key] = names;
    }
    expect(PLACEHOLDERS).toEqual(listed);
  });
});

describe.each([...sources.keys()])('%s.json', (code) => {
  it('should be one flat object of texts', () => {
    expect(() => read(code)).not.toThrow();
  });

  it('should be named by a language code', () => {
    expect(Intl.PluralRules.supportedLocalesOf(code.replace('_', '-'))).toHaveLength(1);
  });

  it('should have no message English lacks, each of the same kind', () => {
    for (const [key, forms] of read(code)) {
      expect(english.has(key), `${key} is not in en.json`).toBe(true);
      expect(kind(forms), key).toBe(kind(english.get(key) ?? new Map([['', '']])));
    }
  });

  it('should leave no text empty', () => {
    for (const [key, forms] of read(code)) {
      for (const [category, text] of forms) {
        expect(text.trim(), category ? `${key}_${category}` : key).not.toBe('');
      }
    }
  });

  it('should keep the placeholders of the English message, and no others', () => {
    for (const [key, forms] of read(code)) {
      const source = english.get(key);
      if (!source) continue;
      const expected = [...new Set([...source.values()].flatMap(placeholders))].sort();
      for (const [category, text] of forms) {
        expect(placeholders(text).sort(), category ? `${key}_${category}` : key).toEqual(expected);
      }
    }
  });

  it('should give a message that depends on a number the forms whole numbers take', () => {
    const categories = wholeNumberCategories(code);
    for (const [key, forms] of read(code)) {
      if (kind(forms) === 'plural') expect([...forms.keys()].sort(), key).toEqual(categories);
    }
  });

  if ((LANGUAGES as readonly string[]).includes(code)) {
    it('should have every message, as a language offered must', () => {
      const messages = read(code);
      expect([...english.keys()].filter((key) => !messages.has(key))).toEqual([]);
    });
  }
});

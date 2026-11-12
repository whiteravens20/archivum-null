import { createContext, createElement, Fragment, useContext, type ReactNode } from 'react';
import en from './messages/en.json';
import pl from './messages/pl.json';
import type { PLACEHOLDERS } from './placeholders.ts';

/**
 * The interface languages, the only ones loaded and offered. English is the source the
 * others translate. A language joins this list once its file in messages/ has every
 * message; until then the file may hold part of them, and it is not loaded.
 */
export const LANGUAGES = ['en', 'pl'] as const;
export type Language = (typeof LANGUAGES)[number];

/** Each language under its own name, the way the switcher offers it. */
export const LANGUAGE_NAMES: Record<Language, string> = { en: 'English', pl: 'Polski' };

export function isLanguage(value: string): value is Language {
  return (LANGUAGES as readonly string[]).includes(value);
}

/** The language of a tag such as `pl-PL`: its first subtag. */
const primary = (tag: string) => tag.split('-')[0].toLowerCase();

/**
 * The languages the browser asks for, most wanted first. The interface language is
 * chosen from these alone: never from the address, a cookie or storage.
 */
export function browserLanguages(): readonly string[] {
  return navigator.languages.length > 0 ? navigator.languages : [navigator.language];
}

/** The first of the visitor's languages the interface has, or English. */
export function detectLanguage(preferred: readonly string[]): Language {
  for (const tag of preferred) {
    const lang = primary(tag);
    if (isLanguage(lang)) return lang;
  }
  return 'en';
}

/**
 * The locale numbers and dates are written in: the visitor's own variant of the
 * language when the browser names one (`en-GB` puts the day first), else the language.
 */
export function localeFor(lang: Language, preferred: readonly string[]): string {
  for (const tag of preferred) {
    if (primary(tag) !== lang) continue;
    try {
      return Intl.getCanonicalLocales(tag)[0];
    } catch {
      // Not a well-formed tag; the next one may be
    }
  }
  return lang;
}

/**
 * A language's messages by key. A message that depends on a number has a key for each
 * plural category whole numbers fall into in the language: `<key>_one`, `<key>_few`...
 */
type Catalogue = Readonly<Record<string, string>>;

const MESSAGES: Record<Language, Catalogue> = { en, pl };

type Key = keyof typeof en;
type PluralBase<K> = K extends `${infer Base}_other` ? Base : never;

/** A message that depends on a number. English has an `_other` form for each. */
export type PluralKey = PluralBase<Key>;
/** A plain message. */
export type TextKey = Exclude<Key, `${PluralKey}_${Intl.LDMLPluralRule}`>;

/** The names of a message's `{placeholders}`. */
type Placeholders<K extends TextKey> = K extends keyof typeof PLACEHOLDERS
  ? (typeof PLACEHOLDERS)[K][number]
  : never;
type Vars<K extends TextKey> = Readonly<Record<Placeholders<K>, string | number>>;
/** The values a message takes: none, or one for each of its placeholders. */
type VarsArg<K extends TextKey> = [Placeholders<K>] extends [never] ? [] : [vars: Vars<K>];

/** A message kept to be shown later. It is held as its key, so it follows a change of language. */
export type Message = {
  [K in TextKey]: [Placeholders<K>] extends [never] ? { key: K } : { key: K; vars: Vars<K> };
}[TextKey];

export interface Translator {
  lang: Language;
  /** The locale numbers and dates are written in. */
  locale: string;
  t<K extends TextKey>(key: K, ...vars: VarsArg<K>): string;
  /** The form of the message that suits the count, with the count in it. */
  plural(key: PluralKey, count: number): string;
  /**
   * A message with React nodes in its placeholders, for markup inside a sentence.
   * The markup stays in the code; nothing in a message is parsed as HTML.
   */
  rich<K extends TextKey>(key: K, slots: Readonly<Record<Placeholders<K>, ReactNode>>): ReactNode;
  message(message: Message): string;
  /** Switch the interface to another language. */
  setLang(lang: Language): void;
}

const PLACEHOLDER = /\{(\w+)\}/g;

export function createTranslator(
  lang: Language,
  locale: string,
  setLang: (lang: Language) => void,
): Translator {
  const numbers = new Intl.NumberFormat(locale);
  const plurals = new Intl.PluralRules(lang);
  const englishPlurals = new Intl.PluralRules('en');

  // Own keys only: `constructor` or `__proto__` is not a message.
  const lookup = (messages: Catalogue, key: string) =>
    Object.hasOwn(messages, key) ? messages[key] : undefined;

  // One pass over the message: what a value brings in is never read again, so a file
  // name such as `{actual}` or `$&` shows as itself.
  const fill = (template: string, vars: Readonly<Record<string, string | number>>) =>
    template.replace(PLACEHOLDER, (match, name: string) => {
      if (!Object.hasOwn(vars, name)) return match;
      const value = vars[name];
      return typeof value === 'number' ? numbers.format(value) : value;
    });

  // A message the language lacks is shown in English, so a key never reaches the page.
  const text = (key: string): string =>
    lookup(MESSAGES[lang], key) ?? lookup(MESSAGES.en, key) ?? key;

  function t(key: TextKey, vars: Readonly<Record<string, string | number>> = {}): string {
    return fill(text(key), vars);
  }

  return {
    lang,
    locale,
    t: t as Translator['t'],
    plural(key, count) {
      // English forms go by the English rules
      const form =
        lookup(MESSAGES[lang], `${key}_${plurals.select(count)}`) ??
        lookup(MESSAGES.en, `${key}_${englishPlurals.select(count)}`);
      return form === undefined ? key : fill(form, { count });
    },
    rich(key, slots) {
      const named: Readonly<Record<string, ReactNode>> = slots;
      // With a capturing group, split() alternates text and placeholder names
      const parts = text(key)
        .split(/\{(\w+)\}/)
        .map((part, i) =>
          i % 2 === 0 ? part : Object.hasOwn(named, part) ? named[part] : `{${part}}`,
        );
      return createElement(Fragment, null, ...parts);
    },
    message(message) {
      return t(message.key, 'vars' in message ? message.vars : {});
    },
    setLang,
  };
}

// What a component gets outside a provider, the tests among them: English.
export const I18nContext = createContext<Translator>(createTranslator('en', 'en', () => {}));

export function useI18n(): Translator {
  return useContext(I18nContext);
}

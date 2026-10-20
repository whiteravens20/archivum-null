import { createContext, createElement, Fragment, useContext, type ReactNode } from 'react';
import { en } from './messages/en.ts';
import { pl } from './messages/pl.ts';

/** The interface languages. English is the source the others translate. */
export const LANGUAGES = ['en', 'pl'] as const;
export type Language = (typeof LANGUAGES)[number];

type En = typeof en;

/** The forms of a message that depends on a number, one per plural category it can fall into. */
export type PluralForms = Readonly<Partial<Record<Intl.LDMLPluralRule, string>> & { other: string }>;

/** What a translation provides: every key of the English messages, with the same kind of value. */
export type Messages = { readonly [K in keyof En]: En[K] extends string ? string : PluralForms };

/** A plain message. */
export type TextKey = { [K in keyof En]: En[K] extends string ? K : never }[keyof En];
/** A message that depends on a number. */
export type PluralKey = Exclude<keyof En, TextKey>;

/** The names of a message's `{placeholders}`. */
type Placeholders<S> = S extends `${string}{${infer Name}}${infer Rest}` ? Name | Placeholders<Rest> : never;
type Vars<K extends TextKey> = Readonly<Record<Placeholders<En[K]>, string | number>>;
/** The values a message takes: none, or one for each of its placeholders. */
type VarsArg<K extends TextKey> = [Placeholders<En[K]>] extends [never] ? [] : [vars: Vars<K>];

/** A message kept to be shown later. It is held as its key, so it follows a change of language. */
export type Message = {
  [K in TextKey]: [Placeholders<En[K]>] extends [never] ? { key: K } : { key: K; vars: Vars<K> };
}[TextKey];

export const MESSAGES: Record<Language, Messages> = { en, pl };

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
  rich<K extends TextKey>(key: K, slots: Readonly<Record<Placeholders<En[K]>, ReactNode>>): ReactNode;
  message(message: Message): string;
}

const PLACEHOLDER = /\{(\w+)\}/g;

export function createTranslator(lang: Language, locale: string): Translator {
  const messages = MESSAGES[lang];
  const numbers = new Intl.NumberFormat(locale);
  const plurals = new Intl.PluralRules(lang);

  // Own keys only: `constructor` or `__proto__` is not a message.
  const lookup = (key: string) => (Object.hasOwn(messages, key) ? messages[key as keyof Messages] : undefined);

  // One pass over the message: what a value brings in is never read again, so a file
  // name such as `{actual}` or `$&` shows as itself.
  const fill = (template: string, vars: Readonly<Record<string, string | number>>) =>
    template.replace(PLACEHOLDER, (match, name: string) => {
      if (!Object.hasOwn(vars, name)) return match;
      const value = vars[name];
      return typeof value === 'number' ? numbers.format(value) : value;
    });

  const text = (key: string): string => {
    const message = lookup(key);
    return typeof message === 'string' ? message : key;
  };

  function t(key: TextKey, vars: Readonly<Record<string, string | number>> = {}): string {
    return fill(text(key), vars);
  }

  return {
    lang,
    locale,
    t: t as Translator['t'],
    plural(key, count) {
      const forms = lookup(key);
      if (typeof forms !== 'object') return key;
      return fill(forms[plurals.select(count)] ?? forms.other, { count });
    },
    rich(key, slots) {
      const named: Readonly<Record<string, ReactNode>> = slots;
      // With a capturing group, split() alternates text and placeholder names
      const parts = text(key)
        .split(/\{(\w+)\}/)
        .map((part, i) => (i % 2 === 0 ? part : Object.hasOwn(named, part) ? named[part] : `{${part}}`));
      return createElement(Fragment, null, ...parts);
    },
    message(message) {
      return t(message.key, 'vars' in message ? message.vars : {});
    },
  };
}

// What a component gets outside a provider, the tests among them: English.
const I18nContext = createContext<Translator>(createTranslator('en', 'en'));

export function useI18n(): Translator {
  return useContext(I18nContext);
}

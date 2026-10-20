import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { browserLanguages, createTranslator, detectLanguage, I18nContext, localeFor, type Language } from './i18n.ts';

/**
 * The interface language: the first of the browser's languages the interface has, until
 * the visitor picks another in the footer. The pick is held in this state and nowhere
 * else, so a reload starts from the browser's languages again.
 *
 * A change re-renders the pages in the new language and remounts nothing: an upload
 * under way, a chosen file and a solved CAPTCHA stay as they are.
 */
export default function I18nProvider({ children }: { children: ReactNode }) {
  const [preferred] = useState(browserLanguages);
  const [lang, setLang] = useState<Language>(() => detectLanguage(preferred));
  const translator = useMemo(() => createTranslator(lang, localeFor(lang, preferred), setLang), [lang, preferred]);

  useEffect(() => {
    document.documentElement.lang = lang;
  }, [lang]);

  return <I18nContext.Provider value={translator}>{children}</I18nContext.Provider>;
}

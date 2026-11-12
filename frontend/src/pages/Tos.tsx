import { useEffect, useState } from 'react';
import { useI18n } from '../i18n/i18n.ts';

/** The terms as the server sends them: TOS.md, and its translations by language code. */
interface Terms {
  terms: string;
  translations: Readonly<Record<string, unknown>>;
}

function parseTerms(raw: unknown): Terms | null {
  if (typeof raw !== 'object' || raw === null) return null;
  // Narrowed field by field below: the body is whatever the server sent.
  const { terms, translations } = raw as Record<string, unknown>;
  if (typeof terms !== 'string' || typeof translations !== 'object' || translations === null)
    return null;
  return { terms, translations: translations as Record<string, unknown> };
}

/**
 * The operator's terms: their translation into the interface language when they made
 * one, TOS.md otherwise. Every translation comes in the one response, so a change of
 * language shows another without asking the server, which never learns the choice.
 */
export default function Tos() {
  const { t, lang } = useI18n();
  const [terms, setTerms] = useState<Terms | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    fetch('/api/tos')
      .then((r): Promise<unknown> => {
        if (!r.ok) throw new Error();
        return r.json();
      })
      .then((raw) => {
        const parsed = parseTerms(raw);
        if (!parsed) throw new Error();
        setTerms(parsed);
      })
      .catch(() => setError(true));
  }, []);

  const translation =
    terms && Object.hasOwn(terms.translations, lang) ? terms.translations[lang] : undefined;

  return (
    <div className="max-w-2xl mx-auto px-4 py-12">
      <div className="mb-8">
        <a href="/" className="text-sm text-vault-accent-ink hover:underline">
          {t('common.home')}
        </a>
      </div>
      {error ? (
        <p className="text-vault-danger text-sm">{t('tos.failed')}</p>
      ) : terms === null ? (
        <p className="text-vault-subtle animate-pulse text-sm">{t('tos.loading')}</p>
      ) : (
        <article
          className="prose prose-sm max-w-none
          prose-headings:text-vault-heading prose-headings:font-semibold
          prose-h1:text-2xl prose-h2:text-base prose-h2:mt-6
          prose-p:text-vault-muted prose-p:leading-relaxed
          prose-li:text-vault-muted
          prose-strong:text-vault-text-soft
          prose-blockquote:border-vault-warning-fill/50 prose-blockquote:bg-vault-warning-fill/10
          prose-blockquote:text-vault-warning prose-blockquote:rounded-lg prose-blockquote:px-4 prose-blockquote:py-1
          prose-hr:border-vault-secondary/50"
          // The terms are the operator's own files, converted to HTML by the server at
          // startup (backend/src/static/terms.ts): raw HTML in them arrives as text, and
          // links are kept to web and mail addresses. The Content-Security-Policy
          // would not run a script from it either way. No Markdown parser is shipped
          // to the browser for this one page.
          dangerouslySetInnerHTML={{
            __html: typeof translation === 'string' ? translation : terms.terms,
          }}
        />
      )}
    </div>
  );
}

import { useEffect, useState } from 'react';
import Markdown from 'react-markdown';

export default function Tos() {
  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    fetch('/api/tos')
      .then((r) => {
        if (!r.ok) throw new Error();
        return r.text();
      })
      .then(setContent)
      .catch(() => setError(true));
  }, []);

  return (
    <div className="max-w-2xl mx-auto px-4 py-12">
      <div className="mb-8">
        <a href="/" className="text-sm text-vault-accent-ink hover:underline">← Home</a>
      </div>
      {error ? (
        <p className="text-vault-danger text-sm">Failed to load Terms of Service.</p>
      ) : content === null ? (
        <p className="text-vault-subtle animate-pulse text-sm">Loading…</p>
      ) : (
        <article className="prose prose-sm max-w-none
          prose-headings:text-vault-heading prose-headings:font-semibold
          prose-h1:text-2xl prose-h2:text-base prose-h2:mt-6
          prose-p:text-vault-muted prose-p:leading-relaxed
          prose-li:text-vault-muted
          prose-strong:text-vault-text-soft
          prose-blockquote:border-vault-warning-fill/50 prose-blockquote:bg-vault-warning-fill/10
          prose-blockquote:text-vault-warning prose-blockquote:rounded-lg prose-blockquote:px-4 prose-blockquote:py-1
          prose-hr:border-vault-secondary/50">
          <Markdown>{content}</Markdown>
        </article>
      )}
    </div>
  );
}

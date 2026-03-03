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
        <a href="/" className="text-sm text-vault-accent hover:underline">← Home</a>
      </div>
      {error ? (
        <p className="text-red-400 text-sm">Failed to load Terms of Service.</p>
      ) : content === null ? (
        <p className="text-gray-500 animate-pulse text-sm">Loading…</p>
      ) : (
        <article className="prose prose-sm prose-invert max-w-none
          prose-headings:text-gray-100 prose-headings:font-semibold
          prose-h1:text-2xl prose-h2:text-base prose-h2:mt-6
          prose-p:text-gray-400 prose-p:leading-relaxed
          prose-li:text-gray-400
          prose-strong:text-gray-300
          prose-blockquote:border-yellow-500/50 prose-blockquote:bg-yellow-500/10
          prose-blockquote:text-yellow-400 prose-blockquote:rounded-lg prose-blockquote:px-4 prose-blockquote:py-1
          prose-hr:border-vault-secondary/50
          prose-a:text-vault-accent">
          <Markdown>{content}</Markdown>
        </article>
      )}
    </div>
  );
}

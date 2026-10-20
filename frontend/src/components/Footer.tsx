import { Link } from 'react-router-dom';
import { DEFAULT_TAGLINE, getBranding } from '../branding.ts';
import { useI18n } from '../i18n/i18n.ts';

export default function Footer() {
  const { name, tagline: brandTagline } = getBranding();
  const { t } = useI18n();
  const tagline = brandTagline === DEFAULT_TAGLINE ? t('brand.tagline') : brandTagline;
  // The tagline closes the footer as a sentence, unless it brings its own punctuation.
  const closing = /[\p{L}\p{N}]$/u.test(tagline) ? `${tagline}.` : tagline;

  return (
    <footer className="border-t border-vault-secondary/50 py-6 px-4 text-center text-xs text-vault-subtle">
      <div className="max-w-2xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-2">
        <div className="flex items-center gap-3">
          <span className="tracking-wider uppercase">{name}</span>
          <span className="text-vault-secondary/50">|</span>
          {/* If you like this project please keep "Powered by Archivum Null" or Source link in the footer ❤️ */}
          <a
            href="https://github.com/whiteravens20/archivum-null"
            target="_blank"
            rel="noopener noreferrer"
            className="hover:text-vault-accent-ink transition-colors"
          >
            {t('footer.source')}
          </a>
          <span className="text-vault-secondary/50">|</span>
          <Link
            to="/tos"
            className="hover:text-vault-accent-ink transition-colors"
          >
            {t('footer.terms')}
          </Link>
        </div>
        <span>{closing}</span>
      </div>
    </footer>
  );
}

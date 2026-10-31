import { Link } from 'react-router-dom';
import { useI18n } from '../i18n/i18n.ts';

export default function NotFound() {
  const { t } = useI18n();
  return (
    <div className="max-w-2xl mx-auto px-4 py-24 text-center">
      <p className="text-7xl font-bold text-vault-accent-ink mb-4">404</p>
      <h1 className="text-2xl font-semibold text-vault-heading mb-3">{t('notFound.title')}</h1>
      <p className="text-vault-muted text-sm mb-8">{t('notFound.detail')}</p>
      <Link
        to="/"
        className="inline-block px-5 py-2 rounded bg-vault-accent text-vault-on-accent text-sm font-medium hover:opacity-90 transition-opacity"
      >
        {t('notFound.back')}
      </Link>
    </div>
  );
}

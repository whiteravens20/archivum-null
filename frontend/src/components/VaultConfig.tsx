import { useI18n, type PluralKey } from '../i18n/i18n.ts';

interface VaultConfigProps {
  ttl: number;
  maxDownloads: number;
  onTtlChange: (ttl: number) => void;
  onMaxDownloadsChange: (max: number) => void;
  disabled?: boolean;
}

const TTL_OPTIONS: { value: number; count: number; unit: PluralKey }[] = [
  { value: 300, count: 5, unit: 'vaultConfig.minutes' },
  { value: 1800, count: 30, unit: 'vaultConfig.minutes' },
  { value: 3600, count: 1, unit: 'vaultConfig.hours' },
  { value: 21600, count: 6, unit: 'vaultConfig.hours' },
  { value: 86400, count: 24, unit: 'vaultConfig.hours' },
  { value: 259200, count: 3, unit: 'vaultConfig.days' },
  { value: 604800, count: 7, unit: 'vaultConfig.days' },
];

const DOWNLOAD_OPTIONS = [1, 3, 5, 10, 25, 50, 100];

export default function VaultConfig({
  ttl,
  maxDownloads,
  onTtlChange,
  onMaxDownloadsChange,
  disabled,
}: VaultConfigProps) {
  const { t, plural } = useI18n();
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
      <div>
        <label className="block text-xs text-vault-muted mb-2 uppercase tracking-wider">
          {t('vaultConfig.expiresAfter')}
        </label>
        <select
          value={ttl}
          onChange={(e) => onTtlChange(Number(e.target.value))}
          disabled={disabled}
          className="w-full bg-vault-secondary border border-vault-line rounded px-3 py-2 text-sm
                     text-vault-text focus:border-vault-accent-ink focus:outline-none
                     disabled:opacity-50"
        >
          {TTL_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {plural(opt.unit, opt.count)}
            </option>
          ))}
        </select>
      </div>

      <div>
        <label className="block text-xs text-vault-muted mb-2 uppercase tracking-wider">
          {t('vaultConfig.maxDownloads')}
        </label>
        <select
          value={maxDownloads}
          onChange={(e) => onMaxDownloadsChange(Number(e.target.value))}
          disabled={disabled}
          className="w-full bg-vault-secondary border border-vault-line rounded px-3 py-2 text-sm
                     text-vault-text focus:border-vault-accent-ink focus:outline-none
                     disabled:opacity-50"
        >
          {DOWNLOAD_OPTIONS.map((n) => (
            <option key={n} value={n}>
              {plural('vaultConfig.downloads', n)}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}

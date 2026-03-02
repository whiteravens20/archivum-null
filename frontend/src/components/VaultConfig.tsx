interface VaultConfigProps {
  ttl: number;
  maxDownloads: number;
  onTtlChange: (ttl: number) => void;
  onMaxDownloadsChange: (max: number) => void;
  disabled?: boolean;
}

const TTL_OPTIONS = [
  { label: '5 min', value: 300 },
  { label: '30 min', value: 1800 },
  { label: '1 hour', value: 3600 },
  { label: '6 hours', value: 21600 },
  { label: '24 hours', value: 86400 },
  { label: '3 days', value: 259200 },
  { label: '7 days', value: 604800 },
];

const DOWNLOAD_OPTIONS = [1, 3, 5, 10, 25, 50, 100];

export default function VaultConfig({
  ttl,
  maxDownloads,
  onTtlChange,
  onMaxDownloadsChange,
  disabled,
}: VaultConfigProps) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
      <div>
        <label className="block text-xs text-gray-400 mb-2 uppercase tracking-wider">
          Expires after
        </label>
        <select
          value={ttl}
          onChange={(e) => onTtlChange(Number(e.target.value))}
          disabled={disabled}
          className="w-full bg-vault-secondary border border-gray-600 rounded px-3 py-2 text-sm
                     text-gray-200 focus:border-vault-accent focus:outline-none
                     disabled:opacity-50"
        >
          {TTL_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      </div>

      <div>
        <label className="block text-xs text-gray-400 mb-2 uppercase tracking-wider">
          Max downloads
        </label>
        <select
          value={maxDownloads}
          onChange={(e) => onMaxDownloadsChange(Number(e.target.value))}
          disabled={disabled}
          className="w-full bg-vault-secondary border border-gray-600 rounded px-3 py-2 text-sm
                     text-gray-200 focus:border-vault-accent focus:outline-none
                     disabled:opacity-50"
        >
          {DOWNLOAD_OPTIONS.map((n) => (
            <option key={n} value={n}>
              {n} {n === 1 ? 'download' : 'downloads'}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}

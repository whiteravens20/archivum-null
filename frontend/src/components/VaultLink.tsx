import { useState } from 'react';
import { useI18n } from '../i18n/i18n.ts';

interface VaultLinkProps {
  url: string;
}

export default function VaultLink({ url }: VaultLinkProps) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Fallback
      const input = document.createElement('input');
      input.value = url;
      document.body.appendChild(input);
      input.select();
      document.execCommand('copy');
      document.body.removeChild(input);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  return (
    <div className="space-y-3">
      <label className="block text-xs text-vault-muted uppercase tracking-wider">
        {t('vaultLink.label')}
      </label>

      <div className="flex gap-2">
        <input
          type="text"
          readOnly
          value={url}
          className="flex-1 bg-vault-bg border border-vault-line rounded px-3 py-2 text-sm
                     text-vault-accent-ink font-mono select-all focus:outline-none focus:border-vault-accent-ink"
          onClick={(e) => (e.target as HTMLInputElement).select()}
        />
        <button
          onClick={handleCopy}
          className="px-4 py-2 bg-vault-accent text-vault-on-accent rounded text-sm font-medium
                     hover:bg-vault-accent/90 transition-colors whitespace-nowrap"
        >
          {copied ? t('vaultLink.copied') : t('vaultLink.copy')}
        </button>
      </div>

      <div className="text-xs text-vault-warning/80 bg-vault-warning/5 border border-vault-warning/20 rounded p-3">
        {t('vaultLink.warning')}
      </div>
    </div>
  );
}

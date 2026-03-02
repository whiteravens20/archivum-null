import { useState } from 'react';

interface VaultLinkProps {
  url: string;
}

export default function VaultLink({ url }: VaultLinkProps) {
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
      <label className="block text-xs text-gray-400 uppercase tracking-wider">
        Vault Link (contains decryption key)
      </label>

      <div className="flex gap-2">
        <input
          type="text"
          readOnly
          value={url}
          className="flex-1 bg-vault-bg border border-gray-600 rounded px-3 py-2 text-sm
                     text-vault-accent font-mono select-all focus:outline-none focus:border-vault-accent"
          onClick={(e) => (e.target as HTMLInputElement).select()}
        />
        <button
          onClick={handleCopy}
          className="px-4 py-2 bg-vault-accent text-vault-bg rounded text-sm font-medium
                     hover:bg-vault-accent/90 transition-colors whitespace-nowrap"
        >
          {copied ? '✓ Copied' : 'Copy'}
        </button>
      </div>

      <div className="text-xs text-yellow-400/80 bg-yellow-400/5 border border-yellow-400/20 rounded p-3">
        ⚠ This link contains the encryption key in the URL fragment (#). 
        The key is never sent to the server. Anyone with this link can decrypt the file. 
        Store it securely or share via an encrypted channel.
      </div>
    </div>
  );
}

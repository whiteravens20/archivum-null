import { useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { getVaultInfo, downloadVault, type VaultInfo } from '../api/vault.ts';
import { importKey, decryptFile, formatBytes } from '../crypto/encrypt.ts';
import ProgressBar from '../components/ProgressBar.tsx';

type Stage = 'loading' | 'ready' | 'downloading' | 'decrypting' | 'done' | 'error';

export default function Vault() {
  const { vaultId } = useParams<{ vaultId: string }>();
  const [info, setInfo] = useState<VaultInfo | null>(null);
  const [stage, setStage] = useState<Stage>(() => (vaultId ? 'loading' : 'error'));
  const [error, setError] = useState<string | null>(() => (vaultId ? null : 'No vault ID'));
  const [progress, setProgress] = useState(0);

  // Extract key from URL fragment (never sent to server)
  const keyFragment = window.location.hash.slice(1);

  useEffect(() => {
    if (!vaultId) return;

    getVaultInfo(vaultId)
      .then((data) => {
        setInfo(data);
        setStage('ready');
      })
      .catch((err) => {
        setError(err.message);
        setStage('error');
      });
  }, [vaultId]);

  const handleDownload = async () => {
    if (!vaultId || !keyFragment) return;

    try {
      setStage('downloading');
      setProgress(0.1);

      // Download encrypted blob
      const encryptedBlob = await downloadVault(vaultId);
      setProgress(0.5);

      // Import key from URL fragment
      setStage('decrypting');
      const key = await importKey(keyFragment);

      // Decrypt
      const decryptedFile = await decryptFile(
        encryptedBlob,
        key,
        info?.originalName || 'download',
        info?.mimeType || 'application/octet-stream'
      );
      setProgress(1);

      // Trigger browser download
      const url = URL.createObjectURL(decryptedFile);
      const a = document.createElement('a');
      a.href = url;
      a.download = decryptedFile.name;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      setStage('done');

      // Refresh vault info
      if (vaultId) {
        getVaultInfo(vaultId)
          .then(setInfo)
          .catch(() => {}); // May be deleted
      }
    } catch (err) {
      setStage('error');
      setError(err instanceof Error ? err.message : 'Decryption failed');
    }
  };

  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const timeRemaining = useMemo(
    () => (info ? Math.max(0, Math.floor((info.expiresAt - now) / 1000)) : 0),
    [info, now]
  );

  return (
    <div className="max-w-xl mx-auto px-4 py-12 sm:py-20">
      <div className="text-center mb-8">
        <a href="/" className="inline-block">
          <img src="/logo-symbol.svg" alt="" className="w-12 h-12 mx-auto mb-2" />
          <h1 className="text-2xl font-bold tracking-[0.05em] text-gray-100 mb-1 uppercase">
            Archivum Null
          </h1>
        </a>
        <p className="text-gray-500 text-xs tracking-[0.15em] uppercase font-mono">
          Vault retrieval
        </p>
      </div>

      {stage === 'loading' && (
        <div className="text-center py-12">
          <div className="text-gray-500 animate-pulse">Loading vault...</div>
        </div>
      )}

      {stage === 'error' && (
        <div className="bg-red-500/10 border border-red-500/30 rounded-lg p-6 text-center">
          <div className="text-2xl mb-3 opacity-40">⊘</div>
          <p className="text-red-400 font-medium mb-1">Vault unavailable</p>
          <p className="text-xs text-gray-500">{error}</p>
          <a
            href="/"
            className="inline-block mt-4 text-sm text-vault-accent hover:underline"
          >
            ← Create a new vault
          </a>
        </div>
      )}

      {(stage === 'ready' || stage === 'downloading' || stage === 'decrypting' || stage === 'done') && info && (
        <div className="space-y-6">
          {/* Vault metadata */}
          <div className="bg-vault-secondary/50 rounded-lg p-6 space-y-4">
            <div className="flex items-center justify-between">
              <span className="text-xs text-gray-500 uppercase tracking-wider">File</span>
              <span className="text-sm text-gray-200 truncate ml-4 max-w-[60%] text-right">
                {info.originalName}
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-xs text-gray-500 uppercase tracking-wider">Size</span>
              <span className="text-sm text-gray-300">{formatBytes(info.ciphertextSize)}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-xs text-gray-500 uppercase tracking-wider">Downloads left</span>
              <span className="text-sm text-gray-300">{info.remainingDownloads}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-xs text-gray-500 uppercase tracking-wider">Expires in</span>
              <span className="text-sm text-gray-300">{formatDuration(timeRemaining)}</span>
            </div>
          </div>

          {/* Key warning */}
          {!keyFragment && (
            <div className="bg-red-500/10 border border-red-500/30 rounded-lg p-3 text-sm text-red-400">
              ⚠ No decryption key found in URL. The key must be in the URL fragment (#).
              Decryption will fail.
            </div>
          )}

          {/* Progress */}
          {(stage === 'downloading' || stage === 'decrypting') && (
            <ProgressBar
              progress={progress}
              label={stage === 'downloading' ? 'Downloading...' : 'Decrypting...'}
            />
          )}

          {/* Done */}
          {stage === 'done' && (
            <div className="bg-green-500/10 border border-green-500/20 rounded-lg p-3 text-sm text-green-400 text-center">
              ✓ File decrypted and downloaded successfully
            </div>
          )}

          {/* Download button */}
          <button
            onClick={handleDownload}
            disabled={stage !== 'ready' && stage !== 'done'}
            className="w-full py-3 bg-vault-accent text-vault-bg rounded-lg font-medium
                       hover:bg-vault-accent/90 transition-colors
                       disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {stage === 'ready'
              ? 'Decrypt & Download'
              : stage === 'downloading'
              ? 'Downloading...'
              : stage === 'decrypting'
              ? 'Decrypting...'
              : stage === 'done'
              ? 'Download again'
              : 'Processing...'}
          </button>

          <p className="text-xs text-gray-500 text-center">
            Decryption happens entirely in your browser. The server never sees the key.
          </p>
        </div>
      )}
    </div>
  );
}

function formatDuration(seconds: number): string {
  if (seconds <= 0) return 'Expired';
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

import { useState, useCallback } from 'react';
import UploadZone from '../components/UploadZone.tsx';
import VaultConfig from '../components/VaultConfig.tsx';
import ProgressBar from '../components/ProgressBar.tsx';
import VaultLink from '../components/VaultLink.tsx';
import Turnstile from '../components/Turnstile.tsx';
import { generateKey, exportKey, encryptFile } from '../crypto/encrypt.ts';
import { uploadVault } from '../api/vault.ts';

const MAX_FILE_SIZE = 100 * 1024 * 1024; // 100 MB — frontend enforcement
const TURNSTILE_SITE_KEY = '0x0000000000000000000000'; // Replace with real key

type Stage = 'idle' | 'encrypting' | 'uploading' | 'done' | 'error';

export default function Home() {
  const [file, setFile] = useState<File | null>(null);
  const [ttl, setTtl] = useState(86400);
  const [maxDownloads, setMaxDownloads] = useState(10);
  const [stage, setStage] = useState<Stage>('idle');
  const [progress, setProgress] = useState(0);
  const [vaultUrl, setVaultUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [turnstileToken, setTurnstileToken] = useState<string | undefined>();

  const handleUpload = useCallback(async () => {
    if (!file) return;

    try {
      setError(null);

      // 1. Generate encryption key
      setStage('encrypting');
      setProgress(0);

      const key = await generateKey();
      const keyString = await exportKey(key);

      // 2. Encrypt file client-side
      const encryptedBlob = await encryptFile(file, key, (p) => {
        setProgress(p * 0.5); // First 50% is encryption
      });

      // 3. Upload encrypted blob
      setStage('uploading');
      const result = await uploadVault(
        encryptedBlob,
        file.name,
        ttl,
        maxDownloads,
        turnstileToken,
        (p) => setProgress(0.5 + p * 0.5) // Second 50% is upload
      );

      // 4. Build vault URL with key in fragment
      const url = `${window.location.origin}/vault/${result.vaultId}#${keyString}`;
      setVaultUrl(url);
      setStage('done');
      setProgress(1);
    } catch (err) {
      setStage('error');
      setError(err instanceof Error ? err.message : 'Unknown error');
    }
  }, [file, ttl, maxDownloads, turnstileToken]);

  const handleReset = () => {
    setFile(null);
    setStage('idle');
    setProgress(0);
    setVaultUrl(null);
    setError(null);
  };

  return (
    <div className="max-w-2xl mx-auto px-4 py-12 sm:py-20">
      {/* Header */}
      <div className="text-center mb-12">
        <div className="flex justify-center mb-4">
          <img src="/logo-symbol.svg" alt="" className="w-16 h-16 sm:w-20 sm:h-20" />
        </div>
        <h1 className="text-3xl sm:text-4xl font-bold tracking-[0.05em] text-gray-100 mb-2 uppercase">
          Archivum Null
        </h1>
        <p className="text-gray-400 text-sm tracking-[0.15em] uppercase font-mono">
          Zero trust file relay
        </p>
        <div className="mt-4 flex justify-center gap-2 flex-wrap">
          {['No accounts', 'No cookies', 'No tracking', 'Zero-knowledge'].map((tag) => (
            <span
              key={tag}
              className="text-[10px] uppercase tracking-widest text-gray-500 border border-gray-700 rounded px-2 py-0.5"
            >
              {tag}
            </span>
          ))}
        </div>
      </div>

      {stage === 'done' && vaultUrl ? (
        /* Success state */
        <div className="space-y-6">
          <div className="bg-vault-secondary/50 border border-green-500/20 rounded-lg p-6">
            <div className="text-center mb-6">
              <div className="text-3xl mb-2">◈</div>
              <p className="text-green-400 font-medium">Vault created</p>
              <p className="text-xs text-gray-500 mt-1">
                File encrypted and uploaded successfully
              </p>
            </div>
            <VaultLink url={vaultUrl} />
          </div>

          <button
            onClick={handleReset}
            className="w-full py-2 text-sm text-gray-400 hover:text-gray-200 transition-colors"
          >
            Create another vault
          </button>
        </div>
      ) : (
        /* Upload form */
        <div className="space-y-6">
          <UploadZone
            onFileSelect={setFile}
            maxSize={MAX_FILE_SIZE}
            disabled={stage !== 'idle'}
          />

          {file && (
            <>
              {/* Selected file info */}
              <div className="bg-vault-secondary/50 rounded-lg p-4 flex items-center justify-between">
                <div className="min-w-0">
                  <p className="text-sm text-gray-200 truncate">{file.name}</p>
                  <p className="text-xs text-gray-500">{formatSize(file.size)}</p>
                </div>
                {stage === 'idle' && (
                  <button
                    onClick={() => setFile(null)}
                    className="text-gray-500 hover:text-gray-300 text-sm ml-4"
                  >
                    ✕
                  </button>
                )}
              </div>

              <VaultConfig
                ttl={ttl}
                maxDownloads={maxDownloads}
                onTtlChange={setTtl}
                onMaxDownloadsChange={setMaxDownloads}
                disabled={stage !== 'idle'}
              />

              <Turnstile
                siteKey={TURNSTILE_SITE_KEY}
                onVerify={setTurnstileToken}
              />

              {(stage === 'encrypting' || stage === 'uploading') && (
                <ProgressBar
                  progress={progress}
                  label={stage === 'encrypting' ? 'Encrypting...' : 'Uploading...'}
                />
              )}

              {error && (
                <div className="bg-red-500/10 border border-red-500/30 rounded-lg p-3 text-sm text-red-400">
                  {error}
                </div>
              )}

              <button
                onClick={handleUpload}
                disabled={stage !== 'idle' || !file}
                className="w-full py-3 bg-vault-accent text-vault-bg rounded-lg font-medium
                           hover:bg-vault-accent/90 transition-colors
                           disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {stage === 'idle'
                  ? 'Encrypt & Upload'
                  : stage === 'encrypting'
                  ? 'Encrypting...'
                  : 'Uploading...'}
              </button>
            </>
          )}

          {/* How it works */}
          <div className="mt-12 border-t border-vault-secondary pt-8">
            <h2 className="text-xs uppercase tracking-widest text-gray-500 mb-4">
              How it works
            </h2>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 text-xs text-gray-400">
              <div className="bg-vault-secondary/30 rounded p-4">
                <div className="text-vault-accent font-mono text-lg mb-2">01</div>
                <p>File is encrypted in your browser using AES-256-GCM before upload.</p>
              </div>
              <div className="bg-vault-secondary/30 rounded p-4">
                <div className="text-vault-accent font-mono text-lg mb-2">02</div>
                <p>Only the ciphertext is sent to the server. The key stays in the URL fragment.</p>
              </div>
              <div className="bg-vault-secondary/30 rounded p-4">
                <div className="text-vault-accent font-mono text-lg mb-2">03</div>
                <p>Vault auto-deletes after TTL expires or download limit is reached.</p>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

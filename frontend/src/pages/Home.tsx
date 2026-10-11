import { useState, useCallback, useEffect, useRef } from 'react';
import UploadZone from '../components/UploadZone.tsx';
import VaultConfig from '../components/VaultConfig.tsx';
import ProgressBar from '../components/ProgressBar.tsx';
import VaultLink from '../components/VaultLink.tsx';
import Turnstile from '../components/Turnstile.tsx';
import Logo from '../components/Logo.tsx';
import { generateKey, exportKey, buildMetadataHeader, calculateTotalEncryptedSize } from '../crypto/encrypt.ts';
import { uploadVault, uploadVaultChunked } from '../api/vault.ts';
import { getBranding } from '../branding.ts';

const TTL_OPTION_VALUES = [300, 1800, 3600, 21600, 86400, 259200, 604800];
const DOWNLOAD_OPTION_VALUES = [1, 3, 5, 10, 25, 50, 100];

function nearestInList(value: number, list: number[]): number {
  return list.reduce((prev, curr) =>
    Math.abs(curr - value) < Math.abs(prev - value) ? curr : prev
  );
}

interface RuntimeConfig {
  maxFileSize: number;
  chunkSize: number;
  cryptoChunkSize: number;
  defaultTtl: number;
  defaultMaxDownloads: number;
  turnstileSiteKey: string;
  turnstileEnabled: boolean;
}

const DEFAULT_CONFIG: RuntimeConfig = {
  maxFileSize: 100 * 1024 * 1024,
  chunkSize: 10 * 1024 * 1024,
  // 28 bytes under 5 MB, like the server's default: two encrypted chunks fill one request
  cryptoChunkSize: 5 * 1024 * 1024 - 28,
  defaultTtl: 86400,
  defaultMaxDownloads: 10,
  turnstileSiteKey: '0x0000000000000000000000',
  turnstileEnabled: false,
};

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

/**
 * The runtime configuration, when the response really is one. Anything else gives
 * null, and the built-in defaults stay in force.
 */
function parseRuntimeConfig(raw: unknown): RuntimeConfig | null {
  if (typeof raw !== 'object' || raw === null) return null;
  // Narrowed field by field below: the body is whatever the server sent.
  const candidate = raw as Record<string, unknown>;
  const { maxFileSize, chunkSize, cryptoChunkSize, defaultTtl, defaultMaxDownloads, turnstileSiteKey, turnstileEnabled } = candidate;
  if (
    !isPositiveInteger(maxFileSize) ||
    !isPositiveInteger(chunkSize) ||
    !isPositiveInteger(cryptoChunkSize) ||
    !isPositiveInteger(defaultTtl) ||
    !isPositiveInteger(defaultMaxDownloads) ||
    typeof turnstileSiteKey !== 'string' ||
    typeof turnstileEnabled !== 'boolean'
  ) {
    return null;
  }
  return { maxFileSize, chunkSize, cryptoChunkSize, defaultTtl, defaultMaxDownloads, turnstileSiteKey, turnstileEnabled };
}

type Stage = 'idle' | 'uploading' | 'done' | 'error';

export default function Home() {
  const { name, tagline } = getBranding();
  const [runtimeConfig, setRuntimeConfig] = useState<RuntimeConfig>(DEFAULT_CONFIG);
  const [file, setFile] = useState<File | null>(null);
  const [ttl, setTtl] = useState(DEFAULT_CONFIG.defaultTtl);
  const [maxDownloads, setMaxDownloads] = useState(DEFAULT_CONFIG.defaultMaxDownloads);
  const [stage, setStage] = useState<Stage>('idle');

  useEffect(() => {
    fetch('/api/config')
      // An error response carries JSON too ({ error, retryAfter }). Taken for the
      // configuration, it would leave every limit undefined.
      .then((r): Promise<unknown> => (r.ok ? r.json() : Promise.resolve(null)))
      .then((raw) => {
        const cfg = parseRuntimeConfig(raw);
        if (!cfg) return; // keep the defaults
        setRuntimeConfig(cfg);
        setTtl(nearestInList(cfg.defaultTtl, TTL_OPTION_VALUES));
        setMaxDownloads(nearestInList(cfg.defaultMaxDownloads, DOWNLOAD_OPTION_VALUES));
      })
      .catch(() => { /* keep defaults on network error */ });
  }, []);
  const [progress, setProgress] = useState(0);
  const [vaultUrl, setVaultUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [turnstileToken, setTurnstileToken] = useState<string | undefined>();
  const [captchaVerified, setCaptchaVerified] = useState(false);
  const [captchaError, setCaptchaError] = useState<string | null>(null);
  const captchaTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Start 10s CAPTCHA timeout when file is selected and Turnstile is enabled
  useEffect(() => {
    if (captchaTimerRef.current) {
      clearTimeout(captchaTimerRef.current);
      captchaTimerRef.current = null;
    }

    if (file && runtimeConfig.turnstileEnabled && !captchaVerified) {
      captchaTimerRef.current = setTimeout(() => {
        if (!captchaVerified) {
          setCaptchaError('CAPTCHA verification timed out — please reload and try again');
        }
      }, 10_000);
    }

    return () => {
      if (captchaTimerRef.current) {
        clearTimeout(captchaTimerRef.current);
        captchaTimerRef.current = null;
      }
    };
  }, [file, runtimeConfig.turnstileEnabled, captchaVerified]);

  const handleCaptchaVerify = useCallback((token: string) => {
    setTurnstileToken(token);
    setCaptchaVerified(true);
    setCaptchaError(null);
    if (captchaTimerRef.current) {
      clearTimeout(captchaTimerRef.current);
      captchaTimerRef.current = null;
    }
  }, []);

  const handleCaptchaError = useCallback(() => {
    setCaptchaError('CAPTCHA verification failed — please reload and try again');
    setCaptchaVerified(false);
  }, []);

  const handleCaptchaExpire = useCallback(() => {
    setCaptchaError('CAPTCHA expired — please reload and try again');
    setCaptchaVerified(false);
    setTurnstileToken(undefined);
  }, []);

  const handleReset = () => {
    setFile(null);
    setStage('idle');
    setProgress(0);
    setVaultUrl(null);
    setError(null);
    setCaptchaVerified(false);
    setCaptchaError(null);
    setTurnstileToken(undefined);
  };

  const handleUpload = useCallback(async () => {
    if (!file) return;
    if (file.size > runtimeConfig.maxFileSize) {
      setError(`File exceeds maximum size of ${formatSize(runtimeConfig.maxFileSize)}`);
      return;
    }

    try {
      setError(null);
      setStage('uploading');
      setProgress(0);

      const ac = new AbortController();
      abortRef.current = ac;

      const key = await generateKey();
      const keyString = await exportKey(key);
      const chunkPlaintextSize = runtimeConfig.cryptoChunkSize;

      // Decide single vs chunked based on total encrypted size
      const header = buildMetadataHeader(file.name, file.type);
      const totalEncrypted = calculateTotalEncryptedSize(
        header.length + file.size,
        chunkPlaintextSize,
      );

      let result;
      if (totalEncrypted > runtimeConfig.chunkSize) {
        result = await uploadVaultChunked(
          file, key, chunkPlaintextSize,
          ttl, maxDownloads, turnstileToken,
          (p) => setProgress(p),
          ac.signal,
        );
      } else {
        result = await uploadVault(
          file, key, chunkPlaintextSize,
          ttl, maxDownloads, turnstileToken,
          (p) => setProgress(p),
          ac.signal,
        );
      }

      // 4. Build vault URL with key + encoded filename in fragment.
      // Fragment NEVER reaches the server — zero-trust is fully preserved.
      // Format: #<key43chars>.<base64url(filename)>
      // '.' is not a valid base64url char, so it acts as an unambiguous separator.
      const encodedName = (() => {
        const bytes = new TextEncoder().encode(file.name.slice(0, 255));
        let bin = '';
        bytes.forEach((b) => (bin += String.fromCharCode(b)));
        return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      })();
      const url = `${window.location.origin}/vault/${result.vaultId}#${keyString}.${encodedName}`;
      setVaultUrl(url);
      setStage('done');
      setProgress(1);
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        // User cancelled — reset to idle without showing an error
        handleReset();
        return;
      }
      setStage('error');
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      abortRef.current = null;
    }
  }, [file, ttl, maxDownloads, turnstileToken, runtimeConfig]);

  const handleCancel = () => {
    abortRef.current?.abort(new DOMException('Upload cancelled', 'AbortError'));
  };

  return (
    <div className="max-w-2xl mx-auto px-4 py-12 sm:py-20">
      {/* Header */}
      <div className="text-center mb-12">
        <div className="flex justify-center mb-4">
          <Logo className="w-16 h-16 sm:w-20 sm:h-20" />
        </div>
        <h1 className="text-3xl sm:text-4xl font-bold tracking-[0.05em] text-vault-heading mb-2 uppercase">
          {name}
        </h1>
        <p className="text-vault-muted text-sm tracking-[0.15em] uppercase font-mono">
          {tagline}
        </p>
        <div className="mt-4 flex justify-center gap-2 flex-wrap">
          {['No accounts', 'No cookies', 'No tracking', 'Zero-knowledge'].map((tag) => (
            <span
              key={tag}
              className="text-[10px] uppercase tracking-widest text-vault-subtle border border-vault-line-soft rounded px-2 py-0.5"
            >
              {tag}
            </span>
          ))}
        </div>
      </div>

      {stage === 'done' && vaultUrl ? (
        /* Success state */
        <div className="space-y-6">
          <div className="bg-vault-secondary/50 border border-vault-success-fill/20 rounded-lg p-6">
            <div className="text-center mb-6">
              <div className="text-3xl mb-2">◈</div>
              <p className="text-vault-success font-medium">Vault created</p>
              <p className="text-xs text-vault-subtle mt-1">
                File encrypted and uploaded successfully
              </p>
            </div>
            <VaultLink url={vaultUrl} />
          </div>

          <button
            onClick={handleReset}
            className="w-full py-2 text-sm text-vault-muted hover:text-vault-text transition-colors"
          >
            Create another vault
          </button>
        </div>
      ) : (
        /* Upload form */
        <div className="space-y-6">
          <UploadZone
            onFileSelect={setFile}
            maxSize={runtimeConfig.maxFileSize}
            disabled={stage !== 'idle'}
          />

          {file && (
            <>
              {/* Selected file info */}
              <div className="bg-vault-secondary/50 rounded-lg p-4 flex items-center justify-between">
                <div className="min-w-0">
                  <p className="text-sm text-vault-text truncate">{file.name}</p>
                  <p className="text-xs text-vault-subtle">{formatSize(file.size)}</p>
                </div>
                {stage === 'idle' && (
                  <button
                    onClick={() => setFile(null)}
                    className="text-vault-subtle hover:text-vault-text-soft text-sm ml-4"
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

              {runtimeConfig.turnstileEnabled && (
                <Turnstile
                  siteKey={runtimeConfig.turnstileSiteKey}
                  onVerify={handleCaptchaVerify}
                  onError={handleCaptchaError}
                  onExpire={handleCaptchaExpire}
                />
              )}

              {captchaError && (
                <div className="bg-vault-danger-fill/10 border border-vault-danger-fill/30 rounded-lg p-3 text-sm text-vault-danger">
                  {captchaError}
                </div>
              )}

              {stage === 'uploading' && (
                <>
                  <ProgressBar
                    progress={progress}
                    label="Encrypting & uploading..."
                  />
                  <button
                    onClick={handleCancel}
                    className="w-full py-2 text-sm text-vault-danger hover:text-vault-danger-strong border border-vault-danger-fill/30 rounded-lg transition-colors"
                  >
                    Cancel upload
                  </button>
                </>
              )}

              {error && (
                <div className="bg-vault-danger-fill/10 border border-vault-danger-fill/30 rounded-lg p-3 text-sm text-vault-danger">
                  {error}
                </div>
              )}

              {stage === 'error' ? (
                <button
                  onClick={handleReset}
                  className="w-full py-3 text-sm text-vault-muted hover:text-vault-text border border-vault-line-soft rounded-lg transition-colors"
                >
                  ← Return to main page
                </button>
              ) : (
                <button
                  onClick={handleUpload}
                  disabled={stage !== 'idle' || !file || (runtimeConfig.turnstileEnabled && !captchaVerified)}
                  className="w-full py-3 bg-vault-accent text-vault-on-accent rounded-lg font-medium
                             hover:bg-vault-accent/90 transition-colors
                             disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {stage === 'idle'
                    ? (runtimeConfig.turnstileEnabled && !captchaVerified
                        ? 'Waiting for CAPTCHA...'
                        : 'Encrypt & Upload')
                    : 'Processing...'}
                </button>
              )}
            </>
          )}

          {/* How it works */}
          <div className="mt-12 border-t border-vault-secondary pt-8">
            <h2 className="text-xs uppercase tracking-widest text-vault-subtle mb-4">
              How it works
            </h2>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 text-xs text-vault-muted">
              <div className="bg-vault-secondary/30 rounded p-4">
                <div className="text-vault-accent-ink font-mono text-lg mb-2">01</div>
                <p>File is encrypted in your browser using AES-256-GCM before upload.</p>
              </div>
              <div className="bg-vault-secondary/30 rounded p-4">
                <div className="text-vault-accent-ink font-mono text-lg mb-2">02</div>
                <p>Only the ciphertext is sent to the server. The key stays in the URL fragment.</p>
              </div>
              <div className="bg-vault-secondary/30 rounded p-4">
                <div className="text-vault-accent-ink font-mono text-lg mb-2">03</div>
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

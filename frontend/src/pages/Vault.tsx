import { useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { getVaultInfo, downloadVault, type VaultInfo } from '../api/vault.ts';
import { ApiError } from '../api/errors.ts';
import { importKey, decryptChunk, parseMetadataHeader, PER_CHUNK_OVERHEAD, sanitizeFilename } from '../crypto/encrypt.ts';
import { formatBytes, formatDuration } from '../format.ts';
import ProgressBar from '../components/ProgressBar.tsx';
import Logo from '../components/Logo.tsx';
import { getBranding } from '../branding.ts';
import { useI18n } from '../i18n/i18n.ts';

type Stage = 'loading' | 'ready' | 'downloading' | 'decrypting' | 'done' | 'error';

type VaultProblem =
  | 'vault.noId'
  | 'vault.notFound'
  | 'vault.rateLimited'
  | 'vault.serverError'
  | 'vault.failed'
  | 'vault.corrupt'
  | 'vault.empty'
  | 'vault.decryptFailed'
  | 'common.unreachable';

/** What to tell the visitor when the vault cannot be had: by the HTTP status the server refused it with. */
function requestProblem(err: unknown): VaultProblem {
  if (!(err instanceof ApiError)) return 'vault.failed';
  if (err.status === null) return 'common.unreachable';
  if (err.status === 404) return 'vault.notFound';
  if (err.status === 429) return 'vault.rateLimited';
  if (err.status >= 500) return 'vault.serverError';
  return 'vault.failed';
}

/** Shown in the warning about misleading names. */
const MISLEADING_EXTENSION = '.pdf.exe';

export default function Vault() {
  const { name } = getBranding();
  const { t, rich, locale } = useI18n();
  const { vaultId } = useParams<{ vaultId: string }>();
  const [info, setInfo] = useState<VaultInfo | null>(null);
  const [stage, setStage] = useState<Stage>(() => (vaultId ? 'loading' : 'error'));
  // Kept as a message key, so a change of language translates it on screen too
  const [error, setError] = useState<VaultProblem | null>(() => (vaultId ? null : 'vault.noId'));
  const [progress, setProgress] = useState(0);
  const [decryptedFilename, setDecryptedFilename] = useState<string | null>(null);

  // Extract key + optional display filename from URL fragment (never sent to server).
  // Fragment format: #<key43chars>.<base64url(filename)>  — '.' is not a base64url char.
  const rawFragment = window.location.hash.slice(1);
  const dotIndex = rawFragment.indexOf('.');
  const keyFragment = dotIndex >= 0 ? rawFragment.slice(0, dotIndex) : rawFragment;
  const fragmentFilename = (() => {
    if (dotIndex < 0) return '';
    try {
      const enc = rawFragment.slice(dotIndex + 1);
      const base64 = enc.replace(/-/g, '+').replace(/_/g, '/');
      const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
      const bin = atob(padded);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return sanitizeFilename(new TextDecoder().decode(bytes));
    } catch {
      return '';
    }
  })();

  useEffect(() => {
    if (!vaultId) return;

    getVaultInfo(vaultId)
      .then((data) => {
        setInfo(data);
        setStage('ready');
      })
      .catch((err) => {
        setError(requestProblem(err));
        setStage('error');
      });
  }, [vaultId]);

  const fail = (problem: VaultProblem) => {
    setStage('error');
    setError(problem);
  };

  const handleDownload = async () => {
    if (!vaultId || !keyFragment || !info) return;

    try {
      setStage('downloading');
      setProgress(0.05);

      const encryptedBlob = await downloadVault(vaultId);
      setProgress(0.4);

      setStage('decrypting');
      const key = await importKey(keyFragment);

      // Streaming per-chunk decryption. Each decrypted chunk is wrapped in a Blob
      // immediately and its plaintext view dropped, so the JS heap holds at most one
      // chunk at a time instead of the whole file — the accumulating Blob parts are
      // managed by the browser (and may be spilled to disk).
      const chunkPT = info.chunkPlaintextSize;
      // Both numbers come from the server. With an unusable chunk size, or with no
      // bytes at all, the loop below would not run once, nothing would be
      // authenticated, and an empty file would pass for a successful download.
      if (!Number.isSafeInteger(chunkPT) || chunkPT <= 0) {
        fail('vault.corrupt');
        return;
      }
      const chunkCT = chunkPT + PER_CHUNK_OVERHEAD;
      const numChunks = Math.ceil(encryptedBlob.size / chunkCT);
      if (numChunks < 1) {
        fail('vault.empty');
        return;
      }
      const contentParts: BlobPart[] = [];
      let filename = 'file';
      let mimeType = 'application/octet-stream';

      for (let i = 0; i < numChunks; i++) {
        const start = i * chunkCT;
        const end = Math.min(start + chunkCT, encryptedBlob.size);
        const chunkBytes = new Uint8Array(await encryptedBlob.slice(start, end).arrayBuffer());
        const plaintext = await decryptChunk(chunkBytes, key, i, i === numChunks - 1);

        if (i === 0) {
          // The metadata header (filename + MIME) prefixes the first chunk's plaintext.
          const meta = parseMetadataHeader(plaintext);
          filename = meta.filename;
          mimeType = meta.mimeType;
          setDecryptedFilename(filename);
          contentParts.push(new Blob([plaintext.slice(meta.contentOffset)]));
        } else {
          contentParts.push(new Blob([plaintext]));
        }
        setProgress(0.4 + ((i + 1) / numChunks) * 0.55);
      }

      const decryptedFile = new File(contentParts, filename, { type: mimeType });
      setProgress(1);

      // Trigger browser download
      const url = URL.createObjectURL(decryptedFile);
      const a = document.createElement('a');
      a.href = url;
      a.download = decryptedFile.name;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      // Released later, not here: some browsers begin reading the object URL only after
      // this handler has returned, and a URL revoked by then downloads nothing.
      setTimeout(() => URL.revokeObjectURL(url), 60_000);

      setStage('done');

      // Refresh vault info to reflect the consumed download
      getVaultInfo(vaultId)
        .then(setInfo)
        .catch(() => {}); // non-fatal: vault may already be deleted
    } catch (err) {
      // A refused request has a status. Anything else went wrong between the
      // ciphertext and the file: the key, the header, a chunk that does not decrypt.
      fail(err instanceof ApiError ? requestProblem(err) : 'vault.decryptFailed');
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
          <Logo className="w-12 h-12 mx-auto mb-2" />
          <h1 className="text-2xl font-bold tracking-[0.05em] text-vault-heading mb-1 uppercase">
            {name}
          </h1>
        </a>
        <p className="text-vault-subtle text-xs tracking-[0.15em] uppercase font-mono">
          {t('vault.subtitle')}
        </p>
      </div>

      {stage === 'loading' && (
        <div className="text-center py-12">
          <div className="text-vault-subtle animate-pulse">{t('vault.loading')}</div>
        </div>
      )}

      {stage === 'error' && (
        <div className="bg-vault-danger-fill/10 border border-vault-danger-fill/30 rounded-lg p-6 text-center">
          <div className="text-2xl mb-3 opacity-40">⊘</div>
          <p className="text-vault-danger font-medium mb-1">{t('vault.unavailable')}</p>
          {error && <p className="text-xs text-vault-subtle">{t(error)}</p>}
          <a
            href="/"
            className="inline-block mt-4 text-sm text-vault-accent-ink hover:underline"
          >
            {t('vault.createNew')}
          </a>
        </div>
      )}

      {(stage === 'ready' || stage === 'downloading' || stage === 'decrypting' || stage === 'done') && info && (
        <div className="space-y-6">
          {/* Vault metadata */}
          <div className="bg-vault-secondary/50 rounded-lg p-6 space-y-4">
            {fragmentFilename && (
              <div className="flex items-center justify-between">
                <span className="text-xs text-vault-subtle uppercase tracking-wider">{t('vault.file')}</span>
                <span className="text-sm text-vault-text truncate ml-4 max-w-[60%] text-right font-mono">
                  {fragmentFilename}
                </span>
              </div>
            )}
            <div className="flex items-center justify-between">
              <span className="text-xs text-vault-subtle uppercase tracking-wider">{t('vault.size')}</span>
              <span className="text-sm text-vault-text-soft">{formatBytes(info.ciphertextSize, locale)}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-xs text-vault-subtle uppercase tracking-wider">{t('vault.downloadsLeft')}</span>
              <span className="text-sm text-vault-text-soft">{info.remainingDownloads}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-xs text-vault-subtle uppercase tracking-wider">{t('vault.expiresIn')}</span>
              <span className="text-sm text-vault-text-soft">
                {timeRemaining > 0 ? formatDuration(timeRemaining, t) : t('vault.expired')}
              </span>
            </div>
          </div>

          {/* Sender trust warning */}
          <div className="bg-vault-warning-fill/10 border border-vault-warning-fill/20 rounded-lg p-3 text-xs text-vault-warning/90 space-y-1">
            <p className="font-medium">{t('vault.notice')}</p>
            <ul className="list-disc list-inside space-y-0.5 text-vault-warning-soft">
              <li>{t('vault.notice.sender')}</li>
              <li>{t('vault.notice.scan')}</li>
              <li>
                {rich('vault.notice.extensions', {
                  example: <span className="font-mono">{MISLEADING_EXTENSION}</span>,
                })}
              </li>
            </ul>
          </div>

          {/* Filename mismatch warning */}
          {decryptedFilename && fragmentFilename && decryptedFilename !== fragmentFilename && (
            <div className="bg-vault-danger-fill/10 border border-vault-danger-fill/30 rounded-lg p-3 text-xs text-vault-danger space-y-1">
              <p className="font-medium">{t('vault.mismatch')}</p>
              <p>
                {/* Both names come from the sender: they go in as text, never as markup */}
                {rich('vault.mismatch.detail', {
                  expected: <span className="font-mono">&quot;{fragmentFilename}&quot;</span>,
                  actual: <span className="font-mono">&quot;{decryptedFilename}&quot;</span>,
                })}
              </p>
            </div>
          )}

          {/* Key warning */}
          {!keyFragment && (
            <div className="bg-vault-danger-fill/10 border border-vault-danger-fill/30 rounded-lg p-3 text-sm text-vault-danger">
              {t('vault.noKey')}
            </div>
          )}

          {/* Progress */}
          {(stage === 'downloading' || stage === 'decrypting') && (
            <ProgressBar
              progress={progress}
              label={stage === 'downloading' ? t('vault.downloading') : t('vault.decrypting')}
            />
          )}

          {/* Done */}
          {stage === 'done' && (
            <div className="bg-vault-success-fill/10 border border-vault-success-fill/20 rounded-lg p-3 text-sm text-vault-success text-center">
              {t('vault.done')}
            </div>
          )}

          {/* Download button */}
          <button
            onClick={handleDownload}
            disabled={(stage !== 'ready' && stage !== 'done') || !keyFragment}
            className="w-full py-3 bg-vault-accent text-vault-on-accent rounded-lg font-medium
                       hover:bg-vault-accent/90 transition-colors
                       disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {stage === 'ready'
              ? t('vault.decryptAndDownload')
              : stage === 'downloading'
              ? t('vault.downloading')
              : stage === 'decrypting'
              ? t('vault.decrypting')
              : stage === 'done'
              ? t('vault.downloadAgain')
              : t('common.processing')}
          </button>

          <p className="text-xs text-vault-subtle text-center">
            {t('vault.footnote')}
          </p>
        </div>
      )}
    </div>
  );
}

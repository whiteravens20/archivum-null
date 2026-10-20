import { useEffect, useRef, useState, useCallback } from 'react';
import { formatBytes, formatDuration } from '../format.ts';
import { useI18n, type Message } from '../i18n/i18n.ts';

interface VaultMeta {
  vaultId: string;
  ciphertextSize: number;
  createdAt: number;
  expiresAt: number;
  remainingDownloads: number;
  maxDownloads: number;
}

interface Stats {
  totalVaults: number;
  activeVaults: number;
  totalStorageBytes: number;
  totalStorageMB: number;
  /** 0 = unlimited */
  storageQuotaBytes: number;
}

interface VersionInfo {
  /** `unknown` when the build was not stamped with APP_VERSION. */
  current: string;
  latest: string | null;
  /** null when no comparison could be made — check off, failed, or unstamped. */
  updateAvailable: boolean | null;
  releaseUrl: string | null;
  compareUrl: string | null;
  publishedAt: string | null;
  checkedAt: number | null;
  /** Whether the operator opted into the GitHub release check. */
  enabled: boolean;
  error: string | null;
  uptime: number;
}

/** The setting that turns the update check on, named where the panel says it is off. */
const UPDATE_CHECK_SETTING = 'UPDATE_CHECK_ENABLED=true';

export default function Admin() {
  const { t, rich, message, locale } = useI18n();
  const [stats, setStats] = useState<Stats | null>(null);
  const [version, setVersion] = useState<VersionInfo | null>(null);
  const [vaults, setVaults] = useState<VaultMeta[]>([]);
  // Kept as a message, so a change of language translates it on screen too
  const [error, setError] = useState<Message | null>(null);
  const [loading, setLoading] = useState(true);
  const [auth, setAuth] = useState('');
  const [authenticated, setAuthenticated] = useState(false);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  // vaultId pending inline confirmation, null = none
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  // Seconds until the server lifts a rate limit, while one is in force
  const [rateLimited, setRateLimited] = useState<number | null>(null);
  // Whether this login has shown data yet. A rate limit before that is the login being
  // refused; after it, the panel keeps what it has and waits.
  const signedIn = useRef(false);

  const authHeader = useCallback(
    () => ({ Authorization: `Basic ${auth}` }),
    [auth]
  );

  const fetchData = useCallback(async (): Promise<boolean> => {
    try {
      const [statsRes, vaultsRes] = await Promise.all([
        fetch('/api/admin/stats', { headers: authHeader() }),
        fetch('/api/admin/vaults', { headers: authHeader() }),
      ]);

      if (statsRes.status === 401 || vaultsRes.status === 401) {
        setError({ key: 'admin.authFailed' });
        return false;
      }

      if (statsRes.status === 403) {
        setError({ key: 'admin.disabled' });
        return true;
      }

      const limited = [statsRes, vaultsRes].find((res) => res.status === 429);
      if (limited) {
        const retryAfter = Number(limited.headers.get('Retry-After')) || 60;
        if (signedIn.current) {
          setRateLimited(retryAfter);
          return true;
        }
        // The body says which limit it is: failed logins, or requests in general
        // (backend/src/middleware/rateLimit.ts). Only that is taken from it; the words
        // shown are the panel's own.
        const body: unknown = await limited.json().catch(() => null);
        const lockedOut =
          typeof body === 'object' && body !== null && 'error' in body && typeof body.error === 'string' &&
          body.error.startsWith('Too many failed login attempts');
        setError({ key: lockedOut ? 'admin.lockedOut' : 'admin.rateLimited', vars: { seconds: retryAfter } });
        return false;
      }

      if (!statsRes.ok || !vaultsRes.ok) {
        const status = !statsRes.ok ? statsRes.status : vaultsRes.status;
        setError({ key: 'admin.backendUnavailable', vars: { status } });
        return true;
      }

      setStats(await statsRes.json());
      setVaults(await vaultsRes.json());
      setError(null);
      setRateLimited(null);
      signedIn.current = true;
    } catch {
      // No answer, or one that is not JSON
      setError({ key: 'admin.noAnswer' });
    } finally {
      setLoading(false);
    }
    return true;
  }, [authHeader]);

  // Fetched on its own cadence rather than with the 10 s stats poll: the very first
  // call can wait on GitHub for up to 5 s, and the backend caches the answer for
  // hours afterwards. A failure here never disturbs the rest of the panel.
  const fetchVersion = useCallback(async () => {
    try {
      const res = await fetch('/api/admin/version', { headers: authHeader() });
      if (res.ok) setVersion(await res.json());
    } catch {
      // Panel stays fully usable without it.
    }
  }, [authHeader]);

  const handleLogin = (e: React.FormEvent) => {
    e.preventDefault();
    const token = btoa(`${username}:${password}`);
    setAuth(token);
    setAuthenticated(true);
  };

  useEffect(() => {
    if (!authenticated) return;
    const poll = async () => {
      const ok = await fetchData();
      if (!ok) {
        signedIn.current = false;
        setAuthenticated(false);
      }
    };
    void poll();
    const interval = setInterval(() => { void poll(); }, 10_000);
    return () => clearInterval(interval);
  }, [authenticated, fetchData]);

  useEffect(() => {
    if (!authenticated) return;
    const check = async () => { await fetchVersion(); };
    void check();
    const interval = setInterval(() => { void check(); }, 600_000);
    return () => clearInterval(interval);
  }, [authenticated, fetchVersion]);

  const handleDeleteConfirmed = async (vaultId: string) => {
    setPendingDelete(null);
    try {
      const res = await fetch(`/api/admin/vaults/${vaultId}`, {
        method: 'DELETE',
        headers: authHeader(),
      });
      if (res.ok) {
        await fetchData();
      }
    } catch {
      // ignore
    }
  };

  if (!authenticated) {
    return (
      <div className="max-w-sm mx-auto px-4 py-20">
        <h1 className="text-xl font-bold text-center mb-6 text-vault-heading">{t('admin.title')}</h1>
        <form onSubmit={handleLogin} className="space-y-4">
          <input
            type="text"
            placeholder={t('admin.username')}
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            className="w-full bg-vault-secondary border border-vault-line rounded px-3 py-2 text-sm text-vault-text focus:outline-none focus:border-vault-accent-ink"
          />
          <input
            type="password"
            placeholder={t('admin.password')}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="w-full bg-vault-secondary border border-vault-line rounded px-3 py-2 text-sm text-vault-text focus:outline-none focus:border-vault-accent-ink"
          />
          <button
            type="submit"
            className="w-full py-2 bg-vault-accent text-vault-on-accent rounded font-medium hover:bg-vault-accent/90"
          >
            {t('admin.login')}
          </button>
          {error && <p className="text-vault-danger text-sm text-center">{message(error)}</p>}
        </form>
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto px-4 py-8">
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-xl font-bold text-vault-heading">{t('admin.title')}</h1>
          <p className="text-xs text-vault-subtle">{t('admin.subtitle')}</p>
        </div>
        <a href="/" className="text-sm text-vault-accent-ink hover:underline">{t('common.home')}</a>
      </div>

      {loading ? (
        <p className="text-vault-subtle animate-pulse">{t('admin.loading')}</p>
      ) : error ? (
        <div className="bg-vault-danger-fill/10 border border-vault-danger-fill/30 rounded-lg p-4 text-vault-danger">
          {message(error)}
        </div>
      ) : (
        <>
          {/* A poll the server refused: the figures stay, with a word on why they are not fresh */}
          {rateLimited !== null && (
            <div className="mb-6 rounded-lg border border-vault-warning-fill/30 bg-vault-warning-fill/10 p-4 text-sm text-vault-warning-strong">
              {t('admin.rateLimitedNotice', { seconds: rateLimited })}
            </div>
          )}

          {/* Update notice — only when a newer release actually exists */}
          {version?.updateAvailable && version.latest && (
            <div className="mb-6 rounded-lg border border-vault-warning-fill/30 bg-vault-warning-fill/10 p-4">
              <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
                <div>
                  <p className="text-sm font-medium text-vault-warning-strong">
                    {t('admin.updateAvailable', { version: version.latest })}
                  </p>
                  <p className="text-xs text-vault-muted mt-0.5">
                    {version.publishedAt
                      ? t('admin.runsReleased', {
                          version: version.current,
                          date: new Date(version.publishedAt).toLocaleDateString(locale),
                        })
                      : t('admin.runs', { version: version.current })}
                  </p>
                </div>
                <div className="flex items-center gap-3 whitespace-nowrap">
                  {version.compareUrl && (
                    <a
                      href={version.compareUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-xs font-medium text-vault-warning-strong hover:underline"
                    >
                      {t('admin.viewChanges')}
                    </a>
                  )}
                  {version.releaseUrl && (
                    <a
                      href={version.releaseUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-xs text-vault-muted hover:text-vault-text hover:underline"
                    >
                      {t('admin.releaseNotes')}
                    </a>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* Stats */}
          {stats && (
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-4 mb-8">
              <div className="bg-vault-secondary/50 rounded-lg p-4">
                <p className="text-[10px] uppercase tracking-widest text-vault-subtle mb-1">{t('admin.activeVaults')}</p>
                <p className="text-lg font-bold text-vault-text">{stats.activeVaults}</p>
              </div>

              {/* Storage card — shows quota bar when limit is set */}
              <div className="bg-vault-secondary/50 rounded-lg p-4 sm:col-span-1">
                <p className="text-[10px] uppercase tracking-widest text-vault-subtle mb-1">{t('admin.storage')}</p>
                {stats.storageQuotaBytes > 0 ? (() => {
                  const pct = Math.min(100, (stats.totalStorageBytes / stats.storageQuotaBytes) * 100);
                  const isNearFull = pct >= 90;
                  const isFull = pct >= 100;
                  const percent = new Intl.NumberFormat(locale, { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(pct);
                  return (
                    <>
                      <p className={`text-lg font-bold ${isFull ? 'text-vault-danger' : isNearFull ? 'text-vault-warning' : 'text-vault-text'}`}>
                        {formatBytes(stats.totalStorageBytes, locale)}
                        <span className="text-xs font-normal text-vault-subtle ml-1">/ {formatBytes(stats.storageQuotaBytes, locale)}</span>
                      </p>
                      <div className="mt-2 h-1.5 rounded-full bg-vault-secondary overflow-hidden">
                        <div
                          className={`h-full rounded-full transition-all ${
                            isFull ? 'bg-vault-danger-fill' : isNearFull ? 'bg-vault-warning-fill' : 'bg-vault-accent'
                          }`}
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                      <p className="text-[10px] text-vault-subtle mt-1">{t('admin.storageUsed', { percent })}</p>
                    </>
                  );
                })() : (
                  <p className="text-lg font-bold text-vault-text">
                    {formatBytes(stats.totalStorageBytes, locale)}
                    <span className="text-xs font-normal text-vault-subtle ml-1">/ ∞</span>
                  </p>
                )}
              </div>

              <div className="bg-vault-secondary/50 rounded-lg p-4">
                <p className="text-[10px] uppercase tracking-widest text-vault-subtle mb-1">{t('admin.version')}</p>
                <p
                  className={`text-lg font-bold ${
                    version?.updateAvailable ? 'text-vault-warning' : 'text-vault-text'
                  }`}
                >
                  {version?.current ?? '—'}
                </p>
                <p className="text-[10px] text-vault-subtle mt-1">
                  {version
                    ? t('admin.onlineFor', { uptime: formatDuration(version.uptime, t) })
                    : t('admin.online')}
                </p>
                {version && !version.enabled && (
                  <p className="text-[10px] text-vault-faint mt-1">
                    {rich('admin.updateCheckOff', { setting: <code>{UPDATE_CHECK_SETTING}</code> })}
                  </p>
                )}
                {version?.enabled && version.updateAvailable === false && (
                  <p className="text-[10px] text-vault-subtle mt-1">{t('admin.upToDate')}</p>
                )}
                {version?.enabled && version.error && (
                  <p className="text-[10px] text-vault-subtle mt-1">{version.error}</p>
                )}
              </div>
            </div>
          )}

          {/* Vault list */}
          <div className="bg-vault-secondary/30 rounded-lg overflow-hidden">
            <div className="px-4 py-3 border-b border-vault-secondary text-xs text-vault-subtle uppercase tracking-wider">
              {t('admin.vaultList', { count: vaults.length })}
            </div>
            {vaults.length === 0 ? (
              <p className="p-6 text-sm text-vault-subtle text-center">{t('admin.noVaults')}</p>
            ) : (
              <div className="divide-y divide-vault-secondary/50">
                {vaults.map((v) => (
                  <div key={v.vaultId} className="px-4 py-3 flex items-center justify-between text-sm">
                    <div className="min-w-0 flex-1">
                      <div className="flex gap-3 items-baseline">
                        <span className="text-vault-accent-ink font-mono text-xs truncate max-w-[200px]">
                          {v.vaultId}
                        </span>
                      </div>
                      <div className="text-xs text-vault-subtle mt-0.5">
                        {t('admin.vaultDetails', {
                          size: formatBytes(v.ciphertextSize, locale),
                          remaining: v.remainingDownloads,
                          max: v.maxDownloads,
                          date: new Date(v.expiresAt).toLocaleString(locale),
                        })}
                      </div>
                    </div>
                    <div className="ml-4 flex items-center gap-2 whitespace-nowrap">
                      {pendingDelete === v.vaultId ? (
                        <>
                          <span className="text-xs text-vault-muted">{t('admin.confirm')}</span>
                          <button
                            onClick={() => handleDeleteConfirmed(v.vaultId)}
                            className="text-xs text-vault-danger hover:text-vault-danger-strong font-medium"
                          >
                            {t('admin.yes')}
                          </button>
                          <button
                            onClick={() => setPendingDelete(null)}
                            className="text-xs text-vault-subtle hover:text-vault-text-soft"
                          >
                            {t('admin.cancel')}
                          </button>
                        </>
                      ) : (
                        <button
                          onClick={() => setPendingDelete(v.vaultId)}
                          className="text-xs text-vault-danger hover:text-vault-danger-strong"
                        >
                          {t('admin.delete')}
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

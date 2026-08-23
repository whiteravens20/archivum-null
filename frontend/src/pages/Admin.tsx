import { useEffect, useState, useCallback } from 'react';
import { formatBytes } from '../crypto/encrypt.ts';

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

function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

export default function Admin() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [version, setVersion] = useState<VersionInfo | null>(null);
  const [vaults, setVaults] = useState<VaultMeta[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [auth, setAuth] = useState('');
  const [authenticated, setAuthenticated] = useState(false);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  // vaultId pending inline confirmation, null = none
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);

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
        setError('Authentication failed');
        return false;
      }

      if (statsRes.status === 403) {
        setError('Admin panel is disabled. Set ADMIN_PASSWORD in environment.');
        return true;
      }

      if (!statsRes.ok || !vaultsRes.ok) {
        const status = !statsRes.ok ? statsRes.status : vaultsRes.status;
        setError(`Backend unavailable (${status}). Is the backend container running?`);
        return true;
      }

      setStats(await statsRes.json());
      setVaults(await vaultsRes.json());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch');
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
      if (!ok) setAuthenticated(false);
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
        <h1 className="text-xl font-bold text-center mb-6 text-gray-100">Admin Panel</h1>
        <form onSubmit={handleLogin} className="space-y-4">
          <input
            type="text"
            placeholder="Username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            className="w-full bg-vault-secondary border border-gray-600 rounded px-3 py-2 text-sm text-gray-200 focus:outline-none focus:border-vault-accent"
          />
          <input
            type="password"
            placeholder="Password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="w-full bg-vault-secondary border border-gray-600 rounded px-3 py-2 text-sm text-gray-200 focus:outline-none focus:border-vault-accent"
          />
          <button
            type="submit"
            className="w-full py-2 bg-vault-accent text-vault-bg rounded font-medium hover:bg-vault-accent/90"
          >
            Login
          </button>
          {error && <p className="text-red-400 text-sm text-center">{error}</p>}
        </form>
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto px-4 py-8">
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-xl font-bold text-gray-100">Admin Panel</h1>
          <p className="text-xs text-gray-500">Operational monitoring</p>
        </div>
        <a href="/" className="text-sm text-vault-accent hover:underline">← Home</a>
      </div>

      {loading ? (
        <p className="text-gray-500 animate-pulse">Loading...</p>
      ) : error ? (
        <div className="bg-red-500/10 border border-red-500/30 rounded-lg p-4 text-red-400">
          {error}
        </div>
      ) : (
        <>
          {/* Update notice — only when a newer release actually exists */}
          {version?.updateAvailable && version.latest && (
            <div className="mb-6 rounded-lg border border-yellow-500/30 bg-yellow-500/10 p-4">
              <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
                <div>
                  <p className="text-sm font-medium text-yellow-300">
                    Update available — {version.latest}
                  </p>
                  <p className="text-xs text-gray-400 mt-0.5">
                    This instance runs {version.current}
                    {version.publishedAt &&
                      ` · released ${new Date(version.publishedAt).toLocaleDateString()}`}
                  </p>
                </div>
                <div className="flex items-center gap-3 whitespace-nowrap">
                  {version.compareUrl && (
                    <a
                      href={version.compareUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-xs font-medium text-yellow-300 hover:underline"
                    >
                      View changes →
                    </a>
                  )}
                  {version.releaseUrl && (
                    <a
                      href={version.releaseUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-xs text-gray-400 hover:text-gray-200 hover:underline"
                    >
                      Release notes
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
                <p className="text-[10px] uppercase tracking-widest text-gray-500 mb-1">Active Vaults</p>
                <p className="text-lg font-bold text-gray-200">{stats.activeVaults}</p>
              </div>

              {/* Storage card — shows quota bar when limit is set */}
              <div className="bg-vault-secondary/50 rounded-lg p-4 sm:col-span-1">
                <p className="text-[10px] uppercase tracking-widest text-gray-500 mb-1">Storage</p>
                {stats.storageQuotaBytes > 0 ? (() => {
                  const pct = Math.min(100, (stats.totalStorageBytes / stats.storageQuotaBytes) * 100);
                  const isNearFull = pct >= 90;
                  const isFull = pct >= 100;
                  return (
                    <>
                      <p className={`text-lg font-bold ${isFull ? 'text-red-400' : isNearFull ? 'text-yellow-400' : 'text-gray-200'}`}>
                        {formatBytes(stats.totalStorageBytes)}
                        <span className="text-xs font-normal text-gray-500 ml-1">/ {formatBytes(stats.storageQuotaBytes)}</span>
                      </p>
                      <div className="mt-2 h-1.5 rounded-full bg-vault-secondary overflow-hidden">
                        <div
                          className={`h-full rounded-full transition-all ${
                            isFull ? 'bg-red-500' : isNearFull ? 'bg-yellow-400' : 'bg-vault-accent'
                          }`}
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                      <p className="text-[10px] text-gray-500 mt-1">{pct.toFixed(1)}% used</p>
                    </>
                  );
                })() : (
                  <p className="text-lg font-bold text-gray-200">
                    {formatBytes(stats.totalStorageBytes)}
                    <span className="text-xs font-normal text-gray-500 ml-1">/ ∞</span>
                  </p>
                )}
              </div>

              <div className="bg-vault-secondary/50 rounded-lg p-4">
                <p className="text-[10px] uppercase tracking-widest text-gray-500 mb-1">Version</p>
                <p
                  className={`text-lg font-bold ${
                    version?.updateAvailable ? 'text-yellow-400' : 'text-gray-200'
                  }`}
                >
                  {version?.current ?? '—'}
                </p>
                <p className="text-[10px] text-gray-500 mt-1">
                  {version ? `● Online · up ${formatUptime(version.uptime)}` : '● Online'}
                </p>
                {version && !version.enabled && (
                  <p className="text-[10px] text-gray-600 mt-1">
                    Update check off — set <code>UPDATE_CHECK_ENABLED=true</code>
                  </p>
                )}
                {version?.enabled && version.updateAvailable === false && (
                  <p className="text-[10px] text-gray-500 mt-1">Up to date</p>
                )}
                {version?.enabled && version.error && (
                  <p className="text-[10px] text-gray-500 mt-1">{version.error}</p>
                )}
              </div>
            </div>
          )}

          {/* Vault list */}
          <div className="bg-vault-secondary/30 rounded-lg overflow-hidden">
            <div className="px-4 py-3 border-b border-vault-secondary text-xs text-gray-500 uppercase tracking-wider">
              Active Vaults ({vaults.length})
            </div>
            {vaults.length === 0 ? (
              <p className="p-6 text-sm text-gray-500 text-center">No active vaults</p>
            ) : (
              <div className="divide-y divide-vault-secondary/50">
                {vaults.map((v) => (
                  <div key={v.vaultId} className="px-4 py-3 flex items-center justify-between text-sm">
                    <div className="min-w-0 flex-1">
                      <div className="flex gap-3 items-baseline">
                        <span className="text-vault-accent font-mono text-xs truncate max-w-[200px]">
                          {v.vaultId}
                        </span>
                      </div>
                      <div className="text-xs text-gray-500 mt-0.5">
                        {formatBytes(v.ciphertextSize)} · {v.remainingDownloads}/{v.maxDownloads} DL ·
                        Expires {new Date(v.expiresAt).toLocaleString()}
                      </div>
                    </div>
                    <div className="ml-4 flex items-center gap-2 whitespace-nowrap">
                      {pendingDelete === v.vaultId ? (
                        <>
                          <span className="text-xs text-gray-400">Confirm?</span>
                          <button
                            onClick={() => handleDeleteConfirmed(v.vaultId)}
                            className="text-xs text-red-400 hover:text-red-300 font-medium"
                          >
                            Yes
                          </button>
                          <button
                            onClick={() => setPendingDelete(null)}
                            className="text-xs text-gray-500 hover:text-gray-300"
                          >
                            Cancel
                          </button>
                        </>
                      ) : (
                        <button
                          onClick={() => setPendingDelete(v.vaultId)}
                          className="text-xs text-red-400 hover:text-red-300"
                        >
                          Delete
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

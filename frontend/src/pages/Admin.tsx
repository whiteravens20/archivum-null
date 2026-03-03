import { useEffect, useState, useCallback } from 'react';
import { formatBytes } from '../crypto/encrypt.ts';

interface VaultMeta {
  vaultId: string;
  ciphertextSize: number;
  originalName: string;
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
}

export default function Admin() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [vaults, setVaults] = useState<VaultMeta[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [auth, setAuth] = useState('');
  const [authenticated, setAuthenticated] = useState(false);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');

  const authHeader = useCallback(
    () => ({ Authorization: `Basic ${auth}` }),
    [auth]
  );

  const fetchData = useCallback(async () => {
    try {
      const [statsRes, vaultsRes] = await Promise.all([
        fetch('/api/admin/stats', { headers: authHeader() }),
        fetch('/api/admin/vaults', { headers: authHeader() }),
      ]);

      if (statsRes.status === 401 || vaultsRes.status === 401) {
        setAuthenticated(false);
        setError('Authentication failed');
        return;
      }

      if (statsRes.status === 403) {
        setError('Admin panel is disabled. Set ADMIN_PASSWORD in environment.');
        return;
      }

      if (!statsRes.ok || !vaultsRes.ok) {
        const status = !statsRes.ok ? statsRes.status : vaultsRes.status;
        setError(`Backend unavailable (${status}). Is the backend container running?`);
        return;
      }

      setStats(await statsRes.json());
      setVaults(await vaultsRes.json());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch');
    } finally {
      setLoading(false);
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
    fetchData();
    const interval = setInterval(fetchData, 10_000);
    return () => clearInterval(interval);
  }, [authenticated, fetchData]);

  const handleDelete = async (vaultId: string) => {
    if (!confirm(`Delete vault ${vaultId}?`)) return;
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
          {/* Stats */}
          {stats && (
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-4 mb-8">
              {[
                { label: 'Active Vaults', value: stats.activeVaults },
                { label: 'Storage', value: `${stats.totalStorageMB} MB` },
                { label: 'Status', value: '● Online' },
              ].map((s) => (
                <div key={s.label} className="bg-vault-secondary/50 rounded-lg p-4">
                  <p className="text-[10px] uppercase tracking-widest text-gray-500 mb-1">{s.label}</p>
                  <p className="text-lg font-bold text-gray-200">{s.value}</p>
                </div>
              ))}
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
                        <span className="text-vault-accent font-mono text-xs truncate max-w-[120px]">
                          {v.vaultId}
                        </span>
                        <span className="text-gray-300 truncate">{v.originalName}</span>
                      </div>
                      <div className="text-xs text-gray-500 mt-0.5">
                        {formatBytes(v.ciphertextSize)} · {v.remainingDownloads}/{v.maxDownloads} DL ·
                        Expires {new Date(v.expiresAt).toLocaleString()}
                      </div>
                    </div>
                    <button
                      onClick={() => handleDelete(v.vaultId)}
                      className="ml-4 text-xs text-red-400 hover:text-red-300 whitespace-nowrap"
                    >
                      Delete
                    </button>
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

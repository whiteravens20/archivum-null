# Configuration Reference

All variables live in a single `.env` file at the project root. Copy `.env.example` to get started.

The README covers the variables you usually touch. This page is the complete reference.

## Backend

### Required

| Variable | Default | Description |
|---|---|---|
| `ADMIN_PASSWORD` | — | Admin panel password (**required**) |

### Network & binding

| Variable | Default | Description |
|---|---|---|
| `HOST_BIND_ADDRESS` | `127.0.0.1` | **Docker only** — host interface Docker publishes the port on; set to your tunnel/WireGuard IP in prod |
| `BIND_ADDRESS` | `0.0.0.0` | **Bare-metal only** — address Fastify binds to directly; Docker overrides this to `0.0.0.0` (container network namespace) |
| `PORT` | `3000` | Server port |
| `TRUST_PROXY` | `1` | Number of trusted reverse-proxy hops for `X-Forwarded-For` (1 = nearest proxy only). Valid range: 0–10. Setting this higher than the actual number of trusted hops allows clients to spoof their IP and bypass rate limiting. |

### Upload limits & vault policy

| Variable | Default | Description |
|---|---|---|
| `MAX_FILE_SIZE` | `104857600` | Max upload size in bytes (100 MB) — enforced by the backend |
| `DEFAULT_TTL` | `86400` | Default vault TTL in seconds (24 h). Must be ≤ `MAX_TTL`. |
| `MAX_TTL` | `604800` | Maximum vault TTL in seconds (7 d). Must be > 0. |
| `DEFAULT_MAX_DOWNLOADS` | `10` | Default max downloads per vault. Must be > 0. |
| `MAX_TOTAL_STORAGE` | `0` (unlimited) | Global storage quota in bytes — new uploads are rejected with HTTP 507 when total active vault storage exceeds this limit; `0` disables the check |
| `STORAGE_PATH` | `/data/vaults` | File storage path inside container |

### Chunked upload internals

| Variable | Default | Description |
|---|---|---|
| `CHUNK_SIZE` | `10485760` | Chunk size in bytes for the chunked upload protocol (default 10 MB) — each HTTP request stays below this limit, which lets uploads pass through Cloudflare's 100 MB per-request cap. Also used by the frontend as the threshold for switching to the chunked upload flow. Smaller chunks work better for homelab/Tailscale/VPS setups with limited bandwidth. |
| `CRYPTO_CHUNK_SIZE` | `5242880` | Crypto chunk size in bytes (default 5 MB) — each plaintext chunk is encrypted independently with AES-256-GCM using a unique IV and chunk index as AAD. Smaller values reduce peak memory; larger values reduce per-chunk overhead (28 bytes per chunk). |
| `UPLOAD_SESSION_TTL` | `3600` | How long an incomplete chunked upload session stays alive in seconds (default 60 min) — increased from 30 min to support 1 GB uploads on slow links (5 Mbps ≈ 26 min) |
| `MAX_UPLOAD_SESSIONS_PER_IP` | `10` | Max concurrent open chunked-upload sessions a single client IP may hold (`0` = unlimited, not recommended). Each open session reserves its declared size against `MAX_TOTAL_STORAGE`; without this cap a single IP could open many sessions and never complete them, tying up the storage quota and blocking legitimate uploads until the sessions expire. |

### Rate limiting

| Variable | Default | Description |
|---|---|---|
| `RATE_LIMIT_WINDOW` | `60` | Rate limit window in seconds |
| `RATE_LIMIT_MAX` | `10` | Max new-upload requests per window per IP — counts `POST /api/vault` and `POST /api/vault/upload/init` (chunked upload start); individual chunk/complete requests are not counted |
| `RATE_LIMIT_API_MAX` | `120` | Max general API requests per window per IP |
| `RATE_LIMIT_DOWNLOAD_MAX` | `30` | Max download requests per window per IP |

### Cloudflare Turnstile

| Variable | Default | Description |
|---|---|---|
| `TURNSTILE_SITE_KEY` | `0x0000000000000000000000` | Cloudflare Turnstile **public** site key — served to the browser at runtime via `GET /api/config`; never exposed as a secret |
| `TURNSTILE_SECRET` | — | Cloudflare Turnstile secret key |
| `TURNSTILE_HOSTNAME` | — | Expected hostname in Turnstile response (e.g. `example.com`); leave empty to skip |

### Admin

| Variable | Default | Description |
|---|---|---|
| `ADMIN_USER` | `admin` | Admin panel username |
| `ADMIN_PASSWORD` | — | Admin panel password (**required**, see above) |

### Version & update check

| Variable | Default | Description |
|---|---|---|
| `APP_VERSION` | — | Version reported in the admin panel. Stamped automatically into Docker images from the release tag; **bare-metal installs must set it themselves** or the panel reports `unknown` |
| `UPDATE_CHECK_ENABLED` | `false` | Compare the running version against the newest GitHub release and show a notice in the admin panel. **Opt-in** — see below |
| `UPDATE_CHECK_REPO` | `whiteravens20/archivum-null` | Repository to compare against; change it on a fork |
| `UPDATE_CHECK_INTERVAL` | `21600` (6 h) | Seconds between checks. Minimum `300`; failed checks retry after 15 min |

The running version is always shown in the admin panel and needs no network. Only
the *comparison* against GitHub does, and that is off by default: it is the one
outbound connection the app ever makes on its own, and
[HARDENING.md](HARDENING.md#egress-containment) tells you to block exactly that.

When enabled, the check:

- issues at most one unauthenticated `GET https://api.github.com/repos/<repo>/releases/latest` per interval;
- sends no token, no cookies, and no version in the `User-Agent` — GitHub sees the server's IP and nothing more;
- is served only from the authenticated `GET /api/admin/version`, never to end users;
- fails quietly if egress is blocked — the panel still reports the running version, with the reason beside it.

If you have applied egress containment, either allow `api.github.com` or leave this `false`.

**Bare-metal / systemd:** `APP_VERSION` is set by the Docker build, so a `node backend/dist/index.js`
install has to provide it in the unit's `EnvironmentFile`:

```ini
# /etc/archivum-null/archivum.env
APP_VERSION=v2.0.0
```

Everything else on this page — including the anti-fingerprinting behaviour described
in [HARDENING.md](HARDENING.md#version-disclosure) — is enforced inside the Node
process and applies identically to Docker and bare-metal.

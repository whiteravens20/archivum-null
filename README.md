# Archivum Null

**Zero trust file relay.**

Anonymous, zero-knowledge encrypted file sharing with expiring vaults. No accounts. No cookies. No tracking.

---

> [!WARNING]
> **Beta — not production-ready.**
> This project is under active testing. The architecture, API, and storage format may change without notice.
> A stable release and official Docker image will be published when the build is considered production-ready.
> Do not rely on it for sensitive data yet.

---

> [!NOTE]
> **This project was developed with AI assistance.**
>
> AI-generated code can contain subtle bugs, insecure patterns, or plausible-looking nonsense ("AI slop"). Here is what we do to keep the bar high — and what you should check when auditing:
>
> - **Tests are mandatory.** Every module has unit tests. `npm test` must pass with 0 failures across backend and frontend before any commit lands.
> - **ESLint enforces standards.** Both projects run `eslint --max-warnings 0`. No warnings are silently ignored.
> - **Architecture decisions are human-driven.** Crypto primitives (AES-256-GCM, key in URL fragment, no plaintext on server) were specified explicitly — not delegated to AI defaults.
> - **Security-critical code is read line by line.** `crypto/encrypt.ts`, `basicAuth.ts`, `storage/local.ts` (path traversal guard), and vault expiry logic were reviewed manually after generation.
> - **AI does not write the threat model.** See the *Threat Model Limitations* section below — those are our honest assessments, not AI boilerplate.
>
> If you find a slop pattern, a logical bug, or a security issue, please open an issue or see [SECURITY.md](SECURITY.md).

---

## Architecture

```
┌──────────────────────────────────────────────────────────┐
│  Browser (Client)                                        │
│                                                          │
│  1. Select file                                          │
│  2. Generate AES-256-GCM key (WebCrypto)                 │
│  3. Encrypt file client-side                             │
│  4. Upload ciphertext to server                          │
│  5. Receive vault URL: /vault/{id}#BASE64_KEY            │
│                                                          │
│  Key NEVER leaves the browser.                           │
│  URL fragment (#) is NOT sent in HTTP requests.          │
└──────────────┬───────────────────────────────────────────┘
               │ HTTPS (ciphertext only)
               ▼
┌──────────────────────────────────────────────────────────┐
│  Server                                                  │
│                                                          │
│  Stores only:                                            │
│  - vault_id                                              │
│  - ciphertext (encrypted blob)                           │
│  - created_at / expires_at                               │
│  - remaining_downloads                                   │
│                                                          │
│  NEVER stores:                                           │
│  - plaintext                                             │
│  - encryption keys                                       │
│  - user identity                                         │
│  - persistent IP logs                                    │
└──────────────────────────────────────────────────────────┘
```

## Quick Start

### Development

```bash
# Clone
git clone https://github.com/whiteravens20/archivum-null.git
cd archivum-null

# Copy env
cp .env.example .env

# Install dependencies
cd backend && npm install && cd ..
cd frontend && npm install && cd ..

# Start backend
cd backend && npm run dev &

# Start frontend
cd frontend && npm run dev
```

Or with Docker:

```bash
cp .env.example .env
docker compose -f docker-compose.dev.yml up --build
```

Frontend: `https://localhost:5173` (self-signed cert — accept the browser warning once)
Backend API: `http://localhost:3000`

### Production

```bash
cp .env.example .env
# Edit .env — set real values:
#   ADMIN_PASSWORD=<strong-password>
#   HOST_BIND_ADDRESS=<tunnel-ip>    # HOST interface Docker binds the port on
#   TURNSTILE_SECRET=<real-secret>

docker compose up -d --build
```

## Environment Variables

All variables live in a single `.env` file at the project root. Copy `.env.example` to get started.

Variables prefixed with `VITE_` are baked into the frontend bundle at build time by Vite. For every backend variable that controls a value also shown in the UI, there is an equivalent `VITE_` mirror — keep both values in sync.

### Backend

| Variable | Default | Description |
|---|---|---|
| `MAX_FILE_SIZE` | `104857600` | Max upload size in bytes (100 MB) — enforced by the backend |
| `TURNSTILE_SITE_KEY` | — | Cloudflare Turnstile site key (passed to backend via env) |
| `TURNSTILE_SECRET` | — | Cloudflare Turnstile secret key |
| `TURNSTILE_HOSTNAME` | — | Expected hostname in Turnstile response (e.g. `example.com`); leave empty to skip |
| `RATE_LIMIT_WINDOW` | `60` | Rate limit window in seconds |
| `RATE_LIMIT_MAX` | `10` | Max upload (`POST /api/vault`) requests per window per IP |
| `RATE_LIMIT_API_MAX` | `120` | Max general API requests per window per IP |
| `RATE_LIMIT_DOWNLOAD_MAX` | `30` | Max download requests per window per IP |
| `DEFAULT_TTL` | `86400` | Default vault TTL in seconds (24 h) |
| `MAX_TTL` | `604800` | Maximum vault TTL in seconds (7 d) |
| `DEFAULT_MAX_DOWNLOADS` | `10` | Default max downloads per vault |
| `ADMIN_USER` | `admin` | Admin panel username |
| `ADMIN_PASSWORD` | — | Admin panel password (**required**) |
| `STORAGE_PATH` | `/data/vaults` | File storage path inside container |
| `HOST_BIND_ADDRESS` | `127.0.0.1` | **Docker only** — host interface Docker publishes the port on; set to your tunnel/WireGuard IP in prod |
| `BIND_ADDRESS` | `0.0.0.0` | **Bare-metal only** — address Fastify binds to directly; Docker overrides this to `0.0.0.0` (container network namespace) |
| `PORT` | `3000` | Server port |
| `TRUST_PROXY` | `1` | Number of trusted reverse-proxy hops for `X-Forwarded-For` (1 = nearest proxy only) |

### Frontend (Vite build-time)

These mirror the backend values above. Change both when you change a setting.

| Variable | Default | Description |
|---|---|---|
| `VITE_TURNSTILE_SITE_KEY` | `0x000…` | Cloudflare Turnstile site key embedded in bundle |
| `VITE_MAX_FILE_SIZE` | `104857600` | Max upload size shown/enforced in the UI |
| `VITE_DEFAULT_TTL` | `86400` | Pre-selected TTL in the upload form |
| `VITE_DEFAULT_MAX_DOWNLOADS` | `10` | Pre-selected download limit in the upload form |

## Deployment Architecture

### Production Mode (Secure Homelab)

```
Internet
  → VPS running a reverse proxy (nginx, Caddy, …) with TLS termination
  → private tunnel (WireGuard, SSH tunnel, VPN overlay, …)
  → Archivum Null VM (tunnel interface IP only)
```

**Key requirements:**
- Docker port published ONLY on the tunnel interface IP (`HOST_BIND_ADDRESS=<tunnel-ip>` in `.env`)
- No LAN access
- Container runs as non-root with read-only filesystem
- All capabilities dropped

### Example Firewall Rules

> **Important:** use a _whitelist-first_ order. Tunnel interfaces often use private-range IPs (e.g. WireGuard at `10.8.0.1`) — if you DROP those subnets first, tunnel traffic is blocked before the ACCEPT rule is reached.

**iptables**
```bash
# 1. Accept traffic arriving on the tunnel interface (e.g. wg0, tun0)
iptables -A INPUT -i <tunnel-iface> -p tcp --dport 3000 -j ACCEPT

# 2. Drop everything else to the app port (covers LAN, WAN, etc.)
iptables -A INPUT -p tcp --dport 3000 -j DROP
```

**nftables** (modern default on Debian/Ubuntu/Fedora)
```bash
# Accept on tunnel interface, drop all other traffic to the port
nft add rule inet filter input tcp dport 3000 iifname "<tunnel-iface>" accept
nft add rule inet filter input tcp dport 3000 drop
```

### Example Reverse Proxy Config (nginx)

Any reverse proxy that supports `proxy_pass` and TLS termination works (nginx, Caddy, Traefik, HAProxy, …). The example below uses nginx.

```nginx
server {
    listen 443 ssl http2;
    server_name archivum.yourdomain.com;

    # TLS — managed by your reverse proxy / Let's Encrypt / acme.sh / etc.

    client_max_body_size 105m;  # Slightly above MAX_FILE_SIZE

    location / {
        proxy_pass http://<TUNNEL_IP>:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # Streaming support
        proxy_request_buffering off;
        proxy_buffering off;
    }
}
```

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | React, TypeScript, Vite, TailwindCSS |
| Backend | Fastify (Node.js), TypeScript |
| Encryption | WebCrypto API, AES-256-GCM |
| Storage | Local disk (abstracted) |
| Anti-abuse | Cloudflare Turnstile, in-memory rate limiting |
| Container | Docker, Alpine-based, multi-stage build |

## Admin Panel

Accessible at `/admin`. Protected by HTTP Basic Auth.

Capabilities:
- View active vault count, storage usage, and status
- List vault metadata (ID, size, timestamps, download counts)
- Force delete any vault
- Health check on API

**Does NOT expose:** encryption keys, plaintext, or uploader identity.

Set `ADMIN_PASSWORD` in `.env` to enable. For production, additionally protect behind a tunnel or a reverse proxy with IP allowlisting.

## Cloudflare Turnstile

To enable:
1. Create a Turnstile widget at [dash.cloudflare.com](https://dash.cloudflare.com)
2. Set `VITE_TURNSTILE_SITE_KEY` (and `TURNSTILE_SITE_KEY`) in `.env`
3. Set `TURNSTILE_SECRET` in `.env`

When secrets are default/missing, Turnstile verification is skipped.

## Security

See [SECURITY.md](SECURITY.md) for the full security checklist.

### Key Guarantees

- **Zero-knowledge:** Server cannot decrypt uploaded files
- **No identity:** No accounts, cookies, or tracking
- **Ephemeral:** Vaults auto-delete after TTL or download limit
- **No persistent IP logs:** Rate limiter uses in-memory only
- **Authenticated encryption:** AES-256-GCM provides confidentiality + integrity

### Threat Model Limitations

- Client device compromise exposes key (URL bar, memory)
- Link interception = file access (share via encrypted channels)
- Not designed to resist targeted state-level adversaries with client access

## Terms of Service

The TOS lives in [TOS.md](TOS.md) at the repository root. The backend serves it at `/api/tos` (plain text) and the frontend renders it as Markdown at the `/tos` route.

> ⚠️ Replace the placeholder TOS with a legally generated document appropriate for your jurisdiction before production deployment.

## License

See [LICENSE](LICENSE).

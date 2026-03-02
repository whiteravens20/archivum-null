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

Frontend: `http://localhost:5173`
Backend: `http://localhost:3000`

### Production

```bash
cp .env.example .env
# Edit .env — set real values:
#   ADMIN_PASSWORD=<strong-password>
#   BIND_ADDRESS=<tunnel-ip>        # IP of your tunnel/private interface
#   TURNSTILE_SECRET=<real-secret>

docker compose up -d --build
```

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `MAX_FILE_SIZE` | `104857600` | Max upload size in bytes (100 MB) |
| `TURNSTILE_SITE_KEY` | — | Cloudflare Turnstile site key |
| `TURNSTILE_SECRET` | — | Cloudflare Turnstile secret key |
| `RATE_LIMIT_WINDOW` | `60` | Rate limit window in seconds |
| `RATE_LIMIT_MAX` | `10` | Max requests per window per IP |
| `DEFAULT_TTL` | `86400` | Default vault TTL in seconds (24h) |
| `MAX_TTL` | `604800` | Maximum vault TTL in seconds (7d) |
| `DEFAULT_MAX_DOWNLOADS` | `10` | Default max downloads per vault |
| `ADMIN_USER` | `admin` | Admin panel username |
| `ADMIN_PASSWORD` | — | Admin panel password (**required**) |
| `STORAGE_PATH` | `/data/vaults` | File storage path |
| `BIND_ADDRESS` | `0.0.0.0` | Bind address (use private/tunnel IP in prod) |
| `PORT` | `3000` | Server port |

## Deployment Architecture

### Production Mode (Secure Homelab)

```
Internet
  → VPS running a reverse proxy (nginx, Caddy, …) with TLS termination
  → private tunnel (WireGuard, SSH tunnel, VPN overlay, …)
  → Archivum Null VM (tunnel interface IP only)
```

**Key requirements:**
- App binds ONLY to the tunnel interface IP (`BIND_ADDRESS=<tunnel-ip>`)
- No LAN access
- Container runs as non-root with read-only filesystem
- All capabilities dropped

### Example Firewall Rules (iptables)

```bash
# Drop all traffic from LAN subnets to the app port
iptables -A INPUT -s 192.168.0.0/16 -p tcp --dport 3000 -j DROP
iptables -A INPUT -s 10.0.0.0/8 -p tcp --dport 3000 -j DROP
iptables -A INPUT -s 172.16.0.0/12 -p tcp --dport 3000 -j DROP

# Allow only the tunnel interface (replace <tunnel-iface> with your actual interface, e.g. wg0, tun0)
iptables -A INPUT -i <tunnel-iface> -p tcp --dport 3000 -j ACCEPT

# Drop everything else to the app port
iptables -A INPUT -p tcp --dport 3000 -j DROP
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
- View total vault count, storage usage, active vaults
- List vault metadata (ID, size, timestamps, download counts)
- Force delete any vault
- Health check on API

**Does NOT expose:** encryption keys, plaintext, or uploader identity.

Set `ADMIN_PASSWORD` in `.env` to enable. For production, additionally protect behind a tunnel or a reverse proxy with IP allowlisting.

## Cloudflare Turnstile

To enable:
1. Create a Turnstile widget at [dash.cloudflare.com](https://dash.cloudflare.com)
2. Set `TURNSTILE_SITE_KEY` in the frontend (update `Home.tsx`)
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

See [TOS.md](TOS.md).

> ⚠️ Replace the placeholder TOS with a legally generated document appropriate for your jurisdiction before production deployment.

## License

See [LICENSE](LICENSE).

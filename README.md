<div align="center">
    <img src=frontend/public/logo-text-modern.svg width="85%">
<br \><br \>

# Archivum Null

**Zero trust file relay**

Anonymous, zero-knowledge encrypted file sharing with expiring vaults.

No accounts. No cookies. No tracking.

<br />

[![Tests](https://github.com/whiteravens20/archivum-null/actions/workflows/test.yml/badge.svg?branch=dev)](https://github.com/whiteravens20/archivum-null/actions/workflows/test.yml)
[![Snapshot build](https://github.com/whiteravens20/archivum-null/actions/workflows/docker-snapshot.yml/badge.svg?branch=dev)](https://github.com/whiteravens20/archivum-null/actions/workflows/docker-snapshot.yml)
[![Release](https://github.com/whiteravens20/archivum-null/actions/workflows/release.yml/badge.svg)](https://github.com/whiteravens20/archivum-null/actions/workflows/release.yml)
[![CodeQL](https://github.com/whiteravens20/archivum-null/actions/workflows/codeql.yml/badge.svg)](https://github.com/whiteravens20/archivum-null/actions/workflows/codeql.yml)
[![Security scan](https://github.com/whiteravens20/archivum-null/actions/workflows/security.yml/badge.svg)](https://github.com/whiteravens20/archivum-null/actions/workflows/security.yml)

<br />

![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?style=flat&logo=typescript&logoColor=white)
![Node.js](https://img.shields.io/badge/Node.js-5FA04E?style=flat&logo=nodedotjs&logoColor=white)
![React](https://img.shields.io/badge/React-61DAFB?style=flat&logo=react&logoColor=black)
![Vite](https://img.shields.io/badge/Vite-646CFF?style=flat&logo=vite&logoColor=white)
![Fastify](https://img.shields.io/badge/Fastify-00B386?style=flat&logo=fastify&logoColor=white)
![Vitest](https://img.shields.io/badge/Vitest-6E9F18?style=flat&logo=vitest&logoColor=white)

</div>

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

## Prerequisites

**You can run this project with Node.js only — no Docker, no VPS, no tunnel required.**
The table below lists the only hard requirement and optional conveniences.

### Required (always)

| Requirement | Notes |
|---|---|
| Node.js 24+ | Both backend and frontend; declared in each `package.json` |

### Optional — containerised setup

| Option | Notes |
|---|---|
| Docker 24+ & Docker Compose | Convenient wrapper around Node — not required; use if you prefer containers or want the production image |

### Recommended for public / production deployment

| Recommendation | Why it matters if skipped |
|---|---|
| Domain name pointed at a public IP | Without one, the service is reachable only on a local network or raw IP — fine for personal/homelab use |
| VPS running a reverse proxy (nginx, Caddy, …) | Without TLS termination, traffic is unencrypted in transit; the browser will block WebCrypto on non-HTTPS origins (see [Troubleshooting](#troubleshooting)) |
| Private tunnel (WireGuard, SSH, VPN overlay) | Without a tunnel, port 3000 must be exposed directly to the internet — significantly higher attack surface |
| Cloudflare Turnstile | Without it, upload abuse protection relies on rate limiting alone; Turnstile verification is automatically skipped when keys are not set |

> **Quickest local start:** `cd backend && npm install && npm run dev` in one terminal, `cd frontend && npm install && npm run dev` in another. Open `https://localhost:5173` (accept the self-signed cert once — required for WebCrypto).

## Architecture

```
┌──────────────────────────────────────────────────────────┐
│  Browser (Client)                                        │
│                                                          │
│  1. Select file                                          │
│  2. Generate AES-256-GCM key (WebCrypto)                 │
│  3. Encrypt file client-side (streaming per-chunk)       │
│     Plaintext split into 5 MB chunks, each encrypted     │
│     independently: AES-256-GCM with unique IV + AAD      │
│     (chunk index prevents reordering attacks)            │
│  4. Upload ciphertext to server                          │
│  5. Receive vault URL:                                   │
│       /vault/{id}#BASE64_KEY.BASE64_FILENAME             │
│                                                          │
│  Key and filename NEVER leave the browser via HTTP.      │
│  URL fragment (#) is NOT included in HTTP requests.      │
└──────────────────────────────────────────────────────────┘
               │ HTTPS (encrypted blob + vault config only)
               ▼
┌──────────────────────────────────────────────────────────┐
│  Server                                                  │
│                                                          │
│  Stores only:                                            │
│  - vault_id                                              │
│  - ciphertext (encrypted blob — filename/MIME inside)    │
│  - created_at / expires_at                               │
│  - remaining_downloads / max_downloads                   │
│                                                          │
│  NEVER stores:                                           │
│  - plaintext                                             │
│  - encryption keys                                       │
│  - original filename or MIME type (encrypted in blob)    │
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

> **First-time deploy checklist** — complete in order.

**1. Provision the VPS.** Install nginx or Caddy. Open ports 80 and 443 only. Keep port 3000 closed (see [VPS Hardening](docs/HARDENING.md#vps-hardening)).

**2. Set up a private tunnel.** WireGuard is recommended — see [WireGuard — Prevent Lateral LAN Movement](docs/HARDENING.md#wireguard--prevent-lateral-lan-movement). Note the tunnel IP assigned to your homelab machine (e.g. `10.8.0.2`).

**3. Configure DNS.** Point your domain `A` record to the VPS public IP.

**4. Clone the repo** on the homelab host.

```bash
git clone https://github.com/whiteravens20/archivum-null.git
cd archivum-null
cp .env.example .env
```

**5. Edit `.env`.** Minimum required changes:

```bash
ADMIN_PASSWORD=<a-strong-random-password>   # required — panel locked without this
HOST_BIND_ADDRESS=<tunnel-ip>              # e.g. 10.8.0.2 — your homelab WireGuard IP
# Uncomment and fill in if using Cloudflare Turnstile:
# TURNSTILE_SECRET=<your-cf-secret>
# TURNSTILE_SITE_KEY=<your-cf-site-key>
```

**6. Start** the production container (pull prebuilt image — no local build needed).

```bash
docker compose pull && docker compose up -d
```

> To build locally from source instead: `docker compose up -d --build`

**7. Configure the reverse proxy** on the VPS — copy the config for your proxy from [Reverse Proxy Configuration](docs/HARDENING.md#reverse-proxy-configuration). Replace `<TUNNEL_IP>` with your homelab tunnel IP.

**8. Validate the deployment posture** on the homelab host.

```bash
./scripts/check-deployment.sh --tunnel-iface wg0
```

All checks should pass before exposing the service publicly.

## Environment Variables

All variables live in a single `.env` file at the project root. Copy `.env.example` to get started.

### Backend

| Variable | Default | Description |
|---|---|---|
| `MAX_FILE_SIZE` | `104857600` | Max upload size in bytes (100 MB) — enforced by the backend |
| `TURNSTILE_SITE_KEY` | `0x0000000000000000000000` | Cloudflare Turnstile **public** site key — served to the browser at runtime via `GET /api/config`; never exposed as a secret |
| `TURNSTILE_SECRET` | — | Cloudflare Turnstile secret key |
| `TURNSTILE_HOSTNAME` | — | Expected hostname in Turnstile response (e.g. `example.com`); leave empty to skip |
| `RATE_LIMIT_WINDOW` | `60` | Rate limit window in seconds |
| `RATE_LIMIT_MAX` | `10` | Max new-upload requests per window per IP — counts `POST /api/vault` and `POST /api/vault/upload/init` (chunked upload start); individual chunk/complete requests are not counted |
| `RATE_LIMIT_API_MAX` | `120` | Max general API requests per window per IP |
| `RATE_LIMIT_DOWNLOAD_MAX` | `30` | Max download requests per window per IP |
| `DEFAULT_TTL` | `86400` | Default vault TTL in seconds (24 h). Must be ≤ `MAX_TTL`. |
| `MAX_TTL` | `604800` | Maximum vault TTL in seconds (7 d). Must be > 0. |
| `DEFAULT_MAX_DOWNLOADS` | `10` | Default max downloads per vault. Must be > 0. |
| `MAX_TOTAL_STORAGE` | `0` (unlimited) | Global storage quota in bytes — new uploads are rejected with HTTP 507 when total active vault storage exceeds this limit; `0` disables the check |
| `ADMIN_USER` | `admin` | Admin panel username |
| `ADMIN_PASSWORD` | — | Admin panel password (**required**) |
| `STORAGE_PATH` | `/data/vaults` | File storage path inside container |
| `CHUNK_SIZE` | `10485760` | Chunk size in bytes for the chunked upload protocol (default 10 MB) — each HTTP request stays below this limit, which lets uploads pass through Cloudflare's 100 MB per-request cap. Also used by the frontend as the threshold for switching to the chunked upload flow. Smaller chunks work better for homelab/Tailscale/VPS setups with limited bandwidth. |
| `CRYPTO_CHUNK_SIZE` | `5242880` | Crypto chunk size in bytes (default 5 MB) — each plaintext chunk is encrypted independently with AES-256-GCM using a unique IV and chunk index as AAD. Smaller values reduce peak memory; larger values reduce per-chunk overhead (28 bytes per chunk). |
| `UPLOAD_SESSION_TTL` | `3600` | How long an incomplete chunked upload session stays alive in seconds (default 60 min) — increased from 30 min to support 1 GB uploads on slow links (5 Mbps ≈ 26 min) |
| `HOST_BIND_ADDRESS` | `127.0.0.1` | **Docker only** — host interface Docker publishes the port on; set to your tunnel/WireGuard IP in prod |
| `BIND_ADDRESS` | `0.0.0.0` | **Bare-metal only** — address Fastify binds to directly; Docker overrides this to `0.0.0.0` (container network namespace) |
| `PORT` | `3000` | Server port |
| `TRUST_PROXY` | `1` | Number of trusted reverse-proxy hops for `X-Forwarded-For` (1 = nearest proxy only) |

## Deployment Architecture

### Production Mode (Secure Homelab)

```
Internet
  → VPS running a reverse proxy (nginx, Caddy, …) with TLS termination
  → private tunnel (WireGuard, SSH tunnel, VPN overlay, …)
  → Archivum Null VM / homelab host (tunnel interface IP only)
```

**Key requirements:**
- Docker port published **only** on the tunnel interface IP (`HOST_BIND_ADDRESS=<tunnel-ip>` in `.env`)
- No direct LAN access to port 3000
- Container runs as non-root with read-only filesystem and all capabilities dropped
- VPS exposes only ports 80 and 443 — port 3000 is never public

For the full hardening guide — inbound firewall rules, reverse proxy config (nginx/Caddy), VPS lockdown, WireGuard scope, and egress containment — see **[docs/HARDENING.md](docs/HARDENING.md)**.

To apply firewall rules without copying commands manually:

```bash
sudo bash scripts/setup-firewall.sh
```

### Proxmox LXC Deployment

Running Archivum Null as a Proxmox LXC container is a lightweight alternative to a full VM. No Docker is needed — Node.js runs directly inside the LXC.

For full instructions covering container creation, manual installation, the Community Scripts quick installer, systemd service hardening, Proxmox Firewall egress rules, and SDN/VLAN isolation, see **[docs/PROXMOX.md](docs/PROXMOX.md)**.

**Quick start (Proxmox host shell):**

```bash
bash -c "$(wget -qLO - https://github.com/whiteravens20/archivum-null/raw/main/scripts/install-lxc.sh)"
```

**Update existing LXC:**

```bash
bash -c "$(wget -qLO - https://github.com/whiteravens20/archivum-null/raw/main/scripts/install-lxc.sh)" -- --update <vmid>
```

### Deployment Validation

After bringing up the production container on the homelab host, run the included validation script:

```bash
./scripts/check-deployment.sh --tunnel-iface wg0
```

It checks:
- Container is running and healthy
- Port 3000 is **not** bound to `0.0.0.0`
- Container is running as non-root
- `cap_drop: ALL` and `no-new-privileges` are active
- Root filesystem is read-only
- Tunnel interface is up and its IP matches `HOST_BIND_ADDRESS`
- Firewall rules exist for the app port
- Port 3000 is **not** reachable via the LAN interface
- `docker.sock` is not mounted inside the container

## Docker Images

Images are published to `ghcr.io/whiteravens20/archivum-null`.

| Tag | Source | Stable | Purpose |
|---|---|---|---|
| `:1.2.3` / `:1.2` / `:1` | Tagged release from `main` | ✅ Yes | Production — pin to an exact version |
| `:main` | Tagged release from `main` | ✅ Yes | Production — always the most recent stable release |
| `:edge` | Every push to `main` | ⚠️ No | Snapshot — preview of next release, not production-ready |
| `:dev` | Every push to `dev` | ❌ No | Snapshot — development builds, may be broken |
| `:edge-<sha>` / `:dev-<sha>` | Specific commit | — | Pin to a known-good snapshot |

> **Only `:main` and versioned tags (`:1.2.3`) are production-ready builds.** They are published exclusively by the release workflow on a semver tag push from `main`.
> `:latest` is intentionally **not published** — it is ambiguous by Docker convention (simply the last image built, not necessarily stable).
> `:edge` and `:dev` are CI snapshot builds — do not use them for any internet-facing deployment.

## Upgrading

**From a registry image (recommended for CD deploys):**
```bash
# Pin to a specific version by setting IMAGE_TAG=1.2.3 in .env first,
# then pull and restart:
docker compose pull
docker compose up -d
docker image prune -f
```

**From source (local build):**
```bash
git pull
docker compose up -d --build
```

The `vault-data` volume is preserved across both modes. Check the release notes for breaking changes before upgrading.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Port 3000 still bound to `0.0.0.0` | `HOST_BIND_ADDRESS` not set in `.env` | Set `HOST_BIND_ADDRESS=<tunnel-ip>` and `docker compose up -d` |
| Health check failing | `PORT` mismatch between app and health check | Ensure `PORT` in `.env` matches `HEALTHCHECK` in `Dockerfile` (default: `3000`) |
| Admin panel returns 403 | `ADMIN_PASSWORD` empty or not set | Set `ADMIN_PASSWORD` in `.env` and restart |
| Uploads fail with 413 | `client_max_body_size` too small on reverse proxy | Set to `105m` (slightly above `MAX_FILE_SIZE`) — see nginx/Caddy config examples |
| Turnstile always fails | Site key / secret key mismatch | Ensure `TURNSTILE_SITE_KEY` matches the Cloudflare dashboard and both `TURNSTILE_SECRET` and `TURNSTILE_SITE_KEY` are set |
| Files not persisted after restart | Volume not mounted | Check `vault-data` volume exists: `docker volume ls` |
| Permission denied writing to `/data/vaults` | Bind mount used instead of named volume, wrong ownership on host | Named volumes handle ownership automatically. If using a bind mount, the host directory must be owned by UID `1001`: `sudo chown 1001:1001 /your/path` |
| `crypto.subtle is undefined` in browser | Page served over plain HTTP | WebCrypto requires a secure context (HTTPS or `localhost`). In dev, use `https://localhost:5173` |

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
2. Set `TURNSTILE_SITE_KEY` in `.env`
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

### What the Server Knows vs. Cannot Know

| The server stores | The server **cannot** know |
|---|---|
| Encrypted ciphertext | Plaintext content |
| Vault ID (random) | Encryption key (never sent) |
| File size (encrypted blob size) | Original filename (stored encrypted) |
| MIME type (stored encrypted) | Original MIME type |
| Created / expires timestamps | Uploader identity (no accounts) |
| Download count | Persistent IP address (in-memory only) |

This is the zero-knowledge guarantee: **a server compromise exposes only encrypted blobs, not plaintext.** The decryption key exists only in the vault URL fragment (`#`), which browsers do not include in HTTP requests.

### Threat Model — What We Protect Against

| Threat | Protection |
|---|---|
| Passive network observer | TLS in transit; ciphertext at rest — observer sees encrypted bytes only |
| Legal demand / server seizure | Only ciphertext + metadata available; operator cannot decrypt |
| Enumeration / brute-force | Vault IDs are 21-character nanoid (128+ bits of entropy) |
| Abuse / spam | Turnstile CAPTCHA + 3-tier rate limiting per IP |
| Large file DoS | Streaming size enforcement — no full file held in memory |
| Admin credential theft | Timing-safe comparison; Basic Auth over TLS |
| Compromised container initiating outbound LAN/WAN connections | Docker `internal` network or host FORWARD egress rules block container-to-LAN and container-to-internet traffic; see [Egress Containment](docs/HARDENING.md#egress-containment) |

### Threat Model Limitations

| Threat | Why we don't mitigate it |
|---|---|
| Compromised client device | Key is in browser memory and visible in the URL bar/history |
| Malicious browser extension | Extensions can read page content and URL fragments |
| Link interception | Anyone with the vault URL can decrypt — share via encrypted channels |
| Compromised server serving modified JS | A compromised server could serve a client that exfiltrates the key |
| Targeted state-level adversary with client access | Outside scope — use dedicated offline encryption tools |
| DDoS at scale | Rate limiting covers casual abuse; use Cloudflare or a CDN for sustained attacks |

## Terms of Service

The TOS lives in [TOS.md](TOS.md) at the repository root. The backend serves it at `/api/tos` (plain text) and the frontend renders it as Markdown at the `/tos` route.

> **Legal notice:** The included TOS is a placeholder template and does not constitute legal advice. Consult a qualified lawyer before deploying a public service.

## Zero-Knowledge Disclaimer

Archivum Null is a **zero-knowledge relay** — the following is built into the architecture:

- The server **never receives** the encryption key. The key exists only in the vault URL fragment (`#KEY`), which browsers exclude from HTTP requests.
- The server **stores only ciphertext**. Even with full server access, an attacker or the operator cannot read the file contents.
- The operator **cannot comply** with a request to reveal file contents. They can provide only: encrypted ciphertext, vault metadata (size, timestamps), and download counts.

> This guarantee holds **only** when the client device and browser are not compromised, and only when the vault URL is shared securely. See [Threat Model Limitations](#threat-model-limitations) above.

## Operator Pre-Launch Checklist

Before exposing this service publicly:

- [ ] Replace [TOS.md](TOS.md) with a legally reviewed document for your jurisdiction
- [ ] Add your contact information to TOS.md (`Replace with your contact information`)
- [ ] Set a strong `ADMIN_PASSWORD` — never leave it as the default
- [ ] Set `HOST_BIND_ADDRESS` to your tunnel IP — never expose port 3000 publicly
- [ ] Apply egress containment rules — Option A (`internal: true`) if Turnstile is off, Option B (FORWARD rules) if Turnstile is on (see [Egress Containment](#egress-containment--blocking-outbound-from-a-compromised-container))
- [ ] Run `./scripts/check-deployment.sh` and confirm all checks pass
- [ ] Review the [Threat Model Limitations](#threat-model-limitations) and confirm they are acceptable for your use case

## Contributing

Contributions are welcome! Please read [CONTRIBUTING.md](CONTRIBUTING.md) for coding guidelines, testing requirements, and the secure contributing checklist before opening a pull request.

## Code of Conduct

This project follows the [Contributor Covenant](CODE_OF_CONDUCT.md). By participating, you are expected to uphold this code.

## License

See [LICENSE](LICENSE) and [ATTRIBUTION](ATTRIBUTION.md).

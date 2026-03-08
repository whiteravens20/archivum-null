<div align="center">
    <img src=frontend/public/logo-text-modern.svg width="85%">
<br \><br \>

# Archivum Null

**Zero trust file relay**

Anonymous, zero-knowledge encrypted file sharing with expiring vaults.

No accounts. No cookies. No tracking.
</div>

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
│  3. Encrypt file client-side                             │
│     Payload: [filename][MIME type][file bytes] → AES-GCM │
│  4. Upload ciphertext to server                          │
│  5. Receive vault URL:                                   │
│       /vault/{id}#BASE64_KEY.BASE64_FILENAME             │
│                                                          │
│  Key and filename NEVER leave the browser via HTTP.      │
│  URL fragment (#) is NOT included in HTTP requests.      │
└──────────────┬───────────────────────────────────────────┘
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

**1. Provision the VPS.** Install nginx or Caddy. Open ports 80 and 443 only. Keep port 3000 closed (see [VPS Hardening](#vps-hardening)).

**2. Set up a private tunnel.** WireGuard is recommended — see [WireGuard — Prevent Lateral LAN Movement](#wireguard--prevent-lateral-lan-movement). Note the tunnel IP assigned to your homelab machine (e.g. `10.8.0.2`).

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
# VITE_TURNSTILE_SITE_KEY=<your-cf-site-key>
```

**6. Build and start** the production container.

```bash
docker compose up -d --build
```

**7. Configure the reverse proxy** on the VPS — copy the config for your proxy from [Reverse Proxy Configuration](#reverse-proxy-configuration). Replace `<TUNNEL_IP>` with your homelab tunnel IP.

**8. Validate the deployment posture** on the homelab host.

```bash
./scripts/check-deployment.sh --tunnel-iface wg0
```

All checks should pass before exposing the service publicly.

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
| `DEFAULT_TTL` | `86400` | Default vault TTL in seconds (24 h). Must be ≤ `MAX_TTL`. |
| `MAX_TTL` | `604800` | Maximum vault TTL in seconds (7 d). Must be > 0. |
| `DEFAULT_MAX_DOWNLOADS` | `10` | Default max downloads per vault. Must be > 0. |
| `MAX_TOTAL_STORAGE` | `0` (unlimited) | Global storage quota in bytes — new uploads are rejected with HTTP 507 when total active vault storage exceeds this limit; `0` disables the check |
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
| `VITE_DEFAULT_TTL` | `86400` | Pre-selected TTL in the upload form. Must be one of: `300`, `1800`, `3600`, `21600`, `86400`, `259200`, `604800`. Other values are silently snapped to the nearest option. |
| `VITE_DEFAULT_MAX_DOWNLOADS` | `10` | Pre-selected download limit in the upload form. Must be one of: `1`, `3`, `5`, `10`, `25`, `50`, `100`. Other values are silently snapped to the nearest option. |

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

### Reverse Proxy Configuration

Any reverse proxy with TLS termination and `proxy_pass`/`reverse_proxy` support works (nginx, Caddy, Traefik, HAProxy, …).

> Replace `<TUNNEL_IP>` with the IP of your homelab tunnel interface as seen from the VPS.

#### nginx
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

#### Caddy (recommended — automatic TLS via Let's Encrypt)
```caddyfile
archivum.yourdomain.com {
    # Caddy handles TLS automatically — no certificate config needed

    request_body max 105MB

    reverse_proxy <TUNNEL_IP>:3000 {
        header_up Host {host}
        header_up X-Real-IP {remote_host}
        header_up X-Forwarded-For {remote_host}
        header_up X-Forwarded-Proto {scheme}

        # Streaming support — disable request buffering
        flush_interval -1
    }
}
```

### VPS Hardening

The VPS runs only the reverse proxy. Port 3000 must **not** be reachable from the public internet — only 80 (HTTP→HTTPS redirect) and 443 (HTTPS).

**UFW (Ubuntu/Debian)**
```bash
ufw default deny incoming
ufw allow 22/tcp    # SSH — restrict to your admin IP if possible
ufw allow 80/tcp    # HTTP (Let's Encrypt challenge / redirect)
ufw allow 443/tcp   # HTTPS
# Port 3000 is intentionally absent — must never be public
ufw enable
```

**nftables**
```bash
nft add rule inet filter input tcp dport { 22, 80, 443 } accept
nft add rule inet filter input drop
```

### WireGuard — Prevent Lateral LAN Movement

Scope `AllowedIPs` on each WireGuard peer to only the tunnel interface address. **Do not** use `0.0.0.0/0` on the homelab peer unless you intend to route all traffic through the tunnel.

```ini
# /etc/wireguard/wg0.conf  (on the VPS)
[Peer]
PublicKey = <homelab-peer-pubkey>
# Restrict to tunnel interface IP only — prevents accidental LAN routing
AllowedIPs = <homelab-tunnel-ip>/32   # e.g. 10.8.0.2/32
```

With a `/32` `AllowedIPs`, even if the container is misconfigured, WireGuard will only route packets destined for the tunnel IP — LAN subnets remain unreachable from the VPS.

### Egress Containment — Blocking Outbound from a Compromised Container

**Threat:** The inbound rules above prevent unauthorized access *to* the container. A separate concern is what happens if an attacker gains code execution *inside* the container (e.g., via a vulnerability in Node.js, Fastify, or a malformed uploaded blob). Without egress controls, the compromised container can freely initiate outbound connections — scanning your internal LAN, pivoting to other hosts, or beaconing to a C2 server on the internet.

The rules below cut off that escape path.

#### Option A — Docker `internal` network (recommended when Turnstile is not enabled)

If Cloudflare Turnstile is **not** used, the container requires zero outbound internet access. Set the Docker network to `internal: true` in `docker-compose.yml`:

```yaml
# docker-compose.yml — networks block at the bottom of the file
networks:
  archivum:
    driver: bridge
    internal: true          # container cannot initiate any outbound connections
    driver_opts:
      com.docker.network.bridge.name: br-archivum   # stable name for iptables rules
```

With `internal: true`, Docker removes the default gateway from the container's network namespace. The container can **still receive** traffic via the `ports:` mapping on the host, but it cannot initiate any TCP/UDP connections outward — to the LAN or to the internet.

> **If Turnstile is enabled,** the backend must reach `https://challenges.cloudflare.com` to verify tokens. Use Option B instead.

#### Option B — Host firewall FORWARD rules (required when Turnstile is enabled)

When the container needs selective internet access, restrict the container's bridge interface using FORWARD chain rules on the homelab host.

**Step 1 — pin the bridge name** (prevents rules from breaking after `docker compose down && up`). Add `driver_opts` to the networks block in `docker-compose.yml`:

```yaml
networks:
  archivum:
    driver: bridge
    driver_opts:
      com.docker.network.bridge.name: br-archivum
```

Then rebuild the network once:

```bash
docker compose down && docker compose up -d
```

**Step 2 — add FORWARD egress rules on the host:**

> **Important:** rules are applied top-to-bottom. Put ACCEPT rules before DROP rules.

**iptables**
```bash
BRIDGE=br-archivum

# Allow return traffic for already-established inbound connections
iptables -I FORWARD -i $BRIDGE -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT

# Always block container → RFC 1918 LAN and link-local
iptables -I FORWARD -i $BRIDGE -d 10.0.0.0/8     -j DROP
iptables -I FORWARD -i $BRIDGE -d 172.16.0.0/12  -j DROP
iptables -I FORWARD -i $BRIDGE -d 192.168.0.0/16 -j DROP
iptables -I FORWARD -i $BRIDGE -d 169.254.0.0/16 -j DROP

# --- If Turnstile IS enabled: allow only Cloudflare challenge endpoints ---
# Cloudflare IPv4 ranges used by challenges.cloudflare.com
iptables -I FORWARD -i $BRIDGE -d 104.16.0.0/13  -p tcp --dport 443 -j ACCEPT
iptables -I FORWARD -i $BRIDGE -d 104.24.0.0/14  -p tcp --dport 443 -j ACCEPT

# Drop everything else outbound from the container
iptables -A FORWARD -i $BRIDGE -j DROP

# --- If Turnstile IS NOT enabled: skip the two ACCEPT lines above ---
# and simply add the final DROP rule:
# iptables -A FORWARD -i $BRIDGE -j DROP
```

**nftables** (modern default on Debian/Ubuntu/Fedora)
```bash
BRIDGE=br-archivum

# Allow established/related return traffic
nft add rule inet filter forward iifname "$BRIDGE" ct state established,related accept

# Block container → RFC 1918 / link-local (always)
nft add rule inet filter forward iifname "$BRIDGE" \
    ip daddr { 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 169.254.0.0/16 } drop

# If Turnstile IS enabled — allow Cloudflare, then drop everything else
nft add rule inet filter forward iifname "$BRIDGE" \
    ip daddr { 104.16.0.0/13, 104.24.0.0/14 } tcp dport 443 accept
nft add rule inet filter forward iifname "$BRIDGE" drop

# If Turnstile IS NOT enabled — only the final drop rule is needed:
# nft add rule inet filter forward iifname "$BRIDGE" drop
```

> **Make rules persistent.** On Debian/Ubuntu use `iptables-persistent` (`apt install iptables-persistent && netfilter-persistent save`). For nftables, save to `/etc/nftables.conf` and ensure the `nftables` systemd service is enabled.

#### Option C — Bare-metal (no Docker)

When running Node.js directly on the host, use the OUTPUT chain with owner matching to restrict the process by UID:

```bash
# Find the UID the backend process runs as
id archivum-null        # if a dedicated system user exists
# or: ps -eo uid,cmd | grep 'node.*index'

APP_UID=<uid>

# Block app process → RFC 1918 LAN / link-local
iptables -I OUTPUT -m owner --uid-owner $APP_UID -d 10.0.0.0/8     -j DROP
iptables -I OUTPUT -m owner --uid-owner $APP_UID -d 172.16.0.0/12  -j DROP
iptables -I OUTPUT -m owner --uid-owner $APP_UID -d 192.168.0.0/16 -j DROP
iptables -I OUTPUT -m owner --uid-owner $APP_UID -d 169.254.0.0/16 -j DROP

# If Turnstile IS enabled — allow Cloudflare only
iptables -I OUTPUT -m owner --uid-owner $APP_UID -d 104.16.0.0/13 -p tcp --dport 443 -j ACCEPT
iptables -I OUTPUT -m owner --uid-owner $APP_UID -d 104.24.0.0/14 -p tcp --dport 443 -j ACCEPT

# Drop all remaining outbound from the app UID
iptables -A OUTPUT -m owner --uid-owner $APP_UID -j DROP
```

#### Summary — which option to apply

| Deployment | Turnstile disabled | Turnstile enabled |
|---|---|---|
| Docker | Option A (`internal: true`) | Option B (FORWARD rules, Cloudflare ACCEPT) |
| Bare-metal / Proxmox LXC | Option C (OUTPUT DROP all) | Option C (OUTPUT with Cloudflare ACCEPT) |
| Proxmox LXC (Proxmox Firewall) | Proxmox Firewall `policy_out: DROP` | Proxmox Firewall `policy_out: DROP` + Cloudflare ACCEPT rule |

> **Quick setup:** instead of applying rules manually, use the included helper script — it is interactive and supports all three modes:
>
> ```bash
> sudo bash scripts/setup-firewall.sh
> ```
>
> Or non-interactively (example — Docker with Turnstile, nftables):
>
> ```bash
> sudo bash scripts/setup-firewall.sh \
>   --mode docker --backend nftables --turnstile yes \
>   --bridge br-archivum --tunnel-iface wg0 --app-port 3000 --persist
> ```

### Proxmox LXC Deployment

Running Archivum Null as a Proxmox LXC container is a lightweight alternative to a full VM. No Docker is needed — Node.js runs directly inside the LXC.

For full instructions covering container creation, manual installation, the Community Scripts quick installer, systemd service hardening, Proxmox Firewall egress rules, and SDN/VLAN isolation, see **[PROXMOX.md](PROXMOX.md)**.

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
| Turnstile always fails | Site key / secret key mismatch | Ensure `TURNSTILE_SITE_KEY` = `VITE_TURNSTILE_SITE_KEY` and both match the Cloudflare dashboard |
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
| Compromised container initiating outbound LAN/WAN connections | Docker `internal` network or host FORWARD egress rules block container-to-LAN and container-to-internet traffic; see [Egress Containment](#egress-containment--blocking-outbound-from-a-compromised-container) |

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

# Security Checklist — Archivum Null

## Cryptography

- [x] AES-256-GCM (authenticated encryption)
- [x] 256-bit key from `crypto.getRandomValues()`
- [x] Unique IV (96-bit) per encryption
- [x] WebCrypto API (hardware-accelerated, constant-time)
- [x] Key stored exclusively in URL fragment (`#`) — never sent to server
- [x] Server receives only ciphertext — zero-knowledge

## Server-Side Security

- [x] No plaintext storage
- [x] No encryption key storage
- [x] No user identity storage
- [x] No cookies
- [x] No analytics / tracking
- [x] No persistent IP logging (in-memory rate limit only)
- [x] Streaming file upload — no full-file memory buffering
- [x] Path traversal protection on vault IDs
- [x] File size enforced at frontend, backend, and proxy levels:
  - Frontend: `file.size > MAX_FILE_SIZE` check before encryption
  - Backend multipart: `@fastify/multipart` stream truncation + explicit `truncated` check → 413
  - Backend streaming: transform stream aborts early in `writeFile` → no full oversized write to disk
  - Reverse proxy: `client_max_body_size` (documented in README)
- [x] Timing-safe comparison for admin credentials
- [x] Security headers: HSTS, CSP, X-Content-Type-Options, X-Frame-Options, Referrer-Policy

## Anti-Abuse

- [x] Cloudflare Turnstile integration (optional)
- [x] Turnstile hostname validation — token reuse from a different site rejected (`TURNSTILE_HOSTNAME`)
- [x] Three-tier in-memory per-IP rate limiting:
  - General API tier: all `/api/` routes (default 120 req/window) — guards file I/O endpoints like `/api/tos`
  - Upload tier: `POST /api/vault` (default 10 req/window) — stricter
  - Download tier: `GET /api/vault/:id/download` (default 30 req/window) — prevents bulk download exhaustion
- [x] `request.ip` used for rate limiting — resolved by Fastify via `trustProxy` chain, not raw `X-Forwarded-For` (prevents IP spoofing)
- [x] Max file size enforcement (413 response)
- [x] TTL clamping (min 60s, max configurable)
- [x] Download count clamping (min 1, max 1000)

## Container Security

- [x] Non-root container user (UID 1001)
- [x] Read-only root filesystem
- [x] `cap_drop: ALL`
- [x] `no-new-privileges: true`
- [x] No docker.sock mount
- [x] tmpfs for /tmp (noexec, nosuid)
- [x] Resource limits (memory, CPU)
- [x] Health checks

## Network Security

- [x] Docker port published only on tunnel/private interface (`HOST_BIND_ADDRESS` in `.env`, default `127.0.0.1`)
- [x] App inside container binds to `0.0.0.0` of its own network namespace — Docker port mapping is the enforcement boundary
- [x] Dedicated Docker bridge network (container isolated from default `docker0` and unrelated containers)
- [x] Tunnel/private-interface-only access in production
- [x] Example firewall rules provided (iptables + nftables, whitelist-first order)
- [x] VPS hardening documented (UFW + nftables — port 3000 never public, only 80/443)
- [x] WireGuard `AllowedIPs = <tunnel-ip>/32` documented to prevent lateral LAN movement
- [x] Deployment validation script (`scripts/check-deployment.sh`) to verify posture on the running host
- [x] No LAN exposure in production mode
- [x] CORS restricted in production
- [x] Configurable reverse-proxy trust depth (`TRUST_PROXY`, default `1` — trusts nearest hop only; prevents `X-Forwarded-For` spoofing)

## Admin Panel

- [x] HTTP Basic Auth (env-based, no DB)
- [x] Timing-safe credential comparison
- [x] No encryption key exposure
- [x] No plaintext exposure
- [x] No uploader identity exposure
- [x] Intended for reverse proxy / tunnel protection

## Supply Chain

- [x] Minimal dependencies
- [x] `npm ci --ignore-scripts` in Docker build
- [x] Multi-stage Docker build (no build tools in prod image)
- [x] Alpine-based images

## What This Does NOT Protect Against

| Threat vector | Why it is out of scope |
|---|---|
| Compromised client device | Encryption key resides in browser memory and the URL bar; malware/physical access exposes it |
| Malicious browser extension | Extensions can read page content, URL fragments, and intercept WebCrypto calls |
| Link sharing over insecure channel | Anyone holding the vault URL `#KEY` fragment can decrypt the file |
| Server-side JS tampering | A compromised server could serve a modified frontend that exfiltrates the key before encryption |
| Targeted state-level adversary with client access | Outside scope — use offline, air-gapped tools for this threat model |
| Sustained DDoS | Rate limiting covers casual abuse; deploy behind Cloudflare or another CDN for sustained attacks |
| Long-term storage security | Vaults are designed to be ephemeral; do not use for archival of sensitive material |

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
- [x] File size enforced at frontend, backend, and proxy levels
- [x] Timing-safe comparison for admin credentials
- [x] Security headers: HSTS, CSP, X-Content-Type-Options, X-Frame-Options, Referrer-Policy

## Anti-Abuse

- [x] Cloudflare Turnstile integration (optional)
- [x] In-memory per-IP rate limiting (configurable window + max)
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

- [x] Bind to specific IP (not 0.0.0.0 in production)
- [x] Tunnel/private-interface-only access in production
- [x] Example firewall rules provided
- [x] No LAN exposure in production mode
- [x] CORS restricted in production

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

- Compromise of the client device (key in memory/URL bar)
- Link interception (share vault links over encrypted channels)
- Browser extensions with access to page content
- Targeted state-level adversaries with client access
- DDoS beyond basic rate limiting (use Cloudflare/proxy)

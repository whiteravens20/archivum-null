# Deployment Hardening Guide

This document covers the full hardening surface for a production Archivum Null deployment:
inbound port protection, reverse proxy configuration, VPS lockdown, WireGuard tunnel
scope, and egress containment in case the application process or container is compromised.

For Proxmox LXC-specific hardening, see [PROXMOX.md](PROXMOX.md).
To apply firewall rules automatically, use [scripts/setup-firewall.sh](../scripts/setup-firewall.sh).

---

## Table of Contents

- [Deployment Hardening Guide](#deployment-hardening-guide)
  - [Table of Contents](#table-of-contents)
  - [Security Considerations](#security-considerations)
    - [What these rules protect against](#what-these-rules-protect-against)
    - [What these rules do NOT protect against](#what-these-rules-do-not-protect-against)
    - [Rule ordering is critical](#rule-ordering-is-critical)
    - [Persistence](#persistence)
  - [Production Architecture](#production-architecture)
  - [Inbound Firewall Rules — App Port](#inbound-firewall-rules--app-port)
  - [Reverse Proxy Configuration](#reverse-proxy-configuration)
    - [nginx](#nginx)
    - [Caddy (recommended — automatic TLS via Let's Encrypt)](#caddy-recommended--automatic-tls-via-lets-encrypt)
  - [VPS Hardening](#vps-hardening)
  - [WireGuard — Prevent Lateral LAN Movement](#wireguard--prevent-lateral-lan-movement)
  - [Cloudflare Tunnel (optional)](#cloudflare-tunnel-optional)
    - [Setup](#setup)
    - [Hardening](#hardening)
    - [Egress containment with Cloudflare Tunnel](#egress-containment-with-cloudflare-tunnel)
    - [Privacy considerations](#privacy-considerations)
  - [Tailscale (optional)](#tailscale-optional)
    - [Setup](#setup-1)
    - [Hardening](#hardening-1)
    - [Self-hosted coordination — Headscale](#self-hosted-coordination--headscale)
    - [Privacy considerations](#privacy-considerations-1)
  - [Egress Containment](#egress-containment)
    - [Option A — Docker `internal` network](#option-a--docker-internal-network)
    - [Option B — Host FORWARD rules (Docker with Turnstile)](#option-b--host-forward-rules-docker-with-turnstile)
    - [Option C — Bare-metal / systemd UID rules](#option-c--bare-metal--systemd-uid-rules)
    - [Summary — which option to apply](#summary--which-option-to-apply)
  - [Quick Setup with setup-firewall.sh](#quick-setup-with-setup-firewallsh)

---

## Security Considerations

Before applying any rules, understand the threat model this guide addresses and its limits.

### What these rules protect against

| Threat | Mitigation |
|---|---|
| Port 3000 reachable from the public internet or LAN | Inbound INPUT rules + `HOST_BIND_ADDRESS` in `.env` bind the port exclusively to the tunnel IP |
| Attacker uses a compromised container to pivot to other LAN hosts | Egress FORWARD / OUTPUT rules block container-to-RFC-1918 traffic |
| Attacker uses a compromised container to beacon to internet C2 | Egress rules drop all outbound except optionally Cloudflare (Turnstile) endpoints |
| VPS reverse proxy exposes the backend port publicly | VPS firewall drops port 3000; only 80/443 are open |
| WireGuard misconfiguration routes all homelab traffic through the tunnel | `AllowedIPs = <homelab-ip>/32` scopes the tunnel to the homelab endpoint only |
| TLS termination breaks WebCrypto on the client | Reverse proxy enforces HTTPS; HSTS header is set by the backend |

### What these rules do NOT protect against

| Limitation | Why |
|---|---|
| A root-level compromise of the Proxmox / hypervisor host | Host compromise is above the firewall layer — keep the host OS patched and SSH restricted |
| IPv6 lateral movement | All examples use IPv4 rules only. If the container or VM has an IPv6 address, duplicate the rules with `ip6tables` / `nft` `ip6` family |
| Rule loss after reboot (without persistence) | iptables rules are in-memory by default — see [persistence notes](#persistence) |
| Docker daemon itself as an attack surface | Do not expose `/var/run/docker.sock` inside containers; the production Compose file already enforces this |
| `conntrack` table exhaustion DoS | Rate limiting in the app and at the reverse proxy layer mitigate this; kernel `nf_conntrack_max` tuning is outside the scope of this guide |
| Cloudflare Tunnel / Tailscale coordination metadata | Both services collect metadata (see their dedicated sections) — they are not zero-knowledge transports |

### Rule ordering is critical

Both iptables and nftables evaluate rules **top-to-bottom and stop at the first match**.

- Always put **ACCEPT** rules before **DROP** rules for the same interface.
- Tunnel interfaces (WireGuard, OpenVPN) often use private-range IPs (e.g. `10.8.0.x`). If you DROP `10.0.0.0/8` before the ACCEPT rule for the tunnel, tunnel traffic is silently blocked.
- The `scripts/setup-firewall.sh` script inserts rules in the correct order automatically.

### Persistence

Rules applied with `iptables` or `nft` commands are **in-memory only** and lost on reboot.

- **iptables:** `apt install iptables-persistent && netfilter-persistent save`
- **nftables:** `nft list ruleset > /etc/nftables.conf && systemctl enable --now nftables`
- **setup-firewall.sh:** pass `--persist` flag or answer `y` when prompted.

---

## Production Architecture

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

---

## Inbound Firewall Rules — App Port

Run these on the **homelab host** (the machine running the container or the bare-metal Node process).

> **Whitelist-first ordering:** put the ACCEPT rule for the tunnel interface *before* the DROP rule.
> If you drop private ranges first, tunnel traffic (which also uses private IPs) is blocked.

**iptables**
```bash
# 1. Accept traffic arriving on the tunnel interface (e.g. wg0, tun0)
iptables -A INPUT -i <tunnel-iface> -p tcp --dport 3000 -j ACCEPT

# 2. Drop everything else to the app port (covers LAN, WAN, etc.)
iptables -A INPUT -p tcp --dport 3000 -j DROP
```

**nftables**
```bash
# Accept on tunnel interface, drop all other traffic to the port
nft add rule inet filter input tcp dport 3000 iifname "<tunnel-iface>" accept
nft add rule inet filter input tcp dport 3000 drop
```

> These rules are applied automatically by `setup-firewall.sh` when `--tunnel-iface` is provided.

---

## Reverse Proxy Configuration

Any reverse proxy with TLS termination and `proxy_pass` / `reverse_proxy` support works (nginx, Caddy, Traefik, HAProxy, …).

> Replace `<TUNNEL_IP>` with the IP of your homelab tunnel interface as seen from the VPS.

### nginx

```nginx
server {
    listen 443 ssl http2;
    server_name archivum.yourdomain.com;

    # TLS — managed by your reverse proxy / Let's Encrypt / acme.sh / etc.

    # Must exceed CHUNK_SIZE (default 50 MB) so individual chunk requests pass
    # through. Set slightly above MAX_FILE_SIZE if you also want the single-
    # request upload path to work for files up to MAX_FILE_SIZE.
    # With chunked uploads each HTTP request body is bounded by CHUNK_SIZE,
    # not the total file size — so 55m is enough for the default 50 MB chunks.
    client_max_body_size 105m;

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

**Security note:** set `TRUST_PROXY=1` in `.env` so Fastify trusts exactly one proxy hop for `X-Forwarded-For`. Do not set it higher than the number of trusted proxy layers — a higher value allows clients to spoof their IP.

### Caddy (recommended — automatic TLS via Let's Encrypt)

```caddyfile
archivum.yourdomain.com {
    # Caddy handles TLS automatically — no certificate config needed

    # Must exceed CHUNK_SIZE (default 50 MB). With chunked uploads each HTTP
    # request body is bounded by CHUNK_SIZE, not the total file size — so
    # 55MB is enough for the default 50 MB chunks. 105MB covers the single-
    # request upload path up to MAX_FILE_SIZE as well.
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

---

## VPS Hardening

The VPS runs **only** the reverse proxy. Port 3000 must **never** be reachable from the public internet — only 80 (HTTP→HTTPS redirect) and 443 (HTTPS).

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

**Additional VPS hardening checklist:**

- [ ] Disable password SSH authentication — key-based only (`PasswordAuthentication no` in `sshd_config`)
- [ ] Restrict SSH to your admin IP: `ufw allow from <admin-ip> to any port 22`
- [ ] Enable automatic security updates: `apt install unattended-upgrades`
- [ ] Do not install Docker on the VPS — it should run only the reverse proxy process
- [ ] Verify port 3000 is closed: `nmap -p 3000 <vps-public-ip>` should return `filtered` or `closed`

---

## WireGuard — Prevent Lateral LAN Movement

Scope `AllowedIPs` on each WireGuard peer to exactly the tunnel interface address. **Do not** use `0.0.0.0/0` on the homelab peer unless you intend to route all traffic through the tunnel.

```ini
# /etc/wireguard/wg0.conf  (on the VPS)
[Peer]
PublicKey = <homelab-peer-pubkey>
# Restrict to tunnel interface IP only — prevents accidental LAN routing
AllowedIPs = <homelab-tunnel-ip>/32   # e.g. 10.8.0.2/32
```

With a `/32` `AllowedIPs`, even if the container is misconfigured, WireGuard will only route packets destined for the tunnel IP — LAN subnets remain unreachable from the VPS.

**Security note:** `0.0.0.0/0` in `AllowedIPs` on the homelab peer makes the VPS a default gateway for all traffic from the homelab host. This is almost never the intent. If you see this in an existing config, narrow it to `/32` immediately.

---

## Cloudflare Tunnel (optional)

Cloudflare Tunnel (`cloudflared`) creates an **outbound-only** encrypted connection from your homelab to Cloudflare's edge. No VPS, no public IP, no open inbound ports are required — the daemon initiates the connection.

```
Internet → Cloudflare edge (TLS termination) → cloudflared daemon → Archivum Null
```

### Setup

```bash
# Install cloudflared (Debian/Ubuntu)
curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg \
  | gpg --dearmor > /usr/share/keyrings/cloudflare-main.gpg
echo 'deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] \
  https://pkg.cloudflare.com/cloudflared bullseye main' \
  > /etc/apt/sources.list.d/cloudflared.list
apt update && apt install cloudflared

# Authenticate and create a tunnel
cloudflared tunnel login
cloudflared tunnel create archivum-null

# Configure routing
cloudflared tunnel route dns archivum-null archivum.yourdomain.com
```

Tunnel config (`~/.cloudflared/config.yml`):

```yaml
tunnel: <tunnel-id>
credentials-file: /root/.cloudflared/<tunnel-id>.json

ingress:
  - hostname: archivum.yourdomain.com
    service: http://127.0.0.1:3000   # or tunnel IP if on separate host
  - service: http_status:404
```

```bash
cloudflared service install
systemctl enable --now cloudflared
```

### Hardening

- Set `TRUST_PROXY=1` in `.env` — `cloudflared` is one trusted proxy hop.
- In `.env`, set `HOST_BIND_ADDRESS=127.0.0.1` (or the container's LAN IP) — the tunnel daemon runs on the same host and connects locally; the port need not be reachable from outside.
- Enable **Cloudflare Zero Trust Access** policies on the tunnel to require authentication before reaching the service (optional but recommended for the admin panel).
- Disable `proxy_ssl_verify` only if you use a self-signed cert between cloudflared and the app — prefer plain HTTP on localhost.

**Chunked uploads and Cloudflare's per-request size limit:**

Cloudflare Free and Pro plans enforce a **100 MB maximum body size per HTTP request**. Archivum Null handles this automatically: the frontend splits large encrypted files into `CHUNK_SIZE`-sized HTTP requests sent sequentially. Each request is processed independently and must individually pass through Cloudflare.

- Keep `CHUNK_SIZE` **below 100 MB** — the default 50 MB is safe.
- Do **not** raise `CHUNK_SIZE` to 100 MB or above when using Cloudflare Tunnel — Cloudflare will reject those requests with HTTP 413 before they reach the backend.
- The Cloudflare Business/Enterprise `1 GB` upload limit applies per-request as well. If you are on a paid plan with a raised limit, you may increase `CHUNK_SIZE` up to (but not equal to) that limit.

### Egress containment with Cloudflare Tunnel

`cloudflared` runs as a **host process**, not inside the Docker container. The container itself still gets Option A (`internal: true`) or Option B FORWARD rules — those remain unchanged.

The `cloudflared` daemon on the host needs outbound HTTPS to Cloudflare's infrastructure. If you apply host-wide egress rules, add the following ACCEPT before any DROP:

```bash
# Cloudflare infrastructure ranges (used by cloudflared)
iptables -I OUTPUT -d 104.16.0.0/13 -p tcp --dport 443 -j ACCEPT
iptables -I OUTPUT -d 104.24.0.0/14 -p tcp --dport 443 -j ACCEPT
iptables -I OUTPUT -d 198.41.192.0/24 -p tcp --dport 443 -j ACCEPT
```

### Privacy considerations

> **Summary: Cloudflare Tunnel does NOT break the zero-knowledge file guarantee, but it does expose metadata to Cloudflare.**

| What Cloudflare can see | Impact on Archivum Null |
|---|---|
| Client IP addresses of every request | IP metadata is exposed to Cloudflare (and any legal demand served on them) |
| Request paths (`/api/vault/<id>`, timestamps) | Vault access patterns are visible — Cloudflare knows which vault IDs were accessed and when |
| HTTP headers, User-Agent strings | Browser/client fingerprinting data retained in Cloudflare logs |
| TLS termination at Cloudflare edge | Cloudflare decrypts TLS and re-encrypts to your origin — they see plaintext HTTP, including uploaded ciphertext blobs |
| URL path — **not** the fragment (`#KEY`) | The encryption key in the URL fragment is **never** sent in HTTP requests; browsers strip it. Cloudflare **cannot** see the decryption key |

**What Cloudflare cannot see:**
- File contents (uploaded as AES-256-GCM ciphertext — Cloudflare receives the same encrypted blob as any transit node)
- The decryption key (lives in the URL fragment `#`, which browsers never transmit in HTTP)
- Original filename or MIME type (encrypted inside the blob)

**Additional concerns:**
- Cloudflare logs are subject to legal demands in US and EU jurisdictions. An operator cannot prevent Cloudflare from complying with a valid subpoena for access logs.
- Cloudflare's [DDoS and abuse detection](https://developers.cloudflare.com/fundamentals/privacy/) systems may analyse request patterns.
- If you enable **Cloudflare WAF** or **Cloudflare Workers** in front of the tunnel, those can inspect request bodies (the ciphertext blob). This does not expose plaintext but breaks the "only the server I control sees the ciphertext" model.
- Log retention defaults vary by Cloudflare plan. Review and minimise log retention in the **Cloudflare dashboard → Analytics & Logs → Logpush**.

**Recommendation:** If operator privacy from intermediaries is a priority, use WireGuard + self-hosted VPS instead. Cloudflare Tunnel is a valid trade-off for ease of setup when the operator accepts Cloudflare's role as a metadata-visible transit.

---

## Tailscale (optional)

Tailscale is a WireGuard-based mesh VPN. It automatically handles NAT traversal — no VPS, no port forwarding, no public IP needed. Devices join a shared network ("tailnet") and get stable `100.x.x.x` addresses.

```
Internet client  →  (not applicable — Tailscale is for admin/internal access)
Admin device  →  Tailscale mesh  →  Archivum Null host (100.x.x.x)
```

> **Use case distinction:** Tailscale is primarily suited for **restricting admin access** to the Archivum Null host and admin panel, not for serving the public-facing upload interface. For public access, combine Tailscale with a VPS reverse proxy or use Cloudflare Tunnel.

### Setup

```bash
# Install Tailscale (Debian/Ubuntu)
curl -fsSL https://tailscale.com/install.sh | sh
tailscale up
```

Note the assigned `100.x.x.x` address:
```bash
tailscale ip -4
```

Bind Archivum Null to the Tailscale IP in `.env`:
```bash
HOST_BIND_ADDRESS=100.x.x.x   # Tailscale IP of this host
```

The service is now reachable only from devices in the same tailnet.

> **Docker + iptables:** Docker manages its own `DOCKER-USER` iptables chain. By default, packets arriving on a tunnel interface (`tailscale0`, `wg0`, etc.) may be silently dropped by that chain before any other rules are evaluated. Add an explicit ACCEPT rule on the homelab host:
>
> ```bash
> sudo iptables -I DOCKER-USER -i tailscale0 -j ACCEPT   # replace with your tunnel iface
> ```
>
> `setup-firewall.sh` applies this automatically when `--mode docker --tunnel-iface <iface>` is set with the `iptables` backend.

### Hardening

- **ACLs:** restrict access to port 3000 to specific tailnet nodes only. Edit the ACL policy at `https://login.tailscale.com/admin/acls`:

```json
{
  "acls": [
    // Deny all by default, allow only your admin nodes to reach port 3000
    {
      "action": "accept",
      "src": ["tag:admin"],
      "dst": ["tag:archivum:3000"]
    }
  ],
  "tagOwners": {
    "tag:admin": ["autogroup:owner"],
    "tag:archivum": ["autogroup:owner"]
  }
}
```

- **Disable subnet routing** unless you explicitly need it — it can expose LAN subnets to other tailnet nodes.
- **Enable MagicDNS** for stable hostnames: set `BIND_ADDRESS` to the MagicDNS name as well as the IP.
- **Key expiry:** set short key expiry for the Archivum Null node (e.g. 90 days) and rotate regularly.
- For Proxmox LXC: run `tailscale up` inside the container or on the host and use the Tailscale IP as `HOST_BIND_ADDRESS`.

### Self-hosted coordination — Headscale

If you want to eliminate Tailscale the company as a metadata observer, run [Headscale](https://headscale.net/) — a self-hosted, open-source implementation of the Tailscale control plane:

```bash
# On a self-controlled server
docker run -d --name headscale \
  -v ./headscale/config:/etc/headscale \
  -p 8080:8080 headscale/headscale:latest headscale serve
```

Clients connect to your Headscale instance instead of Tailscale's servers:

```bash
tailscale up --login-server https://headscale.yourdomain.com
```

With Headscale, the control-plane metadata stays entirely on infrastructure you control.

### Privacy considerations

> **Summary: Tailscale (hosted) exposes device and network metadata to Tailscale Inc.; file contents and encryption keys are unaffected.**

| What Tailscale (the company) can see | Impact |
|---|---|
| Device identities and their `100.x.x.x` addresses | Tailscale's coordination server knows every node in your tailnet and its connected identity (Google/GitHub/Microsoft account) |
| Connection timestamps and online/offline events | Network activity patterns are logged by the coordination server |
| DERP relay traffic (when direct P2P fails) | When NAT traversal fails, encrypted WireGuard packets flow through Tailscale-operated DERP servers. Tailscale sees packet sizes and timing but **cannot decrypt** the WireGuard payload |
| Identity provider linkage | Login requires an SSO provider (Google, GitHub, Microsoft). Your device identity is linked to that account |

**What Tailscale cannot see:**
- WireGuard payload (all traffic is end-to-end encrypted with WireGuard keys; Tailscale's coordination server holds no WireGuard private keys)
- File contents, encryption keys, vault URLs (never reach Tailscale infrastructure)
- Request-level metadata (Tailscale is a network layer; it does not inspect HTTP)

**Additional concerns:**
- Tailscale's coordination server is hosted in the US and subject to US legal process.
- The SSO login requirement (Google/GitHub/Microsoft) links device identity to a third-party account. If that account is compromised, tailnet access is at risk — enable 2FA on the SSO account.
- `tailscale up --advertise-exit-node` or `--advertise-routes` on the Archivum Null host can unintentionally expose LAN subnets to the tailnet. Do not use these flags unless deliberately routing LAN traffic.
- Logs: Tailscale retains audit logs. Review the [Tailscale privacy policy](https://tailscale.com/privacy-policy) and optionally configure [log streaming](https://tailscale.com/kb/1255/log-streaming) to your own SIEM.

**Recommendation:** For operators who want the convenience of Tailscale without the metadata exposure, replace it with Headscale. For operators who are comfortable with Tailscale's data practices, the hosted service is acceptable — WireGuard encryption protects all payload, so only metadata is at risk.

---

## Egress Containment

**Threat:** Inbound rules prevent unauthorized access *to* the container. A separate concern is what happens when an attacker gains code execution *inside* the container — e.g. via a vulnerability in Node.js, Fastify, or a malformed uploaded blob. Without egress controls, the compromised process can freely initiate outbound connections: scanning the internal LAN, pivoting to other hosts, or beaconing to a C2 server on the internet.

The rules below cut off that escape path.

---

### Option A — Docker `internal` network

**When to use:** Turnstile is **disabled**. The container requires zero outbound internet access.

Set the Docker network to `internal: true` in `docker-compose.yml`:

```yaml
# docker-compose.yml — networks block at the bottom of the file
networks:
  archivum:
    driver: bridge
    internal: true          # container cannot initiate any outbound connections
    driver_opts:
      com.docker.network.bridge.name: br-archivum   # stable name for iptables rules
```

With `internal: true`, Docker removes the default gateway from the container's network namespace. The container can **still receive** traffic via the `ports:` mapping on the host, but cannot initiate any TCP/UDP connections outward.

> **If Turnstile is enabled,** the backend must reach `https://challenges.cloudflare.com`. Use Option B instead.

---

### Option B — Host FORWARD rules (Docker with Turnstile)

**When to use:** Turnstile is **enabled** and the container needs selective internet access.

**Step 1 — pin the bridge name** (prevents rules from breaking across `docker compose down && up`):

```yaml
# docker-compose.yml — networks block
networks:
  archivum:
    driver: bridge
    driver_opts:
      com.docker.network.bridge.name: br-archivum
```

Rebuild the network once: `docker compose down && docker compose up -d`

**Step 2 — FORWARD egress rules on the host:**

> **Ordering:** ACCEPT rules before DROP rules. ESTABLISHED,RELATED must be first.

**iptables**
```bash
BRIDGE=br-archivum

# 1. Allow return traffic for inbound connections (MUST be first)
iptables -I FORWARD -i $BRIDGE -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT

# 2. Block container → RFC 1918 LAN and link-local (always)
iptables -A FORWARD -i $BRIDGE -d 10.0.0.0/8     -j DROP
iptables -A FORWARD -i $BRIDGE -d 172.16.0.0/12  -j DROP
iptables -A FORWARD -i $BRIDGE -d 192.168.0.0/16 -j DROP
iptables -A FORWARD -i $BRIDGE -d 169.254.0.0/16 -j DROP

# 3. If Turnstile IS enabled — allow Cloudflare challenge endpoints only
iptables -A FORWARD -i $BRIDGE -d 104.16.0.0/13 -p tcp --dport 443 -j ACCEPT
iptables -A FORWARD -i $BRIDGE -d 104.24.0.0/14 -p tcp --dport 443 -j ACCEPT

# 4. Drop everything else outbound from the container
iptables -A FORWARD -i $BRIDGE -j DROP
```

> **Critical:** use `-I` (insert) only for the ESTABLISHED,RELATED rule so it lands at position 1. All subsequent rules use `-A` (append). If you use `-I` for the RFC 1918 DROP rules too, they get prepended one by one and push ESTABLISHED,RELATED to the bottom — return packets destined for container IPs in `172.16.0.0/12` (Docker's default bridge range) hit the DROP rule before the ACCEPT, breaking all client connections.

**nftables**
```bash
BRIDGE=br-archivum

nft add rule inet filter forward iifname "$BRIDGE" ct state established,related accept
nft add rule inet filter forward iifname "$BRIDGE" \
    ip daddr { 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 169.254.0.0/16 } drop

# If Turnstile IS enabled:
nft add rule inet filter forward iifname "$BRIDGE" \
    ip daddr { 104.16.0.0/13, 104.24.0.0/14 } tcp dport 443 accept

nft add rule inet filter forward iifname "$BRIDGE" drop
```

---

### Option C — Bare-metal / systemd UID rules

**When to use:** Node.js runs directly on the host OS (or inside an LXC without a Docker layer).

Use OUTPUT chain rules matched by process UID:

```bash
# Find the UID
id archivum          # if a dedicated system user exists
# or: ps -eo uid,cmd | grep 'node.*index'

APP_UID=1001         # adjust to match

# Block app process → RFC 1918 / link-local
iptables -A OUTPUT -m owner --uid-owner $APP_UID -d 10.0.0.0/8     -j DROP
iptables -A OUTPUT -m owner --uid-owner $APP_UID -d 172.16.0.0/12  -j DROP
iptables -A OUTPUT -m owner --uid-owner $APP_UID -d 192.168.0.0/16 -j DROP
iptables -A OUTPUT -m owner --uid-owner $APP_UID -d 169.254.0.0/16 -j DROP

# If Turnstile IS enabled — allow Cloudflare only
iptables -A OUTPUT -m owner --uid-owner $APP_UID -d 104.16.0.0/13 -p tcp --dport 443 -j ACCEPT
iptables -A OUTPUT -m owner --uid-owner $APP_UID -d 104.24.0.0/14 -p tcp --dport 443 -j ACCEPT

# Drop all remaining outbound from the app UID
iptables -A OUTPUT -m owner --uid-owner $APP_UID -j DROP
```

**nftables equivalent:**
```bash
APP_UID=1001

nft add rule inet filter output meta skuid $APP_UID \
    ip daddr { 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 169.254.0.0/16 } drop

# If Turnstile IS enabled:
nft add rule inet filter output meta skuid $APP_UID \
    ip daddr { 104.16.0.0/13, 104.24.0.0/14 } tcp dport 443 accept

nft add rule inet filter output meta skuid $APP_UID drop
```

> `meta skuid` matching requires Linux kernel ≥ 4.10 and nft ≥ 0.9, which are standard on any current Debian/Ubuntu/Fedora release.

---

### Summary — which option to apply

| Deployment | Turnstile disabled | Turnstile enabled |
|---|---|---|
| Docker | Option A (`internal: true`) | Option B (FORWARD rules, Cloudflare ACCEPT) |
| Bare-metal | Option C (OUTPUT DROP all) | Option C (OUTPUT with Cloudflare ACCEPT) |
| Proxmox LXC (bare-metal inside) | Option C (OUTPUT DROP all) | Option C (OUTPUT with Cloudflare ACCEPT) |
| Proxmox LXC (Proxmox Firewall) | `policy_out: DROP` in `.fw` | `policy_out: DROP` + Cloudflare ACCEPT rules |

For Proxmox-specific Firewall and veth FORWARD rules, see [PROXMOX.md — Egress Containment](PROXMOX.md#egress-containment--proxmox-firewall).


---

## Quick Setup with setup-firewall.sh

Instead of applying rules manually, use the included interactive script. It covers all three modes (Docker, bare-metal, Proxmox veth), both iptables and nftables, and handles rule ordering and persistence automatically.

**Interactive:**
```bash
sudo bash scripts/setup-firewall.sh
```

**Non-interactive examples:**

```bash
# Docker, Turnstile disabled, nftables, persist rules
sudo bash scripts/setup-firewall.sh \
  --mode docker --backend nftables --turnstile no \
  --bridge br-archivum --tunnel-iface wg0 --app-port 3000 --persist

# Docker, Turnstile enabled, iptables
sudo bash scripts/setup-firewall.sh \
  --mode docker --backend iptables --turnstile yes \
  --bridge br-archivum --tunnel-iface wg0 --persist

# Bare-metal, Turnstile disabled
sudo bash scripts/setup-firewall.sh \
  --mode bare-metal --backend iptables --turnstile no \
  --app-uid 1001 --tunnel-iface wg0 --persist

# Proxmox host: veth FORWARD rules for LXC 200
sudo bash scripts/setup-firewall.sh \
  --mode proxmox-veth --backend iptables --turnstile no \
  --veth veth200i0 --persist
```

Pass `--dry-run` to print the commands without executing them.

After applying, run the deployment validator:

```bash
./scripts/check-deployment.sh --tunnel-iface wg0
```

> All script paths above are relative to the repository root. Run them from there.

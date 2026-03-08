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

**Security note:** set `TRUST_PROXY=1` in `.env` so Fastify trusts exactly one proxy hop for `X-Forwarded-For`. Do not set it higher than the number of trusted proxy layers — a higher value allows clients to spoof their IP.

### Caddy (recommended — automatic TLS via Let's Encrypt)

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

# Allow return traffic for inbound connections
iptables -I FORWARD -i $BRIDGE -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT

# Block container → RFC 1918 LAN and link-local (always)
iptables -I FORWARD -i $BRIDGE -d 10.0.0.0/8     -j DROP
iptables -I FORWARD -i $BRIDGE -d 172.16.0.0/12  -j DROP
iptables -I FORWARD -i $BRIDGE -d 192.168.0.0/16 -j DROP
iptables -I FORWARD -i $BRIDGE -d 169.254.0.0/16 -j DROP

# If Turnstile IS enabled — allow Cloudflare challenge endpoints only
iptables -I FORWARD -i $BRIDGE -d 104.16.0.0/13 -p tcp --dport 443 -j ACCEPT
iptables -I FORWARD -i $BRIDGE -d 104.24.0.0/14 -p tcp --dport 443 -j ACCEPT

# Drop everything else outbound from the container
iptables -A FORWARD -i $BRIDGE -j DROP
```

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

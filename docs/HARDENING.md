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
    - [Rule ordering is critical, and so is the chain](#rule-ordering-is-critical-and-so-is-the-chain)
    - [Persistence](#persistence)
  - [Production Architecture](#production-architecture)
  - [Inbound Firewall Rules — App Port](#inbound-firewall-rules--app-port)
  - [Reverse Proxy Configuration](#reverse-proxy-configuration)
    - [nginx](#nginx)
    - [Caddy (recommended — automatic TLS via Let's Encrypt)](#caddy-recommended--automatic-tls-via-lets-encrypt)
  - [Version Disclosure](#version-disclosure)
    - [What the app already does](#what-the-app-already-does)
    - [What you must not undo](#what-you-must-not-undo)
    - [What is still detectable](#what-is-still-detectable)
    - [Keeping the deployment current](#keeping-the-deployment-current)
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
    - [Egress containment with Tailscale](#egress-containment-with-tailscale)
    - [Self-hosted coordination — Headscale](#self-hosted-coordination--headscale)
    - [Privacy considerations](#privacy-considerations-1)
  - [Egress Containment](#egress-containment)
    - [Docker](#docker)
    - [Bare-metal / systemd](#bare-metal--systemd)
    - [Summary — what to apply](#summary--what-to-apply)
  - [Host-Side Isolation](#host-side-isolation)
    - [A filesystem of its own for the vaults](#a-filesystem-of-its-own-for-the-vaults)
    - [The shared kernel](#the-shared-kernel)
  - [Quick Setup with setup-firewall.sh](#quick-setup-with-setup-firewallsh)
    - [Coming from an earlier version of the script](#coming-from-an-earlier-version-of-the-script)

---

## Security Considerations

Before applying any rules, understand the threat model this guide addresses and its limits.

### What these rules protect against

| Threat | Mitigation |
|---|---|
| Port 3000 reachable from the public internet or LAN | `HOST_BIND_ADDRESS` in `.env` publishes the port on the tunnel address only, and the inbound guard drops connections that did not arrive on the tunnel interface |
| Attacker uses a compromised container to pivot to other LAN hosts | Egress rules drop every connection the app opens, to the LAN and to the Docker host itself |
| Attacker uses a compromised container to beacon to internet C2 | Egress rules drop all outbound except, when Turnstile is on, Cloudflare's challenge endpoints |
| VPS reverse proxy exposes the backend port publicly | VPS firewall drops port 3000; only 80/443 are open |
| WireGuard misconfiguration routes all homelab traffic through the tunnel | `AllowedIPs = <homelab-ip>/32` scopes the tunnel to the homelab endpoint only |
| TLS termination breaks WebCrypto on the client | Reverse proxy enforces HTTPS; HSTS header is set by the backend |

### What these rules do NOT protect against

| Limitation | Why |
|---|---|
| A root-level compromise of the Proxmox / hypervisor host | Host compromise is above the firewall layer — keep the host OS patched and SSH restricted |
| A channel through a destination you allowed | With Turnstile on, the app may reach Cloudflare's address ranges on port 443. Those ranges serve a great many other sites, so egress is narrowed, not closed. The same holds for anything you add with `--allow` |
| Data leaving in DNS queries from a container | Docker's built-in resolver answers the container from the daemon's side, where no rule on the container's traffic applies. See [Docker](#docker) for how to leave the container without a resolver |
| IPv6, if you write the rules by hand | `setup-firewall.sh` drops whatever the app opens over IPv6. The hand-written examples in this guide are IPv4 only: add the `ip6tables` counterparts, or use the nftables form, which covers both |
| Rule loss after reboot (without persistence) | iptables rules are in-memory by default — see [persistence notes](#persistence) |
| Docker daemon itself as an attack surface | Do not expose `/var/run/docker.sock` inside containers; the production Compose file already enforces this |
| `conntrack` table exhaustion DoS | Rate limiting in the app and at the reverse proxy layer mitigate this; kernel `nf_conntrack_max` tuning is outside the scope of this guide |
| Cloudflare Tunnel / Tailscale coordination metadata | Both services collect metadata (see their dedicated sections) — they are not zero-knowledge transports |

### Rule ordering is critical, and so is the chain

Both iptables and nftables evaluate rules **top-to-bottom and stop at the first match**.

- Replies come first. A rule that accepts established connections has to precede every drop, or the app stops answering the very proxy it serves: the reply to a proxy on `10.8.0.1` is a packet to a private address.
- **With Docker, where a rule sits matters as much as its order.** Docker's own rules accept everything a container sends, and they are reached from `FORWARD` before anything you append to that chain. A drop appended to `FORWARD` is never evaluated. The one chain Docker evaluates before its own rules is `DOCKER-USER`.
- Traffic to a published port is forwarded, not delivered to the host. Rules in `INPUT` do not see it.
- A container that connects to the Docker host itself is not forwarded. That traffic passes `INPUT`, not `DOCKER-USER`.
- Do not put an `ACCEPT` into `DOCKER-USER`. It ends the evaluation for the packets it matches, Docker's own filtering included. An accept for a tunnel interface there makes the host forward that interface's packets to every network it has a route to.
- nftables rules in a table of their own are evaluated beside Docker's rules, whatever their order: a packet has to pass every table.

`scripts/setup-firewall.sh` takes care of all of the above.

### Persistence

Rules applied with `iptables` or `nft` commands are **in-memory only** and lost on reboot.

- **setup-firewall.sh:** pass `--persist` or answer `y` when prompted. It installs `archivum-null-firewall.service`, which applies the same rules at every boot, before Docker and before the app start. The unit loads this project's rules and nothing else.
- **Rules you wrote by hand, iptables:** `apt install iptables-persistent && netfilter-persistent save`
- **Rules you wrote by hand, nftables:** keep them in a file of their own and load it from `/etc/nftables.conf`. Do not write `nft list ruleset` over that file on a Docker host: the dump contains Docker's own rules as they were at that moment.

---

## Production Architecture

Visitors connect to a small VPS, which holds the public IP, terminates TLS and runs nothing but a reverse proxy (nginx, Caddy, …). The proxy forwards requests over a private tunnel — WireGuard, an SSH tunnel or a VPN overlay — to the homelab host or VM that actually runs Archivum Null. That host listens only on its tunnel interface, so the app and the stored vaults are never exposed directly to the internet or the LAN.

**Key requirements:**

- Docker port published **only** on the tunnel interface IP (`HOST_BIND_ADDRESS=<tunnel-ip>` in `.env`)
- No direct LAN access to port 3000
- Container runs as non-root with read-only filesystem and all capabilities dropped
- VPS exposes only ports 80 and 443 — port 3000 is never public

---

## Inbound Firewall Rules — App Port

`HOST_BIND_ADDRESS` decides which address the port is published on. It does not decide who can reach that address. Linux answers for each of its addresses on every interface, so a machine on your LAN that routes the tunnel address through the homelab host reaches a port published "on the tunnel address only". The inbound guard closes that: connections to the app are accepted from the tunnel interface and from nowhere else.

```bash
# On the homelab host. wg0 stands for the interface your tunnel arrives on.
sudo bash scripts/setup-firewall.sh --mode docker --turnstile no --tunnel-iface wg0
```

What it sets up differs between the two ways of running the app, because the traffic takes a different path:

| | Path of a connection to the app | Where the guard sits |
|---|---|---|
| **Docker** | Forwarded to the container. `INPUT` never sees it | With iptables, a chain entered from `DOCKER-USER` for traffic going out to the app's bridge; with nftables, a chain on the forward hook |
| **Bare-metal** | Delivered to the Node process on the host | A chain entered from `INPUT` for the app port. Connections from the host itself stay allowed, so a proxy or tunnel daemon on the same machine keeps working |

Add `--dry-run` to print the rules without applying them.

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

    # Must exceed CHUNK_SIZE (default 10 MB). No request the app accepts is
    # larger than one chunk plus its multipart framing, whatever the size of the
    # file, so 15m covers the default. Raise the two together.
    client_max_body_size 15m;

    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;

    # Streaming support
    proxy_request_buffering off;
    proxy_buffering off;

    # The admin panel and its API: the addresses you administer from, nobody else.
    # Everyone else gets 403 here, before the app's own login is ever reached.
    location ~* ^/(admin|api/admin)(/|$) {
        allow <YOUR_IP>;      # one line per address or range, e.g. 203.0.113.7 or 10.8.0.0/24
        deny all;
        proxy_pass http://<TUNNEL_IP>:3000;
    }

    location / {
        proxy_pass http://<TUNNEL_IP>:3000;
    }
}
```

**Security note:** set `TRUST_PROXY` in `.env` to the address the proxy connects to the app from — its tunnel IP when it runs on another host, `loopback` when both run on the same bare-metal host. Behind Docker the address depends on how the port is reached, so check it: send one request through the proxy and read the `peer` address from the `Ignored X-Forwarded-For` warning in `docker compose logs archivum-null`. List the proxy and nothing else — every listed address can set a client's IP, while `X-Forwarded-For` from any other peer is ignored.

### Caddy (recommended — automatic TLS via Let's Encrypt)

```caddyfile
archivum.yourdomain.com {
    # Caddy handles TLS automatically — no certificate config needed

    # Must exceed CHUNK_SIZE (default 10 MB). No request the app accepts is
    # larger than one chunk plus its multipart framing, whatever the size of the
    # file, so 15MB covers the default. Raise the two together.
    request_body {
        max_size 15MB
    }

    # The admin panel and its API: the addresses you administer from, nobody else.
    # Everyone else gets 403 here, before the app's own login is ever reached.
    @admin_from_elsewhere {
        path /admin /admin/* /api/admin /api/admin/*
        not remote_ip <YOUR_IP>      # several addresses or ranges may follow, separated by spaces
    }
    respond @admin_from_elsewhere 403

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

The allowlist in both examples matches the address the proxy sees. If another proxy or a CDN sits in front of this one, that is the CDN's address, and the rule has to be written against the client address that layer reports. Without a fixed address to administer from, leave the block out and keep the panel behind a VPN.

---

## Version Disclosure

**Threat:** knowing which release a host runs turns a published advisory into a
target list. An attacker who can read the version off a deployment does not have to
probe for a vulnerability — they look up whether that release has one. The check
should cost them real effort, not one unauthenticated `GET /`.

### What the app already does

Enforced inside the Node process, so it applies identically to Docker and to a
bare-metal `node backend/dist/index.js`:

| Leak | Status |
|---|---|
| Vite content-hashed asset names (`/assets/index-Qld3srqp.js`) — reproducible by rebuilding any published tag | Randomised per boot; the real names 404 |
| `Last-Modified` on static files — dates the build to the second | Suppressed |
| `ETag` on static files — `"<size>-<mtime as hex>"`, the same timestamp | Suppressed |
| `uptime` on `GET /api/health` — dates the deploy, which pins the release | Removed; moved behind auth to `GET /api/admin/version` |
| Running version | Served only from the authenticated `GET /api/admin/version` |

Asset names are randomised **at container start, not at build time**, deliberately:
release images are public on `ghcr.io`, so anything baked into `archivum-null:2.0.0`
is knowable by anyone who pulls it. Names are rewritten in memory only — the image
stays compatible with `read_only: true`.

### What you must not undo

- **Do not serve `frontend/dist` directly from your reverse proxy.** Proxy `/` to the
  app, as the nginx and Caddy examples above do. A proxy reading files off disk
  bypasses both the randomised names and the header suppression, and re-adds its own
  mtime-based `Last-Modified`/`ETag`.
- **Do not add `add_header Last-Modified`/`etag on;`** for the app's routes.
- **Turn off the proxy's own banner** — nginx advertises itself, and with
  `server_tokens on` (the default on some distros) its version too:

  ```nginx
  http {
      server_tokens off;
  }
  ```

  Caddy sends no `Server` version by default.
- **Do not let the proxy duplicate the app's security headers.** The app already sets
  `Strict-Transport-Security`, `X-Content-Type-Options`, `Content-Security-Policy`
  and the rest on every response. Adding them again in nginx produces two copies of
  each header; strip yours or drop the `add_header` lines.

### What is still detectable

Be honest about the limit: **the bundle's *contents* are the version.** Client-side
code is delivered to the browser by definition, so anyone who downloads the JavaScript
and diffs it against a rebuilt tag can still identify the release, and the bundle
carries dependency versions (`react-dom`, `react-router`) in cleartext regardless.

That is unavoidable for a browser app, and it is not what the measures above are for.
They remove the *cheap, passive, scannable* signal — the kind that gets a host swept
up in a mass scan for "everything running < v1.2.3". They do not stop a targeted
analyst, and nothing short of not shipping JavaScript would.

**Obscurity is not the control. Being current is.** See below.

### Keeping the deployment current

Enable the admin panel's update check (`UPDATE_CHECK_ENABLED=true`) so you find out
when a release ships. It is off by default because it needs egress — with the rules
in [Egress Containment](#egress-containment) applied you must either allow
`api.github.com` or leave it off and track releases another way (GitHub's *Watch →
Releases only*, or an RSS reader on `https://github.com/whiteravens20/archivum-null/releases.atom`).

If you use Watchtower to apply updates, note that a Watchtower running with
`WATCHTOWER_LABEL_ENABLE=true` updates **only** containers that opt in. Without the
label it silently skips the container — the deployment keeps running the image it
first pulled, indefinitely:

```yaml
# docker-compose.yml
services:
  archivum-null:
    labels:
      com.centurylinklabs.watchtower.enable: "true"
```

Verify which containers are actually managed:

```bash
docker inspect <container> \
  --format '{{index .Config.Labels "com.centurylinklabs.watchtower.enable"}}'
```

Know what an updater of that kind is given. It needs the Docker socket, and the socket is root on the host: whoever controls the updater, or an image it pulls, controls the machine. It also deploys whatever the tag points at, without checking where the image came from. Two ways to take less on trust: pin the image by digest after verifying it ([README → Upgrading](../README.md#upgrading)) and move the pin yourself, or let the host's own scheduler run `docker compose pull && docker compose up -d`, which puts no socket into any container.

Without an updater, `docker compose up -d` alone will **not** pick up a new release —
it reuses the local image. Pull first:

```bash
docker compose pull && docker compose up -d
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

Visitors reach Cloudflare's edge, which terminates TLS and passes each request down the tunnel that `cloudflared` holds open from your host. The daemon hands it to Archivum Null locally, so the host only ever makes outbound connections.

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

- Set `TRUST_PROXY` in `.env` to the address `cloudflared` connects from — `loopback` on bare metal; behind Docker, read it from the container log as described in the reverse-proxy security note above.
- In `.env`, set `HOST_BIND_ADDRESS=127.0.0.1` (or the container's LAN IP) — the tunnel daemon runs on the same host and connects locally; the port need not be reachable from outside.
- Enable **Cloudflare Zero Trust Access** policies on the tunnel to require authentication before reaching the service (optional but recommended for the admin panel).
- Disable `proxy_ssl_verify` only if you use a self-signed cert between cloudflared and the app — prefer plain HTTP on localhost.

**Chunked uploads and Cloudflare's per-request size limit:**

Cloudflare Free and Pro plans enforce a **100 MB maximum body size per HTTP request**. Archivum Null handles this automatically: the frontend splits large encrypted files into `CHUNK_SIZE`-sized HTTP requests sent sequentially. Each request is processed independently and must individually pass through Cloudflare.

- Keep `CHUNK_SIZE` **below 100 MB** — the default 10 MB is safe.
- Do **not** raise `CHUNK_SIZE` to 100 MB or above when using Cloudflare Tunnel — Cloudflare will reject those requests with HTTP 413 before they reach the backend.
- The Cloudflare Business/Enterprise `1 GB` upload limit applies per-request as well. If you are on a paid plan with a raised limit, you may increase `CHUNK_SIZE` up to (but not equal to) that limit.

### Egress containment with Cloudflare Tunnel

`cloudflared` runs as a **host process**, not inside the Docker container. The container keeps the rules from [Egress Containment](#egress-containment) unchanged: they apply to the container's traffic, and `cloudflared`'s is the host's own.

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

Only devices you have joined to the tailnet can reach the host, at its `100.x.x.x` address — typically your own machine, for admin access. Public visitors are not on the tailnet, so on its own Tailscale does not serve the upload page to the internet.

> **Use case distinction:** Tailscale is primarily suited for **restricting admin access** to the Archivum Null host and admin panel, not for serving the public-facing upload interface. For public access, combine Tailscale with a VPS reverse proxy or use Cloudflare Tunnel.

### Setup

Install from Tailscale's signed apt repository rather than `curl … | sh`. The
convenience script is fetched over TLS and then executed as root with no
signature check of its own; the repository route pins a keyring that apt
verifies on every update, and upgrades arrive through the same channel as the
rest of the system. This is what [`scripts/install-lxc.sh`](../scripts/install-lxc.sh)
does when you pick Tailscale at its VPN prompt.

```bash
# Debian — on Ubuntu, swap 'debian' for 'ubuntu' in both URLs
CODENAME=$(. /etc/os-release && echo "$VERSION_CODENAME")

curl -fsSL "https://pkgs.tailscale.com/stable/debian/${CODENAME}.noarmor.gpg" \
  | sudo tee /usr/share/keyrings/tailscale-archive-keyring.gpg >/dev/null
curl -fsSL "https://pkgs.tailscale.com/stable/debian/${CODENAME}.tailscale-keyring.list" \
  | sudo tee /etc/apt/sources.list.d/tailscale.list >/dev/null

sudo apt-get update
sudo apt-get install -y --no-install-recommends tailscale

sudo tailscale up
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

> **Do not add an `ACCEPT` for the tunnel interface to `DOCKER-USER`.** Earlier versions of this guide and of `setup-firewall.sh` did (`iptables -I DOCKER-USER -i tailscale0 -j ACCEPT`). The published port works without it, and with it the host forwards whatever arrives on that interface to every network it has a route to. The current script removes the rule when it finds it; to check by hand:
>
> ```bash
> sudo iptables -S DOCKER-USER
> ```

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
- For Proxmox LXC: run `tailscale up` inside the container and set `BIND_ADDRESS` in `.env` to the container's Tailscale IP, so that the app listens on the tunnel only. (`HOST_BIND_ADDRESS` is for Docker's port publishing and has no effect there.)

### Egress containment with Tailscale

[Egress Containment](#egress-containment) below assumes the only process that ever dials out is the app. A mesh VPN breaks that assumption as soon as `tailscaled` runs **inside** the scope those rules cover — an LXC given `policy_out: DROP`, or a host given a blanket `OUTPUT` DROP policy. Such a rule does not merely cut the app off from the internet: it tears the tunnel down, and your remote access to the machine with it.

| `tailscaled` runs on | What changes |
|---|---|
| The Docker / Proxmox **host**, app in a container | Nothing. The container keeps its egress rules unchanged; the tunnel's traffic is host traffic and never crosses them. Prefer this — the app's own egress stays at zero. |
| **Inside** the contained container / LXC | Allow the ports below *before* the DROP, or the tunnel never comes up. |
| Bare-metal alongside the app ([Bare-metal / systemd](#bare-metal--systemd)) | Nothing. Those rules apply to packets of the app's user, and `tailscaled` runs as root, so they never touch it — unless you widen them into a blanket `OUTPUT` DROP, which puts you in the row above. |

**What Tailscale needs outbound:**

| Port | Purpose | If blocked |
|---|---|---|
| `443/tcp` | Control plane and DERP relays | No tunnel at all |
| `3478/udp` | STUN — NAT traversal | Falls back to DERP over 443: works, slower |
| `41641/udp` | Direct WireGuard peer traffic | Falls back to DERP over 443: works, slower |
| `53/udp`, `53/tcp` | DNS | No tunnel — the control plane is reached by name |

The rules are **port-based, not address-based**. DERP is a large and changing relay fleet, so there is no stable IP range to allow the way there is for Cloudflare.

**Proxmox LXC** — `/etc/pve/firewall/<VMID>.fw`. This is what [`scripts/install-lxc.sh`](../scripts/install-lxc.sh) writes when you pick Tailscale, give it your proxy's address and let it configure the firewall:

```ini
[OPTIONS]
enable: 1
policy_in: DROP
policy_out: DROP
dhcp: 1

[RULES]
# The reverse proxy, the one host that may reach the app
IN ACCEPT -source <proxy-address> -proto tcp -dport 3000

# Tailscale outbound (control plane + DERP over 443, STUN, WireGuard)
OUT ACCEPT -proto tcp -dport 443
OUT ACCEPT -proto udp -dport 3478
OUT ACCEPT -proto udp -dport 41641
OUT ACCEPT -proto udp -dport 53
OUT ACCEPT -proto tcp -dport 53
```

> These rules stay inert until the **datacenter** firewall is enabled — see the note under [Summary — what to apply](#summary--what-to-apply).
>
> Return traffic for inbound client sessions is accepted automatically — `pve-firewall` inserts a RELATED,ESTABLISHED accept at the top of every guest chain. Do not add one by hand; the ruleset format does not parse raw iptables options.

Once the tunnel is up, requests to the app arrive on `tailscale0`, so the [inbound rules](#inbound-firewall-rules--app-port) treat it like any other tunnel interface — pass `--tunnel-iface tailscale0` to `setup-firewall.sh`.

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

**Before you pick an option, know what legitimately needs egress.** By default the
app makes no outbound connection at all. Two optional features change that:

| Feature | Needs | If blocked |
|---|---|---|
| Cloudflare Turnstile (`TURNSTILE_SECRET` set) | `https://challenges.cloudflare.com` | Uploads fail — the challenge cannot be verified |
| Update check (`UPDATE_CHECK_ENABLED=true`) | `https://api.github.com` | Fails quietly; the admin panel still reports the running version, with the reason beside it |

The update check is off by default precisely so that this section's rules and the
application's behaviour do not contradict each other. If you want it, allow
`api.github.com` alongside the Cloudflare ranges below; if you would rather keep
egress shut, leave it off and track releases from outside the host — see
[Keeping the deployment current](#keeping-the-deployment-current).

---

### Docker

**One command, on the homelab host:**

```bash
# Turnstile off: the container may open no connection at all
sudo bash scripts/setup-firewall.sh --mode docker --turnstile no --tunnel-iface wg0 --persist

# Turnstile on: it may reach Cloudflare's challenge endpoints, nothing else
sudo bash scripts/setup-firewall.sh --mode docker --turnstile yes --tunnel-iface wg0 --persist
```

The rules match the app's network by the name of its bridge, `br-archivum`, which `docker-compose.yml` pins. They survive `docker compose down && up`, a restart of Docker and, with `--persist`, a reboot.

**What the rules do:**

| Traffic | Verdict |
|---|---|
| Replies of the app to its visitors | Pass: they belong to connections the proxy opened |
| A connection the container opens to the LAN or the internet | Dropped. With `--turnstile yes`, TCP 443 to `104.16.0.0/13` and `104.24.0.0/14` passes |
| A connection the container opens to the Docker host itself | Dropped. Without this the host's SSH daemon, and anything else it listens on, stays within the container's reach whatever the other rules say |
| A connection to the container (with `--tunnel-iface`) | Passes from that interface only |

Do **not** use `internal: true` on the Compose network for this. Docker publishes no port for a container on an internal network, so the app stops being reachable.

**The same by hand.** `--dry-run` prints exactly what the script would apply for your options. As iptables commands, for Turnstile on and a tunnel on `wg0`:

```bash
# Chains of our own. Allowed traffic leaves them with RETURN, so Docker's own
# rules and yours still apply to it.
iptables -N ARCHIVUM-EGRESS
iptables -A ARCHIVUM-EGRESS -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN
iptables -A ARCHIVUM-EGRESS -d 104.16.0.0/13 -p tcp --dport 443 -j RETURN   # Turnstile only
iptables -A ARCHIVUM-EGRESS -d 104.24.0.0/14 -p tcp --dport 443 -j RETURN   # Turnstile only
iptables -A ARCHIVUM-EGRESS -j DROP

iptables -N ARCHIVUM-HOST
iptables -A ARCHIVUM-HOST -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN
iptables -A ARCHIVUM-HOST -j DROP

iptables -N ARCHIVUM-INGRESS
iptables -A ARCHIVUM-INGRESS -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN
iptables -A ARCHIVUM-INGRESS -i wg0 -j RETURN
iptables -A ARCHIVUM-INGRESS -j DROP

# Forwarded traffic of the app's bridge: DOCKER-USER, the chain Docker evaluates
# before its own accept. Not FORWARD, where a rule comes after that accept.
iptables -I DOCKER-USER 1 -i br-archivum -j ARCHIVUM-EGRESS
iptables -I DOCKER-USER 1 -o br-archivum -j ARCHIVUM-INGRESS
# From the container to the host itself
iptables -I INPUT 1 -i br-archivum -j ARCHIVUM-HOST
```

The script adds two things this listing leaves out: the same jumps in `FORWARD`, for a Docker that keeps its rules in nftables and never enters `DOCKER-USER`, and the `ip6tables` counterparts.

As one nftables table, which covers IPv4 and IPv6 and needs no chain of Docker's:

```
table inet archivum_null {
	chain forward_from_app {
		type filter hook forward priority filter; policy accept;
		iifname "br-archivum" jump egress
	}
	chain egress {
		ct state established,related accept
		ip daddr { 104.16.0.0/13, 104.24.0.0/14 } tcp dport 443 accept   # Turnstile only
		drop
	}
	chain input_from_app {
		type filter hook input priority filter; policy accept;
		iifname "br-archivum" jump host
	}
	chain host {
		ct state established,related accept
		icmpv6 type { nd-neighbor-solicit, nd-neighbor-advert, nd-router-solicit } accept
		drop
	}
	chain forward_to_app {
		type filter hook forward priority filter; policy accept;
		oifname "br-archivum" jump ingress
	}
	chain ingress {
		ct state established,related accept
		iifname "wg0" accept
		drop
	}
}
```

**Name resolution.** The container asks Docker's built-in resolver, and Docker passes the query to the host's name servers from the host's side. Turnstile therefore works without any rule for DNS, and the script adds none. Two consequences:

- A resolver the container reaches *by itself* does need one: a server set with `dns:` in the Compose file, or any server on an old Docker. It shows in `docker exec archivum-null cat /etc/resolv.conf` as an `ExtServers` entry without `host(...)`. Pass it with `--dns <address>`.
- The rules cannot stop a contained container from resolving names, and a name can carry data to whoever runs its zone. If Turnstile and the update check are both off, the app resolves nothing. Leave it without a resolver then:

  ```yaml
  # docker-compose.yml, under the archivum-null service
  dns:
    - 127.0.0.1
  ```

**The update check** needs `api.github.com`. Add its range with `--allow`, which takes any `CIDR:PORT` and can be repeated; GitHub publishes the current ranges under `api` at `https://api.github.com/meta`:

```bash
sudo bash scripts/setup-firewall.sh --mode docker --turnstile yes --tunnel-iface wg0 \
  --allow 140.82.112.0/20:443 --persist
```

**Verify.** `sudo ./scripts/check-deployment.sh` reads the rules and then tests them: it has the container try a connection to the internet and one to the host, and fails if either gets through.

---

### Bare-metal / systemd

**When to use:** Node.js runs directly on the host OS, or inside a VM. For a Proxmox LXC use the Proxmox firewall instead, see [PROXMOX.md](PROXMOX.md#egress-containment--proxmox-firewall).

The rules apply to the packets of one user, so the app must run as a user of its own. Rules for root would contain the whole system, and the script refuses to write them.

```bash
sudo bash scripts/setup-firewall.sh --mode bare-metal --turnstile yes --tunnel-iface wg0 --persist
```

`--app-uid` takes the user's name or number and defaults to `archivum`. With `--turnstile yes` the app may also query the name servers in `/etc/resolv.conf`; `--dns` replaces that list.

The same by hand, as the nftables table the script loads (UID 1001, Turnstile on, a local stub resolver):

```
table inet archivum_null {
	chain output_from_app {
		type filter hook output priority filter; policy accept;
		meta skuid 1001 jump egress
	}
	chain egress {
		ct state established,related accept
		ip daddr { 127.0.0.53 } meta l4proto { tcp, udp } th dport 53 accept   # Turnstile only
		ip daddr { 104.16.0.0/13, 104.24.0.0/14 } tcp dport 443 accept        # Turnstile only
		drop
	}
	chain input_to_app {
		type filter hook input priority filter; policy accept;
		tcp dport 3000 jump ingress
	}
	chain ingress {
		iifname "lo" accept
		iifname "wg0" accept
		drop
	}
}
```

Two details carry the weight here:

- `ct state established,related accept` comes first. The app's replies to its visitors are packets of the app's user too; without that line the service answers nobody.
- The rules are entered by a jump that matches the user (`meta skuid 1001 jump egress`), not written as a list that starts with "everyone else may pass". Packets the kernel sends on its own account have no user, and a list of that shape drops them.

With iptables the script builds the same from `-m owner --uid-owner`; `--backend iptables --dry-run` prints it.

---

### Summary — what to apply

| Deployment | Turnstile disabled | Turnstile enabled |
|---|---|---|
| Docker | `setup-firewall.sh --mode docker --turnstile no` | `setup-firewall.sh --mode docker --turnstile yes` |
| Bare-metal, VM | `setup-firewall.sh --mode bare-metal --turnstile no` | `setup-firewall.sh --mode bare-metal --turnstile yes` |
| Proxmox LXC | `policy_out: DROP` in the guest's `.fw` file | `policy_out: DROP` + Cloudflare and DNS ACCEPT rules |

For the Proxmox firewall, see [PROXMOX.md — Egress Containment](PROXMOX.md#egress-containment--proxmox-firewall).

> **A per-container `.fw` file does nothing on its own.** Guest rules are compiled only while the **datacenter** firewall is enabled — `pve-firewall status` must not report `disabled`. Until it is, `policy_out: DROP` is inert and the container's egress is wide open, whatever the file says. Turn it on under **Datacenter → Firewall → Options**, reviewing the host rules first so you do not lock yourself out, or set `enable: 1` under `[OPTIONS]` in `/etc/pve/firewall/cluster.fw`.
>
> [`scripts/install-lxc.sh`](../scripts/install-lxc.sh) warns when it finishes against a disabled datacenter firewall — it will not flip the switch itself, because that is a host-wide change affecting every guest. It does keep `firewall=1` on the container's veth regardless of the firewall prompt, so enabling the datacenter firewall later activates the rules without touching the NIC.

---

## Host-Side Isolation

Everything above limits what the app's container can reach over the network. Two things remain on the host's side: the disk the vaults are written to, and the kernel the container shares with everything else on the machine.

### A filesystem of its own for the vaults

The vault volume is the one place in the production container that can be written to and executed from: `/tmp` is mounted `noexec`, the rest is read-only. By default it is also a directory on the host's own filesystem, so the only bound on its size is `MAX_TOTAL_STORAGE`. A dedicated filesystem closes both: nothing runs from it, and it cannot grow past its size whatever the app believes.

```bash
# On the homelab host. Any block device will do: a partition, a logical volume, a ZFS volume.
mkfs.ext4 /dev/<device>
mkdir -p /srv/archivum
echo '/dev/<device>  /srv/archivum  ext4  noexec,nosuid,nodev  0  2' >> /etc/fstab
mount /srv/archivum

# The vaults go one level down, so that the filesystem's own lost+found is not among them
mkdir /srv/archivum/vaults
chown 1001:1001 /srv/archivum/vaults
```

```yaml
# docker-compose.yml, under the archivum-null service: in place of "vault-data:/data/vaults"
volumes:
  - /srv/archivum/vaults:/data/vaults
```

`docker exec archivum-null grep /data/vaults /proc/mounts` then shows `noexec,nosuid,nodev`. Keep `MAX_TOTAL_STORAGE` below the size of the filesystem: the quota is what makes the app refuse an upload cleanly, the filesystem is what holds if the quota is ever wrong.

### The shared kernel

A container is a process on the host's kernel, confined by it. The settings in `docker-compose.yml` leave the app nothing to work with: no capability, no new privileges, a system-call filter, a read-only root. What they cannot do is fix a flaw in the kernel or in the container runtime, and no setting in this repository can. That part is yours:

- **Keep the host and Docker patched.** A container escape is, almost always, a known and already fixed vulnerability on a machine that was not updated.
- **Consider user-namespace remapping or rootless Docker.** The container's user is UID 1001 inside and, by default, UID 1001 on the host as well, which on many machines is a real account. With `userns-remap` in `/etc/docker/daemon.json`, or with Docker running rootless, the container's IDs map to host IDs that own nothing. See Docker's documentation on [user namespaces](https://docs.docker.com/engine/security/userns-remap/) and [rootless mode](https://docs.docker.com/engine/security/rootless/); both change where volumes live and who owns them, so set them up before the first deployment, not after.
- **A Proxmox LXC** made by the installer is unprivileged for the same reason: root inside it is an unprivileged ID on the host.

---

## Quick Setup with setup-firewall.sh

The script covers Docker and bare-metal, with iptables or nftables, and owns what it creates: with nftables the table `inet archivum_null`, with iptables the chains `ARCHIVUM-EGRESS`, `ARCHIVUM-HOST` and `ARCHIVUM-INGRESS` and the jumps into them. Every run rebuilds them from the options given, so it is safe to run again with different options. Its rules only drop; they never accept a packet your own firewall or Docker would have refused.

**Interactive:**
```bash
sudo bash scripts/setup-firewall.sh
```

**Non-interactive examples:**

```bash
# Docker, Turnstile off, tunnel on wg0, applied again at every boot
sudo bash scripts/setup-firewall.sh \
  --mode docker --turnstile no --tunnel-iface wg0 --persist --yes

# Docker, Turnstile on, iptables instead of nftables
sudo bash scripts/setup-firewall.sh \
  --mode docker --backend iptables --turnstile yes --tunnel-iface wg0 --persist --yes

# Bare-metal, Turnstile off, the app running as the user "archivum"
sudo bash scripts/setup-firewall.sh \
  --mode bare-metal --turnstile no --tunnel-iface wg0 --persist --yes

# See what a run would do, without root and without changing anything
bash scripts/setup-firewall.sh --mode docker --turnstile yes --tunnel-iface wg0 --dry-run

# Take everything out again
sudo bash scripts/setup-firewall.sh --remove
```

| Option | Meaning |
|---|---|
| `--mode docker` \| `bare-metal` | How the app runs |
| `--backend iptables` \| `nftables` | Default: nftables when `nft` is installed |
| `--turnstile yes` \| `no` | Whether the app may reach Cloudflare's challenge endpoints |
| `--tunnel-iface <iface>` | Inbound guard: only this interface may reach the app port |
| `--bridge <name>` | Docker: the bridge of the app's network (default `br-archivum`) |
| `--app-uid <user>` | Bare-metal: the app's user, by name or number (default `archivum`) |
| `--dns <a,b>` \| `none` | Resolvers the app may query; see [Docker](#docker) for when a container needs one |
| `--allow <CIDR:PORT>` | One more TCP destination the app may connect to; repeatable |
| `--persist` | Install `archivum-null-firewall.service`, which applies the same rules at boot |
| `--remove` | Remove the rules and the unit |
| `--dry-run` | Print, change nothing |
| `--yes` | Do not ask for confirmation |

After applying, run the deployment validator:

```bash
sudo ./scripts/check-deployment.sh --tunnel-iface wg0
```

> All script paths above are relative to the repository root. Run them from there.

### Coming from an earlier version of the script

Run the current script once, with the options for your deployment. It finds the rules the earlier version added and removes them, by their exact text:

| Where | What it removes | Why |
|---|---|---|
| `FORWARD`, rules for `br-archivum` | The egress rules of Docker mode with iptables | They sat behind Docker's own accept and were never evaluated: the container's egress was open |
| `DOCKER-USER`, `-i <tunnel> -j ACCEPT` | The accept for the tunnel interface | It made the host forward that interface's packets to every network it has a route to |
| `INPUT`, rules for the app port | The inbound guard | In Docker mode it never saw the traffic. The new guard sits where the traffic passes |
| `OUTPUT`, rules for the app's UID | The egress rules of bare-metal mode | They also dropped the app's replies, so the service answered nobody |
| The table `inet filter`, nftables | The same rules in their nftables form | Replaced by a table of the script's own |

Then deal with what was saved, or the old rules come back at the next boot:

- `netfilter-persistent` or `/etc/iptables/rules.v4`: run `netfilter-persistent save` again.
- `/etc/nftables.conf`: the earlier `--persist` wrote the whole ruleset over this file, Docker's rules of that moment included. Restore your distribution's default or your own file.

The `proxmox-veth` mode is gone. Its rules matched a guest's veth in the host's `FORWARD` chain, and a guest's traffic is never presented there under that interface: bridged frames either bypass iptables or appear as coming from the bridge. If you applied them, they are dead weight; list them with `iptables -S FORWARD | grep veth` and delete each with `iptables -D`. Use the Proxmox firewall, as [PROXMOX.md](PROXMOX.md#egress-containment--proxmox-firewall) describes.

# Proxmox LXC Deployment

Running Archivum Null as a Proxmox LXC container is a lightweight alternative to a full VM. The container has its own network namespace and IP, so no Docker is needed — Node.js runs directly inside the LXC.

## Table of Contents

- [Prerequisites](#prerequisites)
- [Creating the LXC Container](#creating-the-lxc-container)
- [Quick Installer (Community Scripts style)](#quick-installer-community-scripts-style)
- [Manual Installation](#manual-installation)
- [systemd Service](#systemd-service)
- [Updating](#updating)
- [Egress Containment — Proxmox Firewall](#egress-containment--proxmox-firewall)
- [Proxmox SDN / VLAN Isolation](#proxmox-sdn--vlan-isolation)

---

## Prerequisites

- Proxmox VE 8.x (7.x should work but is untested)
- A Debian 12 (bookworm) or Ubuntu 24.04 CT template downloaded in Proxmox
- At least 512 MB RAM and 2 GB root disk assigned to the container

---

## Creating the LXC Container

Run on the **Proxmox host shell** (`pve` node → Shell):

```bash
# Replace <vmid> with a free CT ID (e.g. 200), and adjust storage/bridge names
pct create <vmid> local:vztmpl/debian-12-standard_12.7-1_amd64.tar.zst \
  --unprivileged 1 \
  --hostname archivum-null \
  --memory 512 --swap 256 \
  --cores 1 \
  --net0 name=eth0,bridge=vmbr0,ip=dhcp,firewall=1 \
  --rootfs local-lvm:4 \
  --onboot 1 \
  --start 1

pct enter <vmid>
```

> **Tip:** If you use a dedicated VLAN/SDN VNET for the app, specify `bridge=<your-vnet>,tag=<vlan-id>` in `--net0`. This is the strongest isolation option — see [Proxmox SDN / VLAN Isolation](#proxmox-sdn--vlan-isolation) below.

---

## Quick Installer (Community Scripts style)

The [Proxmox Community Scripts](https://community-scripts.github.io/ProxmoxVE/) project provides one-liner LXC installers. Archivum Null is not yet in the official repository. Until an official script is merged, you can use the included helper directly from the **Proxmox host shell**:

```bash
bash -c "$(wget -qLO - https://github.com/whiteravens20/archivum-null/raw/main/scripts/install-lxc.sh)"
```

> The `install-lxc.sh` script follows the Community Scripts conventions: it finds the next free VMID, downloads the Debian 13 template if needed, creates an unprivileged LXC (`keyctl=1,nesting=1` — nesting is required by Debian 13's systemd), installs Node.js 24, clones the repo, builds the project, creates a systemd service, and writes the Proxmox Firewall egress config. **Review the script before running it.**

To update an existing LXC installed this way:

```bash
bash -c "$(wget -qLO - https://github.com/whiteravens20/archivum-null/raw/main/scripts/install-lxc.sh)" -- --update <vmid>
```

After the installer finishes, set `ADMIN_PASSWORD` before starting the service:

```bash
pct enter <vmid>
nano /opt/archivum-null/.env   # set ADMIN_PASSWORD=<strong-password>
systemctl start archivum-null
```

---

## Manual Installation

Run **inside the container** (`pct enter <vmid>` or via console):

```bash
apt update && apt install -y curl git wget

# Node.js 24 (official NodeSource repo)
curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
apt install -y nodejs

# Dedicated system user (mirrors Docker UID 1001)
useradd -r -u 1001 -s /usr/sbin/nologin -m -d /opt/archivum-null archivum

# Clone and build
git clone https://github.com/whiteravens20/archivum-null.git /opt/archivum-null
cd /opt/archivum-null

# Configure environment
cp .env.example .env
# Edit mandatory values:
#   ADMIN_PASSWORD=<strong-password>
#   BIND_ADDRESS=0.0.0.0   (container has its own network namespace — this is fine)
#   PORT=3000
#   STORAGE_PATH=/opt/archivum-null/data/vaults
nano .env

# Stamp the version. Docker images get this from the release tag; a source install
# has to say so itself, or the admin panel can only report "unknown".
echo "APP_VERSION=$(git describe --tags --abbrev=0)" >> .env

# Build backend
cd backend && npm ci --ignore-scripts && npm run build && npm prune --omit=dev && cd ..

# Build frontend (VITE_ vars must be set in .env before this step)
cd frontend && npm ci --ignore-scripts && npm run build && cd ..

# Data directory owned by app user
mkdir -p /opt/archivum-null/data/vaults
chown -R archivum:archivum /opt/archivum-null
```

---

## systemd Service

Create `/etc/systemd/system/archivum-null.service`:

```ini
[Unit]
Description=Archivum Null — zero-knowledge file relay
After=network.target

[Service]
Type=simple
User=archivum
Group=archivum
WorkingDirectory=/opt/archivum-null
EnvironmentFile=/opt/archivum-null/.env
ExecStart=/usr/bin/node backend/dist/index.js
Restart=on-failure
RestartSec=5

# Hardening
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=strict
ReadWritePaths=/opt/archivum-null/data/vaults
ProtectHome=yes
CapabilityBoundingSet=
AmbientCapabilities=

[Install]
WantedBy=multi-user.target
```

```bash
systemctl daemon-reload
systemctl enable --now archivum-null
systemctl status archivum-null
```

---

## Updating

```bash
# On the Proxmox host — snapshot first (optional but recommended):
pct snapshot <vmid> pre-update --description "before archivum-null update $(date -I)"

# Inside the container:
pct enter <vmid>

cd /opt/archivum-null
systemctl stop archivum-null

git pull

cd backend && npm ci --ignore-scripts && npm run build && npm prune --omit=dev && cd ..
cd frontend && npm ci --ignore-scripts && npm run build && cd ..

systemctl start archivum-null
systemctl status archivum-null
```

> To roll back: `pct rollback <vmid> pre-update` on the Proxmox host.

---

## Egress Containment — Proxmox Firewall

Proxmox has a built-in firewall controllable from the GUI (**Datacenter → `<node>` → CT `<vmid>` → Firewall**) or by editing the container's firewall config file directly on the host.

**Step 1 — enable the firewall and set `policy_out` to DROP:**

Edit `/etc/pve/firewall/<vmid>.fw` on the **Proxmox host**:

```ini
[OPTIONS]
enable: 1
policy_in: ACCEPT
policy_out: DROP    # block all outbound by default

[RULES]
# Return traffic for existing inbound connections (download/upload responses)
# is allowed automatically — pve-firewall inserts a RELATED,ESTABLISHED accept
# at the top of every guest chain. Do not add an explicit rule for it: the
# ruleset format does not parse raw iptables options such as '-m conntrack'.

# --- If Turnstile IS enabled: allow only Cloudflare challenge endpoints ---
OUT ACCEPT -dest 104.16.0.0/13 -proto tcp -dport 443
OUT ACCEPT -dest 104.24.0.0/14 -proto tcp -dport 443

# --- DNS (required for Turnstile hostname lookup on startup) ---
# OUT ACCEPT -proto udp -dport 53
# OUT ACCEPT -proto tcp -dport 53
```

> If Turnstile is **disabled**, omit the Cloudflare and DNS ACCEPT lines — `policy_out: DROP` alone is sufficient.

Changes take effect immediately (no reload required). Verify in the Proxmox GUI under **CT → Firewall → Log**.

> **Important:** per-container rules only apply while the **datacenter-level firewall** is enabled (`pve-firewall status` must not report `disabled`). Enable it under **Datacenter → Firewall → Options** — reviewing the host rules first so you don't lock yourself out — or set `enable: 1` under `[OPTIONS]` in `/etc/pve/firewall/cluster.fw`.

---

> **Do not add iptables rules for the container's `veth` to the host's `FORWARD` chain.** An earlier version of this guide did. A guest's traffic is bridged, and the host's iptables either does not see it at all or sees it as coming from the bridge, never from `veth<vmid>i0`, so such rules match nothing. The Proxmox firewall above is what filters a guest.

---

## Proxmox SDN / VLAN Isolation

The strongest network isolation is to place the container on a dedicated SDN VNET with no default route to the LAN. Create a **Zone** (Simple or VLAN) and a **VNet** in **Datacenter → SDN**, then assign the container to it via `--net0 bridge=<vnet-name>`. Without a gateway configured on the VNET, the container has no route to reach LAN or WAN at all — outbound connections fail at the routing layer rather than at the firewall layer.

Combine with the Proxmox Firewall rules above for defence in depth.

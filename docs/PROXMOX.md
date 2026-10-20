# Proxmox LXC Deployment

Running Archivum Null as a Proxmox LXC container is a lightweight alternative to a full VM. The container has its own network namespace and IP, so no Docker is needed — Node.js runs directly inside the LXC.

## Table of Contents

- [Prerequisites](#prerequisites)
- [Quick Installer](#quick-installer)
  - [Checking what you run](#checking-what-you-run)
- [Manual Installation](#manual-installation)
- [systemd Service](#systemd-service)
- [Updating](#updating)
- [Egress Containment — Proxmox Firewall](#egress-containment--proxmox-firewall)
- [Proxmox SDN / VLAN Isolation](#proxmox-sdn--vlan-isolation)

---

## Prerequisites

- Proxmox VE 8 or 9. The installer is tested on 9.2.
- The Debian 13 (trixie) CT template; the installer downloads it when it is missing.
- RAM: the installer's default of 2 GB is sized for building the app. The running service uses a small fraction of it.
- Root disk: 4 GB or more; the installer's default is 10 GB. Six tenths of it become the storage quota for the vaults.

---

## Quick Installer

One command on the **Proxmox host shell** creates the container and installs the newest release in it:

```bash
bash -c "$(wget -qLO - https://github.com/whiteravens20/archivum-null/raw/main/scripts/install-lxc.sh)"
```

What it does, in order. **Review the script before running it.**

1. Asks for the VMID, storage, bridge, size, addressing, an optional VPN client, and the address your reverse proxy connects from.
2. Creates an unprivileged LXC from the Debian 13 template with `nesting=1`, which Debian 13's systemd needs.
3. Inside it: installs Node.js 24 from NodeSource's signed apt repository, creates the system user `archivum`, clones the **newest release tag**, and builds it as a throwaway user that is deleted again.
4. Writes `/opt/archivum-null/.env` from the example, readable by root only, with the storage path, a storage quota of six tenths of the disk, the installed version, and `TRUST_PROXY` if you gave the proxy's address.
5. Installs the sandboxed [systemd unit](#systemd-service). The app runs as `archivum`, owns its vault directory and nothing else.
6. Writes the container's [Proxmox firewall file](#egress-containment--proxmox-firewall): outbound dropped, inbound from the proxy only.

Then set `ADMIN_PASSWORD` and start the service:

```bash
pct enter <vmid>
nano /opt/archivum-null/.env   # set ADMIN_PASSWORD=<strong-password>
systemctl start archivum-null
curl -s http://127.0.0.1:3000/api/health
```

The admin panel is at `/admin` of the address your reverse proxy serves. Do not log in at `http://<container-ip>:3000/admin` from the LAN: the password would cross the network unencrypted.

Every prompt can be answered ahead of time through the environment, for an unattended run; the head of the script lists the variables:

```bash
VMID=200 STORAGE=local-lvm CT_DISK=20 NET_IP=dhcp VPN_SW=none CT_FIREWALL=yes PROXY_IP=192.168.1.10 \
  bash install-lxc.sh
```

### Checking what you run

The one-liner runs whatever `main` holds at that moment, as root on your hypervisor. Every release also ships as a tarball with a signed build provenance, so you can run a copy you have checked. On a machine with the [GitHub CLI](https://cli.github.com/):

```bash
VERSION=v3.2.0   # the release you want
gh release download "$VERSION" --repo whiteravens20/archivum-null --pattern "archivum-null-$VERSION.tar.gz"
gh attestation verify "archivum-null-$VERSION.tar.gz" --repo whiteravens20/archivum-null
tar -xzf "archivum-null-$VERSION.tar.gz" scripts/install-lxc.sh
scp scripts/install-lxc.sh root@<proxmox-host>:/root/
```

Then, on the Proxmox host, `bash /root/install-lxc.sh`. `gh attestation verify` exits with an error when the file was not built by this repository's release workflow. What this covers is the script that runs on the host. The app itself is still cloned from its release tag inside the container.

---

## Manual Installation

The same result by hand. Create the container on the **Proxmox host shell**:

```bash
# Replace <vmid> with a free CT ID (e.g. 200), and adjust the template, storage and bridge names
pct create <vmid> local:vztmpl/debian-13-standard_13.6-1_amd64.tar.zst \
  --unprivileged 1 \
  --features nesting=1 \
  --hostname archivum-null \
  --memory 2048 --swap 256 \
  --cores 2 \
  --net0 name=eth0,bridge=vmbr0,ip=dhcp,firewall=1 \
  --rootfs local-lvm:10 \
  --onboot 1 \
  --start 1

pct enter <vmid>
```

> **Tip:** If you use a dedicated VLAN/SDN VNET for the app, specify `bridge=<your-vnet>,tag=<vlan-id>` in `--net0`. This is the strongest isolation option — see [Proxmox SDN / VLAN Isolation](#proxmox-sdn--vlan-isolation) below.

Then, **inside the container**:

```bash
apt update && apt install -y --no-install-recommends curl git ca-certificates

# Node.js 24 from NodeSource's apt repository, checked by apt against the key below
install -d -m 0755 /etc/apt/keyrings
curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key -o /etc/apt/keyrings/nodesource.asc
echo "deb [signed-by=/etc/apt/keyrings/nodesource.asc] https://deb.nodesource.com/node_24.x nodistro main" \
  > /etc/apt/sources.list.d/nodesource.list
apt update && apt install -y --no-install-recommends nodejs

# The app's own user. No home directory is created: the clone below needs the path empty.
useradd --system --user-group --home-dir /opt/archivum-null --no-create-home --shell /usr/sbin/nologin archivum

# The newest release, not the development branch
REPO=https://github.com/whiteravens20/archivum-null.git
TAG=$(git ls-remote --tags --refs "$REPO" 'v[0-9]*' | awk -F/ '{ print $NF }' | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' | sort -V | tail -1)
git clone --depth 1 --branch "$TAG" "$REPO" /opt/archivum-null
cd /opt/archivum-null

# Configuration, readable by root only. systemd reads it before it drops privileges.
install -m 0600 .env.example .env
sed -i "s|^STORAGE_PATH=.*|STORAGE_PATH=/opt/archivum-null/data/vaults|" .env
# The version. Docker images get it from the release tag; a source install has to
# say so itself, or the admin panel can only report "unknown".
sed -i -E "s|^#? ?APP_VERSION=.*|APP_VERSION=$TAG|" .env
# Edit by hand:
#   ADMIN_PASSWORD=<strong-password>
#   MAX_TOTAL_STORAGE=<bytes the vaults may use; leave room on the disk>
#   TRUST_PROXY=<the address your reverse proxy connects from>
nano .env

# Build as a user that exists for the build only, so that no build tool runs as root
useradd --system --user-group --home-dir /nonexistent --no-create-home --shell /usr/sbin/nologin archivum-build
BUILD_HOME=$(mktemp -d)
chown -R archivum-build: backend frontend "$BUILD_HOME"
build() { runuser -u archivum-build -- env HOME="$BUILD_HOME" "$@"; }
(cd backend  && build npm ci --ignore-scripts && build npm run build && build npm prune --omit=dev --ignore-scripts)
(cd frontend && build npm ci --ignore-scripts && build npm run build && rm -rf node_modules)
chown -R root:root backend frontend
rm -rf "$BUILD_HOME"
userdel archivum-build

# The vault directory is the one thing the app owns
mkdir -p data/vaults
chown -R archivum:archivum data
```

The build reads no variable from `.env`; everything in that file takes effect when the service starts.

---

## systemd Service

Create `/etc/systemd/system/archivum-null.service`. This is the unit the installer writes:

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
# Node's permission model: no child process, worker thread, native addon, WASI or
# inspector. File access is left to the directives below.
ExecStart=/usr/bin/node --permission --allow-fs-read=* --allow-fs-write=* backend/dist/index.js
Restart=on-failure
RestartSec=5
UMask=0077

# No privileges, and no way to gain any
NoNewPrivileges=yes
CapabilityBoundingSet=
AmbientCapabilities=
RestrictSUIDSGID=yes

# Filesystem: read-only except the vault directory
ProtectSystem=strict
ReadWritePaths=/opt/archivum-null/data/vaults
ProtectHome=yes
PrivateTmp=yes
PrivateDevices=yes
ProtectProc=invisible
ProcSubset=pid

# Kernel, control groups, clock, host name
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectKernelLogs=yes
ProtectControlGroups=yes
ProtectClock=yes
ProtectHostname=yes

# Namespaces, address families, system calls
RestrictNamespaces=yes
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX AF_NETLINK
RestrictRealtime=yes
LockPersonality=yes
SystemCallArchitectures=native
SystemCallFilter=@system-service
SystemCallFilter=~@privileged @resources
SystemCallErrorNumber=EPERM

[Install]
WantedBy=multi-user.target
```

```bash
systemctl daemon-reload
systemctl enable --now archivum-null
systemctl status archivum-null
```

What the unit takes away, beyond running the app as `archivum`: every capability, the right to gain any, write access to everything but the vault directory, the view of other processes, device nodes, kernel tunables and modules, new namespaces, address families other than IP, local sockets and netlink, and system calls outside the set a network service uses. `systemd-analyze security archivum-null` rates the result; expect a score below 2.

Keep your own changes in a drop-in (`systemctl edit archivum-null`): the installer's `--update` writes the unit again.

---

## Updating

On the **Proxmox host**:

```bash
bash install-lxc.sh --update <vmid>
# or, without a local copy:
bash -c "$(wget -qLO - https://github.com/whiteravens20/archivum-null/raw/main/scripts/install-lxc.sh)" -- --update <vmid>
```

It offers a snapshot, stops the service, checks out the newest release tag, rebuilds, and starts the service again. Your `.env`, your `TOS.md` with any translations of it, and the vaults are kept. A second run with nothing new does nothing.

**An install made by an earlier version of the installer is migrated by the same command.** Those ran the app as root, from the development branch, with a world-readable `.env`. After the update the app runs as `archivum` under the sandboxed unit, from a release tag, and the vaults are still there. Two things the update leaves to you, and tells you about: a storage quota, if `MAX_TOTAL_STORAGE` is still `0`, and the inbound side of the firewall file.

**The update needs outbound access.** It fetches the release and its dependencies from inside the container. If the firewall below drops the container's outbound traffic, the update stops before it touches anything and says so. Set `policy_out: ACCEPT` in `/etc/pve/firewall/<vmid>.fw`, run the update, and set it back to `DROP`.

By hand, inside the container, it is the manual installation again from the clone onwards, with `git fetch --depth 1 origin "$TAG" && git checkout --force --detach FETCH_HEAD` in place of the clone, between `systemctl stop archivum-null` and `systemctl start archivum-null`.

> To roll back: `pct rollback <vmid> <snapshot-name>` on the Proxmox host. `pct listsnapshot <vmid>` lists the names.

The update does not upgrade the container's own packages, Node.js included. Do that as on any Debian system: `apt update && apt upgrade`, with the same temporary `policy_out: ACCEPT`.

---

## Egress Containment — Proxmox Firewall

Proxmox has a built-in firewall controllable from the GUI (**Datacenter → `<node>` → CT `<vmid>` → Firewall**) or by editing the container's firewall config file directly on the host. It filters both directions, and both matter here: outbound, so that a compromised app cannot reach your LAN or the internet; inbound, so that only your reverse proxy can talk to the app and its admin API, and not every host on the bridge.

`/etc/pve/firewall/<vmid>.fw` on the **Proxmox host**, as the installer writes it:

```ini
[OPTIONS]
enable: 1
policy_in: DROP     # nothing reaches the container except what the rules below allow
policy_out: DROP    # the container opens no connection of its own
dhcp: 1             # only if the container gets its address by DHCP: lets the lease be renewed

[RULES]
# The reverse proxy, the one host that may reach the app
IN ACCEPT -source <proxy-address> -proto tcp -dport 3000

# Return traffic for existing connections is allowed automatically — pve-firewall
# inserts a RELATED,ESTABLISHED accept at the top of every guest chain. Do not add
# an explicit rule for it: the ruleset format does not parse raw iptables options
# such as '-m conntrack'.

# --- If Turnstile IS enabled: Cloudflare's challenge endpoints, and name resolution ---
# OUT ACCEPT -dest 104.16.0.0/13 -proto tcp -dport 443
# OUT ACCEPT -dest 104.24.0.0/14 -proto tcp -dport 443
# OUT ACCEPT -proto udp -dport 53
# OUT ACCEPT -proto tcp -dport 53
```

- **`<proxy-address>`** is the address the proxy connects from, as the container sees it. Set the same value as `TRUST_PROXY` in `.env`. If the tunnel to your proxy ends inside the container (WireGuard, Tailscale), the app's traffic arrives through the tunnel and no `IN` rule is needed at all; set `BIND_ADDRESS` in `.env` to the container's tunnel address, so that the app does not listen on the bridge in the first place.
- **Turnstile** needs the four `OUT` lines. The app resolves `challenges.cloudflare.com` whenever it verifies a token, not once at startup, so the DNS lines are as necessary as the Cloudflare ones.
- **A VPN client in the container** needs its own `OUT` lines; the installer adds them for the client you pick. [HARDENING.md](HARDENING.md#egress-containment-with-tailscale) lists the ports for Tailscale.

Changes take effect within seconds, without a reload. Verify in the Proxmox GUI under **CT → Firewall → Log**.

> **Important:** per-container rules only apply while the **datacenter-level firewall** is enabled (`pve-firewall status` must not report `disabled`). Until then the file above does nothing, in either direction. Enable it under **Datacenter → Firewall → Options** — reviewing the host rules first so you don't lock yourself out — or set `enable: 1` under `[OPTIONS]` in `/etc/pve/firewall/cluster.fw`. The installer warns when it finishes against a disabled datacenter firewall.

**If you cannot enable the datacenter firewall**, contain the app from inside the container. The rules of [`setup-firewall.sh`](HARDENING.md#bare-metal--systemd) apply to the packets of the `archivum` user, which works in an LXC as it does on a bare-metal host:

```bash
# Inside the container, from /opt/archivum-null
apt install -y nftables
bash scripts/setup-firewall.sh --mode bare-metal --turnstile no --persist
```

This covers the outbound side. It restricts the inbound side only by interface (`--tunnel-iface`), which helps when a tunnel ends inside the container and not otherwise.

> **Do not add iptables rules for the container's `veth` to the host's `FORWARD` chain.** An earlier version of this guide did. A guest's traffic is bridged, and the host's iptables either does not see it at all or sees it as coming from the bridge, never from `veth<vmid>i0`, so such rules match nothing. The Proxmox firewall above is what filters a guest.

---

## Proxmox SDN / VLAN Isolation

The strongest network isolation is to place the container on a dedicated SDN VNET with no default route to the LAN. Create a **Zone** (Simple or VLAN) and a **VNet** in **Datacenter → SDN**, then assign the container to it via `--net0 bridge=<vnet-name>`. Without a gateway configured on the VNET, the container has no route to reach LAN or WAN at all — outbound connections fail at the routing layer rather than at the firewall layer.

Combine with the Proxmox Firewall rules above for defence in depth.

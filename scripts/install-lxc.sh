#!/usr/bin/env bash
# ── Archivum Null — Proxmox LXC Installer / Updater ─────────────────────────
# Follows the Proxmox Community Scripts conventions.
# Run this on the PROXMOX HOST shell (not inside a container or VM).
#
# Usage:
#   Install (creates a new LXC):
#     bash -c "$(wget -qLO - https://github.com/whiteravens20/archivum-null/raw/main/scripts/install-lxc.sh)"
#
#   Update (updates an existing LXC):
#     bash -c "$(wget -qLO - https://github.com/whiteravens20/archivum-null/raw/main/scripts/install-lxc.sh)" -- --update <vmid>
#
# Requirements (on the Proxmox host):
#   - pct, pvesh  (standard Proxmox tools)
#   - wget or curl
#
# Security notes:
#   - Creates an unprivileged LXC container
#   - Applies Proxmox Firewall egress rules (policy_out: DROP)
#   - REVIEW THIS SCRIPT BEFORE RUNNING IN PRODUCTION
# ─────────────────────────────────────────────────────────────────────────────

set -euo pipefail

# Restore cursor visibility on any exit (pick() hides cursor while selecting)
_restore_cursor() { printf '\033[?25h'; }
trap _restore_cursor EXIT

# ── Colours and helpers ───────────────────────────────────────────────────────
green()  { printf '\033[0;32m✓\033[0m %s\n' "$*"; }
red()    { printf '\033[0;31m✗\033[0m %s\n' "$*"; }
yellow() { printf '\033[0;33m⚠\033[0m %s\n' "$*"; }
info()   { printf '\033[0;36mℹ\033[0m %s\n' "$*"; }
header() { printf '\n\033[1;37m━━━ %s ━━━\033[0m\n' "$*"; }
die()    { red "$*"; exit 1; }

# pick <var_name> <prompt> <default> <option ...>
# Inline arrow-key selector (←/→ to move, Enter to confirm).
pick() {
  local _var="$1" _prompt="$2" _default="$3"
  shift 3
  local -a _opts=("$@")
  local _sel=0 _count=${#_opts[@]} _key _seq _i

  for _i in "${!_opts[@]}"; do
    [[ "${_opts[$_i]}" == "$_default" ]] && _sel=$_i
  done

  if (( _count <= 1 )); then
    green "$_prompt ${_opts[0]:-$_default}"
    printf -v "$_var" '%s' "${_opts[0]:-$_default}"
    return
  fi

  printf '\033[?25l'
  while true; do
    printf '\r\033[K%s ' "$_prompt"
    for _i in "${!_opts[@]}"; do
      if (( _i == _sel )); then
        printf '\033[1;36m▸ %s\033[0m  ' "${_opts[$_i]}"
      else
        printf '  %s  ' "${_opts[$_i]}"
      fi
    done
    IFS= read -rsn1 _key
    case "$_key" in
      $'\x1b')
        IFS= read -rsn2 -t 0.2 _seq || _seq=""
        case "$_seq" in
          '[C'|'[B') (( _sel = (_sel + 1) % _count )) ;;
          '[D'|'[A') (( _sel = (_sel - 1 + _count) % _count )) ;;
        esac ;;
      '') break ;;
    esac
  done
  printf '\r\033[K'
  green "$_prompt ${_opts[$_sel]}"
  printf '\033[?25h'
  printf -v "$_var" '%s' "${_opts[$_sel]}"
}

# ── Argument parsing ──────────────────────────────────────────────────────────
MODE="install"
UPDATE_VMID=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --update)
      [[ $# -ge 2 ]] || die "--update requires a <vmid> argument."
      MODE="update"; UPDATE_VMID="$2"; shift 2 ;;
    --help|-h)
      echo "Usage:"
      echo "  install-lxc.sh                     # create a new LXC and install"
      echo "  install-lxc.sh --update <vmid>     # update existing LXC"
      exit 0 ;;
    *) die "Unknown option: $1" ;;
  esac
done

# ── Guards ────────────────────────────────────────────────────────────────────
[[ "$(id -u)" -eq 0 ]] || die "This script must be run as root on the Proxmox host."
command -v pct  >/dev/null 2>&1 || die "'pct' not found — run this on a Proxmox VE host."
command -v pvesh >/dev/null 2>&1 || die "'pvesh' not found — run this on a Proxmox VE host."

# ── Configuration defaults (edit before running if needed) ───────────────────
APP_NAME="archivum-null"
REPO_URL="https://github.com/whiteravens20/archivum-null.git"
INSTALL_DIR="/opt/archivum-null"
NODE_MAJOR=24
DEFAULT_STORAGE="local-lvm"
DEFAULT_BRIDGE="vmbr0"
DEFAULT_MEMORY=2048
DEFAULT_SWAP=256
DEFAULT_CORES=2
DEFAULT_DISK=10   # GiB
TEMPLATE_PATTERN="debian-13-standard"

# ─────────────────────────────────────────────────────────────────────────────
#  UPDATE MODE
# ─────────────────────────────────────────────────────────────────────────────

if [[ "$MODE" == "update" ]]; then
  [[ -n "$UPDATE_VMID" ]] || die "--update requires a <vmid> argument."
  header "Updating Archivum Null in LXC $UPDATE_VMID"

  # Optional snapshot before update
  pick snap_ans "Create a snapshot before updating?" "Yes" "Yes" "No"
  if [[ "$snap_ans" == "Yes" ]]; then
    SNAP_NAME="pre-update-$(date +%Y%m%d-%H%M)"
    info "Creating snapshot '$SNAP_NAME'…"
    pct snapshot "$UPDATE_VMID" "$SNAP_NAME" --description "before archivum-null update $(date -I)"
    green "Snapshot created: $SNAP_NAME"
    info "To roll back: pct rollback $UPDATE_VMID $SNAP_NAME"
  fi

  info "Stopping service inside LXC…"
  pct exec "$UPDATE_VMID" -- systemctl stop archivum-null || true

  info "Pulling latest changes…"
  pct exec "$UPDATE_VMID" -- bash -c "cd $INSTALL_DIR && git pull --ff-only"

  info "Rebuilding backend…"
  pct exec "$UPDATE_VMID" -- bash -c "cd $INSTALL_DIR/backend && npm ci --ignore-scripts && npm run build && npm prune --omit=dev"

  info "Rebuilding frontend…"
  pct exec "$UPDATE_VMID" -- bash -c "cd $INSTALL_DIR/frontend && npm ci --ignore-scripts && npm run build"

  info "Restarting service…"
  pct exec "$UPDATE_VMID" -- systemctl start archivum-null

  green "Update complete."
  pct exec "$UPDATE_VMID" -- systemctl status archivum-null --no-pager || true
  exit 0
fi

# ─────────────────────────────────────────────────────────────────────────────
#  INSTALL MODE
# ─────────────────────────────────────────────────────────────────────────────

header "Archivum Null — Proxmox LXC Installer"

# ── Pick next free VMID (interactively) ─────────────────────────────────────
NEXT_VMID=$(pvesh get /cluster/nextid 2>/dev/null | tr -d '[:space:]') || \
      die "Could not determine next free VMID."
read -rp "VMID [$NEXT_VMID]: " VMID
VMID="${VMID:-$NEXT_VMID}"
[[ "$VMID" =~ ^[0-9]+$ ]] || die "VMID must be a positive integer."
info "Using VMID: $VMID"

# ── Locate CT template ────────────────────────────────────────────────────────
# The template list mixes architectures (amd64 + arm64), so always filter by
# the host architecture — 'sort -V | tail -1' alone would pick arm64.
HOST_ARCH=$(dpkg --print-architecture)
info "Searching for Debian 13 CT template (${HOST_ARCH})…"
TEMPLATE_PATH=$(pveam list local 2>/dev/null | awk '{print $1}' | grep "$TEMPLATE_PATTERN" | grep "_${HOST_ARCH}" | sort -V | tail -1 || true)

if [[ -z "$TEMPLATE_PATH" ]]; then
  info "Template not found locally — downloading…"
  pveam update
  REMOTE_TMPL=$(pveam available --section system 2>/dev/null | awk '{print $2}' | grep "$TEMPLATE_PATTERN" | grep "_${HOST_ARCH}" | sort -V | tail -1 || true)
  [[ -n "$REMOTE_TMPL" ]] || die "Could not find a Debian 13 template in the Proxmox repository."
  pveam download local "$REMOTE_TMPL"
  TEMPLATE_PATH="local:vztmpl/$REMOTE_TMPL"
fi
green "Template: $TEMPLATE_PATH"

# ── Prompt for any overrides ──────────────────────────────────────────────────
mapfile -t _storages < <(pvesm status --content rootdir 2>/dev/null \
  | awk 'NR>1 && $3=="active" {print $1}' | sort)
[[ ${#_storages[@]} -eq 0 ]] && _storages=("$DEFAULT_STORAGE")
pick STORAGE "Storage pool:" "$DEFAULT_STORAGE" "${_storages[@]}"

mapfile -t _bridges < <(ip -o link show type bridge 2>/dev/null \
  | awk -F': ' '{print $2}' | sort)
[[ ${#_bridges[@]} -eq 0 ]] && _bridges=("$DEFAULT_BRIDGE")
pick BRIDGE "Network bridge:" "$DEFAULT_BRIDGE" "${_bridges[@]}"

# ── Container resources ───────────────────────────────────────────────────────
pick CT_MEMORY "RAM (MB):" "$DEFAULT_MEMORY" "512" "1024" "2048" "4096" "8192"
pick CT_CORES  "CPU cores:" "$DEFAULT_CORES" "1" "2" "4" "6" "8"
pick CT_DISK   "Disk (GiB):" "$DEFAULT_DISK" "4" "8" "10" "20" "40" "80"
pick CT_SWAP   "Swap (MB):"  "$DEFAULT_SWAP" "0" "256" "512" "1024"

# ── VPN / tunnel options ──────────────────────────────────────────────────────
pick _vpn_ans "TUN device (VPN / Tunneling):" "No" "No" "Yes"
VPN_TUN=false
VPN_FW_TYPE="none"
if [[ "$_vpn_ans" == "Yes" ]]; then
  VPN_TUN=true
  info "wireguard = UDP 51820 + DNS │ openvpn = UDP/TCP 1194 + DNS │ none = manual"
  pick VPN_FW_TYPE "VPN firewall preset:" "none" "none" "wireguard" "openvpn"
fi

# ── Build container feature flags ────────────────────────────────────────────
# nesting=1 is required: Debian 13 ships systemd 257, which needs it in an
# unprivileged CT to mount /tmp, /dev/mqueue and /run/lock.
CT_FEATURES="keyctl=1,nesting=1"

# ── Create the container ──────────────────────────────────────────────────────
header "Creating LXC container (VMID: $VMID)"
pct create "$VMID" "$TEMPLATE_PATH" \
  --unprivileged 1 \
  --hostname "$APP_NAME" \
  --memory "$CT_MEMORY" \
  --swap "$CT_SWAP" \
  --cores "$CT_CORES" \
  --net0 "name=eth0,bridge=${BRIDGE},ip=dhcp,firewall=1" \
  --rootfs "${STORAGE}:${CT_DISK}" \
  --onboot 1 \
  --features "$CT_FEATURES"

# ── Enable TUN device passthrough (if requested) ─────────────────────────────
if [[ "$VPN_TUN" == "true" ]]; then
  info "Enabling TUN device passthrough in LXC config…"
  LXC_CONF="/etc/pve/lxc/${VMID}.conf"
  cat >> "$LXC_CONF" << 'TUN'
lxc.cgroup2.devices.allow: c 10:200 rwm
lxc.mount.entry: /dev/net dev/net none bind,create=dir
lxc.mount.entry: /dev/net/tun dev/net/tun none bind,create=file
TUN
  green "TUN device enabled via LXC config."
fi

pct start "$VMID"
sleep 3   # wait for network

green "Container started."

# ── Bootstrap function (runs inside the container via pct exec) ───────────────
bootstrap_container() {
  pct exec "$VMID" -- bash -s << 'INNER'
set -euo pipefail

INSTALL_DIR="/opt/archivum-null"
REPO_URL="https://github.com/whiteravens20/archivum-null.git"
NODE_MAJOR=24

echo "==> Updating packages…"
apt-get update -qq
apt install -y --no-install-recommends curl git ca-certificates gnupg

echo "==> Installing Node.js ${NODE_MAJOR}…"
curl -fsSL https://deb.nodesource.com/setup_${NODE_MAJOR}.x | bash - >/dev/null 2>&1
apt install -y --no-install-recommends nodejs
npm install -g npm@latest

echo "==> Clearing apt cache…"
apt clean
rm -rf /var/lib/apt/lists/*

echo "==> Cloning repository…"
git clone --depth 1 "$REPO_URL" "$INSTALL_DIR"

echo "==> Copying .env template…"
cp "$INSTALL_DIR/.env.example" "$INSTALL_DIR/.env"

# Set sensible LXC defaults in .env (operator must set ADMIN_PASSWORD manually)
sed -i 's|^#\?\s*BIND_ADDRESS=.*|BIND_ADDRESS=0.0.0.0|' "$INSTALL_DIR/.env"
sed -i 's|^#\?\s*STORAGE_PATH=.*|STORAGE_PATH=/opt/archivum-null/data/vaults|' "$INSTALL_DIR/.env"

echo "==> Building backend…"
cd "$INSTALL_DIR/backend"
npm ci --ignore-scripts
npm run build
npm prune --omit=dev

echo "==> Building frontend…"
cd "$INSTALL_DIR/frontend"
npm ci --ignore-scripts
npm run build

echo "==> Creating data directory…"
mkdir -p "$INSTALL_DIR/data/vaults"

echo "==> Installing systemd service…"
cat > /etc/systemd/system/archivum-null.service << 'EOF'
[Unit]
Description=Archivum Null — zero-knowledge file relay
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/archivum-null
EnvironmentFile=/opt/archivum-null/.env
ExecStart=/usr/bin/node backend/dist/index.js
Restart=on-failure
RestartSec=5

# Systemd hardening
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=strict
ReadWritePaths=/opt/archivum-null/data/vaults
ProtectHome=yes
EOF

systemctl daemon-reload
systemctl enable archivum-null

echo "==> Bootstrap complete."
INNER
}

header "Installing Archivum Null inside LXC $VMID"
bootstrap_container
green "Application installed."

# ── Apply Proxmox Firewall egress rules ───────────────────────────────────────
header "Configuring Proxmox Firewall (egress containment)"

FW_FILE="/etc/pve/firewall/${VMID}.fw"
if [[ -f "$FW_FILE" ]]; then
  yellow "Firewall config $FW_FILE already exists — skipping (edit manually if needed)."
else
  # Build optional VPN firewall rules
  case "$VPN_FW_TYPE" in
    wireguard)
      VPN_FW_RULES="
# WireGuard VPN outbound
OUT ACCEPT -proto udp -dport 51820
OUT ACCEPT -proto udp -dport 53
OUT ACCEPT -proto tcp -dport 53"
      ;;
    openvpn)
      VPN_FW_RULES="
# OpenVPN outbound
OUT ACCEPT -proto udp -dport 1194
OUT ACCEPT -proto tcp -dport 1194
OUT ACCEPT -proto udp -dport 53
OUT ACCEPT -proto tcp -dport 53"
      ;;
    *)
      VPN_FW_RULES=""
      ;;
  esac

  cat > "$FW_FILE" << FW
# Archivum Null — container firewall
# policy_out: DROP blocks all container-initiated outbound connections.
# Return traffic for inbound client sessions is allowed automatically:
# pve-firewall inserts a RELATED,ESTABLISHED accept at the top of every guest
# chain, and its ruleset format does not parse raw iptables options anyway.
#
# If Cloudflare Turnstile is enabled, uncomment the Cloudflare ACCEPT rules
# and the DNS rules below; otherwise leave them commented out.

[OPTIONS]
enable: 1
policy_in: ACCEPT
policy_out: DROP

[RULES]
# --- Uncomment if Turnstile IS enabled ---
# OUT ACCEPT -dest 104.16.0.0/13 -proto tcp -dport 443
# OUT ACCEPT -dest 104.24.0.0/14 -proto tcp -dport 443
# OUT ACCEPT -proto udp -dport 53
# OUT ACCEPT -proto tcp -dport 53
${VPN_FW_RULES}
FW
  green "Proxmox Firewall config written to $FW_FILE"
fi

# Guest firewall rules only take effect when the datacenter firewall is on.
if pve-firewall status 2>/dev/null | grep -q "disabled"; then
  yellow "The DATACENTER firewall is disabled — the egress rules above have NO effect."
  yellow "Enable it under Datacenter → Firewall → Options (review host rules first),"
  yellow "or set 'enable: 1' under [OPTIONS] in /etc/pve/firewall/cluster.fw."
fi

# ── Post-install summary ──────────────────────────────────────────────────────
CT_IP=$(pct exec "$VMID" -- ip -4 addr show eth0 2>/dev/null \
  | awk '/inet / {sub(/\/.*/, "", $2); print $2}' || true)

header "Installation complete — VMID: $VMID"
[[ -n "$CT_IP" ]] && info "Container IP: $CT_IP"

cat << 'POSTINSTALL'

┌─────────────────────────────────────────────────────────────────────┐
│  1. CONFIGURE .env (required before first start)                    │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  pct enter <VMID>                                                   │
│  nano /opt/archivum-null/.env                                       │
│                                                                     │
│  Required:                                                          │
│    ADMIN_PASSWORD=<strong-random-password>                          │
│      → Admin panel is DISABLED until this is changed.               │
│      → Panel endpoint: http://<ip>:3000/admin                       │
│                                                                     │
│  Recommended to review:                                             │
│    PORT=3000                 # backend listen port                  │
│    BIND_ADDRESS=0.0.0.0      # listen on all interfaces             │
│    MAX_FILE_SIZE=104857600   # max upload size (bytes, default 100M)│
│    MAX_TOTAL_STORAGE=0       # 0 = unlimited; set a quota in bytes  │
│    DEFAULT_TTL=86400         # default vault TTL (24h)              │
│    MAX_TTL=604800            # max vault TTL (7 days)               │
│    TRUST_PROXY=1             # set to number of reverse-proxy hops  │
│                                                                     │
├─────────────────────────────────────────────────────────────────────┤
│  2. START THE SERVICE                                               │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  systemctl start archivum-null                                      │
│  systemctl status archivum-null                                     │
│  journalctl -u archivum-null -f        # live logs                  │
│                                                                     │
├─────────────────────────────────────────────────────────────────────┤
│  3. CLOUDFLARE TURNSTILE (CAPTCHA) — optional                       │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  Turnstile activates automatically when real keys are set:          │
│    TURNSTILE_SECRET=<server-key-from-cloudflare-dashboard>          │
│    TURNSTILE_SITE_KEY=<public-key-from-cloudflare-dashboard>        │
│    TURNSTILE_HOSTNAME=yourdomain.com   # optional hostname check    │
│                                                                     │
│  ⚠  When Turnstile is enabled the backend needs outbound HTTPS     │
│     to Cloudflare. Uncomment the firewall rules in:                 │
│       /etc/pve/firewall/<VMID>.fw                                   │
│     (Cloudflare ACCEPT + DNS lines are already prepared there)      │
│                                                                     │
├─────────────────────────────────────────────────────────────────────┤
│  4. ADMIN PANEL                                                     │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  URL:  http://<ip>:3000/admin                                       │
│  Auth: HTTP Basic (ADMIN_USER / ADMIN_PASSWORD from .env)           │
│                                                                     │
│  Features: vault listing, storage stats, force-delete vaults.       │
│  The panel returns HTTP 403 if ADMIN_PASSWORD is unchanged.         │
│  Brute-force protection: 10 requests/minute (RATE_LIMIT_ADMIN_MAX). │
│                                                                     │
├─────────────────────────────────────────────────────────────────────┤
│  5. RATE LIMITING                                                   │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  In-memory, per-IP, 4 independent buckets (per 60s window):         │
│    RATE_LIMIT_API_MAX=120       # all /api/ requests combined       │
│    RATE_LIMIT_MAX=10            # new uploads (POST /api/vault)     │
│    RATE_LIMIT_DOWNLOAD_MAX=30   # downloads                         │
│    RATE_LIMIT_ADMIN_MAX=10      # admin endpoints                   │
│                                                                     │
├─────────────────────────────────────────────────────────────────────┤
│  6. REVERSE PROXY — do NOT expose port 3000 directly                │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  nginx:  set  client_max_body_size  > CHUNK_SIZE (e.g. 15m)         │
│  Caddy:  request_body { max_size 105MB }                            │
│  Set TRUST_PROXY=1 so X-Forwarded-For is read correctly.            │
│                                                                     │
├─────────────────────────────────────────────────────────────────────┤
│  7. CHUNKED UPLOAD — large file tuning                              │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  CHUNK_SIZE=10485760         # HTTP chunk size (10 MB default)      │
│  CRYPTO_CHUNK_SIZE=5242880   # AES-GCM block (auto-calculated)      │
│  UPLOAD_SESSION_TTL=3600     # incomplete upload timeout (1h)       │
│                                                                     │
│  ⚠  If using Cloudflare Tunnel: CHUNK_SIZE must be < 100 MB.       │
│                                                                     │
├─────────────────────────────────────────────────────────────────────┤
│  8. HARDENING                                                       │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  Full guide: docs/HARDENING.md                                      │
│                                                                     │
│  Key points:                                                        │
│  • Never expose port 3000 to the public internet.                   │
│  • Use a VPS + WireGuard tunnel + reverse proxy (nginx/Caddy).      │
│  • Proxmox Firewall (already configured): blocks all egress         │
│    from this container except return traffic.                        │
│  • WireGuard AllowedIPs: use /32 only — never 0.0.0.0/0.           │
│  • Persist iptables: apt install iptables-persistent                │
│  • Keep system up to date: unattended-upgrades on the VPS.          │
│                                                                     │
├─────────────────────────────────────────────────────────────────────┤
│  9. UPDATE LATER                                                    │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  bash install-lxc.sh --update <VMID>                                │
│  (creates an optional rollback snapshot before updating)             │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
POSTINSTALL

# Replace <VMID> and <ip> in printed output with actual values
if [[ -n "$CT_IP" ]]; then
  info "Quick start:  pct enter $VMID  →  nano /opt/archivum-null/.env  →  systemctl start archivum-null"
  info "Admin panel:  http://${CT_IP}:3000/admin"
fi

if [[ "$VPN_TUN" == "true" ]]; then
  echo
  info "TUN device is enabled. Install WireGuard/OpenVPN inside the container:"
  info "  pct enter $VMID"
  info "  apt install -y --no-install-recommends wireguard-tools   # or openvpn"
fi

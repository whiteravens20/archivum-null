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
#   - Runs the app as a dedicated non-root user (UID 1001)
#   - Applies Proxmox Firewall egress rules (policy_out: DROP)
#   - REVIEW THIS SCRIPT BEFORE RUNNING IN PRODUCTION
# ─────────────────────────────────────────────────────────────────────────────

set -euo pipefail

# ── Colours and helpers ───────────────────────────────────────────────────────
green()  { printf '\033[0;32m✓\033[0m %s\n' "$*"; }
red()    { printf '\033[0;31m✗\033[0m %s\n' "$*"; }
yellow() { printf '\033[0;33m⚠\033[0m %s\n' "$*"; }
info()   { printf '\033[0;36mℹ\033[0m %s\n' "$*"; }
header() { printf '\n\033[1;37m━━━ %s ━━━\033[0m\n' "$*"; }
die()    { red "$*"; exit 1; }

# ── Argument parsing ──────────────────────────────────────────────────────────
MODE="install"
UPDATE_VMID=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --update) MODE="update"; UPDATE_VMID="${2:-}"; shift 2 ;;
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
APP_USER="archivum"
APP_UID=1001
NODE_MAJOR=24
DEFAULT_STORAGE="local-lvm"
DEFAULT_BRIDGE="vmbr0"
CT_MEMORY=512
CT_SWAP=256
CT_CORES=1
CT_DISK=4   # GiB
TEMPLATE_PATTERN="debian-13-standard"

# ─────────────────────────────────────────────────────────────────────────────
#  UPDATE MODE
# ─────────────────────────────────────────────────────────────────────────────

if [[ "$MODE" == "update" ]]; then
  [[ -n "$UPDATE_VMID" ]] || die "--update requires a <vmid> argument."
  header "Updating Archivum Null in LXC $UPDATE_VMID"

  # Optional snapshot before update
  read -rp "Create a snapshot before updating? [Y/n] " snap_ans
  snap_ans="${snap_ans:-Y}"
  if [[ "$snap_ans" =~ ^[Yy]$ ]]; then
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

  info "Fixing ownership…"
  pct exec "$UPDATE_VMID" -- chown -R "${APP_USER}:${APP_USER}" "$INSTALL_DIR"

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
info "Searching for Debian 13 CT template…"
TEMPLATE_PATH=$(pveam list local 2>/dev/null | awk '{print $1}' | grep "$TEMPLATE_PATTERN" | sort -V | tail -1 || true)

if [[ -z "$TEMPLATE_PATH" ]]; then
  info "Template not found locally — downloading…"
  pveam update
  REMOTE_TMPL=$(pveam available --section system 2>/dev/null | awk '{print $2}' | grep "$TEMPLATE_PATTERN" | sort -V | tail -1 || true)
  [[ -n "$REMOTE_TMPL" ]] || die "Could not find a Debian 13 template in the Proxmox repository."
  pveam download local "$REMOTE_TMPL"
  TEMPLATE_PATH="local:vztmpl/$REMOTE_TMPL"
fi
green "Template: $TEMPLATE_PATH"

# ── Prompt for any overrides ──────────────────────────────────────────────────
read -rp "Storage pool [$DEFAULT_STORAGE]: " STORAGE
STORAGE="${STORAGE:-$DEFAULT_STORAGE}"
read -rp "Bridge [$DEFAULT_BRIDGE]: " BRIDGE
BRIDGE="${BRIDGE:-$DEFAULT_BRIDGE}"

# ── VPN / tunnel options ──────────────────────────────────────────────────────
read -rp "Enable TUN device support (required for WireGuard/OpenVPN inside LXC)? [y/N] " _vpn_ans
VPN_TUN=false
VPN_FW_TYPE="none"
if [[ "$_vpn_ans" =~ ^[Yy]$ ]]; then
  VPN_TUN=true
  echo "  Firewall rule presets:"
  echo "    wireguard  — allow UDP 51820 outbound + DNS"
  echo "    openvpn    — allow UDP/TCP 1194 outbound + DNS"
  echo "    none       — no extra rules (configure manually)"
  read -rp "  VPN firewall preset [wireguard/openvpn/none] (default: none): " _vpn_fw
  VPN_FW_TYPE="${_vpn_fw:-none}"
  VPN_FW_TYPE="${VPN_FW_TYPE,,}"
  if [[ ! "$VPN_FW_TYPE" =~ ^(wireguard|openvpn|none)$ ]]; then
    yellow "Unknown preset '$VPN_FW_TYPE' — defaulting to 'none'."
    VPN_FW_TYPE="none"
  fi
  green "TUN support enabled; firewall preset: $VPN_FW_TYPE"
fi

# ── Build container feature flags ────────────────────────────────────────────
CT_FEATURES="keyctl=1,nesting=0"
[[ "$VPN_TUN" == "true" ]] && CT_FEATURES="${CT_FEATURES},tun=1"

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

pct start "$VMID"
sleep 3   # wait for network

green "Container started."

# ── Bootstrap function (runs inside the container via pct exec) ───────────────
bootstrap_container() {
  pct exec "$VMID" -- bash -s << 'INNER'
set -euo pipefail

APP_USER="archivum"
APP_UID=1001
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

echo "==> Creating system user '$APP_USER' (UID $APP_UID)…"
useradd -r -u "$APP_UID" -s /usr/sbin/nologin -m -d "$INSTALL_DIR" "$APP_USER" 2>/dev/null || true

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
chown -R "$APP_USER:$APP_USER" "$INSTALL_DIR"

echo "==> Installing systemd service…"
cat > /etc/systemd/system/archivum-null.service << 'EOF'
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

# Systemd hardening
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=strict
ReadWritePaths=/opt/archivum-null/data/vaults
ProtectHome=yes
CapabilityBoundingSet=
AmbientCapabilities=
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
# ESTABLISHED,RELATED allows return traffic for inbound client sessions.
#
# If Cloudflare Turnstile is enabled, uncomment the Cloudflare ACCEPT rules
# and the DNS rules below; otherwise leave them commented out.

[OPTIONS]
enable: 1
policy_in: ACCEPT
policy_out: DROP

[RULES]
# Allow return traffic for accepted inbound connections (uploads, downloads)
OUT ACCEPT -m conntrack --ctstate ESTABLISHED,RELATED

# --- Uncomment if Turnstile IS enabled ---
# OUT ACCEPT -dest 104.16.0.0/13 -proto tcp -dport 443
# OUT ACCEPT -dest 104.24.0.0/14 -proto tcp -dport 443
# OUT ACCEPT -proto udp -dport 53
# OUT ACCEPT -proto tcp -dport 53
${VPN_FW_RULES}
FW
  green "Proxmox Firewall config written to $FW_FILE"
fi

# ── Prompt to start service ───────────────────────────────────────────────────
header "Post-install steps"
yellow "IMPORTANT: Set ADMIN_PASSWORD in $VMID's .env before starting the service:"
info  "  pct enter $VMID"
info  "  nano /opt/archivum-null/.env   # set ADMIN_PASSWORD=<strong-password>"
info  "  systemctl start archivum-null"
info  "  systemctl status archivum-null"
echo
info "Container IP:"
pct exec "$VMID" -- ip -4 addr show eth0 | awk '/inet / {print "  " $2}' || true
echo
green "Installation complete. VMID: $VMID"
if [[ "$VPN_TUN" == "true" ]]; then
  info "TUN device is enabled (--features tun=1). Install WireGuard/OpenVPN inside the container:"
  info "  pct enter $VMID"
  info "  apt install -y --no-install-recommends wireguard-tools   # or openvpn"
fi
info "Refer to README → Proxmox LXC Deployment for WireGuard tunnel and reverse proxy setup."

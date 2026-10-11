#!/usr/bin/env bash
# ── Archivum Null — Proxmox LXC Installer / Updater ─────────────────────────
# Follows the Proxmox Community Scripts conventions.
# Run this on the PROXMOX HOST shell (not inside a container or VM).
#
# Usage:
#   Install (creates a new LXC):
#     bash -c "$(wget -qLO - https://github.com/whiteravens20/archivum-null/raw/main/scripts/install-lxc.sh)"
#
#   Update (moves an existing LXC to the newest release):
#     bash -c "$(wget -qLO - https://github.com/whiteravens20/archivum-null/raw/main/scripts/install-lxc.sh)" -- --update <vmid>
#
# What it installs is the newest release tag, not a development branch.
#
# Every prompt can be answered ahead of time through the environment, which makes
# an unattended run possible:
#   VMID  CT_HOSTNAME  STORAGE  BRIDGE  CT_MEMORY  CT_CORES  CT_DISK  CT_SWAP
#   NET_IP (dhcp or ADDRESS/PREFIX)  NET_GW  VPN_SW (none, wireguard, openvpn, tailscale)
#   CT_FIREWALL (yes or no)  PROXY_IP (the one address allowed to reach the app; "none" to skip)
#   SNAPSHOT (yes or no, update only)  ARCHIVUM_REF (a tag or branch in place of the newest release)
#
# Requirements (on the Proxmox host):
#   - pct, pvesh  (standard Proxmox tools)
#
# Security notes:
#   - Creates an unprivileged LXC container
#   - The app runs as its own user under a sandboxed systemd unit, never as root
#   - Applies Proxmox Firewall rules: egress dropped, inbound from the proxy only
#   - REVIEW THIS SCRIPT BEFORE RUNNING IN PRODUCTION
# ─────────────────────────────────────────────────────────────────────────────

set -euo pipefail

# Everything below is inside main(), which the last line of the file calls: a
# download that was cut short defines part of a function and runs nothing.
main() {

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

# valid_ipv4 <address> — rejects out-of-range octets that a \d{1,3} regex accepts.
valid_ipv4() {
  local _octet
  local -a _octets
  local IFS=.
  read -ra _octets <<< "$1"
  [[ ${#_octets[@]} -eq 4 ]] || return 1
  for _octet in "${_octets[@]}"; do
    [[ "$_octet" =~ ^[0-9]{1,3}$ ]] || return 1
    ((10#$_octet <= 255)) || return 1
  done
}

# pick <var_name> <prompt> <default> <option ...>
# Inline arrow-key selector (←/→ to move, Enter to confirm). A variable that already
# holds one of the options, set in the environment, is taken as the answer.
pick() {
  local _var="$1" _prompt="$2" _default="$3"
  shift 3
  local -a _opts=("$@")
  local _sel=0 _count=${#_opts[@]} _key _seq _i _preset="${!_var:-}"

  if [[ -n "$_preset" ]]; then
    for _i in "${!_opts[@]}"; do
      if [[ "${_opts[$_i]}" == "$_preset" ]]; then
        green "$_prompt $_preset"
        return
      fi
    done
    die "$_var=$_preset is not one of: ${_opts[*]}"
  fi

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
    # No input left (an unattended run): take the highlighted option, as Enter does.
    IFS= read -rsn1 _key || _key=""
    case "$_key" in
      $'\x1b')
        IFS= read -rsn2 -t 0.2 _seq || _seq=""
        case "$_seq" in
          '[C'|'[B') (( _sel = (_sel + 1) % _count )) || true ;;
          '[D'|'[A') (( _sel = (_sel - 1 + _count) % _count )) || true ;;
        esac ;;
      '') break ;;
    esac
  done
  printf '\r\033[K'
  green "$_prompt ${_opts[$_sel]}"
  printf '\033[?25h'
  printf -v "$_var" '%s' "${_opts[$_sel]}"
}

# ask <var_name> <prompt> — free text; a variable set in the environment is the answer.
ask() {
  local _var="$1" _prompt="$2" _input
  if [[ -n "${!_var:-}" ]]; then
    green "$_prompt ${!_var}"
    return
  fi
  read -rp "$_prompt " _input || _input=""
  printf -v "$_var" '%s' "$_input"
}

# ── Argument parsing ──────────────────────────────────────────────────────────
local MODE="install"
local UPDATE_VMID=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --update)
      [[ $# -ge 2 ]] || die "--update requires a <vmid> argument."
      MODE="update"; UPDATE_VMID="$2"; shift 2 ;;
    --help|-h)
      echo "Usage:"
      echo "  install-lxc.sh                     # create a new LXC and install the newest release"
      echo "  install-lxc.sh --update <vmid>     # move an existing LXC to the newest release"
      echo
      echo "Prompts can be answered through the environment; the head of the script lists the variables."
      exit 0 ;;
    *) die "Unknown option: $1" ;;
  esac
done

# ── Guards ────────────────────────────────────────────────────────────────────
[[ "$(id -u)" -eq 0 ]] || die "This script must be run as root on the Proxmox host."
command -v pct  >/dev/null 2>&1 || die "'pct' not found — run this on a Proxmox VE host."
command -v pvesh >/dev/null 2>&1 || die "'pvesh' not found — run this on a Proxmox VE host."

# ── Configuration defaults (edit before running if needed) ───────────────────
local APP_NAME="archivum-null"
local REPO_URL="https://github.com/whiteravens20/archivum-null.git"
local INSTALL_DIR="/opt/archivum-null"
local APP_PORT=3000
local NODE_MAJOR=24
local DEFAULT_STORAGE="local-lvm"
local DEFAULT_BRIDGE="vmbr0"
local DEFAULT_MEMORY=2048
local DEFAULT_SWAP=256
local DEFAULT_CORES=2
local DEFAULT_DISK=10   # GiB
local TEMPLATE_PATTERN="debian-13-standard"
local ARCHIVUM_REF="${ARCHIVUM_REF:-}"

# ─────────────────────────────────────────────────────────────────────────────
#  What runs inside the container
# ─────────────────────────────────────────────────────────────────────────────
# One script for both modes, handed to bash in the container over pct exec. An
# install and an update end in the same state: the same user, the same unit, the
# same ownership. That is also what migrates an install made by an older version
# of this installer, which ran the app as root from a development branch.

# guest <vmid> <install|update> [KEY=VALUE ...]
guest() {
  local _vmid="$1" _action="$2"
  shift 2
  # The host's locale is not installed in a fresh container; C.UTF-8 always is.
  pct exec "$_vmid" -- env \
    LC_ALL=C.UTF-8 LANG=C.UTF-8 DEBIAN_FRONTEND=noninteractive \
    ACTION="$_action" INSTALL_DIR="$INSTALL_DIR" REPO_URL="$REPO_URL" NODE_MAJOR="$NODE_MAJOR" \
    ARCHIVUM_REF="$ARCHIVUM_REF" "$@" \
    bash -s << 'INNER'
set -euo pipefail

: "${ACTION:?}" "${INSTALL_DIR:?}" "${REPO_URL:?}" "${NODE_MAJOR:?}"
VPN_SW="${VPN_SW:-none}"
ARCHIVUM_REF="${ARCHIVUM_REF:-}"
STORAGE_QUOTA="${STORAGE_QUOTA:-}"
PROXY_IP="${PROXY_IP:-}"
APP_USER=archivum
BUILD_USER=archivum-build
ENV_FILE="$INSTALL_DIR/.env"

say() { echo "==> $*"; }

# The newest release: the highest tag of the form vMAJOR.MINOR.PATCH.
newest_release() {
  git ls-remote --tags --refs "$REPO_URL" 'v[0-9]*' \
    | awk -F/ '{ print $NF }' | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' | sort -V | tail -1 || true
}

# set_env KEY VALUE — replaces the line, commented out or not; appends when there is none.
set_env() {
  local key="$1" value="$2"
  if grep -qE "^#? ?${key}=" "$ENV_FILE"; then
    sed -i -E "0,/^#? ?${key}=.*/s||${key}=${value}|" "$ENV_FILE"
  else
    printf '%s=%s\n' "$key" "$value" >> "$ENV_FILE"
  fi
}

install_packages() {
  say "Updating packages…"
  apt-get update -qq
  apt-get install -y --no-install-recommends curl git ca-certificates

  # NodeSource's apt repository, with its key pinned for apt to check every package
  # against. The alternative, a setup script piped into a root shell, is checked by
  # nobody. The Node.js it ships brings an npm that reads this project's .npmrc.
  say "Installing Node.js ${NODE_MAJOR}…"
  install -d -m 0755 /etc/apt/keyrings
  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key -o /etc/apt/keyrings/nodesource.asc
  echo "deb [signed-by=/etc/apt/keyrings/nodesource.asc] https://deb.nodesource.com/node_${NODE_MAJOR}.x nodistro main" \
    > /etc/apt/sources.list.d/nodesource.list
  apt-get update -qq
  apt-get install -y --no-install-recommends nodejs

  if [[ "$VPN_SW" != "none" ]]; then
    say "Installing VPN software (${VPN_SW})…"
    case "$VPN_SW" in
      wireguard) apt-get install -y --no-install-recommends wireguard-tools ;;
      openvpn)   apt-get install -y --no-install-recommends openvpn ;;
      tailscale)
        # Signed apt repository rather than `curl … | sh`, so the package is
        # GPG-verified by apt instead of executed as an unchecked root shell script.
        _codename=$(. /etc/os-release 2>/dev/null; echo "${VERSION_CODENAME:-}")
        [[ -n "$_codename" ]] || { echo "Cannot read VERSION_CODENAME from /etc/os-release." >&2; exit 1; }
        curl -fsSL "https://pkgs.tailscale.com/stable/debian/${_codename}.noarmor.gpg" \
          -o /usr/share/keyrings/tailscale-archive-keyring.gpg
        curl -fsSL "https://pkgs.tailscale.com/stable/debian/${_codename}.tailscale-keyring.list" \
          -o /etc/apt/sources.list.d/tailscale.list
        apt-get update -qq
        apt-get install -y --no-install-recommends tailscale
        ;;
    esac
  fi

  say "Clearing apt cache…"
  apt-get clean
  rm -rf /var/lib/apt/lists/*
}

# The app's own user. It owns the vault directory and nothing else: the code and
# the configuration belong to root, so the service cannot rewrite either.
ensure_user() {
  id "$APP_USER" >/dev/null 2>&1 \
    || useradd --system --user-group --home-dir "$INSTALL_DIR" --no-create-home --shell /usr/sbin/nologin "$APP_USER"
}

# checkout <ref> — the tree at that tag or branch, whatever was checked out before.
checkout() {
  local ref="$1" kept_tos=""
  if [[ ! -d "$INSTALL_DIR/.git" ]]; then
    say "Cloning ${ref}…"
    git clone --quiet --depth 1 --branch "$ref" "$REPO_URL" "$INSTALL_DIR"
    return
  fi
  say "Fetching ${ref}…"
  cd "$INSTALL_DIR"
  # TOS.md is a tracked file that operators are told to edit. Keep their text.
  if ! git diff --quiet -- TOS.md 2>/dev/null; then
    kept_tos=$(mktemp)
    cp TOS.md "$kept_tos"
  fi
  git fetch --quiet --depth 1 --force origin "$ref"
  git checkout --quiet --force --detach FETCH_HEAD
  if [[ -n "$kept_tos" ]]; then
    cp "$kept_tos" TOS.md
    rm -f "$kept_tos"
    say "Kept your TOS.md"
  fi
}

# Build as a user that exists for the build only: the compilers and bundlers run
# without root and without the service's identity, and what they leave behind that
# the running app does not need, the frontend's dependencies, is deleted.
build() {
  local cache
  rm -rf "$INSTALL_DIR/backend/dist" "$INSTALL_DIR/frontend/dist"
  id "$BUILD_USER" >/dev/null 2>&1 \
    || useradd --system --user-group --home-dir /nonexistent --no-create-home --shell /usr/sbin/nologin "$BUILD_USER"
  cache=$(mktemp -d /tmp/archivum-build.XXXXXX)
  chown -R "$BUILD_USER:$BUILD_USER" "$INSTALL_DIR/backend" "$INSTALL_DIR/frontend" "$cache"
  as_builder() {
    runuser -u "$BUILD_USER" -- env HOME="$cache" npm_config_cache="$cache/npm" npm_config_update_notifier=false "$@"
  }

  say "Building backend…"
  cd "$INSTALL_DIR/backend"
  as_builder npm ci --ignore-scripts
  as_builder npm run build
  as_builder npm prune --omit=dev --ignore-scripts

  say "Building frontend…"
  cd "$INSTALL_DIR/frontend"
  as_builder npm ci --ignore-scripts
  as_builder npm run build
  rm -rf "$INSTALL_DIR/frontend/node_modules"

  cd /
  chown -R root:root "$INSTALL_DIR/backend" "$INSTALL_DIR/frontend"
  rm -rf "$cache"
  userdel "$BUILD_USER" >/dev/null 2>&1 || true
}

write_unit() {
  say "Installing systemd service…"
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
EOF
  systemctl daemon-reload
  systemctl enable --quiet archivum-null
}

finish() {
  mkdir -p "$INSTALL_DIR/data/vaults"
  chown -R "$APP_USER:$APP_USER" "$INSTALL_DIR/data"
  chown root:root "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  write_unit
}

# ── install ───────────────────────────────────────────────────────────────────
if [[ "$ACTION" == "install" ]]; then
  install_packages
  ensure_user
  ref="${ARCHIVUM_REF:-$(newest_release)}"
  [[ -n "$ref" ]] || { echo "Could not find a release tag at $REPO_URL." >&2; exit 1; }
  checkout "$ref"

  say "Writing .env…"
  install -m 0600 "$INSTALL_DIR/.env.example" "$ENV_FILE"
  set_env BIND_ADDRESS 0.0.0.0
  set_env STORAGE_PATH "$INSTALL_DIR/data/vaults"
  set_env APP_VERSION "$ref"
  if [[ -n "$STORAGE_QUOTA" ]]; then set_env MAX_TOTAL_STORAGE "$STORAGE_QUOTA"; fi
  if [[ -n "$PROXY_IP" ]]; then set_env TRUST_PROXY "$PROXY_IP"; fi
  # A release whose example still carries a placeholder here would not start with it.
  sed -i -E 's|^(TRUST_PROXY=<.*>)$|# \1|' "$ENV_FILE"

  build
  finish
  echo "INSTALLED_REF=$ref"
  say "Bootstrap complete."
  exit 0
fi

# ── update ────────────────────────────────────────────────────────────────────
[[ -d "$INSTALL_DIR/.git" && -f "$ENV_FILE" ]] || { echo "No installation found at $INSTALL_DIR." >&2; exit 1; }
ref="${ARCHIVUM_REF:-$(newest_release)}"
[[ -n "$ref" ]] || { echo "Could not find a release tag at $REPO_URL." >&2; exit 1; }

current=$(sed -n 's/^APP_VERSION=//p' "$ENV_FILE" | tail -1)
unit=/etc/systemd/system/archivum-null.service
if [[ "$current" == "$ref" && -f "$INSTALL_DIR/backend/dist/index.js" ]] \
   && grep -q '^User=archivum$' "$unit" 2>/dev/null && grep -q -- '--permission' "$unit" 2>/dev/null; then
  echo "INSTALLED_REF=$ref"
  echo "UNCHANGED=yes"
  say "Already at $ref."
  exit 0
fi

say "Stopping service…"
systemctl stop archivum-null 2>/dev/null || true
ensure_user
checkout "$ref"
set_env APP_VERSION "$ref"
build
finish
say "Starting service…"
systemctl start archivum-null
echo "INSTALLED_REF=$ref"
say "Update complete."
INNER
}

# ─────────────────────────────────────────────────────────────────────────────
#  UPDATE MODE
# ─────────────────────────────────────────────────────────────────────────────

if [[ "$MODE" == "update" ]]; then
  [[ "$UPDATE_VMID" =~ ^[0-9]+$ ]] || die "--update requires a numeric <vmid>."
  pct status "$UPDATE_VMID" >/dev/null 2>&1 || die "No container with VMID $UPDATE_VMID on this host."
  header "Updating Archivum Null in LXC $UPDATE_VMID"

  # The update fetches the release and its dependencies from inside the container.
  # Checked first, while the service is still running: with egress dropped by the
  # Proxmox firewall nothing can be fetched, and the update must not begin.
  info "Checking that the container can reach the repository…"
  if ! pct exec "$UPDATE_VMID" -- timeout 20 git ls-remote --tags --refs "$REPO_URL" 'v[0-9]*' >/dev/null 2>&1; then
    red "The container cannot reach $REPO_URL."
    echo "  If its firewall drops outbound traffic, allow it for the duration of the update:"
    echo "    1. in /etc/pve/firewall/${UPDATE_VMID}.fw set  policy_out: ACCEPT"
    echo "    2. run this update again"
    echo "    3. set  policy_out: DROP  back"
    exit 1
  fi

  # Optional snapshot before update
  local SNAPSHOT="${SNAPSHOT:-}" snap_ans=""
  case "${SNAPSHOT,,}" in yes) snap_ans="Yes" ;; no) snap_ans="No" ;; esac
  pick snap_ans "Create a snapshot before updating?" "Yes" "Yes" "No"
  if [[ "$snap_ans" == "Yes" ]]; then
    local SNAP_NAME
    SNAP_NAME="pre-update-$(date +%Y%m%d-%H%M%S)"
    info "Creating snapshot '$SNAP_NAME'…"
    pct snapshot "$UPDATE_VMID" "$SNAP_NAME" --description "before archivum-null update $(date -I)"
    green "Snapshot created: $SNAP_NAME"
    info "To roll back: pct rollback $UPDATE_VMID $SNAP_NAME"
  fi

  local update_log
  update_log=$(mktemp)
  if ! guest "$UPDATE_VMID" update 2>&1 | tee "$update_log"; then
    rm -f "$update_log"
    die "Update failed inside LXC $UPDATE_VMID — see the output above. The snapshot, if you made one, restores the previous state."
  fi
  local new_ref
  new_ref=$(sed -n 's/^INSTALLED_REF=//p' "$update_log" | tail -1)
  if grep -q '^UNCHANGED=yes$' "$update_log"; then
    green "Already at ${new_ref}. Nothing to do."
  else
    green "Update complete: now at ${new_ref}."
  fi
  rm -f "$update_log"

  # Two things an install made by an older version of this script lacks, and that
  # an update does not decide for the operator.
  if pct exec "$UPDATE_VMID" -- grep -qE '^MAX_TOTAL_STORAGE=0$' "$INSTALL_DIR/.env" 2>/dev/null; then
    yellow "No storage quota is set (MAX_TOTAL_STORAGE=0): uploads can fill the container's disk."
    yellow "Set one, in bytes, in $INSTALL_DIR/.env and restart the service."
  fi
  local fw_file="/etc/pve/firewall/${UPDATE_VMID}.fw"
  if [[ -f "$fw_file" ]] && grep -qE '^policy_in:[[:space:]]*ACCEPT' "$fw_file"; then
    yellow "Every host on the container's bridge can reach the app: $fw_file has policy_in: ACCEPT."
    yellow "docs/PROXMOX.md shows how to allow your reverse proxy only."
  fi
  pct exec "$UPDATE_VMID" -- systemctl status archivum-null --no-pager --lines 0 || true
  exit 0
fi

# ─────────────────────────────────────────────────────────────────────────────
#  INSTALL MODE
# ─────────────────────────────────────────────────────────────────────────────

header "Archivum Null — Proxmox LXC Installer"

# ── Pick next free VMID (interactively) ─────────────────────────────────────
local VMID="${VMID:-}" NEXT_VMID
if [[ -z "$VMID" ]]; then
  NEXT_VMID=$(pvesh get /cluster/nextid 2>/dev/null | tr -d '[:space:]') || \
        die "Could not determine next free VMID."
  read -rp "VMID [$NEXT_VMID]: " VMID || VMID=""
  VMID="${VMID:-$NEXT_VMID}"
fi
[[ "$VMID" =~ ^[0-9]+$ ]] || die "VMID must be a positive integer."
if pct status "$VMID" >/dev/null 2>&1 || qm status "$VMID" >/dev/null 2>&1; then
  die "VMID $VMID is already in use on this host."
fi
info "Using VMID: $VMID"

local CT_HOSTNAME="${CT_HOSTNAME:-$APP_NAME}"
[[ "$CT_HOSTNAME" =~ ^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?$ ]] || die "Invalid hostname: $CT_HOSTNAME"

# ── Locate CT template ────────────────────────────────────────────────────────
# The template list mixes architectures (amd64 + arm64), so always filter by
# the host architecture — 'sort -V | tail -1' alone would pick arm64.
local HOST_ARCH TEMPLATE_PATH REMOTE_TMPL
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
local -a _storages _bridges
local STORAGE="${STORAGE:-}" BRIDGE="${BRIDGE:-}"
mapfile -t _storages < <(pvesm status --content rootdir 2>/dev/null \
  | awk 'NR>1 && $3=="active" {print $1}' | sort)
[[ ${#_storages[@]} -gt 0 ]] || die "No active storage with 'rootdir' content found (pvesm status)."
# DEFAULT_STORAGE is only a preference — pick() falls back to the first
# detected pool when it does not exist on this host (e.g. ZFS-only setups).
pick STORAGE "Storage pool:" "$DEFAULT_STORAGE" "${_storages[@]}"

# Only offer vmbr* — 'type bridge' also lists Proxmox's per-NIC fwbr* bridges.
mapfile -t _bridges < <(ip -o link show type bridge 2>/dev/null \
  | awk -F': ' '{print $2}' | grep '^vmbr' | sort)
[[ ${#_bridges[@]} -eq 0 ]] && _bridges=("$DEFAULT_BRIDGE")
pick BRIDGE "Network bridge:" "$DEFAULT_BRIDGE" "${_bridges[@]}"

# ── Container resources ───────────────────────────────────────────────────────
local CT_MEMORY="${CT_MEMORY:-}" CT_CORES="${CT_CORES:-}" CT_DISK="${CT_DISK:-}" CT_SWAP="${CT_SWAP:-}"
info "Preselected values are the recommended sizing for Archivum Null."
pick CT_MEMORY "RAM (MB):" "$DEFAULT_MEMORY" "512" "1024" "2048" "4096" "8192"
pick CT_CORES  "CPU cores:" "$DEFAULT_CORES" "1" "2" "4" "6" "8"
pick CT_DISK   "Disk (GiB):" "$DEFAULT_DISK" "4" "8" "10" "20" "40" "80"
pick CT_SWAP   "Swap (MB):"  "$DEFAULT_SWAP" "0" "256" "512" "1024"

# The vaults may fill six tenths of the disk, in whole GiB. The rest stays for the
# system, the app with its dependencies and the logs; without a quota an upload
# could fill it.
local QUOTA_GIB=$(( CT_DISK * 6 / 10 ))
(( QUOTA_GIB >= 1 )) || QUOTA_GIB=1
local STORAGE_QUOTA=$(( QUOTA_GIB * 1024 * 1024 * 1024 ))

# ── Network addressing ────────────────────────────────────────────────────────
local NET_IP="${NET_IP:-}" NET_GW="${NET_GW:-}" IP_MODE="" _prefix
if [[ "$NET_IP" == "dhcp" ]]; then
  IP_MODE="dhcp"
elif [[ -n "$NET_IP" ]]; then
  IP_MODE="static"
fi
pick IP_MODE "IPv4 address:" "dhcp" "dhcp" "static"
if [[ "$IP_MODE" == "static" ]]; then
  ask NET_IP "IPv4 address (CIDR, e.g. 192.168.1.50/24):"
  [[ "$NET_IP" == */* ]] || die "Invalid CIDR address — expected ADDRESS/PREFIX."
  valid_ipv4 "${NET_IP%/*}" || die "Invalid CIDR address."
  _prefix="${NET_IP##*/}"
  [[ "$_prefix" =~ ^[0-9]{1,2}$ ]] || die "Invalid CIDR prefix — expected 0–32."
  ((10#$_prefix <= 32)) || die "Invalid CIDR prefix — expected 0–32."
  ask NET_GW "Gateway:"
  valid_ipv4 "$NET_GW" || die "Invalid gateway address."
else
  NET_IP="dhcp"
  NET_GW=""
fi
# firewall=1 stays on the veth even when the firewall prompt is answered "No":
# without a ${VMID}.fw file the guest chain holds no rules, so egress is
# unrestricted either way, and the flag lets rules be added later without
# editing the NIC.
local NET0="name=eth0,bridge=${BRIDGE},ip=${NET_IP},firewall=1"
[[ -n "$NET_GW" ]] && NET0+=",gw=${NET_GW}"

# ── VPN / tunnel options ──────────────────────────────────────────────────────
# The chosen VPN software is installed during bootstrap — before any egress
# rules apply — and the firewall preset (if the firewall is enabled) opens the
# matching outbound ports, so the tunnel works out of the box. 'none' = manual.
local VPN_SW="${VPN_SW:-}" VPN_TUN=false _vpn_ans=""
if [[ -n "$VPN_SW" ]]; then
  if [[ "$VPN_SW" == "none" ]]; then _vpn_ans="No"; else _vpn_ans="Yes"; fi
fi
pick _vpn_ans "TUN device (VPN / Tunneling):" "No" "No" "Yes"
if [[ "$_vpn_ans" == "Yes" ]]; then
  VPN_TUN=true
  pick VPN_SW "VPN software to preinstall:" "none" "none" "wireguard" "openvpn" "tailscale"
else
  VPN_SW="none"
fi

# ── Proxmox firewall choice ───────────────────────────────────────────────────
local CT_FIREWALL="${CT_FIREWALL:-}" _fw_ans=""
case "${CT_FIREWALL,,}" in yes|true) _fw_ans="Yes" ;; no|false) _fw_ans="No" ;; esac
info "Egress DROP blocks all container-initiated outbound traffic (recommended)."
pick _fw_ans "Configure Proxmox firewall (egress DROP):" "Yes" "Yes" "No"
CT_FIREWALL=false
[[ "$_fw_ans" == "Yes" ]] && CT_FIREWALL=true

# ── The one host that may reach the app ───────────────────────────────────────
# Without this every host on the bridge can talk to the app and its admin API. The
# address also becomes TRUST_PROXY, the peer whose X-Forwarded-For the app believes.
local PROXY_IP="${PROXY_IP:-}"
if [[ -z "$PROXY_IP" ]]; then
  echo
  info "Which address does your reverse proxy connect from? Only that address will be"
  info "allowed to reach the app. For a tunnel that ends inside this container, give the"
  info "proxy's tunnel address. Leave blank to decide later: the app is then open to"
  info "every host on $BRIDGE."
  read -rp "Reverse proxy address []: " PROXY_IP || PROXY_IP=""
fi
[[ "${PROXY_IP,,}" == "none" ]] && PROXY_IP=""
if [[ -n "$PROXY_IP" ]]; then
  valid_ipv4 "$PROXY_IP" || die "Invalid reverse proxy address: $PROXY_IP (an IPv4 address, or leave blank)."
fi

# ── Build container feature flags ────────────────────────────────────────────
# nesting=1 is required: Debian 13 ships systemd 257, which needs it in an
# unprivileged CT to mount /tmp, /dev/mqueue and /run/lock, and for the
# namespaces the service's sandbox is built from.
local CT_FEATURES="nesting=1"

# ── Create the container ──────────────────────────────────────────────────────
header "Creating LXC container (VMID: $VMID)"
pct create "$VMID" "$TEMPLATE_PATH" \
  --unprivileged 1 \
  --hostname "$CT_HOSTNAME" \
  --memory "$CT_MEMORY" \
  --swap "$CT_SWAP" \
  --cores "$CT_CORES" \
  --net0 "$NET0" \
  --rootfs "${STORAGE}:${CT_DISK}" \
  --onboot 1 \
  --features "$CT_FEATURES"

# ── Enable TUN device passthrough (if requested) ─────────────────────────────
if [[ "$VPN_TUN" == "true" ]]; then
  info "Enabling TUN device passthrough in LXC config…"
  local LXC_CONF="/etc/pve/lxc/${VMID}.conf"
  # Read and write on the device are enough to open a tunnel. The node itself is
  # bind-mounted from the host, so the container needs no right to create it.
  cat >> "$LXC_CONF" << 'TUN'
lxc.cgroup2.devices.allow: c 10:200 rw
lxc.mount.entry: /dev/net dev/net none bind,create=dir
lxc.mount.entry: /dev/net/tun dev/net/tun none bind,create=file
TUN
  green "TUN device enabled via LXC config."
fi

pct start "$VMID"

# Wait for the network for real — a fixed sleep races DHCP and the bootstrap
# then dies on its first apt-get call.
info "Waiting for the container network…"
local _net_ok=false
for _ in $(seq 1 30); do
  if pct exec "$VMID" -- sh -c 'ip -4 addr show eth0 2>/dev/null | grep -q " inet " \
      && getent hosts deb.debian.org >/dev/null 2>&1'; then
    _net_ok=true; break
  fi
  sleep 2
done
[[ "$_net_ok" == "true" ]] || die "Container network did not come up within 60s."

green "Container started."

header "Installing Archivum Null inside LXC $VMID"
local install_log INSTALLED_REF
install_log=$(mktemp)
if ! guest "$VMID" install VPN_SW="$VPN_SW" STORAGE_QUOTA="$STORAGE_QUOTA" PROXY_IP="$PROXY_IP" 2>&1 | tee "$install_log"; then
  rm -f "$install_log"
  die "Bootstrap failed inside LXC $VMID — see the output above."
fi
INSTALLED_REF=$(sed -n 's/^INSTALLED_REF=//p' "$install_log" | tail -1)
rm -f "$install_log"
green "Application installed: ${INSTALLED_REF:-unknown version}."

# ── Apply Proxmox Firewall rules ──────────────────────────────────────────────
header "Configuring Proxmox Firewall (egress containment, inbound from the proxy)"

local FW_FILE="/etc/pve/firewall/${VMID}.fw" VPN_FW_RULES POLICY_IN INBOUND_RULES DHCP_OPTION
if [[ "$CT_FIREWALL" != "true" ]]; then
  info "Skipped on request — the container's traffic is unrestricted in both directions."
elif [[ -f "$FW_FILE" ]]; then
  yellow "Firewall config $FW_FILE already exists — skipping (edit manually if needed)."
else
  # Build optional VPN firewall rules
  case "$VPN_SW" in
    wireguard)
      VPN_FW_RULES="
# WireGuard VPN outbound (standard peer port — adjust if your peer differs)
OUT ACCEPT -proto udp -dport 51820
OUT ACCEPT -proto udp -dport 53
OUT ACCEPT -proto tcp -dport 53"
      ;;
    tailscale)
      VPN_FW_RULES="
# Tailscale outbound (control plane + DERP relays over 443, STUN, WireGuard)
OUT ACCEPT -proto tcp -dport 443
OUT ACCEPT -proto udp -dport 3478
OUT ACCEPT -proto udp -dport 41641
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

  if [[ -n "$PROXY_IP" ]]; then
    POLICY_IN="DROP"
    INBOUND_RULES="# The reverse proxy, the one host that may reach the app
IN ACCEPT -source ${PROXY_IP} -proto tcp -dport ${APP_PORT}"
  else
    POLICY_IN="ACCEPT"
    INBOUND_RULES="# No reverse proxy address was given at install time, so every host on the bridge
# can reach the app. To allow the proxy only, set policy_in to DROP above and add:
# IN ACCEPT -source <proxy-address> -proto tcp -dport ${APP_PORT}"
  fi

  # With both policies on DROP a lease could not be renewed without this.
  DHCP_OPTION=""
  [[ "$NET_IP" == "dhcp" ]] && DHCP_OPTION=$'\ndhcp: 1'

  cat > "$FW_FILE" << FW
# Archivum Null — container firewall
# policy_out: DROP blocks all container-initiated outbound connections.
# Return traffic for inbound client sessions is allowed automatically:
# pve-firewall inserts a RELATED,ESTABLISHED accept at the top of every guest
# chain, and its ruleset format does not parse raw iptables options anyway.
#
# If Cloudflare Turnstile is enabled, uncomment the Cloudflare ACCEPT rules
# and the DNS rules below; otherwise leave them commented out.
#
# An update fetches the new release from inside the container: set policy_out to
# ACCEPT for its duration, then back to DROP.

[OPTIONS]
enable: 1
policy_in: ${POLICY_IN}
policy_out: DROP${DHCP_OPTION}

[RULES]
${INBOUND_RULES}

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
if [[ "$CT_FIREWALL" == "true" ]] && pve-firewall status 2>/dev/null | grep -q "disabled"; then
  yellow "The DATACENTER firewall is disabled — the rules above have NO effect:"
  yellow "the container can connect anywhere, and anything on $BRIDGE can connect to it."
  yellow "Enable it under Datacenter → Firewall → Options (review host rules first),"
  yellow "or set 'enable: 1' under [OPTIONS] in /etc/pve/firewall/cluster.fw."
fi
if [[ "$CT_FIREWALL" == "true" && -z "$PROXY_IP" ]]; then
  yellow "No reverse proxy address given: every host on $BRIDGE can reach the app and its admin API."
  yellow "Edit $FW_FILE to allow the proxy only, and set TRUST_PROXY in .env."
fi

# ── Post-install summary ──────────────────────────────────────────────────────
local CT_IP
CT_IP=$(pct exec "$VMID" -- ip -4 addr show eth0 2>/dev/null \
  | awk '/inet / {sub(/\/.*/, "", $2); print $2}' || true)

header "Installation complete — VMID: $VMID"
[[ -n "$CT_IP" ]] && info "Container IP: $CT_IP"
info "Installed release: ${INSTALLED_REF:-unknown}"
info "Storage quota: ${QUOTA_GIB} GiB of the ${CT_DISK} GiB disk (MAX_TOTAL_STORAGE)"
if [[ -n "$PROXY_IP" ]]; then
  info "Reverse proxy: $PROXY_IP (TRUST_PROXY, and the only address the firewall lets in)"
fi

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
│                                                                     │
│  Set by this installer, review:                                     │
│    MAX_TOTAL_STORAGE         # quota for all vaults, see above      │
│    TRUST_PROXY               # your reverse proxy, if you gave one. │
│                              # Unset, the app ignores the proxy's   │
│                              # X-Forwarded-For and all visitors     │
│                              # share one rate-limit bucket.         │
│    APP_VERSION               # the release that was installed       │
│                                                                     │
│  Recommended to review:                                             │
│    PORT=3000                 # backend listen port                  │
│    BIND_ADDRESS=0.0.0.0      # listen on all interfaces             │
│    MAX_FILE_SIZE=104857600   # max upload size (bytes, default 100M)│
│    DEFAULT_TTL=86400         # default vault TTL (24h)              │
│    MAX_TTL=604800            # max vault TTL (7 days)               │
│                                                                     │
├─────────────────────────────────────────────────────────────────────┤
│  2. START THE SERVICE                                               │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  systemctl start archivum-null                                      │
│  systemctl status archivum-null                                     │
│  journalctl -u archivum-null -f        # live logs                  │
│  curl -s http://127.0.0.1:3000/api/health                           │
│                                                                     │
│  The service runs as the user "archivum" under a sandboxed unit.    │
│  It can write to /opt/archivum-null/data/vaults and nowhere else.   │
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
│  URL:  https://<your-domain>/admin, through your reverse proxy      │
│  Auth: HTTP Basic (ADMIN_USER / ADMIN_PASSWORD from .env)           │
│                                                                     │
│  ⚠  Do not log in at http://<ip>:3000/admin from the LAN: the      │
│     password would cross the network unencrypted.                   │
│                                                                     │
│  Features: vault listing, storage stats, force-delete vaults.       │
│  The panel returns HTTP 403 if ADMIN_PASSWORD is unchanged.         │
│  After 10 failed logins in a minute (RATE_LIMIT_ADMIN_MAX) the      │
│  client is locked out until the minute is over.                     │
│                                                                     │
├─────────────────────────────────────────────────────────────────────┤
│  5. RATE LIMITING                                                   │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  In-memory, per-IP, 4 independent buckets (per 60s window):         │
│    RATE_LIMIT_API_MAX=120       # all /api/ requests combined       │
│    RATE_LIMIT_MAX=10            # new uploads (POST /api/vault)     │
│    RATE_LIMIT_DOWNLOAD_MAX=30   # downloads                         │
│    RATE_LIMIT_ADMIN_MAX=10      # failed admin logins               │
│                                                                     │
├─────────────────────────────────────────────────────────────────────┤
│  6. REVERSE PROXY — do NOT expose port 3000 directly                │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  nginx:  set  client_max_body_size  > CHUNK_SIZE (e.g. 15m)         │
│  Caddy:  request_body { max_size 15MB }                             │
│  TRUST_PROXY must name the address the proxy connects from          │
│  (loopback if it runs in here).                                     │
│                                                                     │
├─────────────────────────────────────────────────────────────────────┤
│  7. CHUNKED UPLOAD — large file tuning                              │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  CHUNK_SIZE=10485760         # HTTP chunk size (10 MB default)      │
│  CRYPTO_CHUNK_SIZE           # AES-GCM block; leave unset, it is    │
│                              # derived from CHUNK_SIZE              │
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
│  • Proxmox Firewall (if configured): blocks all egress from this    │
│    container and lets only the reverse proxy in. It works only      │
│    while the DATACENTER firewall is enabled.                        │
│  • WireGuard AllowedIPs: use /32 only — never 0.0.0.0/0.           │
│  • Keep the container's packages up to date (apt upgrade), Node.js  │
│    included: this installer does not do it for you.                 │
│                                                                     │
├─────────────────────────────────────────────────────────────────────┤
│  9. WHERE YOUR CONFIGURATION LIVES                                  │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  Inside the container (pct enter <VMID>):                           │
│    /opt/archivum-null/.env     runtime settings (see section 1)     │
│    /opt/archivum-null/TOS.md   terms of service shown at /tos       │
│      → edit, then restart:  systemctl restart archivum-null         │
│    /opt/archivum-null/branding/   your own logo and icons           │
│      → file names in docs/BRANDING.md, then restart as above        │
│    /etc/systemd/system/archivum-null.service   service unit,        │
│      rewritten by every update: put your own changes in a drop-in   │
│      (systemctl edit archivum-null)                                 │
│                                                                     │
│  On the Proxmox host:                                               │
│    /etc/pve/firewall/<VMID>.fw   firewall rules (if configured)     │
│    /etc/pve/lxc/<VMID>.conf      container config (TUN, features)   │
│                                                                     │
├─────────────────────────────────────────────────────────────────────┤
│  10. UPDATE LATER                                                   │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  bash install-lxc.sh --update <VMID>                                │
│  Moves the container to the newest release and offers a rollback    │
│  snapshot first. It needs outbound access for its duration: set     │
│  policy_out to ACCEPT in the .fw file, update, set it back to DROP. │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
POSTINSTALL

if [[ -n "$CT_IP" ]]; then
  info "Quick start:  pct enter $VMID  →  nano /opt/archivum-null/.env  →  systemctl start archivum-null"
  info "Health check: pct exec $VMID -- curl -s http://127.0.0.1:${APP_PORT}/api/health"
fi

if [[ "$VPN_TUN" == "true" ]]; then
  echo
  case "$VPN_SW" in
    tailscale)
      info "Tailscale is preinstalled. Bring the tunnel up:  pct enter $VMID  →  tailscale up" ;;
    wireguard)
      info "WireGuard tools are preinstalled. Configure /etc/wireguard/wg0.conf inside the container." ;;
    openvpn)
      info "OpenVPN is preinstalled. Drop your client config in /etc/openvpn/client/ inside the container." ;;
    *)
      info "TUN device is enabled. Install your VPN software inside the container:"
      info "  pct enter $VMID"
      info "  apt-get install -y --no-install-recommends wireguard-tools   # or openvpn / tailscale"
      ;;
  esac
fi

}

main "$@"

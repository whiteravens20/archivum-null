#!/usr/bin/env bash
# ── Archivum Null — Firewall Rules Setup ─────────────────────────────────────
# Interactive script that applies the correct egress-containment and inbound
# port-protection rules for your deployment type.
#
# Supported deployment targets:
#   1) Docker (host FORWARD rules on bridge br-archivum)
#   2) Bare-metal / Proxmox LXC inside the container (OUTPUT rules per UID)
#   3) Proxmox LXC — host veth FORWARD rules (run on the Proxmox host)
#
# What it configures:
#   Inbound  — allow the app port only from the tunnel/WireGuard interface;
#              drop from all other interfaces (LAN, WAN)
#   Egress   — block container/process outbound to RFC 1918 LAN + internet,
#              optionally allow Cloudflare Turnstile endpoints only
#
# Usage (interactive):
#   sudo bash scripts/setup-firewall.sh
#
# Usage (non-interactive / CI):
#   sudo bash scripts/setup-firewall.sh \
#     --mode docker \
#     --backend iptables \
#     --turnstile yes \
#     --tunnel-iface wg0 \
#     --app-port 3000 \
#     --bridge br-archivum \
#     --dry-run
#
# Flags:
#   --mode          docker | bare-metal | proxmox-veth
#   --backend       iptables | nftables  (auto-detected if omitted)
#   --turnstile     yes | no
#   --tunnel-iface  interface name (e.g. wg0, tun0) — inbound guard only
#   --app-port      default: 3000
#   --bridge        Docker bridge name (mode=docker), default: br-archivum
#   --veth          veth interface name (mode=proxmox-veth), e.g. veth200i0
#   --app-uid       UID of the app process (mode=bare-metal)
#   --dry-run       Print commands without executing them
#   --persist       Automatically persist rules after applying
# ─────────────────────────────────────────────────────────────────────────────

set -euo pipefail

# ── Colours ───────────────────────────────────────────────────────────────────
red()    { printf '\033[0;31m%s\033[0m\n' "$*"; }
green()  { printf '\033[0;32m%s\033[0m\n' "$*"; }
yellow() { printf '\033[0;33m%s\033[0m\n' "$*"; }
cyan()   { printf '\033[0;36m%s\033[0m\n' "$*"; }
bold()   { printf '\033[1m%s\033[0m\n' "$*"; }
die()    { red "ERROR: $*"; exit 1; }

# ── Defaults ──────────────────────────────────────────────────────────────────
MODE=""
BACKEND=""
TURNSTILE=""
TUNNEL_IFACE=""
APP_PORT="3000"
BRIDGE="br-archivum"
VETH=""
APP_UID=""
DRY_RUN=0
AUTO_PERSIST=0

# ── Argument parsing ──────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case "$1" in
    --mode)          MODE="$2";         shift 2 ;;
    --backend)       BACKEND="$2";      shift 2 ;;
    --turnstile)     TURNSTILE="$2";    shift 2 ;;
    --tunnel-iface)  TUNNEL_IFACE="$2"; shift 2 ;;
    --app-port)      APP_PORT="$2";     shift 2 ;;
    --bridge)        BRIDGE="$2";       shift 2 ;;
    --veth)          VETH="$2";         shift 2 ;;
    --app-uid)       APP_UID="$2";      shift 2 ;;
    --dry-run)       DRY_RUN=1;         shift   ;;
    --persist)       AUTO_PERSIST=1;    shift   ;;
    --help|-h)
      sed -n '3,50p' "$0" | grep '^#' | sed 's/^# \?//'
      exit 0 ;;
    *) die "Unknown option: $1" ;;
  esac
done

# ── Guard: must run as root ───────────────────────────────────────────────────
[[ "$(id -u)" -eq 0 ]] || die "This script must be run as root (sudo)."

# ── Helper: execute or print ──────────────────────────────────────────────────
run() {
  if [[ $DRY_RUN -eq 1 ]]; then
    cyan "  [dry-run] $*"
  else
    "$@"
  fi
}

# ── Auto-detect firewall backend ──────────────────────────────────────────────
detect_backend() {
  if [[ -n "$BACKEND" ]]; then return; fi
  if command -v nft >/dev/null 2>&1; then
    BACKEND="nftables"
  elif command -v iptables >/dev/null 2>&1; then
    BACKEND="iptables"
  else
    die "Neither 'nft' nor 'iptables' found. Install one and retry."
  fi
  yellow "Auto-detected firewall backend: $BACKEND"
}

# ── Interactive prompts ───────────────────────────────────────────────────────
prompt() {
  local var_name="$1" prompt_text="$2" default="$3"
  local current
  current="${!var_name:-}"
  if [[ -n "$current" ]]; then return; fi   # already set via flag
  read -rp "$(bold "$prompt_text") [${default}]: " input
  printf -v "$var_name" '%s' "${input:-$default}"
}

prompt_choice() {
  local var_name="$1" prompt_text="$2"
  local current
  current="${!var_name:-}"
  if [[ -n "$current" ]]; then return; fi
  local choice
  while true; do
    read -rp "$(bold "$prompt_text"): " choice
    case "${choice,,}" in
      yes|no|docker|bare-metal|proxmox-veth|iptables|nftables) break ;;
      *) yellow "  Please enter one of the listed options." ;;
    esac
  done
  printf -v "$var_name" '%s' "$choice"
}

# ── Cloudflare Turnstile IPv4 ranges ─────────────────────────────────────────
CF_RANGES=("104.16.0.0/13" "104.24.0.0/14")

# ─────────────────────────────────────────────────────────────────────────────
#  INBOUND GUARD — allow app port only via tunnel interface
# ─────────────────────────────────────────────────────────────────────────────

apply_inbound_iptables() {
  local iface="$1" port="$2"
  echo
  bold "── Inbound rules (iptables) ──"
  run iptables -A INPUT -i "$iface" -p tcp --dport "$port" -j ACCEPT
  run iptables -A INPUT -p tcp --dport "$port" -j DROP
  green "  Inbound: port $port allowed only on $iface"
}

apply_inbound_nftables() {
  local iface="$1" port="$2"
  echo
  bold "── Inbound rules (nftables) ──"
  run nft add rule inet filter input tcp dport "$port" iifname "$iface" accept
  run nft add rule inet filter input tcp dport "$port" drop
  green "  Inbound: port $port allowed only on $iface"
}

# ─────────────────────────────────────────────────────────────────────────────
#  MODE: docker  — FORWARD rules on bridge
# ─────────────────────────────────────────────────────────────────────────────

apply_docker_iptables() {
  local br="$1" turnstile="$2"
  echo
  bold "── Docker egress rules (iptables, bridge: $br) ──"

  run iptables -I FORWARD -i "$br" -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT

  for cidr in "10.0.0.0/8" "172.16.0.0/12" "192.168.0.0/16" "169.254.0.0/16"; do
    run iptables -I FORWARD -i "$br" -d "$cidr" -j DROP
  done

  if [[ "${turnstile,,}" == "yes" ]]; then
    for cf in "${CF_RANGES[@]}"; do
      run iptables -I FORWARD -i "$br" -d "$cf" -p tcp --dport 443 -j ACCEPT
    done
    green "  Cloudflare Turnstile ACCEPT rules added"
  fi

  run iptables -A FORWARD -i "$br" -j DROP
  green "  Docker egress: all other outbound from $br dropped"
}

apply_docker_nftables() {
  local br="$1" turnstile="$2"
  echo
  bold "── Docker egress rules (nftables, bridge: $br) ──"

  run nft add rule inet filter forward iifname "$br" ct state established,related accept
  run nft add rule inet filter forward iifname "$br" \
      ip daddr "{ 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 169.254.0.0/16 }" drop

  if [[ "${turnstile,,}" == "yes" ]]; then
    run nft add rule inet filter forward iifname "$br" \
        ip daddr "{ 104.16.0.0/13, 104.24.0.0/14 }" tcp dport 443 accept
    green "  Cloudflare Turnstile ACCEPT rules added"
  fi

  run nft add rule inet filter forward iifname "$br" drop
  green "  Docker egress: all other outbound from $br dropped"
}

# ─────────────────────────────────────────────────────────────────────────────
#  MODE: bare-metal  — OUTPUT rules per UID
# ─────────────────────────────────────────────────────────────────────────────

apply_baremetal_iptables() {
  local uid="$1" turnstile="$2"
  echo
  bold "── Bare-metal egress rules (iptables, UID: $uid) ──"

  for cidr in "10.0.0.0/8" "172.16.0.0/12" "192.168.0.0/16" "169.254.0.0/16"; do
    run iptables -I OUTPUT -m owner --uid-owner "$uid" -d "$cidr" -j DROP
  done

  if [[ "${turnstile,,}" == "yes" ]]; then
    for cf in "${CF_RANGES[@]}"; do
      run iptables -I OUTPUT -m owner --uid-owner "$uid" -d "$cf" -p tcp --dport 443 -j ACCEPT
    done
    green "  Cloudflare Turnstile ACCEPT rules added"
  fi

  run iptables -A OUTPUT -m owner --uid-owner "$uid" -j DROP
  green "  Bare-metal egress: all other outbound from UID $uid dropped"
}

apply_baremetal_nftables() {
  local uid="$1" turnstile="$2"
  echo
  bold "── Bare-metal egress rules (nftables, UID: $uid) ──"
  yellow "  Note: nftables meta skuid matching requires kernel 4.10+ and nft 0.9+"

  run nft add rule inet filter output meta skuid "$uid" \
      ip daddr "{ 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 169.254.0.0/16 }" drop

  if [[ "${turnstile,,}" == "yes" ]]; then
    run nft add rule inet filter output meta skuid "$uid" \
        ip daddr "{ 104.16.0.0/13, 104.24.0.0/14 }" tcp dport 443 accept
    green "  Cloudflare Turnstile ACCEPT rules added"
  fi

  run nft add rule inet filter output meta skuid "$uid" drop
  green "  Bare-metal egress: all other outbound from UID $uid dropped"
}

# ─────────────────────────────────────────────────────────────────────────────
#  MODE: proxmox-veth  — FORWARD rules on veth interface (Proxmox host)
# ─────────────────────────────────────────────────────────────────────────────

apply_proxmox_iptables() {
  local veth="$1" turnstile="$2"
  echo
  bold "── Proxmox veth egress rules (iptables, interface: $veth) ──"

  run iptables -I FORWARD -i "$veth" -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT

  for cidr in "10.0.0.0/8" "172.16.0.0/12" "192.168.0.0/16" "169.254.0.0/16"; do
    run iptables -I FORWARD -i "$veth" -d "$cidr" -j DROP
  done

  if [[ "${turnstile,,}" == "yes" ]]; then
    for cf in "${CF_RANGES[@]}"; do
      run iptables -I FORWARD -i "$veth" -d "$cf" -p tcp --dport 443 -j ACCEPT
    done
    green "  Cloudflare Turnstile ACCEPT rules added"
  fi

  run iptables -A FORWARD -i "$veth" -j DROP
  green "  Proxmox veth egress: all other outbound from $veth dropped"
}

apply_proxmox_nftables() {
  local veth="$1" turnstile="$2"
  echo
  bold "── Proxmox veth egress rules (nftables, interface: $veth) ──"

  run nft add rule inet filter forward iifname "$veth" ct state established,related accept
  run nft add rule inet filter forward iifname "$veth" \
      ip daddr "{ 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 169.254.0.0/16 }" drop

  if [[ "${turnstile,,}" == "yes" ]]; then
    run nft add rule inet filter forward iifname "$veth" \
        ip daddr "{ 104.16.0.0/13, 104.24.0.0/14 }" tcp dport 443 accept
    green "  Cloudflare Turnstile ACCEPT rules added"
  fi

  run nft add rule inet filter forward iifname "$veth" drop
  green "  Proxmox veth egress: all other outbound from $veth dropped"
}

# ─────────────────────────────────────────────────────────────────────────────
#  PERSIST helpers
# ─────────────────────────────────────────────────────────────────────────────

persist_iptables() {
  echo
  bold "── Persisting iptables rules ──"
  if command -v netfilter-persistent >/dev/null 2>&1; then
    run netfilter-persistent save
    green "  Saved via netfilter-persistent"
  elif command -v iptables-save >/dev/null 2>&1; then
    local save_file="/etc/iptables/rules.v4"
    mkdir -p "$(dirname "$save_file")"
    if [[ $DRY_RUN -eq 1 ]]; then
      cyan "  [dry-run] iptables-save > $save_file"
    else
      iptables-save > "$save_file"
      green "  Saved to $save_file"
    fi
  else
    yellow "  Could not auto-persist: install 'iptables-persistent' (apt install iptables-persistent)"
  fi
}

persist_nftables() {
  echo
  bold "── Persisting nftables rules ──"
  local conf="/etc/nftables.conf"
  if [[ $DRY_RUN -eq 1 ]]; then
    cyan "  [dry-run] nft list ruleset > $conf"
    cyan "  [dry-run] systemctl enable --now nftables"
  else
    nft list ruleset > "$conf"
    systemctl enable --now nftables 2>/dev/null || true
    green "  Saved to $conf and nftables service enabled"
  fi
}

# ─────────────────────────────────────────────────────────────────────────────
#  MAIN
# ─────────────────────────────────────────────────────────────────────────────

bold "═══════════════════════════════════════════"
bold " Archivum Null — Firewall Setup"
bold "═══════════════════════════════════════════"
[[ $DRY_RUN -eq 1 ]] && yellow " (DRY RUN — no changes will be made)"
echo

# Collect missing values interactively
echo "Deployment mode:"
echo "  docker       — Docker Compose on a homelab/bare-metal host"
echo "  bare-metal   — Node.js running directly on the OS (or inside an LXC)"
echo "  proxmox-veth — Proxmox host: FORWARD rules on the LXC veth interface"
prompt_choice MODE "Select mode [docker/bare-metal/proxmox-veth]"
MODE="${MODE,,}"
[[ "$MODE" =~ ^(docker|bare-metal|proxmox-veth)$ ]] || die "Invalid mode: $MODE"

echo
echo "Firewall backend:"
echo "  iptables — classic, widely supported"
echo "  nftables — modern default on Debian 11+/Ubuntu 22+/Fedora"
detect_backend
prompt_choice BACKEND "Select backend [iptables/nftables]"
BACKEND="${BACKEND,,}"
[[ "$BACKEND" =~ ^(iptables|nftables)$ ]] || die "Invalid backend: $BACKEND"

echo
prompt TURNSTILE "Is Cloudflare Turnstile enabled? [yes/no]" "no"
TURNSTILE="${TURNSTILE,,}"
[[ "$TURNSTILE" =~ ^(yes|no)$ ]] || die "Invalid value for --turnstile: $TURNSTILE"

# Mode-specific parameter collection
case "$MODE" in
  docker)
    echo
    prompt BRIDGE "Docker bridge interface name" "br-archivum"
    ;;
  bare-metal)
    echo
    if [[ -z "$APP_UID" ]]; then
      if id archivum >/dev/null 2>&1; then
        APP_UID=$(id -u archivum)
        yellow "Auto-detected UID for 'archivum': $APP_UID"
      fi
    fi
    prompt APP_UID "UID of the Node.js process (run: id archivum)" "${APP_UID:-1001}"
    ;;
  proxmox-veth)
    echo
    if [[ -z "$VETH" ]]; then
      yellow "Tip: find the veth name with: ip link show | grep veth"
    fi
    prompt VETH "veth interface name on the Proxmox host (e.g. veth200i0)" ""
    [[ -n "$VETH" ]] || die "veth interface name is required for proxmox-veth mode"
    ;;
esac

# Inbound tunnel guard (optional)
echo
yellow "Inbound port guard (optional): restricts the app port to a tunnel interface only."
yellow "Skip if you handle inbound access elsewhere (e.g. HOST_BIND_ADDRESS in .env)."
prompt TUNNEL_IFACE "Tunnel interface for inbound guard (leave blank to skip)" ""

prompt APP_PORT "App port" "3000"

# Persist prompt
if [[ $AUTO_PERSIST -eq 0 && $DRY_RUN -eq 0 ]]; then
  echo
  read -rp "$(bold "Persist rules so they survive reboot? [y/N]: ")" persist_ans
  [[ "${persist_ans,,}" == "y" ]] && AUTO_PERSIST=1
fi

# ── Summary ───────────────────────────────────────────────────────────────────
echo
bold "───────────────────────────────────────────"
bold " Plan"
bold "───────────────────────────────────────────"
echo "  Mode:      $MODE"
echo "  Backend:   $BACKEND"
echo "  Turnstile: $TURNSTILE"
echo "  App port:  $APP_PORT"
[[ "$MODE" == "docker" ]]       && echo "  Bridge:    $BRIDGE"
[[ "$MODE" == "bare-metal" ]]   && echo "  App UID:   $APP_UID"
[[ "$MODE" == "proxmox-veth" ]] && echo "  veth:      $VETH"
[[ -n "$TUNNEL_IFACE" ]]        && echo "  Inbound guard on: $TUNNEL_IFACE"
[[ $AUTO_PERSIST -eq 1 ]]       && echo "  Persist:   yes"
[[ $DRY_RUN -eq 1 ]]            && echo "  Dry run:   yes"
bold "───────────────────────────────────────────"
echo

if [[ $DRY_RUN -eq 0 ]]; then
  read -rp "$(bold "Apply these rules now? [y/N]: ")" confirm
  [[ "${confirm,,}" == "y" ]] || { yellow "Aborted."; exit 0; }
fi

# ── Apply rules ───────────────────────────────────────────────────────────────

# Inbound guard
if [[ -n "$TUNNEL_IFACE" ]]; then
  if [[ "$BACKEND" == "iptables" ]]; then
    apply_inbound_iptables "$TUNNEL_IFACE" "$APP_PORT"
  else
    apply_inbound_nftables "$TUNNEL_IFACE" "$APP_PORT"
  fi
fi

# Egress
case "$MODE" in
  docker)
    if [[ "$BACKEND" == "iptables" ]]; then
      apply_docker_iptables "$BRIDGE" "$TURNSTILE"
    else
      apply_docker_nftables "$BRIDGE" "$TURNSTILE"
    fi
    ;;
  bare-metal)
    if [[ "$BACKEND" == "iptables" ]]; then
      apply_baremetal_iptables "$APP_UID" "$TURNSTILE"
    else
      apply_baremetal_nftables "$APP_UID" "$TURNSTILE"
    fi
    ;;
  proxmox-veth)
    if [[ "$BACKEND" == "iptables" ]]; then
      apply_proxmox_iptables "$VETH" "$TURNSTILE"
    else
      apply_proxmox_nftables "$VETH" "$TURNSTILE"
    fi
    ;;
esac

# Persist
if [[ $AUTO_PERSIST -eq 1 ]]; then
  if [[ "$BACKEND" == "iptables" ]]; then
    persist_iptables
  else
    persist_nftables
  fi
fi

# ── Done ──────────────────────────────────────────────────────────────────────
echo
green "Done."
if [[ $DRY_RUN -eq 0 ]]; then
  echo
  bold "Next steps:"
  echo "  • Run ./scripts/check-deployment.sh to verify the full deployment posture"
  if [[ "$MODE" == "proxmox-veth" ]]; then
    echo "  • Also configure /etc/pve/firewall/<vmid>.fw (see PROXMOX.md)"
  fi
  if [[ $AUTO_PERSIST -eq 0 ]]; then
    yellow "  • Rules are NOT persisted — they will be lost on reboot."
    yellow "    Re-run with --persist or answer 'y' to the persist prompt next time."
  fi
fi

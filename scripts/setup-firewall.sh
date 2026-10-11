#!/usr/bin/env bash
# ── Archivum Null — Firewall Rules Setup ─────────────────────────────────────
# Contains the app: once applied, the app can open no connection of its own except
# the ones named here, and (optionally) only one interface can reach its port.
#
# Deployment modes:
#   docker      — Docker Compose; the app's container sits on its own bridge
#   bare-metal  — Node.js under systemd on the host, or inside an LXC or VM
#
# What it sets up:
#   Egress   — connections the app opens are dropped. With --turnstile yes it may
#              reach Cloudflare's challenge endpoints and a DNS resolver; --allow
#              adds destinations of your own. Replies to its visitors always pass.
#   Host     — docker mode: the container cannot open connections to the Docker
#              host itself (its SSH daemon, other services).
#   Inbound  — with --tunnel-iface, the app port accepts connections from that
#              interface only.
#
# How: the script owns its rules and nothing else. With iptables these are the
# chains ARCHIVUM-EGRESS, ARCHIVUM-HOST and ARCHIVUM-INGRESS and the jumps into
# them; with nftables, the table "inet archivum_null". Every run rebuilds them from
# the options given, so running it again is safe, and --remove takes them out. Its
# rules only ever drop: they never accept a packet that Docker or your own firewall
# would have refused. IPv6 gets the same treatment, with no outbound allowances.
#
# Usage (interactive):
#   sudo bash scripts/setup-firewall.sh
#
# Usage (non-interactive):
#   sudo bash scripts/setup-firewall.sh \
#     --mode docker --turnstile yes --tunnel-iface wg0 --persist --yes
#
# Options:
#   --mode          docker | bare-metal
#   --backend       iptables | nftables   (default: nftables when nft is installed)
#   --turnstile     yes | no
#   --tunnel-iface  only this interface may reach the app port (e.g. wg0); omit to skip
#   --app-port      default: 3000
#   --bridge        docker mode: the bridge of the app's network, default: br-archivum
#   --app-uid       bare-metal mode: user name or UID of the app, default: archivum
#   --dns           resolvers the app may query, comma-separated, or "none".
#                   Default in bare-metal mode: the name servers in /etc/resolv.conf.
#                   Default in docker mode: none, because Docker asks the host's
#                   resolvers on the container's behalf. Give it only if the
#                   container's /etc/resolv.conf names a resolver without "host(...)"
#   --allow         one more destination the app may connect to: CIDR:PORT, TCP.
#                   Repeatable. Example for the update check: --allow 140.82.112.0/20:443
#   --persist       apply the same rules at every boot (installs a systemd unit)
#   --remove        remove the rules and the unit, including what the earlier version
#                   of this script left in FORWARD, INPUT, OUTPUT and DOCKER-USER
#   --dry-run       print what would be applied and change nothing (needs no root)
#   --yes           do not ask for confirmation
# ─────────────────────────────────────────────────────────────────────────────

set -euo pipefail

# ── Output ────────────────────────────────────────────────────────────────────
# Colour on a terminal only, so that piped output and logs stay plain text.
if [[ -t 1 ]]; then
  paint() { printf '\033[%sm%s\033[0m\n' "$1" "$2"; }
else
  paint() { printf '%s\n' "$2"; }
fi
red()    { paint '0;31' "$*"; }
green()  { paint '0;32' "$*"; }
yellow() { paint '0;33' "$*"; }
cyan()   { paint '0;36' "$*"; }
bold()   { paint '1' "$*"; }
die()    { red "ERROR: $*" >&2; exit 1; }

# ── Names this script owns ────────────────────────────────────────────────────
CHAIN_EGRESS="ARCHIVUM-EGRESS"
CHAIN_HOST="ARCHIVUM-HOST"
CHAIN_INGRESS="ARCHIVUM-INGRESS"
NFT_TABLE="archivum_null"
UNIT_NAME="archivum-null-firewall.service"
UNIT_PATH="/etc/systemd/system/$UNIT_NAME"
INSTALLED_COPY="/usr/local/sbin/archivum-null-firewall"

# Where challenges.cloudflare.com is served from. Check with: getent ahostsv4 challenges.cloudflare.com
CF_RANGES=("104.16.0.0/13" "104.24.0.0/14")

# ── Defaults ──────────────────────────────────────────────────────────────────
MODE=""
BACKEND=""
TURNSTILE=""
TUNNEL_IFACE=""
TUNNEL_IFACE_SET=0
APP_PORT="3000"
BRIDGE="br-archivum"
APP_UID=""
DNS_OPT=""
ALLOW=()
DRY_RUN=0
PERSIST=0
REMOVE=0
ASSUME_YES=0
AT_BOOT=0

# ── Argument parsing ──────────────────────────────────────────────────────────
need_value() { [[ $# -ge 2 ]] || die "Option $1 needs a value"; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --mode)          need_value "$@"; MODE="$2";         shift 2 ;;
    --backend)       need_value "$@"; BACKEND="$2";      shift 2 ;;
    --turnstile)     need_value "$@"; TURNSTILE="$2";    shift 2 ;;
    --tunnel-iface)  need_value "$@"; TUNNEL_IFACE="$2"; TUNNEL_IFACE_SET=1; shift 2 ;;
    --app-port)      need_value "$@"; APP_PORT="$2";     shift 2 ;;
    --bridge)        need_value "$@"; BRIDGE="$2";       shift 2 ;;
    --app-uid)       need_value "$@"; APP_UID="$2";      shift 2 ;;
    --dns)           need_value "$@"; DNS_OPT="$2";      shift 2 ;;
    --allow)         need_value "$@"; ALLOW+=("$2");     shift 2 ;;
    --dry-run)       DRY_RUN=1;     shift ;;
    --persist)       PERSIST=1;     shift ;;
    --remove)        REMOVE=1;      shift ;;
    --yes|-y)        ASSUME_YES=1;  shift ;;
    # Set by the unit --persist installs: Docker is not running yet at that point.
    --at-boot)       AT_BOOT=1; ASSUME_YES=1; shift ;;
    --veth)
      die "The proxmox-veth mode is gone: rules on a guest's veth in the host's FORWARD chain never see its traffic. Use the Proxmox firewall instead (docs/PROXMOX.md)." ;;
    --help|-h)
      sed -n '2,/^# ─────/p' "$0" | sed '$d' | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *) die "Unknown option: $1 (see --help)" ;;
  esac
done

MODE="${MODE,,}"; BACKEND="${BACKEND,,}"; TURNSTILE="${TURNSTILE,,}"
[[ "$MODE" == "proxmox-veth" ]] && die "The proxmox-veth mode is gone: rules on a guest's veth in the host's FORWARD chain never see its traffic. Use the Proxmox firewall instead (docs/PROXMOX.md)."

if [[ $DRY_RUN -eq 0 && "$(id -u)" -ne 0 ]]; then
  die "This script must be run as root (sudo). Use --dry-run to see what it would do."
fi

have() { command -v "$1" >/dev/null 2>&1; }

# ── Interactive prompts ───────────────────────────────────────────────────────
# A value that was not given as an option is asked for, and only on a terminal: a
# script or a boot unit that leaves one out gets an error, not a prompt nobody answers.
ask() {
  local var_name="$1" prompt_text="$2" default="$3" input
  if [[ -n "${!var_name:-}" ]]; then return; fi
  if [[ ! -t 0 ]]; then
    [[ -n "$default" ]] || die "Missing a value for: $prompt_text"
    printf -v "$var_name" '%s' "$default"
    return
  fi
  read -rp "$(bold "$prompt_text") [${default}]: " input
  printf -v "$var_name" '%s' "${input:-$default}"
}

confirm() {
  local answer
  [[ $ASSUME_YES -eq 1 ]] && return 0
  [[ -t 0 ]] || die "Not a terminal: pass --yes to apply without asking"
  read -rp "$(bold "$1 [y/N]: ")" answer
  [[ "${answer,,}" == "y" || "${answer,,}" == "yes" ]]
}

# ── Validation helpers ────────────────────────────────────────────────────────
valid_iface() { [[ "$1" =~ ^[A-Za-z0-9_.:@-]{1,15}$ ]]; }
is_ipv4()     { [[ "$1" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]]; }
is_ipv6()     { [[ "$1" =~ ^[0-9A-Fa-f:.]+$ && "$1" == *:* ]]; }

# ── Backend ───────────────────────────────────────────────────────────────────
detect_backend() {
  [[ -n "$BACKEND" ]] && return
  if have nft; then
    BACKEND="nftables"
  elif have iptables; then
    BACKEND="iptables"
  elif [[ $DRY_RUN -eq 1 ]]; then
    BACKEND="nftables"
  else
    die "Neither 'nft' nor 'iptables' found. Install one and retry."
  fi
}

# ── Resolvers the app may query ───────────────────────────────────────────────
# A process on the host asks the host's name servers itself, the local stub
# included, so in bare-metal mode they are read from /etc/resolv.conf.
#
# A container asks Docker's built-in resolver, and Docker passes the query on to the
# host's name servers from the host's side, where no rule of ours applies. Nothing
# is allowed by default, then. The exception is a resolver the container reaches by
# itself: one set with "dns:" in the Compose file, or any on an old Docker. It shows
# in the container's /etc/resolv.conf as an ExtServers entry without "host(...)",
# and has to be given with --dns.
DNS4=(); DNS6=()
collect_dns() {
  local entries=() entry
  if [[ "${DNS_OPT,,}" == "none" ]]; then
    return
  elif [[ -n "$DNS_OPT" ]]; then
    IFS=',' read -r -a entries <<< "$DNS_OPT"
  elif [[ "$MODE" == "docker" ]]; then
    return
  elif [[ -r /etc/resolv.conf ]]; then
    mapfile -t entries < <(awk '$1 == "nameserver" { print $2 }' /etc/resolv.conf)
  fi
  for entry in "${entries[@]}"; do
    entry="${entry%%%*}"            # fe80::1%eth0 → fe80::1
    entry="${entry//[[:space:]]/}"
    [[ -z "$entry" ]] && continue
    if is_ipv4 "$entry"; then DNS4+=("$entry")
    elif is_ipv6 "$entry"; then DNS6+=("$entry")
    else die "Not an IP address in the resolver list: $entry"
    fi
  done
}

# ── Extra allowances: CIDR:PORT ───────────────────────────────────────────────
ALLOW4=(); ALLOW6=()
collect_allow() {
  local item cidr port
  for item in "${ALLOW[@]}"; do
    cidr="${item%:*}"; port="${item##*:}"
    [[ "$item" == *:* && "$port" =~ ^[0-9]{1,5}$ && "$port" -ge 1 && "$port" -le 65535 ]] \
      || die "--allow takes CIDR:PORT, for example 140.82.112.0/20:443 (got: $item)"
    cidr="${cidr#[}"; cidr="${cidr%]}"
    if is_ipv4 "${cidr%/*}"; then ALLOW4+=("$cidr $port")
    elif is_ipv6 "${cidr%/*}"; then ALLOW6+=("$cidr $port")
    else die "--allow takes CIDR:PORT, for example 140.82.112.0/20:443 (got: $item)"
    fi
  done
}

# The app needs name resolution only when it is allowed to connect somewhere.
wants_egress() { [[ "$TURNSTILE" == "yes" || ${#ALLOW[@]} -gt 0 ]]; }

# ═════════════════════════════════════════════════════════════════════════════
#  nftables
# ═════════════════════════════════════════════════════════════════════════════
# One table of our own. Its chains hook in beside whatever else filters packets on
# this host: a packet has to pass every table, so a drop here holds whatever Docker's
# own rules accept, and an accept here ends only this table's say.

# nft_set a b c → { a, b, c }
nft_set() {
  local joined
  printf -v joined '%s, ' "$@"
  printf '{ %s }' "${joined%, }"
}

nft_egress_rules() {
  local pair
  echo "		ct state established,related accept"
  if wants_egress; then
    [[ ${#DNS4[@]} -gt 0 ]] && echo "		ip daddr $(nft_set "${DNS4[@]}") meta l4proto { tcp, udp } th dport 53 accept"
    [[ ${#DNS6[@]} -gt 0 ]] && echo "		ip6 daddr $(nft_set "${DNS6[@]}") meta l4proto { tcp, udp } th dport 53 accept"
  fi
  [[ "$TURNSTILE" == "yes" ]] && echo "		ip daddr $(nft_set "${CF_RANGES[@]}") tcp dport 443 accept"
  for pair in "${ALLOW4[@]}"; do echo "		ip daddr ${pair% *} tcp dport ${pair#* } accept"; done
  for pair in "${ALLOW6[@]}"; do echo "		ip6 daddr ${pair% *} tcp dport ${pair#* } accept"; done
  echo "		drop"
}

nft_ruleset() {
  # Declared, deleted and declared again in one transaction: the first line makes
  # the delete succeed on a host that has never had the table.
  echo "table inet $NFT_TABLE"
  echo "delete table inet $NFT_TABLE"
  echo "table inet $NFT_TABLE {"
  if [[ "$MODE" == "docker" ]]; then
    cat <<EOF
	# Connections the container opens to anything beyond the Docker host
	chain forward_from_app {
		type filter hook forward priority filter; policy accept;
		iifname "$BRIDGE" jump egress
	}
	chain egress {
$(nft_egress_rules)
	}

	# Connections the container opens to the Docker host itself
	chain input_from_app {
		type filter hook input priority filter; policy accept;
		iifname "$BRIDGE" jump host
	}
	chain host {
		ct state established,related accept
		icmpv6 type { nd-neighbor-solicit, nd-neighbor-advert, nd-router-solicit } accept
EOF
    if wants_egress; then
      [[ ${#DNS4[@]} -gt 0 ]] && echo "		ip daddr $(nft_set "${DNS4[@]}") meta l4proto { tcp, udp } th dport 53 accept"
      [[ ${#DNS6[@]} -gt 0 ]] && echo "		ip6 daddr $(nft_set "${DNS6[@]}") meta l4proto { tcp, udp } th dport 53 accept"
    fi
    echo "		drop"
    echo "	}"
    if [[ -n "$TUNNEL_IFACE" ]]; then
      cat <<EOF

	# Connections to the container: from the tunnel interface only
	chain forward_to_app {
		type filter hook forward priority filter; policy accept;
		oifname "$BRIDGE" jump ingress
	}
	chain ingress {
		ct state established,related accept
		iifname "$TUNNEL_IFACE" accept
		drop
	}
EOF
    fi
  else
    cat <<EOF
	# Connections the app's user opens. Entered by packets of that user only:
	# anything else, the kernel's own replies included, never comes in here.
	chain output_from_app {
		type filter hook output priority filter; policy accept;
		meta skuid $APP_UID jump egress
	}
	chain egress {
$(nft_egress_rules)
	}
EOF
    if [[ -n "$TUNNEL_IFACE" ]]; then
      cat <<EOF

	# Connections to the app port: from this host and the tunnel interface only
	chain input_to_app {
		type filter hook input priority filter; policy accept;
		tcp dport $APP_PORT jump ingress
	}
	chain ingress {
		iifname "lo" accept
		iifname "$TUNNEL_IFACE" accept
		drop
	}
EOF
    fi
  fi
  echo "}"
}

apply_nftables() {
  local ruleset
  ruleset="$(nft_ruleset)"
  if [[ $DRY_RUN -eq 1 ]]; then
    cyan "# nft -f - <<'EOF'"
    printf '%s\n' "$ruleset"
    cyan "# EOF"
    return
  fi
  printf '%s\n' "$ruleset" | nft -f -
  green "  nftables: table inet $NFT_TABLE loaded"
}

remove_nftables() {
  have nft || return 0
  if nft list table inet "$NFT_TABLE" >/dev/null 2>&1; then
    run nft delete table inet "$NFT_TABLE"
    [[ $DRY_RUN -eq 1 ]] || green "  nftables: table inet $NFT_TABLE removed"
  fi
}

# ═════════════════════════════════════════════════════════════════════════════
#  iptables
# ═════════════════════════════════════════════════════════════════════════════
# Three chains of our own, each entered by a jump placed first in its parent. Allowed
# traffic leaves them with RETURN, not ACCEPT, so whatever else filters on this host
# still gets its say.
#
# For forwarded traffic there are two parents, and the jump goes into both:
#   DOCKER-USER  the one chain Docker's iptables rules evaluate before their own
#                accept of a container's traffic. Rules appended to FORWARD come
#                after that accept and never run.
#   FORWARD      for a Docker that keeps its rules in nftables, or does not manage
#                this address family, and so never enters DOCKER-USER.
# A packet that meets both passes the same chain twice, to the same verdict.

run() {
  if [[ $DRY_RUN -eq 1 ]]; then
    cyan "$*"
  else
    "$@"
  fi
}

ipt_tool() { if [[ "$1" == 6 ]]; then echo ip6tables; else echo iptables; fi; }

# ipt <4|6> args... — the iptables command of that family
ipt() {
  local family="$1"; shift
  "$(ipt_tool "$family")" "$@"
}

# ipt_run <4|6> args... — the same, printed and not executed in a dry run
ipt_run() {
  local family="$1"; shift
  run "$(ipt_tool "$family")" "$@"
}

family_usable() {
  if [[ "$1" == 6 ]]; then
    [[ -e /proc/net/if_inet6 ]] && have ip6tables
  else
    have iptables
  fi
}

# The body of a chain, one rule per line, without the leading "-A <chain>".
ipt_egress_rules() {
  local family="$1" entry pair
  echo "-m conntrack --ctstate ESTABLISHED,RELATED -j RETURN"
  if [[ "$family" == 4 ]]; then
    if wants_egress; then
      for entry in "${DNS4[@]}"; do
        echo "-d $entry -p udp --dport 53 -j RETURN"
        echo "-d $entry -p tcp --dport 53 -j RETURN"
      done
    fi
    if [[ "$TURNSTILE" == "yes" ]]; then
      for entry in "${CF_RANGES[@]}"; do echo "-d $entry -p tcp --dport 443 -j RETURN"; done
    fi
    for pair in "${ALLOW4[@]}"; do echo "-d ${pair% *} -p tcp --dport ${pair#* } -j RETURN"; done
  else
    if wants_egress; then
      for entry in "${DNS6[@]}"; do
        echo "-d $entry -p udp --dport 53 -j RETURN"
        echo "-d $entry -p tcp --dport 53 -j RETURN"
      done
    fi
    for pair in "${ALLOW6[@]}"; do echo "-d ${pair% *} -p tcp --dport ${pair#* } -j RETURN"; done
  fi
  echo "-j DROP"
}

ipt_host_rules() {
  local family="$1" entry
  echo "-m conntrack --ctstate ESTABLISHED,RELATED -j RETURN"
  if [[ "$family" == 6 ]]; then
    # Without neighbour discovery the bridge has no IPv6 at all
    for entry in 133 135 136; do echo "-p ipv6-icmp --icmpv6-type $entry -j RETURN"; done
    if wants_egress; then
      for entry in "${DNS6[@]}"; do
        echo "-d $entry -p udp --dport 53 -j RETURN"
        echo "-d $entry -p tcp --dport 53 -j RETURN"
      done
    fi
  elif wants_egress; then
    for entry in "${DNS4[@]}"; do
      echo "-d $entry -p udp --dport 53 -j RETURN"
      echo "-d $entry -p tcp --dport 53 -j RETURN"
    done
  fi
  echo "-j DROP"
}

ipt_ingress_rules() {
  if [[ "$MODE" == "docker" ]]; then
    echo "-m conntrack --ctstate ESTABLISHED,RELATED -j RETURN"
  else
    echo "-i lo -j RETURN"
  fi
  echo "-i $TUNNEL_IFACE -j RETURN"
  echo "-j DROP"
}

# ipt_jumps — the jumps that have to exist, one per line: "<parent> <match...> -j <chain>"
ipt_jumps() {
  local parent
  if [[ "$MODE" == "docker" ]]; then
    for parent in DOCKER-USER FORWARD; do
      echo "$parent -i $BRIDGE -j $CHAIN_EGRESS"
      if [[ -n "$TUNNEL_IFACE" ]]; then echo "$parent -o $BRIDGE -j $CHAIN_INGRESS"; fi
    done
    echo "INPUT -i $BRIDGE -j $CHAIN_HOST"
  else
    echo "OUTPUT -m owner --uid-owner $APP_UID -j $CHAIN_EGRESS"
    if [[ -n "$TUNNEL_IFACE" ]]; then echo "INPUT -p tcp -m tcp --dport $APP_PORT -j $CHAIN_INGRESS"; fi
  fi
}

# Every jump into one of our chains that this family holds, as "<parent> <match...> -j <chain>".
# Nothing on a host that has no iptables: the nftables rules need none of it.
ipt_existing_jumps() {
  local family="$1"
  family_usable "$family" || return 0
  ipt "$family" -S 2>/dev/null \
    | awk -v e="$CHAIN_EGRESS" -v h="$CHAIN_HOST" -v i="$CHAIN_INGRESS" \
        '$1 == "-A" && ($NF == e || $NF == h || $NF == i) { sub(/^-A /, ""); print }'
}

# Compare two jump specs the way iptables prints them back.
normalise_jump() { sed -E 's/ -m tcp//; s/ +/ /g; s/ $//' <<< "$1"; }

apply_iptables_family() {
  local family="$1" chains=() chain payload="" line jump found existing wanted_jumps=()
  # A dry run prints both families, whatever the machine it runs on has installed.
  if [[ $DRY_RUN -eq 0 ]]; then family_usable "$family" || return 0; fi

  chains=("$CHAIN_EGRESS")
  [[ "$MODE" == "docker" ]] && chains+=("$CHAIN_HOST")
  [[ -n "$TUNNEL_IFACE" ]] && chains+=("$CHAIN_INGRESS")

  # One restore per family: the chains are emptied and refilled in a single commit,
  # so there is no moment in which a chain exists without its rules.
  payload="*filter"$'\n'
  for chain in "${chains[@]}"; do payload+=":$chain - [0:0]"$'\n'; done
  while IFS= read -r line; do payload+="-A $CHAIN_EGRESS $line"$'\n'; done < <(ipt_egress_rules "$family")
  if [[ "$MODE" == "docker" ]]; then
    while IFS= read -r line; do payload+="-A $CHAIN_HOST $line"$'\n'; done < <(ipt_host_rules "$family")
  fi
  if [[ -n "$TUNNEL_IFACE" ]]; then
    while IFS= read -r line; do payload+="-A $CHAIN_INGRESS $line"$'\n'; done < <(ipt_ingress_rules)
  fi
  payload+="COMMIT"$'\n'

  mapfile -t wanted_jumps < <(ipt_jumps)

  local tool; tool="$(ipt_tool "$family")"
  if [[ $DRY_RUN -eq 1 ]]; then
    cyan "# ${tool}-restore --noflush <<'EOF'"
    printf '%s' "$payload"
    cyan "# EOF"
    if [[ "$MODE" == "docker" ]]; then cyan "$tool -N DOCKER-USER   # unless Docker has made it already"; fi
    for jump in "${wanted_jumps[@]}"; do
      cyan "$tool -I ${jump%% *} 1 ${jump#* }"
    done
    return
  fi

  # Made here when it is missing: at boot this runs before Docker, which adopts the
  # chain as it finds it.
  if [[ "$MODE" == "docker" ]]; then ipt "$family" -N DOCKER-USER 2>/dev/null || true; fi
  printf '%s' "$payload" | "${tool}-restore" --noflush

  # Jumps: put in what is missing, then take out what an earlier run left for other
  # options (another bridge, a tunnel interface since dropped).
  for jump in "${wanted_jumps[@]}"; do
    # shellcheck disable=SC2086  # a rule specification is a list of words
    ipt "$family" -C ${jump%% *} ${jump#* } 2>/dev/null || ipt "$family" -I ${jump%% *} 1 ${jump#* }
  done
  while IFS= read -r existing; do
    [[ -z "$existing" ]] && continue
    found=0
    for jump in "${wanted_jumps[@]}"; do
      [[ "$(normalise_jump "$existing")" == "$(normalise_jump "$jump")" ]] && found=1
    done
    # shellcheck disable=SC2086
    [[ $found -eq 1 ]] || ipt "$family" -D ${existing%% *} ${existing#* }
  done < <(ipt_existing_jumps "$family")

  # A chain this run has no use for (the inbound guard, when no interface is given)
  for chain in "$CHAIN_EGRESS" "$CHAIN_HOST" "$CHAIN_INGRESS"; do
    [[ " ${chains[*]} " == *" $chain "* ]] && continue
    ipt "$family" -F "$chain" 2>/dev/null || true
    ipt "$family" -X "$chain" 2>/dev/null || true
  done
  green "  $tool: ${chains[*]} loaded"
}

apply_iptables() {
  have iptables || [[ $DRY_RUN -eq 1 ]] || die "'iptables' not found"
  apply_iptables_family 4
  apply_iptables_family 6
}

remove_iptables_family() {
  local family="$1" existing chain
  family_usable "$family" || return 0
  while IFS= read -r existing; do
    [[ -z "$existing" ]] && continue
    # shellcheck disable=SC2086
    ipt_run "$family" -D ${existing%% *} ${existing#* }
  done < <(ipt_existing_jumps "$family")
  for chain in "$CHAIN_EGRESS" "$CHAIN_HOST" "$CHAIN_INGRESS"; do
    if ipt "$family" -S "$chain" >/dev/null 2>&1; then
      ipt_run "$family" -F "$chain"
      ipt_run "$family" -X "$chain"
    fi
  done
  # A DOCKER-USER that this script made, on a host where Docker never took it over.
  # It goes only if it is empty and nothing jumps to it; Docker's own is in use.
  if [[ $DRY_RUN -eq 0 ]]; then ipt "$family" -X DOCKER-USER 2>/dev/null || true; fi
}

remove_iptables() {
  local before after
  before="$(ipt_existing_jumps 4; ipt_existing_jumps 6)"
  remove_iptables_family 4
  remove_iptables_family 6
  after="$(ipt_existing_jumps 4; ipt_existing_jumps 6)"
  if [[ $DRY_RUN -eq 0 && -n "$before" && -z "$after" ]]; then green "  iptables: chains and jumps removed"; fi
}

# ═════════════════════════════════════════════════════════════════════════════
#  Rules of the earlier version of this script
# ═════════════════════════════════════════════════════════════════════════════
# It added its rules straight to FORWARD, INPUT, OUTPUT and DOCKER-USER, or to the
# chains of the table "inet filter". In docker mode with iptables the egress rules
# sat behind Docker's own accept and never ran, and its accept for the tunnel
# interface in DOCKER-USER let that interface's packets through to any network this
# host routes to. They are taken out here by their exact text.

LEGACY_FOUND=0

legacy_delete_ipt() {
  # legacy_delete_ipt <chain> <spec...> — every copy of one rule
  local chain="$1"; shift
  have iptables || return 0
  while iptables -C "$chain" "$@" 2>/dev/null; do
    LEGACY_FOUND=1
    run iptables -D "$chain" "$@"
    [[ $DRY_RUN -eq 1 ]] && break
  done
  return 0
}

legacy_delete_nft() {
  # legacy_delete_nft <chain> <extended-regex> — rules of inet filter/<chain> matching the text
  local chain="$1" pattern="$2" handle
  have nft || return 0
  while IFS= read -r handle; do
    [[ -z "$handle" ]] && continue
    LEGACY_FOUND=1
    run nft delete rule inet filter "$chain" handle "$handle"
  done < <(nft -a -n list chain inet filter "$chain" 2>/dev/null | grep -E "$pattern" | sed -n 's/.*# handle \([0-9]\+\)$/\1/p')
  return 0
}

remove_legacy() {
  local cidr uid_candidates=() uid ifaces=() iface
  local private=("10.0.0.0/8" "172.16.0.0/12" "192.168.0.0/16" "169.254.0.0/16")
  [[ $DRY_RUN -eq 1 && "$(id -u)" -ne 0 ]] && return 0

  # Tunnel interfaces the old rules may name: the one given now, and the usual ones
  [[ -n "$TUNNEL_IFACE" ]] && ifaces+=("$TUNNEL_IFACE")
  for iface in wg0 wg1 tun0 tun1 tailscale0; do
    [[ " ${ifaces[*]} " == *" $iface "* ]] || ifaces+=("$iface")
  done
  [[ -n "$APP_UID" ]] && uid_candidates+=("$APP_UID")
  [[ " ${uid_candidates[*]} " == *" 1001 "* ]] || uid_candidates+=("1001")

  # docker mode, iptables
  legacy_delete_ipt FORWARD -i "$BRIDGE" -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
  for cidr in "${private[@]}"; do legacy_delete_ipt FORWARD -i "$BRIDGE" -d "$cidr" -j DROP; done
  for cidr in "${CF_RANGES[@]}"; do legacy_delete_ipt FORWARD -i "$BRIDGE" -d "$cidr" -p tcp --dport 443 -j ACCEPT; done
  legacy_delete_ipt FORWARD -i "$BRIDGE" -j DROP
  if have iptables && iptables -S DOCKER-USER >/dev/null 2>&1; then
    for iface in "${ifaces[@]}"; do legacy_delete_ipt DOCKER-USER -i "$iface" -j ACCEPT; done
  fi

  # bare-metal mode, iptables
  for uid in "${uid_candidates[@]}"; do
    for cidr in "${private[@]}"; do legacy_delete_ipt OUTPUT -m owner --uid-owner "$uid" -d "$cidr" -j DROP; done
    for cidr in "${CF_RANGES[@]}"; do legacy_delete_ipt OUTPUT -m owner --uid-owner "$uid" -d "$cidr" -p tcp --dport 443 -j ACCEPT; done
    legacy_delete_ipt OUTPUT -m owner --uid-owner "$uid" -j DROP
  done

  # the inbound guard, iptables
  for iface in "${ifaces[@]}"; do legacy_delete_ipt INPUT -i "$iface" -p tcp --dport "$APP_PORT" -j ACCEPT; done
  legacy_delete_ipt INPUT -p tcp --dport "$APP_PORT" -j DROP

  # nftables: the same rules, in the table "inet filter"
  local body='(ct state [^ ]+ accept|ip daddr \{[^}]*\} (tcp dport 443 accept|drop)|drop) # handle'
  legacy_delete_nft forward "iifname \"$BRIDGE\" $body"
  for uid in "${uid_candidates[@]}"; do
    legacy_delete_nft output "skuid $uid (ip daddr \{[^}]*\} (tcp dport 443 accept|drop)|drop) # handle"
  done
  legacy_delete_nft input "tcp dport $APP_PORT iifname \"[^\"]+\" accept # handle"
  legacy_delete_nft input "tcp dport $APP_PORT drop # handle"

  if [[ $LEGACY_FOUND -eq 1 ]]; then
    yellow "  Removed rules of the earlier version of this script."
    yellow "  If you had saved them (netfilter-persistent, /etc/iptables/rules.v4, /etc/nftables.conf),"
    yellow "  save again or edit that file, or they come back at the next boot."
  fi
  return 0
}

# ═════════════════════════════════════════════════════════════════════════════
#  Persistence
# ═════════════════════════════════════════════════════════════════════════════
# A unit of our own that runs this script again at boot with the same options. It
# loads nothing but our rules, so it leaves alone whatever else the host restores,
# and it is ordered before Docker and before the app: the rules are there first.

unit_arguments() {
  local args="--at-boot --mode $MODE --backend $BACKEND --turnstile $TURNSTILE --app-port $APP_PORT"
  local resolvers=("${DNS4[@]}" "${DNS6[@]}") dns_list item
  if [[ "$MODE" == "docker" ]]; then args+=" --bridge $BRIDGE"; else args+=" --app-uid $APP_UID"; fi
  if [[ -n "$TUNNEL_IFACE" ]]; then args+=" --tunnel-iface $TUNNEL_IFACE"; fi
  # The resolvers are written down as they are now: at boot this runs before the
  # network is up, and /etc/resolv.conf may still be empty then.
  dns_list="$(IFS=','; echo "${resolvers[*]}")"
  args+=" --dns ${dns_list:-none}"
  for item in "${ALLOW[@]}"; do args+=" --allow $item"; done
  echo "$args"
}

install_unit() {
  local source="${BASH_SOURCE[0]}" unit
  unit="[Unit]
Description=Archivum Null firewall rules
Documentation=https://github.com/whiteravens20/archivum-null/blob/main/docs/HARDENING.md
DefaultDependencies=no
Wants=network-pre.target
After=local-fs.target systemd-modules-load.service
Before=network-pre.target docker.service archivum-null.service shutdown.target
Conflicts=shutdown.target

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=$INSTALLED_COPY $(unit_arguments)

[Install]
WantedBy=multi-user.target"

  echo
  bold "── Persistence ──"
  if [[ $DRY_RUN -eq 1 ]]; then
    cyan "install -m 0755 $source $INSTALLED_COPY"
    cyan "# $UNIT_PATH"
    printf '%s\n' "$unit"
    cyan "systemctl daemon-reload && systemctl enable $UNIT_NAME"
    return
  fi
  [[ -f "$source" ]] || die "--persist needs the script as a file: download it and run it from disk"
  have systemctl || die "--persist needs systemd. Without it, run this script from your own boot scripts."
  if [[ "$(readlink -f "$source")" != "$INSTALLED_COPY" ]]; then
    install -m 0755 "$source" "$INSTALLED_COPY"
  fi
  printf '%s\n' "$unit" > "$UNIT_PATH"
  systemctl daemon-reload
  systemctl enable "$UNIT_NAME" >/dev/null 2>&1
  # Mark it as run, so "systemctl status" shows the state the rules are in
  systemctl start "$UNIT_NAME"
  green "  $UNIT_NAME enabled: the rules are applied again at every boot"
}

remove_unit() {
  if [[ -e "$UNIT_PATH" ]]; then
    if [[ $DRY_RUN -eq 1 ]]; then
      cyan "systemctl disable --now $UNIT_NAME && rm $UNIT_PATH $INSTALLED_COPY"
    else
      systemctl disable --now "$UNIT_NAME" >/dev/null 2>&1 || true
      rm -f "$UNIT_PATH" "$INSTALLED_COPY"
      systemctl daemon-reload
      green "  $UNIT_NAME removed"
    fi
  fi
}

# ═════════════════════════════════════════════════════════════════════════════
#  MAIN
# ═════════════════════════════════════════════════════════════════════════════

if [[ $AT_BOOT -eq 0 ]]; then
  bold "═══════════════════════════════════════════"
  bold " Archivum Null — Firewall Setup"
  bold "═══════════════════════════════════════════"
  [[ $DRY_RUN -eq 1 ]] && yellow " (DRY RUN — no changes will be made)"
  echo
fi

# ── Remove ────────────────────────────────────────────────────────────────────
if [[ $REMOVE -eq 1 ]]; then
  if [[ -n "$APP_UID" && ! "$APP_UID" =~ ^[0-9]+$ ]]; then APP_UID="$(id -u "$APP_UID" 2>/dev/null || true)"; fi
  confirm "Remove the Archivum Null firewall rules from this host?" || { yellow "Aborted."; exit 0; }
  remove_unit
  remove_nftables
  remove_iptables
  remove_legacy
  green "Done. Nothing of this script's is left in the firewall."
  exit 0
fi

# ── Collect what was not given ────────────────────────────────────────────────
if [[ -z "$MODE" && -t 0 ]]; then
  echo "Deployment mode:"
  echo "  docker       — Docker Compose"
  echo "  bare-metal   — Node.js under systemd, on the host or inside an LXC or VM"
fi
ask MODE "Mode [docker/bare-metal]" ""
MODE="${MODE,,}"
[[ "$MODE" =~ ^(docker|bare-metal)$ ]] || die "Invalid mode: $MODE (docker or bare-metal)"

detect_backend
[[ "$BACKEND" =~ ^(iptables|nftables)$ ]] || die "Invalid backend: $BACKEND (iptables or nftables)"

ask TURNSTILE "Is Cloudflare Turnstile enabled? [yes/no]" "no"
TURNSTILE="${TURNSTILE,,}"
[[ "$TURNSTILE" =~ ^(yes|no)$ ]] || die "Invalid value for --turnstile: $TURNSTILE (yes or no)"

if [[ "$MODE" == "docker" ]]; then
  valid_iface "$BRIDGE" || die "Invalid bridge name: $BRIDGE"
else
  ask APP_UID "User the app runs as (name or UID)" "archivum"
  if [[ ! "$APP_UID" =~ ^[0-9]+$ ]]; then
    resolved_uid="$(id -u "$APP_UID" 2>/dev/null || true)"
    [[ -n "$resolved_uid" ]] || die "No such user: $APP_UID. Pass --app-uid with the user or UID the app runs as."
    APP_UID="$resolved_uid"
  fi
  # Rules for UID 0 would cut off the system's own updates and name resolution.
  [[ "$APP_UID" -ne 0 ]] || die "The app runs as root here. Give it a user of its own first; rules for UID 0 would contain the whole system."
fi

if [[ $TUNNEL_IFACE_SET -eq 0 && -t 0 && $ASSUME_YES -eq 0 ]]; then
  echo
  yellow "Inbound guard (optional): only one interface may reach the app port."
  yellow "Give the interface your reverse proxy's tunnel arrives on, or leave blank to skip."
  read -rp "$(bold "Tunnel interface") []: " TUNNEL_IFACE
fi
if [[ -n "$TUNNEL_IFACE" ]]; then
  valid_iface "$TUNNEL_IFACE" || die "Invalid interface name: $TUNNEL_IFACE"
fi

[[ "$APP_PORT" =~ ^[0-9]{1,5}$ && "$APP_PORT" -ge 1 && "$APP_PORT" -le 65535 ]] || die "Invalid port: $APP_PORT"

collect_allow
if wants_egress; then collect_dns; fi

if [[ $PERSIST -eq 0 && $DRY_RUN -eq 0 && $ASSUME_YES -eq 0 && -t 0 ]]; then
  echo
  if confirm "Apply the same rules at every boot?"; then PERSIST=1; fi
fi

# ── Plan ──────────────────────────────────────────────────────────────────────
if [[ $AT_BOOT -eq 0 ]]; then
  echo
  bold "───────────────────────────────────────────"
  bold " Plan"
  bold "───────────────────────────────────────────"
  echo "  Mode:       $MODE"
  echo "  Backend:    $BACKEND"
  if [[ "$MODE" == "docker" ]]; then
    echo "  Bridge:     $BRIDGE"
  else
    echo "  App UID:    $APP_UID"
  fi
  if wants_egress; then
    echo "  The app may connect to:"
    [[ "$TURNSTILE" == "yes" ]] && echo "    Cloudflare Turnstile   ${CF_RANGES[*]}, TCP 443"
    for item in "${ALLOW[@]}"; do echo "    --allow                $item"; done
    if [[ ${#DNS4[@]} -gt 0 || ${#DNS6[@]} -gt 0 ]]; then
      resolvers=("${DNS4[@]}" "${DNS6[@]}")
      echo "    DNS resolvers          ${resolvers[*]}"
    elif [[ "$MODE" == "docker" ]]; then
      echo "    DNS resolvers          none: Docker asks the host's resolvers itself (see --dns)"
    else
      yellow "    DNS resolvers          none found: the app will not resolve names. Pass --dns."
    fi
  else
    echo "  The app may connect to: nothing"
  fi
  [[ "$MODE" == "docker" ]] && echo "  The container may connect to this host: no"
  if [[ -n "$TUNNEL_IFACE" ]]; then
    echo "  Port $APP_PORT is reachable from: $TUNNEL_IFACE$([[ "$MODE" == "bare-metal" ]] && echo " and this host")"
  else
    echo "  Port $APP_PORT is reachable from: wherever it is published (no inbound guard)"
  fi
  [[ $PERSIST -eq 1 ]] && echo "  At boot:    yes"
  [[ $DRY_RUN -eq 1 ]] && echo "  Dry run:    yes"
  bold "───────────────────────────────────────────"
  echo
fi

if [[ $DRY_RUN -eq 0 ]]; then
  confirm "Apply these rules now?" || { yellow "Aborted."; exit 0; }
fi

# ── Apply ─────────────────────────────────────────────────────────────────────
# Only one backend holds our rules at a time. A run that switches backend takes the
# other one's rules out, after its own are in.
if [[ "$BACKEND" == "nftables" ]]; then
  have nft || [[ $DRY_RUN -eq 1 ]] || die "'nft' not found"
  apply_nftables
  [[ $DRY_RUN -eq 1 ]] || remove_iptables
else
  apply_iptables
  [[ $DRY_RUN -eq 1 ]] || remove_nftables
fi

[[ $AT_BOOT -eq 1 ]] || remove_legacy

if [[ $PERSIST -eq 1 ]]; then
  install_unit
elif [[ $AT_BOOT -eq 0 && $DRY_RUN -eq 0 && -e "$UNIT_PATH" ]]; then
  yellow "  $UNIT_NAME still applies the options of an earlier run at boot."
  yellow "  Run again with --persist to bring it in line with these."
fi

# ── Done ──────────────────────────────────────────────────────────────────────
if [[ $AT_BOOT -eq 0 ]]; then
  echo
  green "Done."
  if [[ $DRY_RUN -eq 0 ]]; then
    echo
    bold "Next steps:"
    [[ "$MODE" == "docker" ]] && echo "  • Run ./scripts/check-deployment.sh to verify the deployment posture"
    echo "  • Connections the app already had open stay open. Restart it to be sure none is left."
    if [[ $PERSIST -eq 0 && ! -e "$UNIT_PATH" ]]; then
      yellow "  • These rules last until the next reboot. Run again with --persist to keep them."
    fi
  fi
fi

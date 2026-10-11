#!/usr/bin/env bash
# ── Archivum Null — Deployment Posture Check ──────────────────────────────────
# Run this on the HOMELAB HOST (not the VPS) after bringing up the production
# container. It checks that the container is confined the way docker-compose.yml
# intends, that the port is published where you meant it to be, and that the
# container cannot open connections of its own.
#
# The last part is tested, not read off the rules: the script makes the container
# try a connection to a public address and one to this host. With the egress rules
# in place neither leaves the container's bridge.
#
# Usage:
#   sudo ./scripts/check-deployment.sh [--tunnel-iface wg0] [--port 3000]
#
# Requirements:
#   - docker
#   - ss  (iproute2)
#   - root, to read the firewall rules; without it those checks are skipped
#   - nc or curl, for the LAN reachability test
# ─────────────────────────────────────────────────────────────────────────────

set -euo pipefail

# iptables and nft live in sbin, which a plain user's PATH often leaves out.
PATH="$PATH:/usr/sbin:/sbin"

# ── Defaults ──────────────────────────────────────────────────────────────────
TUNNEL_IFACE=""
APP_PORT="${PORT:-3000}"
CONTAINER_NAME="${CONTAINER_NAME:-archivum-null}"
ENV_FILE=".env"

PASS=0
FAIL=0
WARN=0

# ── Helpers ───────────────────────────────────────────────────────────────────
green()  { printf '\033[0;32m✓\033[0m %s\n' "$*"; }
red()    { printf '\033[0;31m✗\033[0m %s\n' "$*"; }
yellow() { printf '\033[0;33m⚠\033[0m %s\n' "$*"; }
header() { printf '\n\033[1m%s\033[0m\n' "$*"; }

pass()  { green  "$*"; PASS=$(( PASS + 1 ));  }
fail()  { red    "$*"; FAIL=$(( FAIL + 1 ));  }
warn()  { yellow "$*"; WARN=$(( WARN + 1 ));  }

inspect() { docker inspect --format "$1" "$CONTAINER_NAME" 2>/dev/null || true; }

# ── Argument parsing ──────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case "$1" in
    --tunnel-iface) TUNNEL_IFACE="$2"; shift 2 ;;
    --port)         APP_PORT="$2";     shift 2 ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

# Try to auto-detect tunnel interface if not provided
if [[ -z "$TUNNEL_IFACE" ]]; then
  for iface in wg0 wg1 tun0 tun1 tailscale0; do
    if ip link show "$iface" &>/dev/null; then
      TUNNEL_IFACE="$iface"
      break
    fi
  done
fi

# ── Load .env for HOST_BIND_ADDRESS ───────────────────────────────────────────
HOST_BIND_ADDRESS=""
if [[ -f "$ENV_FILE" ]]; then
  HOST_BIND_ADDRESS=$(grep -E '^HOST_BIND_ADDRESS=' "$ENV_FILE" | cut -d= -f2 | tr -d '[:space:]' || true)
fi
HOST_BIND_ADDRESS="${HOST_BIND_ADDRESS:-}"

# ── Check 1: Container is running ─────────────────────────────────────────────
header "1. Container status"
RUNNING=false
if [[ "$(inspect '{{.State.Running}}')" == "true" ]]; then
  RUNNING=true
  pass "Container '$CONTAINER_NAME' is running"
  HEALTHY=$(inspect '{{if .State.Health}}{{.State.Health.Status}}{{else}}no-healthcheck{{end}}')
  if [[ "$HEALTHY" == "healthy" ]]; then
    pass "Health check: $HEALTHY"
  elif [[ "$HEALTHY" == "no-healthcheck" ]]; then
    warn "No Docker health check configured"
  else
    fail "Health check status: $HEALTHY"
  fi
else
  fail "Container '$CONTAINER_NAME' is NOT running — start it with: docker compose up -d"
fi

# ── Check 2: Port binding ──────────────────────────────────────────────────────
header "2. Port binding (ss)"
if ! command -v ss &>/dev/null; then
  warn "ss not found — skipping port binding check (install iproute2)"
else
  # Fourth column of "ss -tlnH": the local address and port
  mapfile -t LISTENERS < <(ss -tlnH 2>/dev/null | awk -v p=":${APP_PORT}" '$4 ~ p"$" { print $4 }' | sort -u)
  if [[ ${#LISTENERS[@]} -eq 0 ]]; then
    fail "Nothing is listening on port $APP_PORT"
  else
    echo "  Listening on: ${LISTENERS[*]}"
    WILDCARD=false
    for listener in "${LISTENERS[@]}"; do
      # 0.0.0.0, the IPv6 wildcard, and the dual-stack "*" all mean every interface
      case "${listener%:*}" in
        0.0.0.0|'*'|'[::]') WILDCARD=true ;;
      esac
    done
    if [[ "$WILDCARD" == "true" ]]; then
      fail "Port $APP_PORT is bound to every interface of this host (set HOST_BIND_ADDRESS in .env)"
    else
      pass "Port $APP_PORT is bound to ${LISTENERS[*]} only"
      if [[ -n "$HOST_BIND_ADDRESS" && " ${LISTENERS[*]} " != *" ${HOST_BIND_ADDRESS}:${APP_PORT} "* ]]; then
        warn "The bound address does not match HOST_BIND_ADDRESS ($HOST_BIND_ADDRESS) in .env"
      fi
    fi
  fi
fi

# ── Check 3: Container user is non-root ───────────────────────────────────────
header "3. Container user"
CUSER=$(inspect '{{.Config.User}}')
if [[ -z "$CUSER" || "$CUSER" == "root" || "$CUSER" == "0" || "$CUSER" == 0:* ]]; then
  fail "Container is running as root — check USER in Dockerfile"
else
  pass "Container running as user: $CUSER"
fi

# ── Check 4: Capabilities, confinement and limits ─────────────────────────────
header "4. Container security options"
if [[ "$(inspect '{{.HostConfig.Privileged}}')" == "true" ]]; then
  fail "Container is privileged — every other restriction is void"
else
  pass "Container is not privileged"
fi

CAP_DROP=$(inspect '{{range .HostConfig.CapDrop}}{{.}} {{end}}')
CAP_ADD=$(inspect '{{range .HostConfig.CapAdd}}{{.}} {{end}}')
if [[ " ${CAP_DROP^^} " != *" ALL "* ]]; then
  fail "Capabilities are not dropped — set cap_drop: [ALL] in docker-compose.yml"
elif [[ -n "${CAP_ADD// /}" ]]; then
  fail "Capabilities added back: ${CAP_ADD% } — review docker-compose.yml"
else
  pass "All capabilities dropped, none added"
fi

SECURITY_OPT=$(inspect '{{.HostConfig.SecurityOpt}}')
if echo "$SECURITY_OPT" | grep -q 'no-new-privileges'; then
  pass "no-new-privileges enabled"
else
  fail "no-new-privileges is NOT enabled"
fi
for profile in seccomp apparmor; do
  if echo "$SECURITY_OPT" | grep -qE "${profile}[=:]unconfined"; then
    fail "The ${profile} profile is switched off (${profile}=unconfined)"
  fi
done

if [[ "$(inspect '{{.HostConfig.ReadonlyRootfs}}')" == "true" ]]; then
  pass "Root filesystem is read-only"
else
  fail "Root filesystem is writable — set read_only: true in docker-compose.yml"
fi

SHARED=()
[[ "$(inspect '{{.HostConfig.NetworkMode}}')" == "host" ]] && SHARED+=("network")
[[ "$(inspect '{{.HostConfig.PidMode}}')" == "host" ]] && SHARED+=("process")
[[ "$(inspect '{{.HostConfig.IpcMode}}')" == "host" ]] && SHARED+=("IPC")
[[ "$(inspect '{{.HostConfig.UsernsMode}}')" == "host" ]] && SHARED+=("user")
if [[ ${#SHARED[@]} -gt 0 ]]; then
  fail "Container shares the host's namespaces: ${SHARED[*]}"
else
  pass "No host namespace is shared with the container"
fi

PIDS_LIMIT=$(inspect '{{.HostConfig.PidsLimit}}')
if [[ "$PIDS_LIMIT" =~ ^[0-9]+$ && "$PIDS_LIMIT" -gt 0 ]]; then
  pass "Process limit: $PIDS_LIMIT"
else
  fail "No process limit — set deploy.resources.limits.pids in docker-compose.yml"
fi
MEMORY_LIMIT=$(inspect '{{.HostConfig.Memory}}')
if [[ "$MEMORY_LIMIT" =~ ^[0-9]+$ && "$MEMORY_LIMIT" -gt 0 ]]; then
  pass "Memory limit: $(( MEMORY_LIMIT / 1024 / 1024 )) MiB"
else
  warn "No memory limit — set deploy.resources.limits.memory in docker-compose.yml"
fi

# ── Check 5: Tunnel interface ─────────────────────────────────────────────────
header "5. Tunnel interface"
if [[ -z "$TUNNEL_IFACE" ]]; then
  warn "No tunnel interface detected (checked: wg0 wg1 tun0 tun1 tailscale0). Pass --tunnel-iface <iface> to specify."
else
  if ip link show "$TUNNEL_IFACE" 2>/dev/null | grep -q 'UP'; then
    pass "Tunnel interface $TUNNEL_IFACE is UP"
    TUNNEL_IP=$(ip -4 addr show "$TUNNEL_IFACE" 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+' | head -1 || true)
    if [[ -n "$TUNNEL_IP" ]]; then
      pass "Tunnel interface IP: $TUNNEL_IP"
      if [[ -n "$HOST_BIND_ADDRESS" && "$HOST_BIND_ADDRESS" != "$TUNNEL_IP" ]]; then
        warn "HOST_BIND_ADDRESS ($HOST_BIND_ADDRESS) does not match $TUNNEL_IFACE IP ($TUNNEL_IP)"
      fi
    else
      warn "No IPv4 address assigned to $TUNNEL_IFACE"
    fi
  else
    fail "Tunnel interface $TUNNEL_IFACE exists but is NOT UP"
  fi
fi

# ── Check 6: Firewall rules ────────────────────────────────────────────────────
# Rules made by setup-firewall.sh: the nftables table "inet archivum_null", or the
# iptables chain ARCHIVUM-EGRESS in the mangle table, entered from FORWARD there.
header "6. Firewall rules"
# The $name below belongs to Docker's template, not to the shell.
# shellcheck disable=SC2016
NETWORK=$(inspect '{{range $name, $net := .NetworkSettings.Networks}}{{$name}}{{end}}')
BRIDGE=$(docker network inspect "$NETWORK" --format '{{index .Options "com.docker.network.bridge.name"}}' 2>/dev/null || true)
BRIDGE="${BRIDGE:-br-archivum}"

if [[ "$(id -u)" -ne 0 ]]; then
  warn "Not root — cannot read the firewall rules. Run with sudo for this check."
else
  RULES_FOUND=false
  GUARD_FOUND=false
  if command -v nft &>/dev/null && nft list table inet archivum_null &>/dev/null; then
    RULES_FOUND=true
    pass "nftables: table inet archivum_null is loaded"
    nft list table inet archivum_null 2>/dev/null | grep -q 'chain ingress' && GUARD_FOUND=true
  fi
  if command -v iptables &>/dev/null && iptables -t mangle -S ARCHIVUM-EGRESS &>/dev/null; then
    RULES_FOUND=true
    if iptables -t mangle -C FORWARD -i "$BRIDGE" -j ARCHIVUM-EGRESS 2>/dev/null; then
      pass "iptables: ARCHIVUM-EGRESS in the mangle table is entered for traffic from $BRIDGE"
    else
      fail "iptables: the chain ARCHIVUM-EGRESS exists, but nothing sends traffic from $BRIDGE into it — run setup-firewall.sh again"
    fi
    iptables -t mangle -S ARCHIVUM-INGRESS &>/dev/null && GUARD_FOUND=true
  fi
  # Version 3.2.0 of setup-firewall.sh kept the same chains in the filter table.
  if command -v iptables &>/dev/null && iptables -S ARCHIVUM-EGRESS &>/dev/null; then
    RULES_FOUND=true
    iptables -S ARCHIVUM-INGRESS &>/dev/null && GUARD_FOUND=true
    warn "iptables: the rules are in the filter table, where version 3.2.0 put them. An ACCEPT that another program (a VPN client, a second firewall) places ahead of them lets traffic pass them by. Run setup-firewall.sh again; it moves them."
    FIRST_RULE=$(iptables -S DOCKER-USER 2>/dev/null | grep '^-A ' | head -1 || true)
    if [[ "$FIRST_RULE" == *"-j ACCEPT"* ]]; then
      fail "iptables: DOCKER-USER starts with an ACCEPT ($FIRST_RULE) — traffic it matches skips the rules after it"
    fi
  fi
  if [[ "$RULES_FOUND" == "false" ]]; then
    fail "No egress rules found — run: sudo bash scripts/setup-firewall.sh --mode docker"
  elif [[ "$GUARD_FOUND" == "true" ]]; then
    pass "Inbound guard is in place: one interface may reach the container"
  else
    warn "No inbound guard: anything that can route to the published address reaches port $APP_PORT. Run setup-firewall.sh with --tunnel-iface."
  fi

  # What the earlier version of setup-firewall.sh left behind
  if command -v iptables &>/dev/null; then
    if iptables -S FORWARD 2>/dev/null | grep -qE -- "^-A FORWARD .*-i ${BRIDGE} .*-j (DROP|ACCEPT)"; then
      warn "Old rules in FORWARD for $BRIDGE: they sit behind Docker's own accept and never run. Run setup-firewall.sh again; it removes them."
    fi
    if iptables -S DOCKER-USER 2>/dev/null | grep -qE -- '^-A DOCKER-USER -i [^ ]+ -j ACCEPT$'; then
      fail "DOCKER-USER accepts everything from an interface: this host forwards that interface's packets to any network it routes to. Run setup-firewall.sh again; it removes the rule."
    fi
  fi
fi

# ── Check 7: Egress, tested from inside the container ─────────────────────────
header "7. Container egress (tested)"
if [[ "$RUNNING" != "true" ]]; then
  warn "Container is not running — skipping the egress test"
else
  # try <host> <port> — open / timeout / an error code, as seen from the container
  try() {
    docker exec "$CONTAINER_NAME" node -e '
      const [host, port] = process.argv.slice(1);
      const socket = require("net").connect({ host, port: Number(port) });
      const timer = setTimeout(() => { console.log("timeout"); socket.destroy(); }, 4000);
      socket.on("connect", () => { clearTimeout(timer); console.log("open"); socket.destroy(); });
      socket.on("error", (e) => { clearTimeout(timer); console.log(e.code); });' "$1" "$2" 2>/dev/null | tail -1
  }
  # A refused connection counts as reachable: the answer came from the other end.
  blocked() { [[ "$1" == "timeout" || "$1" == "EHOSTUNREACH" || "$1" == "ENETUNREACH" ]]; }

  # 1.1.1.1 is outside the ranges the Turnstile allowance opens.
  INTERNET=$(try 1.1.1.1 443)
  if blocked "$INTERNET"; then
    pass "The container cannot open a connection to the internet (1.1.1.1:443: $INTERNET)"
  else
    fail "The container can reach the internet (1.1.1.1:443: $INTERNET) — egress is not contained"
  fi

  GATEWAY=$(inspect '{{range .NetworkSettings.Networks}}{{.Gateway}}{{end}}')
  if [[ -n "$GATEWAY" ]]; then
    HOST_RESULT=$(try "$GATEWAY" 22)
    if blocked "$HOST_RESULT"; then
      pass "The container cannot open a connection to this host ($GATEWAY:22: $HOST_RESULT)"
    else
      fail "The container can reach this host ($GATEWAY:22: $HOST_RESULT) — whatever the host listens on is exposed to it"
    fi
  fi
fi

# ── Check 8: LAN reachability test ────────────────────────────────────────────
# From this host to its own LAN address. It shows where the port is published; it
# cannot show what another machine on the LAN reaches by routing to the published
# address. That is what the inbound guard of check 6 is for.
header "8. LAN reachability test"
LAN_IF=$(ip route | awk '/^default/ {print $5}' | head -1)
if [[ -n "$LAN_IF" ]]; then
  LAN_IP=$(ip -4 addr show "$LAN_IF" 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+' | head -1 || true)
  if [[ -n "$LAN_IP" ]]; then
    # Only test if LAN_IP ≠ HOST_BIND_ADDRESS (i.e. the port is NOT intentionally on LAN)
    if [[ "$LAN_IP" != "$HOST_BIND_ADDRESS" ]]; then
      if command -v nc &>/dev/null; then
        if nc -z -w2 "$LAN_IP" "$APP_PORT" 2>/dev/null; then
          fail "Port $APP_PORT is REACHABLE on the LAN address of $LAN_IF ($LAN_IP)"
        else
          pass "Port $APP_PORT is NOT published on the LAN address of $LAN_IF ($LAN_IP)"
        fi
      elif command -v curl &>/dev/null; then
        if curl -s --max-time 2 "http://$LAN_IP:$APP_PORT/api/health" &>/dev/null; then
          fail "Port $APP_PORT is REACHABLE on the LAN address ($LAN_IP)"
        else
          pass "Port $APP_PORT is NOT published on the LAN address ($LAN_IP)"
        fi
      else
        warn "Neither nc nor curl found — skipping LAN reachability test"
      fi
    else
      warn "HOST_BIND_ADDRESS matches LAN IP ($LAN_IP) — port is intentionally on LAN. This is insecure for production."
    fi
  fi
fi

# ── Check 9: docker.sock mount ────────────────────────────────────────────────
header "9. docker.sock mount"
SOCK_MOUNTS=$(inspect '{{range .Mounts}}{{.Source}}{{"\n"}}{{end}}' | grep docker.sock || true)
if [[ -n "$SOCK_MOUNTS" ]]; then
  fail "docker.sock is mounted inside the container — container escape risk"
else
  pass "docker.sock is NOT mounted"
fi

# ── Summary ───────────────────────────────────────────────────────────────────
header "Summary"
printf 'Passed: \033[0;32m%d\033[0m  Failed: \033[0;31m%d\033[0m  Warnings: \033[0;33m%d\033[0m\n' "$PASS" "$FAIL" "$WARN"

if [[ "$FAIL" -gt 0 ]]; then
  echo ""
  red "$FAIL check(s) failed — see above for details."
  exit 1
elif [[ "$WARN" -gt 0 ]]; then
  echo ""
  yellow "$WARN warning(s) — review before exposing to the internet."
  exit 0
else
  echo ""
  green "All checks passed."
  exit 0
fi

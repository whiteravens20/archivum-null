#!/usr/bin/env bash
# ── Archivum Null — Deployment Posture Check ──────────────────────────────────
# Run this on the HOMELAB HOST (not the VPS) after bringing up the production
# container.  It validates that the network exposure matches the expected secure
# posture: port 3000 reachable only via the tunnel interface, not from LAN.
#
# Usage:
#   ./scripts/check-deployment.sh [--tunnel-iface wg0] [--port 3000]
#
# Requirements:
#   - ss  (iproute2, default on all Debian/Ubuntu/Fedora/Arch systems)
#   - iptables or nft  (at least one must be present for firewall checks)
#   - docker  (for container status)
#   - curl or nc  (for connectivity tests)
# ─────────────────────────────────────────────────────────────────────────────

set -euo pipefail

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

pass()  { green  "$*"; (( PASS++ ));  }
fail()  { red    "$*"; (( FAIL++ ));  }
warn()  { yellow "$*"; (( WARN++ ));  }

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
    if ip link show "$iface" &>/dev/null 2>&1; then
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
if docker inspect --format '{{.State.Running}}' "$CONTAINER_NAME" 2>/dev/null | grep -q 'true'; then
  pass "Container '$CONTAINER_NAME' is running"
  HEALTHY=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}no-healthcheck{{end}}' "$CONTAINER_NAME")
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
  BINDINGS=$(ss -tlnp 2>/dev/null | grep ":${APP_PORT} " || true)
  if [[ -z "$BINDINGS" ]]; then
    fail "Nothing is listening on port $APP_PORT"
  else
    echo "  Listening: $BINDINGS"
    if echo "$BINDINGS" | grep -qE "^LISTEN\s+\S+\s+\S+\s+0\.0\.0\.0:${APP_PORT}|^\*:${APP_PORT}"; then
      fail "Port $APP_PORT is bound to 0.0.0.0 — exposed on ALL host interfaces (set HOST_BIND_ADDRESS in .env)"
    else
      BOUND_IP=$(echo "$BINDINGS" | grep -oE '[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+' | head -1)
      pass "Port $APP_PORT is bound to $BOUND_IP (not 0.0.0.0)"
      if [[ -n "$HOST_BIND_ADDRESS" && "$BOUND_IP" != "$HOST_BIND_ADDRESS" ]]; then
        warn "Bound address ($BOUND_IP) does not match HOST_BIND_ADDRESS ($HOST_BIND_ADDRESS) in .env"
      fi
    fi
  fi
fi

# ── Check 3: Container user is non-root ───────────────────────────────────────
header "3. Container user"
CUSER=$(docker inspect --format '{{.Config.User}}' "$CONTAINER_NAME" 2>/dev/null || true)
if [[ -z "$CUSER" || "$CUSER" == "root" || "$CUSER" == "0" ]]; then
  fail "Container is running as root — check USER in Dockerfile"
else
  pass "Container running as user: $CUSER"
fi

# ── Check 4: Capabilities and security options ────────────────────────────────
header "4. Container security options"
CAPS=$(docker inspect --format '{{len .HostConfig.CapAdd}}' "$CONTAINER_NAME" 2>/dev/null || echo 0)
if [[ "$CAPS" -eq 0 ]]; then
  pass "No capabilities added (cap_drop: ALL in effect)"
else
  fail "Container has $CAPS added capabilities — review docker-compose.yml"
fi

NO_NEW_PRIV=$(docker inspect --format '{{.HostConfig.SecurityOpt}}' "$CONTAINER_NAME" 2>/dev/null || true)
if echo "$NO_NEW_PRIV" | grep -q 'no-new-privileges'; then
  pass "no-new-privileges enabled"
else
  fail "no-new-privileges is NOT enabled"
fi

READONLY=$(docker inspect --format '{{.HostConfig.ReadonlyRootfs}}' "$CONTAINER_NAME" 2>/dev/null || echo false)
if [[ "$READONLY" == "true" ]]; then
  pass "Root filesystem is read-only"
else
  fail "Root filesystem is writable — set read_only: true in docker-compose.yml"
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
header "6. Firewall rules (port $APP_PORT)"
FIREWALL_CHECKED=false
if command -v nft &>/dev/null; then
  FIREWALL_CHECKED=true
  NFT_RULES=$(nft list ruleset 2>/dev/null | grep -E "dport\s+$APP_PORT|dport\s+\{[^}]*$APP_PORT" || true)
  if [[ -n "$NFT_RULES" ]]; then
    pass "nftables has rules for port $APP_PORT:"
    echo "$NFT_RULES" | sed 's/^/    /'
  else
    warn "No nftables rules found for port $APP_PORT (may be fine if iptables is in use)"
  fi
fi
if command -v iptables &>/dev/null; then
  FIREWALL_CHECKED=true
  IPT_RULES=$(iptables -S INPUT 2>/dev/null | grep -- "--dport $APP_PORT" || true)
  if [[ -n "$IPT_RULES" ]]; then
    pass "iptables has rules for port $APP_PORT:"
    echo "$IPT_RULES" | sed 's/^/    /'
    # Check for the critical order mistake: DROP before ACCEPT
    FIRST_RELEVANT=$(echo "$IPT_RULES" | head -1)
    if echo "$FIRST_RELEVANT" | grep -q "\-j DROP"; then
      fail "First firewall rule for port $APP_PORT is a DROP — tunnel traffic may be blocked before ACCEPT. See README for correct whitelist-first ordering."
    fi
  else
    warn "No iptables rules found for port $APP_PORT"
  fi
fi
if [[ "$FIREWALL_CHECKED" == "false" ]]; then
  warn "Neither nft nor iptables found — cannot verify firewall posture"
fi

# ── Check 7: LAN reachability test ────────────────────────────────────────────
header "7. LAN reachability test"
LAN_IF=$(ip route | awk '/^default/ {print $5}' | head -1)
if [[ -n "$LAN_IF" ]]; then
  LAN_IP=$(ip -4 addr show "$LAN_IF" 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+' | head -1 || true)
  if [[ -n "$LAN_IP" ]]; then
    # Only test if LAN_IP ≠ HOST_BIND_ADDRESS (i.e. the port is NOT intentionally on LAN)
    if [[ "$LAN_IP" != "$HOST_BIND_ADDRESS" ]]; then
      if command -v nc &>/dev/null; then
        if nc -z -w2 "$LAN_IP" "$APP_PORT" 2>/dev/null; then
          fail "Port $APP_PORT is REACHABLE via LAN interface $LAN_IF ($LAN_IP) — firewall rules are missing or wrong"
        else
          pass "Port $APP_PORT is NOT reachable via LAN interface $LAN_IF ($LAN_IP)"
        fi
      elif command -v curl &>/dev/null; then
        if curl -s --max-time 2 "http://$LAN_IP:$APP_PORT/api/health" &>/dev/null; then
          fail "Port $APP_PORT is REACHABLE via LAN ($LAN_IP) — firewall rules are missing or wrong"
        else
          pass "Port $APP_PORT is NOT reachable via LAN ($LAN_IP)"
        fi
      else
        warn "Neither nc nor curl found — skipping LAN reachability test"
      fi
    else
      warn "HOST_BIND_ADDRESS matches LAN IP ($LAN_IP) — port is intentionally on LAN. This is insecure for production."
    fi
  fi
fi

# ── Check 8: docker.sock mount ────────────────────────────────────────────────
header "8. docker.sock mount"
SOCK_MOUNTS=$(docker inspect --format '{{range .Mounts}}{{.Source}}{{"\n"}}{{end}}' "$CONTAINER_NAME" 2>/dev/null | grep docker.sock || true)
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

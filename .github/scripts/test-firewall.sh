#!/usr/bin/env bash
# Tests scripts/setup-firewall.sh.
#
#   dry-run   What the script prints for each mode and backend, checked as text. Needs nothing.
#   live      The rules applied for real and probed: to a container on a bridge named br-archivum, and to a process of
#             a test user. Needs root, Docker, iptables, nft, curl and python3. It changes this machine's firewall and
#             puts it back, so it is meant for a CI runner or a throwaway VM, not for a machine you care about.
#
# The live part builds the deployment in small: a "proxy" in one network namespace, reaching the app over a veth pair
# that stands for the tunnel, and a "LAN neighbour" in another. Every expectation below is one the rules exist for.
#
# Usage: .github/scripts/test-firewall.sh dry-run | live
set -uo pipefail

cd "$(dirname "$0")/../.." || exit 2
SCRIPT=scripts/setup-firewall.sh
failed=0
checks=0

ok()   { checks=$((checks + 1)); printf '  ok    %s\n' "$1"; }
bad()  { checks=$((checks + 1)); failed=$((failed + 1)); printf '  FAIL  %s\n' "$1"; [[ -n "${2:-}" ]] && printf '        %s\n' "$2"; return 0; }
group() { printf '\n%s\n' "$1"; }

# expect <what> <wanted> <got>
expect() { if [[ "$2" == "$3" ]]; then ok "$1: $3"; else bad "$1" "wanted $2, got $3"; fi; }
# has <what> <text> <fixed string> / lacks <what> <text> <fixed string>
has()   { if grep -qF -- "$3" <<< "$2"; then ok "$1"; else bad "$1" "missing: $3"; fi; }
lacks() { if grep -qF -- "$3" <<< "$2"; then bad "$1" "present: $3"; else ok "$1"; fi; }

# ═════════════════════════════════════════════════════════════════════════════
dry_run() {
  local out

  group "docker, iptables, Turnstile on, tunnel interface"
  out=$(bash "$SCRIPT" --mode docker --backend iptables --turnstile yes --tunnel-iface wg0 --dry-run 2>&1)
  has   "egress rules live in a chain of their own"         "$out" "-A ARCHIVUM-EGRESS -j DROP"
  has   "the chain is entered from DOCKER-USER"             "$out" "iptables -I DOCKER-USER 1 -i br-archivum -j ARCHIVUM-EGRESS"
  has   "and from FORWARD, for a Docker without that chain" "$out" "iptables -I FORWARD 1 -i br-archivum -j ARCHIVUM-EGRESS"
  lacks "no rule is appended to FORWARD"                    "$out" "-A FORWARD"
  lacks "nothing is accepted, only returned or dropped"     "$out" "-j ACCEPT"
  has   "traffic to the host itself has its own chain"      "$out" "iptables -I INPUT 1 -i br-archivum -j ARCHIVUM-HOST"
  has   "Cloudflare is allowed on 443"                      "$out" "-A ARCHIVUM-EGRESS -d 104.16.0.0/13 -p tcp --dport 443 -j RETURN"
  has   "the inbound guard lets the tunnel interface in"    "$out" "-A ARCHIVUM-INGRESS -i wg0 -j RETURN"
  has   "and drops the rest"                                "$out" "-A ARCHIVUM-INGRESS -j DROP"
  has   "IPv6 is covered"                                   "$out" "ip6tables -I DOCKER-USER 1 -i br-archivum -j ARCHIVUM-EGRESS"
  lacks "no resolver is allowed unless one is given"        "$out" "--dport 53"
  # Replies have to pass before anything is dropped, in every chain.
  for chain in ARCHIVUM-EGRESS ARCHIVUM-HOST ARCHIVUM-INGRESS; do
    expect "first rule of $chain" "-A $chain -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN" \
      "$(grep -F -- "-A $chain " <<< "$out" | head -1)"
  done

  group "docker, iptables, Turnstile off, no tunnel interface"
  out=$(bash "$SCRIPT" --mode docker --backend iptables --turnstile no --dry-run 2>&1)
  lacks "no Cloudflare allowance"  "$out" "104.16.0.0/13"
  lacks "no inbound guard"         "$out" "ARCHIVUM-INGRESS"
  expect "the egress chain holds two rules" "2" "$(grep -cF -- "-A ARCHIVUM-EGRESS " <<< "$(sed -n '/^# iptables-restore/,/^# EOF/p' <<< "$out")")"

  group "docker, nftables, Turnstile on, tunnel interface"
  out=$(bash "$SCRIPT" --mode docker --backend nftables --turnstile yes --tunnel-iface wg0 --dry-run 2>&1)
  has   "a table of its own"                    "$out" "table inet archivum_null {"
  has   "rebuilt in one transaction"            "$out" "delete table inet archivum_null"
  has   "egress is entered by the bridge"       "$out" 'iifname "br-archivum" jump egress'
  has   "the host has its own chain"            "$out" 'iifname "br-archivum" jump host'
  has   "Cloudflare is allowed on 443"          "$out" "ip daddr { 104.16.0.0/13, 104.24.0.0/14 } tcp dport 443 accept"
  has   "the inbound guard names the interface" "$out" 'iifname "wg0" accept'
  lacks "no resolver is allowed unless one is given" "$out" "dport 53"

  group "docker, a resolver and an extra destination given"
  out=$(bash "$SCRIPT" --mode docker --backend nftables --turnstile no --dns 192.0.2.53 --allow 198.51.100.0/24:443 --dry-run 2>&1)
  has   "the resolver is allowed on 53"         "$out" "ip daddr { 192.0.2.53 } meta l4proto { tcp, udp } th dport 53 accept"
  has   "the extra destination is allowed"      "$out" "ip daddr 198.51.100.0/24 tcp dport 443 accept"
  lacks "Cloudflare is not, with Turnstile off" "$out" "104.16.0.0/13"

  group "bare-metal, nftables, Turnstile on"
  out=$(bash "$SCRIPT" --mode bare-metal --backend nftables --turnstile yes --tunnel-iface wg0 --app-uid 1001 --dns 127.0.0.53 --dry-run 2>&1)
  has   "entered by packets of the app's user only"   "$out" "meta skuid 1001 jump egress"
  has   "the port guard lets this host in"            "$out" 'iifname "lo" accept'
  has   "the resolver is allowed"                     "$out" "ip daddr { 127.0.0.53 } meta l4proto { tcp, udp } th dport 53 accept"
  expect "replies pass first" "ct state established,related accept" \
    "$(sed -n '/chain egress {/,/}/p' <<< "$out" | sed -n '2p' | sed 's/^[[:space:]]*//')"

  group "bare-metal, iptables, Turnstile off"
  out=$(bash "$SCRIPT" --mode bare-metal --backend iptables --turnstile no --app-uid 1001 --dry-run 2>&1)
  has   "the jump matches the user"   "$out" "iptables -I OUTPUT 1 -m owner --uid-owner 1001 -j ARCHIVUM-EGRESS"
  lacks "nothing is accepted"         "$out" "-j ACCEPT"
  lacks "no resolver without anywhere to connect to" "$out" "--dport 53"

  group "what it refuses"
  out=$(bash "$SCRIPT" --mode proxmox-veth --dry-run 2>&1); expect "the removed proxmox-veth mode, exit code" "1" "$?"
  has   "and says what to use"                    "$out" "Proxmox firewall"
  out=$(bash "$SCRIPT" --mode bare-metal --turnstile no --app-uid 0 --dry-run 2>&1); expect "rules for root, exit code" "1" "$?"
  out=$(bash "$SCRIPT" --mode docker --turnstile no --allow not-a-range --dry-run 2>&1); expect "a malformed --allow, exit code" "1" "$?"
  out=$(bash "$SCRIPT" --mode docker --turnstile maybe --dry-run 2>&1); expect "an unknown --turnstile value, exit code" "1" "$?"
  out=$(bash "$SCRIPT" --no-such-option 2>&1); expect "an unknown option, exit code" "1" "$?"
  out=$(bash "$SCRIPT" --mode docker --turnstile no --tunnel-iface 'wg0; reboot' --dry-run 2>&1); expect "an interface name that is not one, exit code" "1" "$?"
}

# ═════════════════════════════════════════════════════════════════════════════
TUNNEL=anfwtun0            # stands for the tunnel interface on the host
TUNNEL_HOST_IP=10.213.0.2  # where the app is published
PROXY_IP=10.213.0.1
LAN_HOST_IP=10.214.0.1
LAN_IP=10.214.0.2
APP=an-fwtest-app
NETWORK=an-fwtest
TEST_USER=anfwtest
HOST_PORT=18099
PIDS=()

cleanup() {
  set +e
  bash "$SCRIPT" --remove --yes >/dev/null 2>&1
  for pid in "${PIDS[@]}"; do kill "$pid" 2>/dev/null; done
  pkill -u "$TEST_USER" 2>/dev/null
  docker rm -f "$APP" >/dev/null 2>&1
  docker network rm "$NETWORK" >/dev/null 2>&1
  ip netns del an-fwtest-proxy 2>/dev/null
  ip netns del an-fwtest-lan 2>/dev/null
  ip link del "$TUNNEL" 2>/dev/null
  ip link del anfwlan0 2>/dev/null
  userdel "$TEST_USER" 2>/dev/null
  return 0
}

# from_app <host> <port> — a TCP connection attempt from inside the container: open, timeout or an error code
from_app() {
  docker exec "$APP" node -e '
    const [host, port] = process.argv.slice(1);
    const socket = require("net").connect({ host, port: Number(port) });
    const timer = setTimeout(() => { console.log("timeout"); socket.destroy(); }, 3000);
    socket.on("connect", () => { clearTimeout(timer); console.log("open"); socket.destroy(); });
    socket.on("error", (e) => { clearTimeout(timer); console.log(e.code); });' "$1" "$2" 2>/dev/null | tail -1
}
# as_user <host> <port> — the same from a process of the test user
as_user() {
  if sudo -u "$TEST_USER" timeout 3 bash -c "exec 3<>/dev/tcp/$1/$2" 2>/dev/null; then echo open; else echo blocked; fi
}
# http_from <namespace|host> <url> — status code, 000 when nothing answers
http_from() {
  if [[ "$1" == host ]]; then curl -s -m 4 -o /dev/null -w '%{http_code}' "$2" 2>/dev/null
  else ip netns exec "$1" curl -s -m 4 -o /dev/null -w '%{http_code}' "$2" 2>/dev/null; fi
  return 0
}
apply() { bash "$SCRIPT" "$@" --yes >/dev/null 2>&1 || bad "setup-firewall.sh $*" "exit code $?"; }
rules() { { iptables-save; ip6tables-save; nft list ruleset; } 2>/dev/null | grep -v -E '^(#|:)|packets [0-9]+ bytes'; }

live() {
  local image cloudflare gateway before after backend

  [[ "$(id -u)" -eq 0 ]] || { echo "live needs root"; exit 2; }
  for tool in docker iptables ip6tables nft curl python3 ip; do
    command -v "$tool" >/dev/null 2>&1 || { echo "live needs $tool"; exit 2; }
  done
  trap cleanup EXIT
  cleanup

  # The image the product itself is built from, pinned by digest in the Dockerfile.
  image=$(awk '$1 == "FROM" { print $2; exit }' Dockerfile)
  cloudflare=$(getent ahostsv4 challenges.cloudflare.com | awk '{ print $1; exit }')
  [[ -n "$cloudflare" ]] || { echo "cannot resolve challenges.cloudflare.com"; exit 2; }

  group "building the deployment in small"
  ip netns add an-fwtest-proxy; ip netns add an-fwtest-lan
  ip link add "$TUNNEL" type veth peer name eth0 netns an-fwtest-proxy
  ip link add anfwlan0 type veth peer name eth0 netns an-fwtest-lan
  ip addr add "$TUNNEL_HOST_IP/24" dev "$TUNNEL"; ip link set "$TUNNEL" up
  ip addr add "$LAN_HOST_IP/24" dev anfwlan0; ip link set anfwlan0 up
  ip netns exec an-fwtest-proxy sh -c "ip link set lo up; ip addr add $PROXY_IP/24 dev eth0; ip link set eth0 up"
  ip netns exec an-fwtest-lan sh -c "ip link set lo up; ip addr add $LAN_IP/24 dev eth0; ip link set eth0 up; ip route add default via $LAN_HOST_IP"
  # A LAN neighbour that sends the published address through this host
  ip netns exec an-fwtest-lan ip route replace "$TUNNEL_HOST_IP/32" via "$LAN_HOST_IP"
  ip netns exec an-fwtest-lan python3 -m http.server 8080 --bind "$LAN_IP" >/dev/null 2>&1 & PIDS+=($!)
  python3 -m http.server "$HOST_PORT" --bind 0.0.0.0 >/dev/null 2>&1 & PIDS+=($!)

  docker network create -o com.docker.network.bridge.name=br-archivum "$NETWORK" >/dev/null
  docker run -d --name "$APP" --network "$NETWORK" -p "$TUNNEL_HOST_IP:3000:3000" "$image" \
    node -e 'require("http").createServer((q, s) => s.end("ok")).listen(3000, "0.0.0.0")' >/dev/null
  gateway=$(docker inspect "$APP" --format '{{range .NetworkSettings.Networks}}{{.Gateway}}{{end}}')
  for _ in $(seq 1 20); do [[ "$(http_from host "http://$TUNNEL_HOST_IP:3000/")" == 200 ]] && break; sleep 0.5; done
  before=$(rules)

  group "without rules (what the rules are there to change)"
  expect "proxy reaches the app"                         "200"  "$(http_from an-fwtest-proxy "http://$TUNNEL_HOST_IP:3000/")"
  expect "a LAN neighbour reaches it too, by routing"    "200"  "$(http_from an-fwtest-lan "http://$TUNNEL_HOST_IP:3000/")"
  expect "container reaches the internet"                "open" "$(from_app 1.1.1.1 443)"
  expect "container reaches the LAN neighbour"           "open" "$(from_app "$LAN_IP" 8080)"
  expect "container reaches a service on the host"       "open" "$(from_app "$gateway" "$HOST_PORT")"

  for backend in iptables nftables; do
    group "docker, $backend, Turnstile off, inbound guard"
    apply --mode docker --backend "$backend" --turnstile no --tunnel-iface "$TUNNEL"
    expect "proxy reaches the app"                       "200"     "$(http_from an-fwtest-proxy "http://$TUNNEL_HOST_IP:3000/")"
    expect "this host reaches the app"                   "200"     "$(http_from host "http://$TUNNEL_HOST_IP:3000/")"
    expect "the LAN neighbour no longer does"            "000"     "$(http_from an-fwtest-lan "http://$TUNNEL_HOST_IP:3000/")"
    expect "container cannot reach the internet"         "timeout" "$(from_app 1.1.1.1 443)"
    expect "container cannot reach Cloudflare"           "timeout" "$(from_app "$cloudflare" 443)"
    expect "container cannot reach the LAN neighbour"    "timeout" "$(from_app "$LAN_IP" 8080)"
    expect "container cannot reach the proxy on its own" "timeout" "$(from_app "$PROXY_IP" 8080)"
    expect "container cannot reach the host"             "timeout" "$(from_app "$gateway" "$HOST_PORT")"

    group "docker, $backend, Turnstile on, inbound guard"
    apply --mode docker --backend "$backend" --turnstile yes --tunnel-iface "$TUNNEL"
    expect "container reaches Cloudflare on 443"         "open"    "$(from_app "$cloudflare" 443)"
    expect "but not on another port"                     "timeout" "$(from_app "$cloudflare" 80)"
    expect "and not the rest of the internet"            "timeout" "$(from_app 1.1.1.1 443)"
    expect "container cannot reach the host"             "timeout" "$(from_app "$gateway" "$HOST_PORT")"
    expect "proxy reaches the app"                       "200"     "$(http_from an-fwtest-proxy "http://$TUNNEL_HOST_IP:3000/")"

    group "docker, $backend, run again with the same options"
    after=$(rules); apply --mode docker --backend "$backend" --turnstile yes --tunnel-iface "$TUNNEL"
    expect "the rules are the same after a second run"   "same" "$([[ "$after" == "$(rules)" ]] && echo same || echo different)"

    group "docker, $backend, the tunnel interface dropped from the options"
    apply --mode docker --backend "$backend" --turnstile no
    expect "the guard is gone: the LAN neighbour is back" "200"    "$(http_from an-fwtest-lan "http://$TUNNEL_HOST_IP:3000/")"
    expect "egress stays contained"                      "timeout" "$(from_app 1.1.1.1 443)"
  done

  group "rules of the earlier version of the script"
  apply --mode docker --backend nftables --turnstile no --tunnel-iface "$TUNNEL"
  iptables -I FORWARD -i br-archivum -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
  iptables -A FORWARD -i br-archivum -d 10.0.0.0/8 -j DROP
  iptables -A FORWARD -i br-archivum -j DROP
  iptables -I DOCKER-USER -i wg0 -j ACCEPT
  iptables -A INPUT -i wg0 -p tcp --dport 3000 -j ACCEPT
  iptables -A INPUT -p tcp --dport 3000 -j DROP
  apply --mode docker --backend nftables --turnstile no --tunnel-iface "$TUNNEL"
  expect "the accept for the tunnel interface is gone from DOCKER-USER" "0" "$(iptables -S DOCKER-USER | grep -c -- '-j ACCEPT')"
  expect "the old rules are gone from FORWARD"                          "0" "$(iptables -S FORWARD | grep -c -- '-i br-archivum')"
  expect "the old rules are gone from INPUT"                            "0" "$(iptables -S INPUT | grep -c -- '--dport 3000')"

  group "--remove"
  bash "$SCRIPT" --remove --yes >/dev/null 2>&1
  expect "the firewall is as it was before the first run" "same" "$([[ "$before" == "$(rules)" ]] && echo same || echo different)"
  expect "container reaches the internet again"           "open" "$(from_app 1.1.1.1 443)"
  docker rm -f "$APP" >/dev/null 2>&1

  # ── bare-metal: a process of a user of its own ──
  useradd --system --no-create-home --shell /usr/sbin/nologin "$TEST_USER"
  sudo -u "$TEST_USER" python3 -m http.server 3000 --bind 0.0.0.0 >/dev/null 2>&1 & PIDS+=($!)
  for _ in $(seq 1 20); do [[ "$(http_from host http://127.0.0.1:3000/)" == 200 ]] && break; sleep 0.5; done

  for backend in iptables nftables; do
    group "bare-metal, $backend, Turnstile on, inbound guard"
    apply --mode bare-metal --backend "$backend" --turnstile yes --tunnel-iface "$TUNNEL" --app-uid "$TEST_USER" --dns none
    expect "proxy reaches the app (its replies pass)"    "200"     "$(http_from an-fwtest-proxy "http://$TUNNEL_HOST_IP:3000/")"
    expect "this host reaches the app"                   "200"     "$(http_from host http://127.0.0.1:3000/)"
    expect "a LAN neighbour does not"                    "000"     "$(http_from an-fwtest-lan "http://$LAN_HOST_IP:3000/")"
    expect "the app's user cannot reach the internet"    "blocked" "$(as_user 1.1.1.1 443)"
    expect "the app's user reaches Cloudflare on 443"    "open"    "$(as_user "$cloudflare" 443)"
    expect "the app's user cannot reach the LAN"         "blocked" "$(as_user "$LAN_IP" 8080)"
    expect "the app's user cannot reach this host's own services" "blocked" "$(as_user 127.0.0.1 "$HOST_PORT")"
    expect "another user is not affected"                "200"     "$(http_from host "http://$LAN_IP:8080/")"
    expect "packets the kernel sends itself still pass"  "ok"      "$(ping -c 1 -W 2 "$PROXY_IP" >/dev/null 2>&1 && echo ok || echo lost)"
  done

  group "--remove"
  bash "$SCRIPT" --remove --yes >/dev/null 2>&1
  expect "the app's user reaches the internet again"     "open" "$(as_user 1.1.1.1 443)"
}

case "${1:-}" in
  dry-run) dry_run ;;
  live)    live ;;
  *) echo "usage: $0 dry-run | live" >&2; exit 2 ;;
esac

printf '\n%d checks, %d failed\n' "$checks" "$failed"
[[ $failed -eq 0 ]]

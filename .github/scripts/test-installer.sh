#!/usr/bin/env bash
# Checks scripts/install-lxc.sh as far as that is possible without a Proxmox host: the parts that can be read off its
# text. The live behaviour, a real install and a real update, needs a hypervisor and is tested by hand.
#
#   - The service unit the installer writes keeps the app unprivileged and sandboxed. Measured with systemd's own
#     exposure score, on the unit taken out of the script: the installer of v3.1.1 scored 8.7, this one 1.3.
#   - The script is one function called on its last line, so a download that was cut short runs nothing.
#
# Needs systemd-analyze 250 or newer. Usage: .github/scripts/test-installer.sh
set -uo pipefail

cd "$(dirname "$0")/../.." || exit 2
installer=scripts/install-lxc.sh
failed=0
fail() { echo "::error file=$installer::$1"; failed=1; }

workdir=$(mktemp -d)
trap 'rm -rf "$workdir"' EXIT
unit="$workdir/archivum-null.service"
sed -n "/^  cat > \/etc\/systemd\/system\/archivum-null.service << 'EOF'$/,/^EOF$/p" "$installer" | sed '1d;$d' > "$unit"
[[ -s "$unit" ]] || { fail "could not find the service unit in the installer"; exit 1; }

for line in 'User=archivum' 'Group=archivum' 'NoNewPrivileges=yes' 'CapabilityBoundingSet=' 'AmbientCapabilities=' \
            'ProtectSystem=strict' 'ReadWritePaths=/opt/archivum-null/data/vaults'; do
  grep -qxF -- "$line" "$unit" || fail "the unit lacks the line: $line"
done
[[ "$(grep -c '^ReadWritePaths=' "$unit")" == 1 ]] || fail "the unit may write to more than the vault directory"
grep -qE '^ExecStart=/usr/bin/node --permission ' "$unit" || fail "the unit does not start Node under its permission model"

# 2.0 leaves room for a directive or two to change; an unsandboxed unit is far above it.
if ! systemd-analyze security --offline=true --threshold=20 "$unit" | tail -1; then
  fail "systemd rates the unit's exposure above 2.0"
fi

[[ "$(tail -n 1 "$installer")" == 'main "$@"' ]] || fail "the last line must be: main \"\$@\""
# Nothing may run before that line except the shell options.
if grep -vE '^\s*(#|$)' "$installer" | sed -n '1,/^main() {$/p' | grep -vE '^(set -euo pipefail|main\(\) \{)$' | grep -q .; then
  fail "there are commands outside main()"
fi

[[ $failed -eq 0 ]] && echo "installer checks passed"
exit "$failed"

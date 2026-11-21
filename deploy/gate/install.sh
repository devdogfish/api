#!/bin/bash
# One-time Owner install on Gate (needs the Owner's sudo password once):
#   sudo bash install.sh girke-api.tail555ca5.ts.net
# Adds a loopback Caddy relay on 127.0.0.1:8803 and Funnel on :10000.
# Leaves the existing webhook relay (:443 -> 8790) and :8443 untouched.
set -euo pipefail
umask 022
test "$(hostname -s)" = gate
host=${1:?usage: install.sh VM_API_TAILNET_HOST}
[[ "$host" =~ ^[a-z0-9.-]+\.ts\.net$ ]]
cd "$(dirname "$0")"
install -d -m 0755 /etc/girke-api-funnel
install -m 0644 Caddyfile /etc/girke-api-funnel/Caddyfile
printf 'GIRKE_API_TAILNET_HOST=%s\n' "$host" >/etc/girke-api-funnel/funnel.env
install -m 0644 girke-api-funnel.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now girke-api-funnel.service
tailscale funnel --bg --https=10000 http://127.0.0.1:8803
tailscale funnel status
echo GIRKE_GATE_INSTALL_DONE

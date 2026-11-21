#!/bin/bash
# One-time setup inside vm api (Atlas VM 3500), run as root via `qm guest exec`.
# Installs Docker, Tailscale and the pull deployer. Reads the Tailscale auth key
# from stdin so it never appears in argv or logs. Idempotent apart from `tailscale up`.
#
#   qm guest exec 3500 --pass-stdin 1 -- bash /root/setup-vm.sh < authkey
set -euo pipefail
umask 022
export DEBIAN_FRONTEND=noninteractive
test "$(hostname -s)" = girke-api

apt-get update -q
apt-get install -y -q --no-install-recommends ca-certificates curl git gnupg nftables \
  docker.io docker-compose docker-buildx unattended-upgrades

install -d -m 0755 /usr/share/keyrings
curl -fsSL https://pkgs.tailscale.com/stable/debian/trixie.noarmor.gpg -o /usr/share/keyrings/tailscale-archive-keyring.gpg
curl -fsSL https://pkgs.tailscale.com/stable/debian/trixie.tailscale-keyring.list -o /etc/apt/sources.list.d/tailscale.list
apt-get update -q
apt-get install -y -q tailscale

# Guest firewall: nothing listens on eth0 except replies. The tailnet reaches
# only the edge (8080) through tailscale serve; ACLs limit that to Gate.
cat >/etc/nftables.conf <<'NFT'
#!/usr/sbin/nft -f
# Own table only: never flush Docker's rules.
table inet girke_guest
delete table inet girke_guest
table inet girke_guest {
    chain input {
        type filter hook input priority filter; policy drop;
        iifname "lo" accept
        ct state established,related accept
        iifname "tailscale0" tcp dport 8080 accept
        icmp type echo-request limit rate 5/second accept
    }
}
NFT
systemctl enable --now nftables

if ! tailscale status >/dev/null 2>&1; then
  key=$(cat)
  [ -n "$key" ] || { echo "Tailscale auth key on stdin required" >&2; exit 1; }
  tailscale up --auth-key="$key" --hostname=girke-api --advertise-tags=tag:girke-api --ssh=false
  unset key
fi
tailscale serve --bg --tcp=8080 tcp://127.0.0.1:8080

install -d -m 0750 /srv/girke-api /srv/girke-api/releases /srv/girke-api/state
install -d -m 0755 /srv/girke-api/boards
[ -d /srv/girke-api/repo ] || git init -q --bare /srv/girke-api/repo
docker network inspect girke-edge >/dev/null 2>&1 || docker network create girke-edge >/dev/null

src=$(dirname "$0")
install -m 0755 "$src/girke-deploy" /usr/local/sbin/girke-deploy
install -m 0644 "$src/girke-deploy.service" "$src/girke-deploy.timer" /etc/systemd/system/
systemctl daemon-reload
echo "SETUP_DONE: put .env at /srv/girke-api/.env (0600), Boards at /srv/girke-api/boards, then: girke-deploy --ref main; systemctl enable --now girke-deploy.timer"

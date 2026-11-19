#!/usr/bin/env bash
set -euo pipefail

# Synthetic only. Use a staged aggregate proof image and a local Docker context.
image=${1:?usage: scripts/prove-owner-console-linux.sh IMAGE_ID}
if [[ ! "$image" =~ ^sha256:[0-9a-f]{64}$ ]]; then
  echo 'Pass the exact local proof image ID.' >&2
  exit 1
fi
context=$(docker context show)
endpoint=$(docker context inspect "$context" --format '{{.Endpoints.docker.Host}}')
[[ "$endpoint" == unix://* ]]
[[ "$(docker --context "$context" image inspect "$image" --format '{{.Os}}/{{.Architecture}}')" == linux/amd64 ]]

cd "$(git rev-parse --show-toplevel)"
umask 077
stage=$(mktemp -d)
trap 'rm -r -- "$stage"' EXIT
git archive --format=tar --output="$stage/source.tar" HEAD bun.lock package.json scripts src tests
docker --context "$context" run --rm --pull=never --platform linux/amd64 --network none \
  --read-only --init --security-opt no-new-privileges --cap-drop ALL \
  --cap-add KILL --cap-add CHOWN --cap-add SETUID --cap-add SETGID --cap-add DAC_OVERRIDE \
  --cpus=2 --memory=3g --memory-swap=3g \
  --tmpfs /tmp:rw,nosuid,nodev,mode=1777,size=128m \
  --tmpfs /fixture:rw,nosuid,nodev,mode=755,size=128m \
  --tmpfs /fixture-identity/scratch:rw,nosuid,nodev,mode=0700,uid=11001,gid=12001,size=64m \
  --tmpfs /fixture-identity/work:rw,nosuid,nodev,mode=2750,uid=11001,gid=12002,size=64m \
  --tmpfs /fixture-identity/vault:rw,nosuid,nodev,mode=0700,uid=11001,gid=12001,size=64m \
  --mount "type=bind,source=$stage/source.tar,target=/tmp-source.tar,readonly" \
  --entrypoint sh "$image" -euc '
  cd /fixture
  tar xf /tmp-source.tar --no-same-owner
  cmp bun.lock /app/bun.lock
  ln -s /app/node_modules node_modules
  exec python scripts/prove-owner-console-linux.py
'

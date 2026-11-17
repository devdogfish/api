#!/bin/sh
# Run a transferred, sealed proof from an already authorized disposable guest.
set -eu

mode=run
case "${1:-}" in
  --check-bundle) mode=check-bundle; shift ;;
  --preflight) mode=preflight; shift ;;
esac
test "$#" -eq 1 || {
  echo 'Supply one sealed bundle directory' >&2
  exit 1
}
bundle=$(cd "$1" && pwd -P)
image=girke-213-aggregate-proof:407c8bb7
archive=girke-aggregate-amd64.tar.gz
manifest_sha=ae787d61182b1bee52eaf1e368185f86810344e5becb44f3a6a131aca01448dc

check_sha256() {
  if command -v sha256sum >/dev/null; then
    sha256sum -c "$@"
  else
    shasum -a 256 -c "$@"
  fi
}

local_docker() (
  unset DOCKER_HOST DOCKER_CONTEXT
  command docker --host "$docker_host" "$@"
)

if [ "$mode" != check-bundle ]; then
  if [ "$(uname -s)" != Linux ] || [ "$(uname -m)" != x86_64 ] ||
     ! grep -Eq '^vendor_id[[:space:]]*:[[:space:]]*(GenuineIntel|AuthenticAMD)$' /proc/cpuinfo; then
    echo 'Native AMD64 Linux guest required' >&2
    exit 1
  fi
  if [ -n "${DOCKER_CONTEXT:-}" ] || [ -z "${DOCKER_HOST:-}" ]; then
    docker_host=$(docker context inspect --format '{{.Endpoints.docker.Host}}')
  else
    docker_host=$DOCKER_HOST
  fi
  case "$docker_host" in
    unix:///*) test -S "${docker_host#unix://}" ;;
    *) echo 'Local Docker Unix socket required' >&2; exit 1 ;;
  esac
  case "$(local_docker info --format '{{.Architecture}}')" in
    x86_64|amd64) ;;
    *) echo 'Native AMD64 Docker server required' >&2; exit 1 ;;
  esac
  test "$(local_docker info --format '{{.CgroupVersion}}')" = 2
  local_docker info --format '{{json .SecurityOptions}}' | grep -q 'name=rootless'
  test "$(getconf _NPROCESSORS_ONLN)" -ge 2
  awk '$1 == "MemAvailable:" { ok = ($2 >= 6291456) } END { exit !ok }' /proc/meminfo
fi

cd "$bundle"
printf '%s  SHA256SUMS\n' "$manifest_sha" | check_sha256 -
check_sha256 SHA256SUMS
config=$(awk 'NR == 1 {sub(/^sha256:/, "", $2); print $2}' linux-image.txt)
case "$config" in
  ''|*[!a-f0-9]*) exit 1 ;;
esac
test "${#config}" -eq 64
actual=$(mktemp)
loaded_id=
cleanup() {
  rm "$actual"
  if [ -n "$loaded_id" ] &&
     [ "$(local_docker image inspect "$image" --format '{{.Id}}' 2>/dev/null)" = "$loaded_id" ]; then
    local_docker image rm "$image"
  fi
}
trap cleanup EXIT
tar -xOzf "$archive" "blobs/sha256/$config" > "$actual"
cmp linux-config.json "$actual"
printf '%s  %s\n' "$config" "$actual" | check_sha256 -
if [ "$mode" = check-bundle ]; then exit 0; fi

if local_docker image inspect "$image" >/dev/null 2>&1; then
  image_id=$(local_docker image inspect "$image" --format '{{.Id}}')
  test "$image_id" = "sha256:$config" ||
    { echo 'Existing fixture tag does not match the sealed config' >&2; exit 1; }
else
  storage=$(local_docker info --format '{{.DockerRootDir}}')
  df -Pk "$storage" | awk 'END { exit !($4 >= 6291456) }'
  local_docker image load -i "$archive"
  image_id=$(local_docker image inspect "$image" --format '{{.Id}}')
  loaded_id=$image_id
fi
test "$(local_docker image inspect "$image_id" --format '{{.Os}}/{{.Architecture}}')" = linux/amd64
local_docker image inspect "$image_id" --format '{{json .RootFS.Layers}}' | python3 -c '
import json
import sys
from pathlib import Path
expected = json.loads(Path("linux-config.json").read_bytes())["rootfs"]["diff_ids"]
actual = json.load(sys.stdin)
if expected != actual:
    raise SystemExit("loaded layers differ from sealed image")
print(f"verified {len(actual)} loaded layers")
'

if [ "$mode" = preflight ]; then
  set --
else
  set -- \
    --mount "type=bind,source=$bundle/proof.py,target=/fixture/proof.py,readonly" \
    --mount "type=bind,source=$bundle/whisper,target=/fixture/whisper,readonly" \
    --mount "type=bind,source=$bundle/speech.wav,target=/fixture/lantern.wav,readonly" \
    --mount "type=bind,source=$bundle/paddle,target=/fixture/paddle,readonly"
fi

# The inner shell expands its arguments inside the container.
# shellcheck disable=SC2016
local_docker run --rm --pull never --platform linux/amd64 --network none \
  --cpus=2 --memory=6g --memory-swap=6g --read-only --init \
  --tmpfs /tmp:rw,size=256m --cap-drop=ALL --security-opt=no-new-privileges \
  "$@" "$image_id" sh -eu -c '
    test "$(ls -1 /sys/class/net)" = lo || {
      echo "Egress isolation check failed" >&2
      exit 1
    }
    echo "network_isolated=1"
    if [ "$1" = preflight ]; then exit 0; fi
    shift
    exec "$@"
  ' sh "$mode" bun scripts/prove-aggregate-queue.ts /usr/local/bin/python /usr/local/bin/python \
    /fixture/proof.py /fixture/whisper /fixture/lantern.wav /fixture/paddle
if [ "$mode" = preflight ]; then
  echo 'native_preflight_passed=1'
fi

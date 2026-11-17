#!/bin/sh
# Run a transferred, sealed proof from an already authorized disposable guest.
set -eu

verify_only=false
if [ "${1:-}" = --check-bundle ]; then
  verify_only=true
  shift
fi
test "$#" -eq 1
bundle=$(cd "$1" && pwd -P)
image=girke-213-aggregate-proof:407c8bb7
archive=girke-aggregate-amd64.tar.gz

if ! "$verify_only"; then
  test "$(uname -m)" = x86_64 || { echo 'Native AMD64 guest required' >&2; exit 1; }
  case "$(docker info --format '{{.Architecture}}')" in
    x86_64|amd64) ;;
    *) echo 'Native AMD64 Docker server required' >&2; exit 1 ;;
  esac
  test "$(docker info --format '{{.CgroupVersion}}')" = 2
  docker info --format '{{json .SecurityOptions}}' | grep -q 'name=rootless'
  test "$(getconf _NPROCESSORS_ONLN)" -ge 2
  awk '$1 == "MemAvailable:" { ok = ($2 >= 6291456) } END { exit !ok }' /proc/meminfo
fi

cd "$bundle"
if command -v sha256sum >/dev/null; then
  sha256sum -c SHA256SUMS
else
  shasum -a 256 -c SHA256SUMS
fi
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
     [ "$(docker image inspect "$image" --format '{{.Id}}' 2>/dev/null)" = "$loaded_id" ]; then
    docker image rm "$image"
  fi
}
trap cleanup EXIT
tar -xOzf "$archive" "blobs/sha256/$config" > "$actual"
cmp linux-config.json "$actual"
printf '%s  %s\n' "$config" "$actual" | (
  if command -v sha256sum >/dev/null; then sha256sum -c -; else shasum -a 256 -c -; fi
)
if "$verify_only"; then exit 0; fi

if docker image inspect "$image" >/dev/null 2>&1; then
  test "$(docker image inspect "$image" --format '{{.Id}}')" = "sha256:$config" ||
    { echo 'Existing fixture tag does not match the sealed config' >&2; exit 1; }
else
  storage=$(docker info --format '{{.DockerRootDir}}')
  df -Pk "$storage" | awk 'END { exit !($4 >= 6291456) }'
  docker image load -i "$archive"
  loaded_id=$(docker image inspect "$image" --format '{{.Id}}')
fi
test "$(docker image inspect "$image" --format '{{.Os}}/{{.Architecture}}')" = linux/amd64
docker image inspect "$image" --format '{{json .RootFS.Layers}}' | python3 -c '
import json
import sys
from pathlib import Path
expected = json.loads(Path("linux-config.json").read_bytes())["rootfs"]["diff_ids"]
actual = json.load(sys.stdin)
if expected != actual:
    raise SystemExit("loaded layers differ from sealed image")
print(f"verified {len(actual)} loaded layers")
'

docker run --rm --pull never --platform linux/amd64 --network none \
  --cpus=2 --memory=6g --memory-swap=6g --read-only --init \
  --tmpfs /tmp:rw,size=256m --cap-drop=ALL --security-opt=no-new-privileges \
  --mount "type=bind,source=$bundle/proof.py,target=/fixture/proof.py,readonly" \
  --mount "type=bind,source=$bundle/whisper,target=/fixture/whisper,readonly" \
  --mount "type=bind,source=$bundle/speech.wav,target=/fixture/lantern.wav,readonly" \
  --mount "type=bind,source=$bundle/paddle,target=/fixture/paddle,readonly" \
  "$image" bun scripts/prove-aggregate-queue.ts /usr/local/bin/python /usr/local/bin/python \
    /fixture/proof.py /fixture/whisper /fixture/lantern.wav /fixture/paddle

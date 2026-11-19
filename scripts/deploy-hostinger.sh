#!/usr/bin/env bash
set -euo pipefail

deploy_path=$1
release=$2
cd "$deploy_path"

project_label='{{ index .Config.Labels "com.docker.compose.project" }}'
project=$(docker inspect --format "$project_label" girke-api)
if [[ ! "$project" =~ ^[a-z0-9][a-z0-9_-]*$ ]]; then
  echo 'Girke API has no valid existing Compose project.' >&2
  exit 1
fi
for container in girke-api-whisper girke-api-postgres; do
  if [[ "$(docker inspect --format "$project_label" "$container")" != "$project" ]]; then
    echo "Unexpected Compose project for $container." >&2
    exit 1
  fi
done
if [[ "$(docker inspect --format '{{.State.Health.Status}}' girke-api-postgres)" != healthy ]]; then
  echo 'Girke PostgreSQL must already be healthy.' >&2
  exit 1
fi

running_image=$(docker inspect --format '{{.Image}}' girke-api)
running_release=$(docker image inspect --format '{{with .Config.Labels}}{{index . "org.opencontainers.image.revision"}}{{end}}' "$running_image")
if [[ ! "$running_release" =~ ^[0-9a-f]{40}$ ]] ||
  ! git merge-base --is-ancestor "$running_release" "$release"; then
  echo 'The running API image has no verified release ancestor. Stage a compatible runtime before deploying.' >&2
  exit 1
fi
if ! git diff --quiet "$running_release" "$release" -- Dockerfile bun.lock package.json whisper-sidecar; then
  echo 'Runtime dependencies or Whisper inputs changed. Stage compatible runtime images before deploying on this VPS.' >&2
  exit 1
fi

stage=$(mktemp -d)
trap 'rm -r -- "$stage"' EXIT
payload=(src scripts drizzle package.json tsconfig.json drizzle.config.ts CODEBASE.md)
sidecars=(docker-compose.yml docker-compose.hostinger.yml whisper-sidecar)

# Check before extracting. Reserve room for staging, the build context and the layer.
payload_kib=$(git archive "$release" -- "${payload[@]}" "${sidecars[@]}" | wc -c | awk '{print int(($1 + 1023) / 1024)}')
required_kib=$((65536 + 4 * payload_kib))
docker_root=$(docker info --format '{{.DockerRootDir}}')
storage=("$stage" "$docker_root")
if [[ -d /var/lib/containerd ]]; then storage+=(/var/lib/containerd); fi
for path in "${storage[@]}"; do
  available_kib=$(df -Pk "$path" | awk 'NR == 2 {print $4}')
  if [[ ! "$available_kib" =~ ^[0-9]+$ ]] || (( available_kib < required_kib )); then
    printf 'Insufficient free space at %s (need %s KiB for the API source layer).\n' "$path" "$required_kib" >&2
    exit 1
  fi
done

mkdir "$stage/api"
git archive "$release" -- "${payload[@]}" | tar -xf - -C "$stage/api"
git archive "$release" -- "${sidecars[@]}" | tar -xf - -C "$stage"
whisper_manifest='cd /app; sha256sum app.py media_normalization.py requirements.txt'
if [[ "$(docker exec girke-api-whisper sh -ec "$whisper_manifest")" != "$(cd "$stage/whisper-sidecar"; sha256sum app.py media_normalization.py requirements.txt)" ]]; then
  echo 'Running Whisper files differ from the release. Stage a compatible Whisper image before deploying.' >&2
  exit 1
fi

# Reuse one base across source releases to avoid adding layers to each previous release.
base_id=$(docker image inspect --format '{{with .Config.Labels}}{{index . "dev.girke.runtime.base"}}{{end}}' "$running_image")
base_id=${base_id:-$running_image}
if [[ ! "$base_id" =~ ^sha256:[0-9a-f]{64}$ ]] ||
  [[ "$(docker image inspect --format '{{.Id}}' "$base_id")" != "$base_id" ]]; then
  echo 'Pinned API runtime base is unavailable.' >&2
  exit 1
fi
base_tag="girke-api-runtime:${base_id#sha256:}"
pinned_id=$(docker image inspect --format '{{.Id}}' "$base_tag" 2>/dev/null || true)
if [[ -z "$pinned_id" ]]; then
  docker image tag "$base_id" "$base_tag"
elif [[ "$pinned_id" != "$base_id" ]]; then
  echo 'API runtime base tag points to an unexpected image.' >&2
  exit 1
fi

cat > "$stage/api/Dockerfile" <<'DOCKERFILE'
ARG RUNTIME
FROM ${RUNTIME}
WORKDIR /app
RUN rm -r /app/src /app/scripts /app/drizzle
COPY package.json tsconfig.json drizzle.config.ts CODEBASE.md ./
COPY src ./src
COPY scripts ./scripts
COPY drizzle ./drizzle
DOCKERFILE
image="girke-release-api:$release"
docker build --pull=false --network=none --build-arg "RUNTIME=$base_tag" \
  --label "org.opencontainers.image.revision=$release" --label "dev.girke.runtime.base=$base_id" \
  --tag "$image" "$stage/api"
manifest='find src scripts drizzle package.json tsconfig.json drizzle.config.ts CODEBASE.md -type f -print0 | LC_ALL=C sort -z | xargs -0 sha256sum'
expected=$(cd "$stage/api"; bash -o pipefail -c "$manifest")
actual=$(docker run --rm --network none --read-only --pull never --entrypoint bash "$image" \
  -o pipefail -ec "cd /app; $manifest")
if [[ "$actual" != "$expected" ]]; then
  echo 'Release image files do not match the staged API payload.' >&2
  exit 1
fi

ln -s "$deploy_path/.env" "$stage/.env"
cat > "$stage/api-image.yml" <<YAML
services:
  girke-api:
    image: $image
YAML
cd "$stage"
compose=(docker compose --project-name "$project" -f docker-compose.yml -f docker-compose.hostinger.yml -f api-image.yml)
"${compose[@]}" config --quiet
"${compose[@]}" run --rm --no-deps -T --pull never girke-api bun run db:migrate < /dev/null
"${compose[@]}" up -d --no-deps --no-build --pull never --force-recreate girke-api
printf 'deployed_commit=%s\n' "$release"

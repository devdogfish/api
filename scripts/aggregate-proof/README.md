# Girke #213 shared queue proof

This fixture uses Girke's async and synchronous transcription routes, OCR route,
private review caller and one `ComputeAdmission`. A stdio adapter invokes the
actual Whisper sidecar handler in a single Python process. Its loaded-model
cache stays alive during the PaddleOCR, German spaCy, phone and PDF audit work.
The OCR image comes from [Quantself #447](https://github.com/devdogfish/quantself/pull/447).
The PDF adds fictional names, contact details and an exact-list control.

The assertions cover FIFO start and completion, overflow, queued cancellation,
and active cancellation while a native worker runs. Active cancellation holds
admission until that worker exits and removes its draft. The fixture checks a
real cold transcript and a warm transcript after redaction. Its model and
mapping paths are disposable fixture paths.

## Stage public assets

Use the [#447 asset pins](https://github.com/devdogfish/quantself/blob/6a7eba601b33034f4565fb7a9313b2e86e88b4b7/scripts/proofs/pdf-redaction/README.md)
for Whisper Small revision `536b0662742c02347bc0e980a01041f333bce120` and both
PP-OCRv5 mobile archives. Verify the published archive checksums before
extracting Paddle. Verify the Whisper model file and the #447 fixture source
from a local Quantself checkout. Stage both official spaCy 3.8.0 wheels in a
directory containing only those wheels. The Docker build verifies them before
installing. [English model](https://github.com/explosion/spacy-models/releases/tag/en_core_web_sm-3.8.0)
· [German model](https://github.com/explosion/spacy-models/releases/tag/de_core_news_sm-3.8.0)

```sh
printf '%s  %s\n' \
  3e305921506d8872816023e4c273e75d2419fb89b24da97b4fe7bce14170d671 "$whisper_dir/model.bin" \
  34c50478d177bd9936e26cf1a5833b12f2b52a5c4d8f3ff322d25376df3ab849 "$quantself_proof" | sha256sum -c -
```

Use a synthetic mono 16 kHz PCM WAV of “The blue lantern shines. The blue
lantern shines.” This is the #447 speech fixture. On macOS, generate it with
`say -v Samantha` and convert it with FFmpeg.

## Run under the native AMD64 budget

Use a disposable AMD64 host with cgroup v2 and at least 6 GiB available for the
container. Confirm the host and Docker server architectures. The architecture
of an emulated container alone cannot establish native execution.

```sh
test "$(uname -m)" = x86_64
docker info --format '{{.Architecture}} cgroup={{.CgroupVersion}} RAM={{.MemTotal}}'
docker buildx build --platform linux/amd64 --load \
  --build-context "name_wheels=$name_wheels" \
  --file scripts/aggregate-proof/Dockerfile --tag girke-213-aggregate-proof:local .
docker image inspect girke-213-aggregate-proof:local --format '{{.Id}} {{json .RootFS.Layers}}'

docker run --rm --pull never --platform linux/amd64 --network none \
  --cpus=2 --memory=6g --memory-swap=6g --read-only --init \
  --tmpfs /tmp:rw,size=256m --cap-drop=ALL --security-opt=no-new-privileges \
  --mount "type=bind,source=$quantself_proof,target=/fixture/proof.py,readonly" \
  --mount "type=bind,source=$whisper_dir,target=/fixture/whisper,readonly" \
  --mount "type=bind,source=$synthetic_wav,target=/fixture/lantern.wav,readonly" \
  --mount "type=bind,source=$paddle_dir,target=/fixture/paddle,readonly" \
  girke-213-aggregate-proof:local \
  bun scripts/prove-aggregate-queue.ts /usr/local/bin/python /usr/local/bin/python \
    /fixture/proof.py /fixture/whisper /fixture/lantern.wav /fixture/paddle
```

Require a zero exit code, both PASS lines, and zero OOM and OOM-kill events.
The entrypoint checks `memory.max=6442450944`, `memory.swap.max=0` and
`cpu.max=200000 100000` before starting. It records cgroup peak and memory
events even if the job fails. Cgroup memory is the budget measurement.
Sampled process-tree RSS can double-count shared pages and miss short peaks.

For a transferred sealed bundle, run from the already authorized AMD64 guest.

```sh
sh "$bundle/run-sealed-native.sh" "$bundle"
```

The helper checks native rootless Docker, capacity, archive checksums, the
sealed config, and loaded layers. It removes an image tag only when this
invocation loaded it. Run with `--check-bundle` before transfer to verify
the bundle without accessing Docker. Preserve the run output, then remove
the transferred proof files.

## Run the native macOS fallback

Stage the same Python versions and weights externally. The proof accepts
separate staged Python executables for redaction and Whisper. It requires
FFmpeg, Poppler, and Tesseract with English and German data on the path.

```sh
sandbox-exec -p '(version 1) (allow default) (deny network*)' /usr/bin/time -lp \
  bun scripts/prove-aggregate-queue.ts "$redactor_python" "$whisper_python" \
    "$quantself_proof" "$whisper_dir" "$synthetic_wav" "$paddle_dir"
```

macOS samples RSS and checks the shared queue and model retention. The Linux
container enforces the 6 GiB, two-CPU, zero-swap budget.

## Local evidence

The network-disabled native macOS arm64 run passed cold and warm transcription,
OCR, the two-page German text/scan PDF review, FIFO, overflow, queued cancellation
and active cancellation. It completed in 32.12 s. Sampled tree RSS peaked at
1,569 MiB. Whisper's process was at 856 MiB immediately after cold inference.
During review, the largest sampled overlapping tree was 1,461 MiB, including
29 MiB of Whisper RSS and a 1,393 MiB PDF worker. The same Whisper process
retained the loaded model entry and served the warm request in 2.63 s.

The local Docker host was Linux ARM64 with 3.83 GiB guest RAM. Its cgroup
canary verified the 6 GiB limit, two-CPU quota, swap disabled, and preservation
of a nonzero payload exit. A canary at 5 GiB was refused before execution.
The emulated AMD64 run completed Whisper and OCR before the private PDF worker
failed. Its cgroup peak up to failure was 1,739,124,736 bytes (1.62 GiB) with
zero OOMs. An isolated replay of the same Paddle detector initialization
returned `SIGILL` (132) with zero OOMs. The staged image config is
`sha256:e80c08e1e4b923a2f821f531d73cf18ccd291cc0deb60419ecda5fb837ea78e0`.
The #447 handoff identifies existing Atlas coding guest 3362. Its configured
Atlas SSH path denied public-key access during read-only preflight. A current
guest login and capacity check are required before transferring the sealed
bundle. Native AMD64 aggregate qualification remains open.

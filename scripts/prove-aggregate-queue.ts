/** Run the pinned synthetic workload with no network and one real Girke admission queue. */
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createApp } from '../src/app'
import { ComputeAdmission } from '../src/computeAdmission'
import { createTesseractOcrProcessor } from '../src/ocr/ocrProcessor'
import { createExactMatchPdfRedactor } from '../src/redaction/exactMatchPdf'
import { createPrivatePdfReview } from '../src/redaction/privatePdfReview'
import { InMemoryTranscriptionJobStore } from '../src/routes/transcription'
import { authHeaders, testApiTokenStore } from '../tests/helpers'
import { currentRssKiB } from './aggregate-proof/rss'

const [redactorPython, whisperPython, fixture, whisperModel, audio, models] = process.argv.slice(2)
assert.ok(redactorPython && whisperPython && fixture && whisperModel && audio && models,
  'usage: bun scripts/prove-aggregate-queue.ts <redactor python> <Whisper python> <Quantself proof.py> <Whisper Small dir> <synthetic wav> <Paddle dir>')
const proofRoot = await mkdtemp(join(tmpdir(), 'girke-aggregate-'))
const scratch = join(proofRoot, 'private')
const vaultRoot = join(proofRoot, 'synthetic-mapping')
const uploads = join(proofRoot, 'uploads')
const modelDirectory = resolve(whisperModel)
const syntheticAudio = await readFile(audio)
const sidecarSource = new URL('../whisper-sidecar', import.meta.url).pathname
const env = {
  PATH: process.env.PATH ?? '', HOME: proofRoot, TMPDIR: proofRoot,
  HF_HUB_OFFLINE: '1', PYTHONDONTWRITEBYTECODE: '1', PYTHONNOUSERSITE: '1',
  OMP_NUM_THREADS: '2', OPENBLAS_NUM_THREADS: '2'
}

const bridge = `
import asyncio
import base64
import io
import json
import sys
from pathlib import Path

sys.path.insert(0, sys.argv[1])
from app import UploadFile, health, transcribe
from importlib.metadata import version

assert (version("faster-whisper"), version("ctranslate2"), version("av")) == ("1.2.1", "4.8.1", "16.0.1")
assert Path(sys.argv[2], "model.bin").is_file()
for line in sys.stdin:
    request = json.loads(line)
    if request["op"] == "health":
        output = health()
    else:
        audio = UploadFile(file=io.BytesIO(base64.b64decode(request["audio"])), filename=request["filename"])
        output = asyncio.run(transcribe(audio, request["level"], request["language"]))
    print(json.dumps(output), flush=True)
`
const sidecar = Bun.spawn([whisperPython, '-u', '-c', bridge, sidecarSource, modelDirectory], {
  stdin: 'pipe', stdout: 'pipe', stderr: 'inherit',
  env: {
    ...env, WHISPER_DEVICE: 'cpu', WHISPER_COMPUTE_TYPE: 'int8', WHISPER_CPU_THREADS: '2',
    WHISPER_NUM_WORKERS: '1', WHISPER_MODEL_MEDIUM_EN: modelDirectory
  }
})
const responses = sidecar.stdout.getReader()
const decoder = new TextDecoder()
let received = ''
async function whisper(request: { op: 'health' } | { op: 'transcribe'; audio: string; filename: string; level: string; language: string }) {
  sidecar.stdin.write(JSON.stringify(request) + '\n')
  await sidecar.stdin.flush()
  while (!received.includes('\n')) {
    const response = await responses.read()
    assert.ok(!response.done, 'Whisper sidecar exited')
    received += decoder.decode(response.value, { stream: true })
  }
  const newline = received.indexOf('\n')
  const value = JSON.parse(received.slice(0, newline))
  received = received.slice(newline + 1)
  return value
}

// Observation around the actual admission implementation keeps the contention checks deterministic.
class RecordedAdmission extends ComputeAdmission {
  calls = 0
  starts: number[] = []
  finishes: number[] = []

  override run<T>(task: () => Promise<T>, signal?: AbortSignal, background = false) {
    const id = ++this.calls
    return super.run(async () => {
      this.starts.push(id)
      try {
        return await task()
      } finally {
        this.finishes.push(id)
      }
    }, signal, background)
  }
}

async function until(check: () => boolean | Promise<boolean>, message: string, limit = 15_000) {
  const stop = performance.now() + limit
  while (!await check()) {
    assert.ok(performance.now() < stop, message)
    await Bun.sleep(20)
  }
}

function memorySample() {
  // Process RSS can count shared pages more than once. Linux cgroup peak is accounted separately.
  const sample = currentRssKiB()
  let sum = 0
  let retained = 0
  let childRss = 0
  for (const [pid, rss] of sample) {
    sum += rss
    if (pid === sidecar.pid) retained = rss
    else if (pid !== process.pid) childRss = Math.max(childRss, rss)
  }
  peakRssKiB = Math.max(peakRssKiB, sum)
  whisperPeakKiB = Math.max(whisperPeakKiB, retained)
  // Only samples with an active native redactor or verifier count toward the overlap proof.
  if (admission.starts.at(-1) === 4 && admission.finishes.at(-1) !== 4 && retained && childRss > 128 * 1024 && sum > coResident.total) {
    coResident = { total: sum, retained, child: childRss }
  }
}

const makeFixtures = `
import runpy
import sys
from pathlib import Path
import pymupdf as pdf

proof = runpy.run_path(sys.argv[1])
root = Path(sys.argv[2])
source = root / "ocr.pdf"
proof["make_source"](source, proof["Fixture"]((proof["MARKERS"][1],), scanned=True))
with pdf.open(source) as scan:
    proof["raster"](scan[0]).save(root / "image.png")

with pdf.open() as typeset, pdf.open() as output:
    page = typeset.new_page(width=540, height=260)
    lines = ["Dies ist der externe Index.", "Lena Falkenrath hat den Entwurf gelesen.",
             "+1 902-555-0100", "kontakt: sample@example.invalid",
             "referenzcode: private archive identifier", "ende der probe."]
    for i, text in enumerate(lines):
        page.insert_text((40, 32 + i * 39), text, fontsize=20)
    output.insert_pdf(typeset)
    scan = output.new_page(width=540, height=260)
    scan.insert_image(scan.rect, pixmap=page.get_pixmap(dpi=300, alpha=False))
    assert not scan.get_text().strip()
    output.save(root / "review.pdf")
`

let peakRssKiB = 0
let whisperPeakKiB = 0
let whisperAfterColdKiB = 0
let coResident = { total: 0, retained: 0, child: 0 }
const admission = new RecordedAdmission()
const store = new InMemoryTranscriptionJobStore()
const firstWhisper = Promise.withResolvers<void>()
const releaseWhisper = Promise.withResolvers<void>()
let whisperCalls = 0
const app = createApp({
  apiTokenStore: testApiTokenStore(), version: 'synthetic',
  transcriptionJobStore: store, transcriptionUploadDir: uploads,
  ocrProcessor: createTesseractOcrProcessor(),
  whisperFetch: async (_url, init) => {
    if (++whisperCalls === 1) {
      firstWhisper.resolve()
      await releaseWhisper.promise
    }
    const form = init?.body
    assert.ok(form instanceof FormData)
    const file = form.get('file')
    assert.ok(file instanceof File)
    const response = await whisper({
      op: 'transcribe', audio: Buffer.from(await file.arrayBuffer()).toString('base64'),
      filename: file.name, level: String(form.get('level')), language: String(form.get('language'))
    })
    if (whisperCalls === 1) whisperAfterColdKiB = currentRssKiB().get(sidecar.pid) ?? 0
    return Response.json(response)
  }
}, admission)

const reviewer = createPrivatePdfReview(admission, scratch, redactorPython, {
  vaultRoot, paddleModels: resolve(models), phoneRegions: ['DE', 'CA'], personNames: true
})
const plain = createExactMatchPdfRedactor(admission, scratch, redactorPython)
const jobs = '/api/v1/transcription/jobs'
const pending: Promise<unknown>[] = []
function track<T>(promise: Promise<T>) {
  pending.push(promise)
  void promise.catch(() => {})
  return promise
}
function upload(path: string, name: string, bytes: Uint8Array<ArrayBuffer>, speech = false) {
  const body = new FormData()
  body.set('file', new File([bytes], name))
  if (speech) {
    body.set('level', 'medium')
    body.set('language', 'en')
  }
  return Promise.resolve(app.request(path, { method: 'POST', headers: authHeaders, body }))
}

const start = performance.now()
let sampler: ReturnType<typeof setInterval> | undefined
try {
  await Promise.all([scratch, vaultRoot, uploads].map(path => mkdir(path, { mode: 0o700 })))
  const generated = Bun.spawn([redactorPython, '-c', makeFixtures, resolve(fixture), proofRoot], {
    stdout: 'inherit', stderr: 'inherit', env
  })
  assert.equal(await generated.exited, 0)
  const pdf = await readFile(join(proofRoot, 'review.pdf'))
  const picture = await readFile(join(proofRoot, 'image.png'))
  const settings = { pdf, identifiers: ['private archive identifier'], language: 'deu' as const, structuredIdentifiers: true,
    safeTextByPage: Array.from({ length: 2 }, () => ['externe Index', 'den Entwurf gelesen', 'ende der probe']) }
  const initialHealth = await whisper({ op: 'health' })
  assert.deepEqual(initialHealth.loaded_models, [])
  assert.equal(initialHealth.compute_type, 'int8')
  assert.equal(initialHealth.cpu_threads, 2)
  assert.ok(currentRssKiB().has(sidecar.pid), 'unable to sample retained sidecar RSS')
  sampler = setInterval(memorySample, 100)

  const queued = await upload(jobs, 'synthetic.wav', syntheticAudio, true)
  assert.equal(queued.status, 202)
  const id = (await queued.json()).job_id
  await Promise.race([firstWhisper.promise, Bun.sleep(15_000).then(() => { throw new Error('Whisper was not admitted') })])
  assert.deepEqual(admission.starts, [1])

  const waitingCancel = new AbortController()
  const queuedCancelled = track(assert.rejects(plain(settings, waitingCancel.signal), { name: 'AbortError' }))
  await until(() => admission.calls === 2, 'queued cancellation was not registered')
  waitingCancel.abort()
  await queuedCancelled
  assert.deepEqual(await readdir(scratch), [])

  const ocr = track(upload('/api/v1/ocr', 'synthetic.png', picture))
  await until(() => admission.calls === 3, 'OCR was not queued')
  const review = track(reviewer.prepare({ ...settings, documentType: 'correspondence' }))
  await until(() => admission.calls === 4, 'private review was not queued')
  const overflow = await upload('/api/v1/ocr', 'overflow.png', picture)
  assert.equal(overflow.status, 503)
  assert.deepEqual(await overflow.json(), { error: 'compute_busy' })
  assert.deepEqual(admission.starts, [1])
  releaseWhisper.resolve()
  const ocrResult = await ocr
  assert.equal(ocrResult.status, 200)
  assert.match((await ocrResult.json()).text, /PUBLIC/i)
  const prepared = await review
  assert.deepEqual(admission.starts, [1, 3, 4])
  assert.deepEqual(admission.finishes, [1, 3, 4])

  const transcript = await app.request(jobs + '/' + id + '/result', { headers: authHeaders })
  assert.equal(transcript.status, 200)
  assert.match((await transcript.json()).text, /the blue lantern shines/i)
  assert.deepEqual((await whisper({ op: 'health' })).loaded_models, [modelDirectory])
  const [attempt] = await readdir(scratch)
  const plan = JSON.parse(await readFile(join(scratch, attempt, 'review-plan.json'), 'utf8'))
  assert.equal(plan.paddle.model, 'PP-OCRv5_mobile')
  assert.equal(plan.names.model, 'de_core_news_sm-3.8.0')
  assert.equal(plan.phones.version, '9.0.43')
  const mapping = JSON.parse(await readFile(join(vaultRoot, prepared.candidateSha256, 'mapping.json'), 'utf8'))
  assert.deepEqual(mapping.values, {
    '[PERSON_1]': 'Lena Falkenrath', '[PHONE_1]': '+19025550100',
    '[EMAIL_1]': 'sample@example.invalid', '[IDENTIFIER_1]': 'private archive identifier'
  })
  const bytes = await reviewer.readApprovedCandidate(prepared, await reviewer.approve(prepared, await reviewer.inspect(prepared)))
  assert.ok(bytes.subarray(0, 5).equals(Buffer.from('%PDF-')))
  await reviewer.discard(prepared)
  assert.ok(whisperAfterColdKiB > 0 && coResident.retained > 0 && coResident.child > 0, 'missed concurrent Whisper and PDF worker memory')
  console.log('PASS real async Whisper → OCR → verified PDF FIFO, overflow and queued cancellation')

  const activeCancel = new AbortController()
  const cancelled = track(assert.rejects(reviewer.prepare({ ...settings, documentType: 'correspondence' }, activeCancel.signal), { name: 'AbortError' }))
  await until(() => admission.starts.at(-1) === 6, 'cancelled review did not acquire the slot')
  await until(() => [...currentRssKiB()].some(([pid, rss]) =>
    pid !== process.pid && pid !== sidecar.pid && rss > 16 * 1024), 'cancelled native worker did not start')
  activeCancel.abort()
  const after = track(upload('/api/v1/ocr', 'after-cancel.png', picture))
  await until(() => admission.calls === 7, 'following OCR did not queue')
  assert.equal(admission.starts.at(-1), 6)
  await cancelled
  assert.equal((await after).status, 200)
  assert.deepEqual(admission.starts, [1, 3, 4, 6, 7])
  assert.deepEqual(admission.finishes, admission.starts)
  assert.deepEqual(await readdir(scratch), [])
  assert.deepEqual(await readdir(vaultRoot), [prepared.candidateSha256])
  assert.deepEqual((await whisper({ op: 'health' })).loaded_models, [modelDirectory])
  console.log('PASS active cancellation held admission until the worker settled, cleared its draft, then resumed OCR')

  const warm = performance.now()
  const warmResponse = await upload('/api/v1/transcription/transcribe', 'synthetic.wav', syntheticAudio, true)
  assert.equal(warmResponse.status, 200)
  assert.match((await warmResponse.json()).text, /the blue lantern shines/i)
  assert.equal(whisperCalls, 2)
  const mib = (value: number) => (value / 1024).toFixed(0)
  console.log(`wall_s=${((performance.now() - start) / 1000).toFixed(2)} warm_whisper_s=${((performance.now() - warm) / 1000).toFixed(2)} sampled_tree_peak_mib=${mib(peakRssKiB)}`)
  console.log(`whisper_peak_mib=${mib(whisperPeakKiB)} whisper_after_cold_mib=${mib(whisperAfterColdKiB)}`)
  console.log(`co_resident_tree_mib=${mib(coResident.total)} retained_whisper_mib=${mib(coResident.retained)} largest_worker_mib=${mib(coResident.child)}`)
} finally {
  if (sampler) clearInterval(sampler)
  releaseWhisper.resolve()
  sidecar.stdin.end()
  await sidecar.exited
  await Promise.allSettled(pending)
  await rm(proofRoot, { recursive: true, force: true })
}

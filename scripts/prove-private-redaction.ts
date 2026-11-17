/** Run with pinned Python and Quantself's merged proof.py in a network-disabled environment. */
import assert from 'node:assert/strict'
import { copyFile, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createApp } from '../src/app'
import { ComputeAdmission } from '../src/computeAdmission'
import { OCR_MODEL } from '../src/ocr/ocrProcessor'
import { createPrivateRedactionExecutor, UnverifiedRedactionError } from '../src/redaction/privateRedaction'
import { InMemoryTranscriptionJobStore } from '../src/routes/transcription'
import { authHeaders, testApiTokenStore } from '../tests/helpers'

const [python, proofPath] = process.argv.slice(2)
assert.ok(python && proofPath, 'usage: bun scripts/prove-private-redaction.ts <python> <Quantself proof.py>')
const proof = resolve(proofPath)
const root = await mkdtemp(join(tmpdir(), 'girke-redaction-fixture-'))
const artifacts = join(root, 'proof')
const mapping = join(root, 'mapping.json')
const original = join(artifacts, 'scan-source.pdf')
const working = join(artifacts, 'scan-working.pdf')
const trace: string[] = []

async function runPython(args: string[], expectedExit = 0) {
  const child = Bun.spawn([python!, ...args], { stdout: 'ignore', stderr: 'inherit' })
  if (await child.exited !== expectedExit) throw new Error('Synthetic PDF proof command failed')
}

const loadProof = `import json, runpy, sys
from pathlib import Path
proof = runpy.run_path(sys.argv[1])
`
const redactPass = Promise.withResolvers<void>()
const verifyStarted = Promise.withResolvers<void>()
const whisperStarted = Promise.withResolvers<void>()
const whisperStop = Promise.withResolvers<void>()
const cancelStarted = Promise.withResolvers<void>()
const cancelStop = Promise.withResolvers<void>()
const admission = new ComputeAdmission()
const store = new InMemoryTranscriptionJobStore()
const app = createApp({
  apiTokenStore: testApiTokenStore(),
  version: 'synthetic',
  transcriptionJobStore: store,
  transcriptionUploadDir: root,
  transcriptionDurationProbe: { async probe() { return { durationSeconds: 1 } } },
  transcriptionMediaProcessor: {
    async prepare(inputPath) {
      return {
        normalizedAudioPath: inputPath,
        durationSeconds: 1,
        chunks: [{ path: inputPath, chunkIndex: 0, startSeconds: 0, endSeconds: 1 }]
      }
    }
  },
  whisperFetch: async () => {
    trace.push('whisper-start')
    whisperStarted.resolve()
    await whisperStop.promise
    trace.push('whisper-stop')
    return Response.json({
      text: 'invented transcript',
      segments: [{ start: 0, end: 1, text: 'invented transcript' }],
      duration_seconds: 1, processing_seconds: 1, level: 'medium',
      language: 'auto', detected_language: 'en', model: 'fixture'
    })
  },
  ocrProcessor: { async recognize() {
    trace.push('ocr')
    return { text: 'invented OCR', lines: ['invented OCR'], processing_seconds: 1, model: OCR_MODEL }
  } }
}, admission)

const jobs = '/api/v1/transcription/jobs'
async function upload(path: string, name: string) {
  const body = new FormData()
  body.set('file', new File(['invented input'], name))
  return app.request(path, { method: 'POST', headers: authHeaders, body })
}

type Case = 'verified' | 'unsafe' | 'cancel'
const candidates = new Map<Case, string>()
let verified: string
const redact = createPrivateRedactionExecutor<Case>(admission, root, {
  async redact(job, candidate) {
    candidates.set(job, candidate)
    if (job === 'verified') {
      trace.push('redaction-start')
      await runPython([proof, '--german', '--artifacts-dir', artifacts])
      await runPython(['-c', loadProof + 'Path(sys.argv[2]).write_text(json.dumps(proof["MARKERS"][1:]))', proof, mapping])
      await copyFile(join(artifacts, 'scan-redacted.pdf'), candidate)
    } else if (job === 'unsafe') {
      // Fresh raster pages and no source metadata, but planted identifiers remain in the pixels.
      await runPython(['-c', loadProof + `
pdf = proof["pdf"]
with pdf.open(sys.argv[2]) as source, pdf.open() as output:
    for page in source:
        fresh = output.new_page(width=page.rect.width, height=page.rect.height)
        xref = fresh.insert_image(fresh.rect, pixmap=proof["raster"](page), keep_proportion=False)
        output.xref_set_key(xref, "ColorSpace", "/DeviceRGB")
    proof["save_flat"](output, sys.argv[3])
`, proof, original, candidate])
    } else {
      await copyFile(verified, candidate)
      trace.push('cancel-start')
      cancelStarted.resolve()
      await cancelStop.promise
      trace.push('cancel-stop')
    }
  },
  async verify(job, candidate) {
    if (job === 'cancel') trace.push('cancel-verify')
    assert.notEqual(job, 'cancel', 'cancelled work must not reach verification')
    if (job === 'verified') {
      verifyStarted.resolve()
      await redactPass.promise
    }
    await runPython(['-c', loadProof + `
with proof["pdf"].open(sys.argv[2]) as working:
    expected = [proof["raster"](page) for page in working]
fixture = proof["Fixture"](tuple(json.loads(Path(sys.argv[3]).read_text())), scanned=True)
try:
    proof["verify_flat"](Path(sys.argv[4]), expected, fixture)
except RuntimeError as err:
    if sys.argv[5] == "unsafe" and str(err) == "embedded pixels differ from the redacted working page":
        sys.exit(42)
    raise
`, proof, working, mapping, candidate, job], job === 'unsafe' ? 42 : 0)
    trace.push(job === 'unsafe' ? 'unsafe raster refused' : 'verified')
    return job !== 'unsafe'
  }
})

const pending: Promise<unknown>[] = []
try {
  const spec = await app.request('/openapi.json')
  assert.equal(spec.status, 200)
  const { paths } = await spec.json()
  assert.ok(!Object.keys(paths).some(path => /redact/i.test(path)))

  const queued = await upload(jobs, 'synthetic.wav')
  assert.equal(queued.status, 202)
  const id = (await queued.json()).job_id
  await whisperStarted.promise
  const waitingCancel = new AbortController()
  const waiting = assert.rejects(redact('cancel', waitingCancel.signal), { name: 'AbortError' })
  waitingCancel.abort()
  await waiting
  assert.equal(candidates.size, 0, 'queued cancellation must not run the processor')

  const execution = redact('verified')
  const ocr = [upload('/api/v1/ocr', 'fictional.png'), upload('/api/v1/ocr', 'overflow.png')]
  pending.push(execution, ...ocr)
  assert.equal((await Promise.race(ocr)).status, 503)
  assert.deepEqual(trace, ['whisper-start'])
  whisperStop.resolve()

  await Promise.race([verifyStarted.promise, execution.then(() => { throw new Error('Verification did not run') })])
  assert.deepEqual(trace, ['whisper-start', 'whisper-stop', 'redaction-start'])
  redactPass.resolve()
  verified = await execution
  assert.deepEqual((await Promise.all(ocr)).map(res => res.status).sort(), [200, 503])
  assert.deepEqual(trace, ['whisper-start', 'whisper-stop', 'redaction-start', 'verified', 'ocr'])
  assert.equal((await store.findByPublicId(id))?.status, 'completed')

  const before = await Promise.all([readFile(original), readFile(mapping)])
  await assert.rejects(redact('unsafe'), UnverifiedRedactionError)
  assert.ok(candidates.has('unsafe'))
  assert.equal(await Bun.file(candidates.get('unsafe')!).exists(), false)
  assert.equal(trace.at(-1), 'unsafe raster refused')

  const activeCancel = new AbortController()
  const aborted = assert.rejects(redact('cancel', activeCancel.signal), { name: 'AbortError' })
  pending.push(aborted)
  await cancelStarted.promise
  activeCancel.abort()
  const after = [0, 1, 2].map(n => upload('/api/v1/ocr', `fictional-${n}.png`))
  pending.push(...after)
  assert.equal((await Promise.race(after)).status, 503)
  assert.equal(trace.at(-1), 'cancel-start')
  cancelStop.resolve()
  await aborted
  assert.deepEqual((await Promise.all(after)).map(res => res.status).sort(), [200, 200, 503])
  assert.deepEqual(trace.slice(-4), ['cancel-start', 'cancel-stop', 'ocr', 'ocr'])
  assert.equal(await Bun.file(candidates.get('cancel')!).exists(), false)
  assert.deepEqual(await Promise.all([readFile(original), readFile(mapping)]), before)
  assert.equal((await readdir(root)).filter(name => name.startsWith('redaction-')).length, 1)
  console.log('PASS five synthetic PDF pages, shared Whisper/OCR admission, queued and active cancellation, and unsafe raster refusal')
} finally {
  whisperStop.resolve()
  redactPass.resolve()
  cancelStop.resolve()
  await Promise.allSettled(pending)
  await rm(root, { recursive: true, force: true })
}

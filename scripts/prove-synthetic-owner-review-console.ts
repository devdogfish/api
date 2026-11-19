import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, stat, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { createApp } from '../src/app'
import { ComputeAdmission } from '../src/computeAdmission'
import { OCR_MODEL } from '../src/ocr/ocrProcessor'
import { testApiTokenStore, authHeaders } from '../tests/helpers'
import { syntheticOwnerReviewConsole } from './synthetic-owner-review-console'

class ObservedAdmission extends ComputeAdmission {
  submitted = [Promise.withResolvers<void>(), Promise.withResolvers<void>(), Promise.withResolvers<void>()]
  started: number[] = []
  private count = 0

  override run<T>(task: () => Promise<T>, signal?: AbortSignal, background = false) {
    const index = this.count++
    this.submitted[index]?.resolve()
    return super.run(() => {
      this.started.push(index)
      return task()
    }, signal, background)
  }
}

const python = process.argv[2]
assert.ok(python, 'staged Python path required')
const root = await realpath(await mkdtemp(join(tmpdir(), 'girke-owner-review-')))
const scratch = join(root, 'scratch')
const vault = join(root, 'vault')
const work = join(root, 'work')
const preview = join(scratch, 'owner-console-session', 'preview.pdf')
const source = join(vault, 'fixture.pdf')
const admission = new ObservedAdmission()
const whisperStarted = Promise.withResolvers<void>()
const releaseWhisper = Promise.withResolvers<void>()
const prepared = Promise.withResolvers<string>()
const refused = Array.from({ length: 3 }, () => Promise.withResolvers<void>())
let refusalCount = 0
const input = new PassThrough()
const pending: Promise<unknown>[] = []
const track = <T>(promise: Promise<T>) => {
  pending.push(promise)
  void promise.catch(() => {})
  return promise
}
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const app = createApp({
  apiTokenStore: testApiTokenStore(), version: 'synthetic',
  whisperFetch: async () => {
    whisperStarted.resolve()
    await releaseWhisper.promise
    return Response.json({ text: 'fixture', segments: [], duration_seconds: 1, processing_seconds: 1,
      level: 'medium', language: 'en', detected_language: 'en', model: 'fixture' })
  },
  ocrProcessor: { async recognize() {
    return { text: 'fixture', lines: ['fixture'], model: OCR_MODEL, processing_seconds: 1 }
  } }
}, admission)
function post(path: string, name: string) {
  const body = new FormData()
  body.set('file', new File(['synthetic'], name))
  return track(Promise.resolve(app.request(path, { method: 'POST', headers: authHeaders, body })))
}
const timer = setTimeout(() => {
  process.stderr.write('owner console proof timed out\n')
  input.end()
  releaseWhisper.resolve()
  for (const latch of [...admission.submitted, whisperStarted, prepared, ...refused]) {
    latch.reject(new Error('fixture timed out'))
  }
}, 25000)
for (const latch of [...admission.submitted, whisperStarted, prepared, ...refused]) {
  void latch.promise.catch(() => {})
}

try {
  await mkdir(scratch, { mode: 0o700 })
  await mkdir(vault, { mode: 0o700 })
  await mkdir(work, { mode: 0o700 })
  await chmod(work, process.platform === 'darwin' ? 0o750 : 0o2750)
  const fixture = Bun.spawnSync([python, '-c', `
import sys
import pymupdf
with pymupdf.open() as doc, pymupdf.open() as output:
    page = doc.new_page(width=550, height=350)
    page.insert_text((45, 75), "PUBLIC REFERENCE", fontsize=22)
    page.insert_text((45, 145), "ORCHID VECTOR", fontsize=24)
    page.insert_text((45, 225), "END OF SAMPLE", fontsize=22)
    output.insert_pdf(doc)
    scan = output.new_page(width=550, height=350)
    scan.insert_image(scan.rect, pixmap=page.get_pixmap(dpi=300, alpha=False))
    assert not scan.get_text().strip()
    output.save(sys.argv[1])
`, source])
  assert.equal(fixture.exitCode, 0)

  const whisper = post('/api/v1/transcription/transcribe', 'fixture.wav')
  await whisperStarted.promise
  const original = await readFile(source)
  const consoleRun = track(syntheticOwnerReviewConsole(input, { admission, scratch, vaultRoot: vault, workRoot: work, python }, {
    pdf: original, identifiers: ['ORCHID VECTOR'],
    safeTextByPage: [['PUBLIC REFERENCE', 'END OF SAMPLE'], ['PUBLIC REFERENCE', 'END OF SAMPLE']]
  }, (status, line) => {
    if (status === 'prepared') prepared.resolve(line!)
    if (status === 'refused') refused[refusalCount++]?.resolve()
  }))
  input.write('prepare\n')
  await Promise.race([admission.submitted[1]!.promise, consoleRun.then(() => { throw new Error('console exited early') })])
  const ocr = post('/api/v1/ocr', 'fixture.png')
  await admission.submitted[2]!.promise
  assert.deepEqual(admission.started, [0])
  assert.deepEqual(await readdir(work), [])
  releaseWhisper.resolve()
  const approval = await Promise.race([prepared.promise, consoleRun.then(() => { throw new Error('console exited early') })])
  const [, candidateHash, previewHash, nonce] = approval.split(' ')
  const previewBytes = await readFile(preview)
  assert.equal(digest(previewBytes), previewHash)
  assert.equal((await stat(preview)).mode & 0o777, 0o600)
  assert.deepEqual(await readdir(work), [])
  input.write(`approve ${candidateHash} ${'0'.repeat(64)} ${nonce}\n`)
  await refused[0]!.promise
  await writeFile(preview, 'substituted preview')
  input.write(approval + '\n')
  await refused[1]!.promise
  assert.deepEqual(await readdir(work), [])
  await writeFile(preview, previewBytes)
  const moved = join(root, 'byte-identical-preview.pdf')
  await rename(preview, moved)
  await symlink(moved, preview)
  input.write(approval + '\n')
  await refused[2]!.promise
  assert.deepEqual(await readdir(work), [])
  await unlink(preview)
  await rename(moved, preview)
  input.write(approval + '\n' + approval + '\n')
  const destination = await consoleRun
  assert.equal(destination, join(await realpath(work), candidateHash + '.pdf'))
  assert.equal(digest(await readFile(destination!)), candidateHash)
  assert.deepEqual(await readdir(work), [candidateHash + '.pdf'])
  assert.deepEqual(await readdir(scratch), ['.owner-console.lock'])
  assert.equal((await stat(destination!)).mode & 0o777, 0o640)
  assert.equal((await stat(join(vault, candidateHash!, 'mapping.json'))).mode & 0o777, 0o600)
  assert.deepEqual(await readFile(source), original)
  assert.equal((await whisper).status, 200)
  assert.equal((await ocr).status, 200)
  assert.deepEqual(admission.started, [0, 1, 2])
  console.log('owner_console=pass shared_order=whisper,owner_pdf,ocr pages=2 stale_tampered_linked_preview_refused=1 synthetic_export=1')
} finally {
  clearTimeout(timer)
  input.end()
  releaseWhisper.resolve()
  await Promise.allSettled(pending)
  await rm(root, { recursive: true, force: true })
}

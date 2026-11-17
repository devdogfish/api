/** Synthetic scans and staged PP-OCRv5 mobile assets. Run with network disabled. */
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ComputeAdmission } from '../src/computeAdmission'
import { createPrivatePdfReview } from '../src/redaction/privatePdfReview'
import { UnverifiedRedactionError } from '../src/redaction/privateRedaction'

const [python, modelDirectory] = process.argv.slice(2)
assert.ok(python && modelDirectory, 'usage: bun scripts/prove-paddle-pdf-scans.ts <staged python> <staged Paddle model directory>')
const paddleModels = resolve(modelDirectory)
const worker = fileURLToPath(new URL('../src/redaction/exact_match_pdf.py', import.meta.url))
const root = await mkdtemp(join(tmpdir(), 'girke-paddle-pdf-fixture-'))
const scratch = join(root, 'private')
const vaultRoot = join(root, 'synthetic-mapping')
const admission = new ComputeAdmission()
const reviewer = createPrivatePdfReview(admission, scratch, python, { vaultRoot, paddleModels })
const scanOnly = createPrivatePdfReview(admission, scratch, python, { paddleModels })

const fixtures = `
import sys
from pathlib import Path
import pymupdf as pdf

root = Path(sys.argv[1])
good = [
    [(36, "PUBLIC ORCHID VECTOR REFERENCE"), (92, "sample@example.invalid"), (199, "END OF SAMPLE")],
    [(36, "PUBLIC SECOND INDEX"), (88, "ORCHID VECTOR"),
     (125, "sample@example.invalid"), (199, "END OF SAMPLE")],
]
miss = [[(36, "PUBLIC REFERENCE"), (96, "AMBER"), (130, "FIGMENT"), (199, "END OF SAMPLE")]]
for label, pages in [("scan", good), ("miss", miss)]:
    with pdf.open() as typeset, pdf.open() as output:
        for lines in pages:
            page = typeset.new_page(width=540, height=230)
            for y, text in lines:
                page.insert_text((46, y), text, fontsize=22)
            scan = output.new_page(width=540, height=230)
            scan.insert_image(scan.rect, pixmap=page.get_pixmap(dpi=300, alpha=False))
            assert not scan.get_text().strip()
        output.set_metadata({"author": "ORCHID VECTOR"})
        output.save(root / (label + ".pdf"), deflate=True)
`

const checkCandidate = `
import json
import re
import sys
from pathlib import Path
sys.path.insert(0, str(Path(sys.argv[1]).parent))
from exact_match_pdf import pdf, ocr, ocr_text
from placeholder_pixels import apply_patches

directory, approved = Path(sys.argv[2]), Path(sys.argv[3])
plan = json.loads((directory / "review-plan.json").read_text())
with pdf.open(approved) as candidate:
    assert not candidate.metadata["author"]
    for page, patches in zip(candidate, plan["placements"], strict=True):
        assert not page.get_text().strip()
        assert not page.get_links() and not list(page.annots())
        image, = page.get_images()
        embedded = pdf.Pixmap(candidate, image[0])
        assert apply_patches(embedded, patches, verify=True) == {"[PERSON_1]", "[EMAIL_1]"}
        seen = ocr_text(ocr(embedded, "eng", 11))
        assert re.search("PERSON[ _]1", seen) and re.search("EMAIL[ _]1", seen), seen
        for anchor in ("PUBLIC", "END OF SAMPLE", "REFERENCE" if page.number == 0 else "SECOND INDEX"):
            assert anchor in seen, seen
        assert not re.search("orchid|vector|example|invalid", seen, re.I), seen
`

async function run(...args: string[]) {
  const child = Bun.spawn([python, ...args], {
    stdout: 'ignore', stderr: 'pipe',
    env: { PATH: process.env.PATH ?? '', HOME: root, PYTHONDONTWRITEBYTECODE: '1', PYTHONNOUSERSITE: '1' }
  })
  const [status, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()])
  return { status, stderr }
}

try {
  await mkdir(scratch, { mode: 0o700 })
  await mkdir(vaultRoot, { mode: 0o700 })
  const generated = await run('-c', fixtures, root)
  assert.equal(generated.status, 0, generated.stderr)
  const job = {
    pdf: await readFile(join(root, 'scan.pdf')),
    identifiers: ['ORCHID VECTOR'], identifierTypes: ['PERSON'] as const, structuredIdentifiers: true,
    safeTextByPage: [['PUBLIC', 'REFERENCE', 'END OF SAMPLE'], ['PUBLIC SECOND INDEX', 'END OF SAMPLE']]
  }
  const started = performance.now()
  const review = await reviewer.prepare(job)
  const duration = (performance.now() - started) / 1000
  const [attempt] = await readdir(scratch)
  const directory = join(scratch, attempt)
  const plan = JSON.parse(await readFile(join(directory, 'review-plan.json'), 'utf8'))
  assert.equal(plan.paddle.model, 'PP-OCRv5_mobile')
  assert.equal(plan.paddle.pages.length, 2)
  assert.ok(plan.paddle.pages.every((page: { words: number; seconds: number }) => page.words > 5 && page.seconds > 0))
  const [first, second] = plan.paddle.pages
  assert.ok(plan.paddle.initializationSeconds > 0 && plan.paddle.peakRssBytes > 0)
  const approved = await reviewer.readApprovedCandidate(review, await reviewer.approve(review, await reviewer.inspect(review)))
  const approvedPath = join(root, 'approved.pdf')
  await writeFile(approvedPath, approved)
  const checked = await run('-c', checkCandidate, worker, directory, approvedPath)
  assert.equal(checked.status, 0, checked.stderr)
  const mapping = JSON.parse(await readFile(join(vaultRoot, review.candidateSha256, 'mapping.json'), 'utf8'))
  assert.deepEqual(mapping.values, { '[PERSON_1]': 'ORCHID VECTOR', '[EMAIL_1]': 'sample@example.invalid' })
  await reviewer.discard(review)
  console.log('PASS two image-only pages used real Paddle word boxes and passed independent OCR, pixel and PDF checks')
  console.log(`Cold initialization + page 1 ${(plan.paddle.initializationSeconds + first.seconds).toFixed(2)} s (init ${plan.paddle.initializationSeconds.toFixed(2)} s); warm page 2 ${second.seconds.toFixed(2)} s; prepare ${duration.toFixed(2)} s; redactor peak RSS ${(plan.paddle.peakRssBytes / 2 ** 20).toFixed(0)} MiB`)

  const missed = {
    pdf: await readFile(join(root, 'miss.pdf')), identifiers: ['AMBER FIGMENT'],
    language: 'eng' as const, safeTextByPage: [['PUBLIC REFERENCE', 'END OF SAMPLE']]
  }
  const control = join(root, 'miss-control')
  await mkdir(control, { mode: 0o700 })
  await writeFile(join(control, 'source.pdf'), missed.pdf)
  await writeFile(join(control, 'dictionary.json'), JSON.stringify({ ...missed, pdf: undefined }))
  const redacted = await run(worker, 'redact-review', control, '--paddle-models', paddleModels)
  assert.equal(redacted.status, 0, redacted.stderr)
  assert.ok(await Bun.file(join(control, 'candidate.pdf')).exists())
  const diagnostic = JSON.parse(await readFile(join(control, 'review-plan.json'), 'utf8'))
  assert.equal(diagnostic.paddle.model, 'PP-OCRv5_mobile')
  assert.deepEqual(diagnostic.highlights, [[]])
  const audit = await run(worker, 'verify-review', control)
  assert.notEqual(audit.status, 0)
  assert.match(audit.stderr, /identifier remains in raster OCR/)
  await assert.rejects(scanOnly.prepare(missed), UnverifiedRedactionError)
  assert.deepEqual(await readdir(scratch), [])

  const unavailable = createPrivatePdfReview(admission, scratch, python, { paddleModels: join(root, 'missing') })
  await assert.rejects(unavailable.prepare(job), UnverifiedRedactionError)
  assert.deepEqual(await readdir(scratch), [])
  console.log('PASS independent verifier refused a Paddle-path line-wrap miss; missing model files refused without fallback')
} finally {
  await rm(root, { recursive: true, force: true })
}

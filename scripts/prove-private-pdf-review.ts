/** Use generated documents and staged dependencies with network disabled. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { appendFile, link, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ComputeAdmission } from '../src/computeAdmission'
import { createPrivatePdfReview, InvalidPdfReviewError } from '../src/redaction/privatePdfReview'

const python = process.argv[2]
assert.ok(python, 'usage: bun scripts/prove-private-pdf-review.ts <staged python>')
const worker = fileURLToPath(new URL('../src/redaction/exact_match_pdf.py', import.meta.url))
const root = await mkdtemp(join(tmpdir(), 'girke-pdf-review-fixture-'))
const scratch = join(root, 'private')
const admission = new ComputeAdmission()
const reviewer = createPrivatePdfReview(admission, scratch, python)
const fixture = `
import sys
from pathlib import Path
import pymupdf as pdf

root = Path(sys.argv[1])
for label in ("FIRST", "SECOND"):
    with pdf.open() as typeset, pdf.open() as output:
        for index in range(2 if label == "FIRST" else 1):
            page = typeset.new_page(width=432, height=216)
            page.insert_text((45, 30), "PUBLIC " + label + " REFERENCE", fontsize=16)
            page.insert_text((45, 83), "ORCHID VECTOR", fontsize=24)
            page.insert_text((45, 126), "sample@example.invalid", fontsize=20)
            page.insert_text((45, 189), "END OF SAMPLE", fontsize=16)
            if index == 0:
                output.insert_pdf(typeset, from_page=0, to_page=0)
            else:
                scan = output.new_page(width=432, height=216)
                scan.insert_image(scan.rect, pixmap=page.get_pixmap(dpi=300, alpha=False))
        output.save(root / (label + ".pdf"), deflate=True)
`
const checkPreview = `
import sys
import pymupdf as pdf

with (pdf.open(sys.argv[1]) as review, pdf.open(sys.argv[2]) as candidate,
      pdf.open(sys.argv[3]) as source):
    assert len(source) == len(review) == len(candidate) == 2
    for preview, approved, original in zip(review, candidate, source, strict=True):
        assert "PRIVATE REVIEW / ORIGINAL" in preview.get_text()
        assert "VERIFIED CANDIDATE" in preview.get_text()
        images = preview.get_images()
        assert len(images) == 2
        before, after = [pdf.Pixmap(review, image[0]) for image in images]
        assert before.samples != after.samples
        for image, page in [(before, original), (after, approved)]:
            expected = page.get_pixmap(dpi=300, colorspace=pdf.csRGB, alpha=False, annots=False)
            assert image.samples == expected.samples
        highlights = [drawing["rect"] - (464, 26, 464, 26) for drawing in preview.get_drawings()]
        assert any(rect.contains(pdf.Point(80, 75)) for rect in highlights)
        assert any(rect.contains(pdf.Point(80, 118)) for rect in highlights)
`

async function run(...args: string[]) {
  const child = Bun.spawn([python, ...args], {
    stdout: 'ignore', stderr: 'pipe', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' }
  })
  const [status, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()])
  return { status, stderr }
}

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const settings = { identifiers: ['ORCHID VECTOR'], structuredIdentifiers: true, language: 'eng' as const }
const anchors = (label: string) => [`PUBLIC ${label} REFERENCE`, 'END OF SAMPLE']

try {
  const started = performance.now()
  await mkdir(scratch, { mode: 0o700 })
  const generated = await run('-c', fixture, root)
  assert.equal(generated.status, 0, generated.stderr)
  const firstJob = {
    ...settings, pdf: await readFile(join(root, 'FIRST.pdf')), safeTextByPage: [anchors('FIRST'), anchors('FIRST')]
  }
  const first = await reviewer.prepare({ ...firstJob, documentType: 'correspondence' })
  const [name] = await readdir(scratch)
  const directory = join(scratch, name)
  const candidate = join(directory, 'candidate.pdf')
  const preview = join(directory, 'review.pdf')
  const originalCandidate = await readFile(candidate)
  const originalPreview = await readFile(preview)
  const displayed = await reviewer.inspect(first)
  assert.equal(sha256(originalCandidate), displayed.candidateSha256)
  assert.equal(sha256(displayed.pdf), displayed.reviewSha256)
  assert.deepEqual(displayed.pdf, originalPreview)
  assert.equal((await stat(directory)).mode & 0o777, 0o700)
  for (const file of await readdir(directory)) assert.equal((await stat(join(directory, file))).mode & 0o777, 0o600)
  const checked = await run('-c', checkPreview, preview, candidate, join(directory, 'source.pdf'))
  assert.equal(checked.status, 0, checked.stderr)
  console.log('PASS private highlighted text/scan review shows exact verified candidate pixels')

  const second = await reviewer.prepare({ documentType: 'correspondence',
    ...settings, pdf: await readFile(join(root, 'SECOND.pdf')), safeTextByPage: [anchors('SECOND')]
  })
  const otherAttempt = (await readdir(scratch)).find(entry => entry !== name)
  assert.ok(otherAttempt)
  const otherCandidate = await readFile(join(scratch, otherAttempt, 'candidate.pdf'))
  assert.notEqual(first.candidateSha256, second.candidateSha256)
  await assert.rejects(reviewer.approve(first, await reviewer.inspect(second)), InvalidPdfReviewError)
  await assert.rejects(reviewer.approve(first, { ...displayed }), InvalidPdfReviewError)
  const modifiedInspection = await reviewer.inspect(first)
  modifiedInspection.pdf[0] ^= 1
  await assert.rejects(reviewer.approve(first, modifiedInspection), InvalidPdfReviewError)

  const replacedPreview = await reviewer.approve(first, displayed)
  await writeFile(preview, otherCandidate)
  await assert.rejects(reviewer.inspect(first), InvalidPdfReviewError)
  await assert.rejects(reviewer.approve(first, displayed), InvalidPdfReviewError)
  await assert.rejects(reviewer.readApprovedCandidate(first, replacedPreview), InvalidPdfReviewError)
  await writeFile(preview, originalPreview)

  const old = await reviewer.approve(first, displayed)
  const approval = await reviewer.approve(first, displayed)
  await assert.rejects(reviewer.readApprovedCandidate(first, old), InvalidPdfReviewError)
  await assert.rejects(reviewer.readApprovedCandidate(first, { ...approval }), InvalidPdfReviewError)
  await assert.rejects(reviewer.readApprovedCandidate(second, approval), InvalidPdfReviewError)
  const restarted = createPrivatePdfReview(admission, scratch, python)
  await assert.rejects(restarted.readApprovedCandidate(first, approval), InvalidPdfReviewError)

  await writeFile(candidate, otherCandidate)
  await assert.rejects(reviewer.inspect(first), InvalidPdfReviewError)
  await assert.rejects(reviewer.approve(first, displayed), InvalidPdfReviewError)
  await assert.rejects(reviewer.readApprovedCandidate(first, approval), InvalidPdfReviewError)
  await writeFile(candidate, originalCandidate)
  await assert.rejects(reviewer.readApprovedCandidate(first, approval), InvalidPdfReviewError)
  const saved = join(directory, 'saved.pdf')
  await rename(candidate, saved)
  for (const alias of [symlink, link]) {
    await alias(saved, candidate)
    await assert.rejects(reviewer.approve(first, displayed), InvalidPdfReviewError)
    await rm(candidate)
  }
  await rename(saved, candidate)

  const current = await reviewer.approve(first, displayed)
  const [snapshot, concurrent] = await Promise.allSettled([
    reviewer.readApprovedCandidate(first, current), reviewer.readApprovedCandidate(first, current)
  ])
  assert.equal(snapshot.status, 'fulfilled')
  assert.equal(concurrent.status, 'rejected')
  assert.ok(concurrent.reason instanceof InvalidPdfReviewError)
  assert.deepEqual(snapshot.value, originalCandidate)
  assert.equal(sha256(snapshot.value), current.candidateSha256)
  const discarded = await reviewer.approve(first, displayed)
  await reviewer.discard(first)
  await assert.rejects(reviewer.readApprovedCandidate(first, discarded), InvalidPdfReviewError)
  await reviewer.discard(second)
  assert.deepEqual(await readdir(scratch), [])
  console.log('PASS copied, wrong-job, superseded, restarted, consumed and discarded approvals refused')
  console.log('PASS substituted inspection, review PDF, candidate PDF, symlink and hardlink refused')

  const control = join(root, 'substitution-control')
  await mkdir(control, { mode: 0o700 })
  await writeFile(join(control, 'source.pdf'), firstJob.pdf)
  await writeFile(join(control, 'dictionary.json'), JSON.stringify({ ...settings, safeTextByPage: firstJob.safeTextByPage }))
  const redacted = await run(worker, 'redact-review', control)
  assert.equal(redacted.status, 0, redacted.stderr)
  await appendFile(join(control, 'candidate.pdf'), '\n% substituted after redaction\n')
  const refused = await run(worker, 'verify-review', control)
  assert.notEqual(refused.status, 0)
  assert.match(refused.stderr, /candidate bytes changed after redaction/)
  assert.ok(!(await Bun.file(join(control, 'review.pdf')).exists()))
  console.log(`PASS pre-verification substitution refused before review creation, ${((performance.now() - started) / 1000).toFixed(2)} s total`)
} finally {
  await rm(root, { recursive: true, force: true })
}

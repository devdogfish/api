/** Synthetic only. Run with staged Python dependencies and network disabled. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ComputeAdmission } from '../src/computeAdmission'
import { UnverifiedRedactionError } from '../src/redaction/privateRedaction'
import { createPrivatePdfReview, InvalidPdfReviewError } from '../src/redaction/privatePdfReview'

const python = process.argv[2]
assert.ok(python, 'usage: bun scripts/prove-vault-placeholders.ts <staged python>')
const worker = fileURLToPath(new URL('../src/redaction/exact_match_pdf.py', import.meta.url))
const root = await mkdtemp(join(tmpdir(), 'girke-vault-fixture-'))
const scratch = join(root, 'private-review')
const vault = join(root, 'vault')
const work = join(root, 'work')
const admission = new ComputeAdmission()
const reviewer = createPrivatePdfReview(admission, scratch, python, { vaultRoot: vault })
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const ibanBody = '000000001111222233'
const iban = 'DE' + String(98n - BigInt(ibanBody + '131400') % 97n).padStart(2, '0') + ibanBody
const tax = '02476291358' // Published ELSTER TestID.

const fixture = `
from pathlib import Path
import sys
import pymupdf as pdf

path, iban, tax = Path(sys.argv[1]), sys.argv[2], sys.argv[3]
groups = [iban[i:i+4] for i in range(0, len(iban), 4)]
with pdf.open() as output, pdf.open() as typeset:
    for index in range(2):
        page = typeset.new_page(width=540, height=440)
        page.insert_text((45, 30), "PUBLIC REFERENCE", fontsize=16)
        page.insert_text((45, 412), "END OF SAMPLE", fontsize=16)
        if index == 0:
            lines = [(74, "ORCHID VECTOR"), (113, "orchid"), (142, "vector"), (194, iban),
                     (237, "sample@example.invalid"), (283, tax), (326, "AMBER FIGMENT")]
        else:
            lines = [(74, "ORCHID"), (103, "VECTOR"), (151, " ".join(groups[:3])),
                     (180, " ".join(groups[3:])), (225, "sample@"), (254, "EXAMPLE.INVALID"),
                     (298, "02 476 291 358"), (343, "AMBER FIGMENT")]
        for y, line in lines:
            page.insert_text((45, y), line, fontsize=22)
        if index == 0:
            output.insert_pdf(typeset, from_page=0, to_page=0)
        else:
            scan = output.new_page(width=540, height=440)
            scan.insert_image(scan.rect, pixmap=page.get_pixmap(dpi=300, alpha=False))
    output.set_metadata({"author": "ORCHID VECTOR"})
    output.save(path, deflate=True)
`

const checkWork = `
import re
import sys
from pathlib import Path
sys.path.insert(0, str(Path(sys.argv[1]).parent))
from exact_match_pdf import check_identifiers, ocr, ocr_text, pdf, tokens

with pdf.open(sys.argv[2]) as candidate:
    assert len(candidate) == 2
    for page in candidate:
        assert not page.get_text().strip()
        assert not page.get_links() and not list(page.annots())
        assert not candidate.metadata["author"]
        image, = page.get_images()
        seen = ocr_text(ocr(pdf.Pixmap(candidate, image[0]), "eng", 11))
        check_identifiers(seen, [tokens("ORCHID VECTOR"), tokens("AMBER FIGMENT")], True, "source leaked")
        for label in ("PERSON_1", "PERSON_2", "EMAIL_1", "IBAN_1", "TAX_ID_1"):
            assert re.search(label.replace("_", "[ _]"), seen), seen
        assert len(re.findall("PERSON[ _]1", seen)) == (2 if page.number == 0 else 1), seen
`

const injectSourcePixel = `
import hashlib
import json
import sys
from pathlib import Path
sys.path.insert(0, str(Path(sys.argv[1]).parent))
from exact_match_pdf import pdf, raster, raster_digest, save_flat

directory, vault = Path(sys.argv[2]), Path(sys.argv[3])
path = directory / "candidate.pdf"
plan_path = directory / "review-plan.json"
plan = json.loads(plan_path.read_text())
rasters = []
with pdf.open(path) as candidate, pdf.open(directory / "source.pdf") as source, pdf.open() as output:
    for page, original in zip(candidate, source, strict=True):
        image, = page.get_images()
        pixels = pdf.Pixmap(candidate, image[0])
        if page.number == 0:
            coords, _ = plan["placements"][0][0]
            left, top, right, bottom = coords
            before = raster(original)
            x, y = next((x, y) for y in range(top, bottom) for x in range(left, right)
                        if before.pixel(x, y) == (0, 0, 0) and pixels.pixel(x, y) == (255, 255, 255))
            pixels.set_pixel(x, y, before.pixel(x, y))
        rasters.append(raster_digest(pixels))
        fresh = output.new_page(width=page.rect.width, height=page.rect.height)
        xref = fresh.insert_image(fresh.rect, pixmap=pixels, keep_proportion=False)
        output.xref_set_key(xref, "ColorSpace", "/DeviceRGB")
    temp = directory / "substituted.pdf"
    digest = save_flat(output, temp, review=True, placeholders=True)
temp.replace(path)
mapping_path = vault / "mapping.json"
mapping = json.loads(mapping_path.read_text())
mapping["candidateSha256"] = digest
payload = json.dumps(mapping).encode()
mapping_path.write_bytes(payload)
plan.update(digest=digest, mappingDigest=hashlib.sha256(payload).hexdigest())
plan_path.write_text(json.dumps(plan))
(directory / "rasters.json").write_text(json.dumps(rasters))
`

async function run(...args: string[]) {
  const child = Bun.spawn([python, ...args], {
    stdout: 'ignore', stderr: 'pipe', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' }
  })
  const [status, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()])
  return { status, stderr }
}

const values = {
  '[PERSON_1]': 'ORCHID VECTOR', '[PERSON_2]': 'AMBER FIGMENT',
  '[IBAN_1]': iban, '[EMAIL_1]': 'sample@example.invalid', '[TAX_ID_1]': tax
}

try {
  const started = performance.now()
  await Promise.all([scratch, vault, work].map(path => mkdir(path, { mode: 0o700 })))
  const source = join(root, 'fictional.pdf')
  const generated = await run('-c', fixture, source, iban, tax)
  assert.equal(generated.status, 0, generated.stderr)
  const settings = {
    identifiers: ['ORCHID VECTOR', 'AMBER FIGMENT'],
    identifierTypes: ['PERSON', 'PERSON'] as const,
    structuredIdentifiers: true, language: 'eng' as const,
    safeTextByPage: Array.from({ length: 2 }, () => ['PUBLIC REFERENCE', 'END OF SAMPLE'])
  }
  const job = { ...settings, pdf: await readFile(source) }
  const control = join(root, 'pixel-control')
  const controlVault = join(vault, 'pixel-control')
  await Promise.all([mkdir(control, { mode: 0o700 }), mkdir(controlVault, { mode: 0o700 })])
  await writeFile(join(control, 'source.pdf'), job.pdf)
  await writeFile(join(control, 'dictionary.json'), JSON.stringify(settings))
  const workerRedacted = await run(worker, 'redact-review', control, controlVault)
  assert.equal(workerRedacted.status, 0, workerRedacted.stderr)
  const downgrade = await run(worker, 'verify-review', control)
  assert.notEqual(downgrade.status, 0)
  assert.match(downgrade.stderr, /review requires its Vault mapping/)
  const controlMapping = join(controlVault, 'mapping.json')
  const originalControlMapping = await readFile(controlMapping)
  await writeFile(controlMapping, '{}')
  const changed = await run(worker, 'verify-review', control, controlVault)
  assert.notEqual(changed.status, 0)
  assert.match(changed.stderr, /Vault mapping changed before verification/)
  await writeFile(controlMapping, originalControlMapping)
  const workerVerified = await run(worker, 'verify-review', control, controlVault)
  assert.equal(workerVerified.status, 0, workerVerified.stderr)

  const corrupt = await run('-c', injectSourcePixel, worker, control, controlVault)
  assert.equal(corrupt.status, 0, corrupt.stderr)
  const refused = await run(worker, 'verify-review', control, controlVault)
  assert.notEqual(refused.status, 0)
  assert.match(refused.stderr, /unexpected pixels inside placeholder region/)
  await Promise.all([rm(control, { recursive: true }), rm(controlVault, { recursive: true })])
  console.log('PASS verifier rejected source ink inside a placeholder despite matching file and raster digests')

  const first = await reviewer.prepare(job)
  const oldApproval = await reviewer.approve(first, await reviewer.inspect(first))
  const firstMapping = join(vault, first.candidateSha256, 'mapping.json')
  assert.deepEqual(JSON.parse(await readFile(firstMapping, 'utf8')), { candidateSha256: first.candidateSha256, values })
  const second = await reviewer.prepare(job)
  const mapping = join(vault, second.candidateSha256, 'mapping.json')
  assert.notEqual(first.candidateSha256, second.candidateSha256)
  assert.deepEqual(JSON.parse(await readFile(mapping, 'utf8')), { candidateSha256: second.candidateSha256, values })
  await reviewer.discard(first)
  await assert.rejects(readFile(firstMapping), { code: 'ENOENT' })
  await assert.rejects(reviewer.readApprovedCandidate(first, oldApproval), InvalidPdfReviewError)
  await assert.rejects(reviewer.readApprovedCandidate(second, oldApproval), InvalidPdfReviewError)

  const [attempt] = await readdir(scratch)
  assert.ok(!(await readdir(join(scratch, attempt))).includes('mapping.json'))
  assert.deepEqual(await readdir(work), [])
  assert.equal((await stat(join(vault, second.candidateSha256))).mode & 0o777, 0o700)
  assert.equal((await stat(mapping)).mode & 0o777, 0o600)
  const inspected = await reviewer.inspect(second)
  assert.deepEqual(Object.keys(inspected).sort(), ['candidateSha256', 'pdf', 'reviewSha256'])
  const approval = await reviewer.approve(second, inspected)
  const original = await readFile(mapping)
  await writeFile(mapping, original.toString().replace('ORCHID VECTOR', 'FICTIONAL SUBSTITUTE'))
  await assert.rejects(reviewer.inspect(second), InvalidPdfReviewError)
  await assert.rejects(reviewer.approve(second, inspected), InvalidPdfReviewError)
  await assert.rejects(reviewer.readApprovedCandidate(second, approval), InvalidPdfReviewError)
  await writeFile(mapping, original)
  await assert.rejects(reviewer.readApprovedCandidate(second, approval), InvalidPdfReviewError)
  console.log('PASS replacement draft required fresh approval; substituted Vault mapping blocked review and handoff')

  const cleared = await reviewer.approve(second, inspected)
  const candidate = await reviewer.readApprovedCandidate(second, cleared)
  assert.equal(sha256(candidate), second.candidateSha256)
  const workPdf = join(work, 'candidate.pdf')
  await writeFile(workPdf, candidate, { flag: 'wx', mode: 0o600 })
  const checked = await run('-c', checkWork, worker, workPdf)
  assert.equal(checked.status, 0, checked.stderr)
  await reviewer.discard(second)
  assert.deepEqual(await readdir(scratch), [])
  assert.deepEqual(await readdir(work), ['candidate.pdf'])
  assert.deepEqual(await readdir(vault), [second.candidateSha256])
  assert.deepEqual(await readFile(mapping), original)

  const unsafe = createPrivatePdfReview(admission, scratch, python, { vaultRoot: scratch })
  await assert.rejects(unsafe.prepare(job), InvalidPdfReviewError)
  const conflict = { ...job, identifiers: [...job.identifiers, 'VECTOR'],
    identifierTypes: ['PERSON', 'PERSON', 'IDENTIFIER'] as const }
  await assert.rejects(reviewer.prepare(conflict), UnverifiedRedactionError)
  assert.deepEqual(await readdir(scratch), [])
  assert.deepEqual(await readdir(vault), [second.candidateSha256])
  console.log(`PASS stable repeated/wrapped labels across text and scan, candidate-only Work and retained Vault mapping; ${((performance.now() - started) / 1000).toFixed(2)} s`)
} finally {
  await rm(root, { recursive: true, force: true })
}

/** Synthetic PDF qualification. Stage dependencies, then run with network denied. */
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ComputeAdmission } from '../src/computeAdmission'
import { createPrivatePdfReview, InvalidPdfReviewError } from '../src/redaction/privatePdfReview'
import { UnverifiedRedactionError } from '../src/redaction/privateRedaction'

const [python, paddleDirectory] = process.argv.slice(2)
assert.ok(python && paddleDirectory, 'usage: bun scripts/prove-phone-numbers.ts <staged python> <staged Paddle models>')
const paddleModels = resolve(paddleDirectory)
const worker = fileURLToPath(new URL('../src/redaction/exact_match_pdf.py', import.meta.url))
const root = await mkdtemp(join(tmpdir(), 'girke-phone-fixture-'))
const scratch = join(root, 'private')
const vaultRoot = join(root, 'synthetic-mapping')
const gate = new ComputeAdmission()
const regions = ['DE', 'CA']
const review = createPrivatePdfReview(gate, scratch, python, { vaultRoot, paddleModels, phoneRegions: regions })
const anchors = ['public index', 'ID 9025550199', 'date 17 11 2026', 'end of sample']

const fixtures = `
import sys
from pathlib import Path
import pymupdf as pdf

root = Path(sys.argv[1])
lines = [
    "public index", "Phone: (030) 23125 123", "+1 902-555-0100",
    "Tel: 030 23125", "123", "Fax: 03023125123",
    "archive: 12045", "ID 9025550199", "date 17 11 2026", "end of sample"
]
for label, content in [("phones", lines), ("miss", ["public index", "+1 902-555-0100", "end of sample"])]:
    with pdf.open() as typeset, pdf.open() as output:
        page = typeset.new_page(width=500, height=440)
        for i, line in enumerate(content):
            page.insert_text((40, 32 + 41 * i), line, fontsize=22)
        output.insert_pdf(typeset)
        scan = output.new_page(width=page.rect.width, height=page.rect.height)
        scan.insert_image(scan.rect, pixmap=page.get_pixmap(dpi=300, alpha=False))
        assert not scan.get_text().strip()
        output.save(root / (label + ".pdf"), deflate=True)
`

const checkMatching = `
import sys
from pathlib import Path
sys.path.insert(0, str(Path(sys.argv[1]).parent))
from phone_numbers import PhoneNumbers

de_ca = PhoneNumbers(["DE", "CA"])
international = PhoneNumbers([])
as_values = lambda matches: [match.value for match in matches]
assert as_values(de_ca.matches("phone: 030 23125\\n123")) == ["+493023125123"]
assert as_values(de_ca.matches("phone: (902) 555-0100 ext. 42")) == ["+19025550100;ext=42"]
assert as_values(de_ca.matches("(902) 555-0100")) == ["+19025550100"]
assert as_values(international.matches("+49 30 23125 123")) == ["+493023125123"]
assert not international.matches("phone: (030) 23125 123")
assert not de_ca.matches("phone: 0049 30 23125 123")
assert not de_ca.matches("ID 9025550199\\norder id 902-555-0198\\ndate 2026-11-17\\ndate 17.11.2026")
assert as_values(de_ca.matches("9025550100", known={"+19025550100"})) == ["+19025550100"]
try:
    de_ca.matches("x" * 65537)
except ValueError as error:
    assert "bound" in str(error)
else:
    raise AssertionError("unbounded phone input")
`

const checkApproved = `
import json
import re
import sys
from pathlib import Path
sys.path.insert(0, str(Path(sys.argv[1]).parent))
from exact_match_pdf import check_identifiers, ocr, ocr_text, pdf, tokens
from phone_numbers import PhoneNumbers
from placeholder_pixels import apply_patches

plan = json.loads(Path(sys.argv[2]).read_text())
phones = PhoneNumbers(["DE", "CA"])
with pdf.open(sys.argv[3]) as document:
    for page, placements in zip(document, plan["placements"], strict=True):
        assert not page.get_text().strip()
        image, = page.get_images()
        pixels = pdf.Pixmap(document, image[0])
        assert apply_patches(pixels, placements, verify=True) == {"[PHONE_1]", "[PHONE_2]", "[IDENTIFIER_1]"}
        assert [label for _, label in placements].count("[PHONE_1]") == 3
        seen = ocr_text(ocr(pixels, "eng", 11))
        known = {"+493023125123", "+19025550100"}
        check_identifiers(seen, [tokens("12045")], True, "exact fallback leaked", phones, known)
        assert "9025550199" in seen and re.search(r"17\\s+11\\s+2026", seen)
        assert not re.search(r"\\b(?:23125|0100|123)\\b", seen), seen
`

async function run(...args: string[]) {
  const child = Bun.spawn([python, ...args], {
    stdout: 'pipe', stderr: 'pipe', env: {
      PATH: process.env.PATH ?? '', HOME: root, PYTHONDONTWRITEBYTECODE: '1', PYTHONNOUSERSITE: '1'
    }
  })
  const [status, stdout, stderr] = await Promise.all([
    child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()
  ])
  return { status, stdout, stderr }
}

try {
  await Promise.all([scratch, vaultRoot].map(path => mkdir(path, { mode: 0o700 })))
  const parser = await run('-c', checkMatching, worker)
  assert.equal(parser.status, 0, parser.stderr)
  const generated = await run('-c', fixtures, root)
  assert.equal(generated.status, 0, generated.stderr)
  const job = {
    pdf: await readFile(join(root, 'phones.pdf')), language: 'eng' as const, identifiers: ['12045'],
    structuredIdentifiers: true, safeTextByPage: [anchors, anchors]
  }
  const started = performance.now()
  const prepared = await review.prepare(job)
  const elapsed = (performance.now() - started) / 1000
  const [attempt] = await readdir(scratch)
  const planPath = join(scratch, attempt, 'review-plan.json')
  const plan = JSON.parse(await readFile(planPath, 'utf8'))
  assert.equal(plan.paddle.pages.length, 2)
  assert.equal(plan.phones.version, '9.0.43')
  assert.deepEqual(plan.phones.regions, regions)
  assert.equal(plan.phones.calls, 7)
  const reverse = JSON.parse(await readFile(join(vaultRoot, prepared.candidateSha256, 'mapping.json'), 'utf8'))
  assert.deepEqual(reverse.values, {
    '[PHONE_1]': '+493023125123', '[PHONE_2]': '+19025550100', '[IDENTIFIER_1]': '12045'
  })
  const approved = await review.readApprovedCandidate(prepared, await review.approve(prepared, await review.inspect(prepared)))
  const approvedPath = join(root, 'approved.pdf')
  await writeFile(approvedPath, approved)
  const checked = await run('-c', checkApproved, worker, planPath, approvedPath)
  assert.equal(checked.status, 0, checked.stderr)
  await review.discard(prepared)
  console.log(`PASS text and Paddle scan, 8/8 phone occurrences removed; date and phone-shaped ID retained; prepare ${elapsed.toFixed(2)} s, phone parser redactor CPU ${(plan.phones.cpuSeconds * 1000).toFixed(1)} ms (${plan.phones.calls} calls plus import)`)

  const control = join(root, 'planted-miss')
  const mapping = join(vaultRoot, 'planted-miss')
  await Promise.all([control, mapping].map(path => mkdir(path, { mode: 0o700 })))
  await writeFile(join(control, 'source.pdf'), await readFile(join(root, 'miss.pdf')))
  const controls = ['public index', 'end of sample']
  await writeFile(join(control, 'dictionary.json'), JSON.stringify({
    identifiers: [], structuredIdentifiers: true, language: 'eng', safeTextByPage: [controls, controls]
  }))
  const omitted = await run(worker, 'redact-review', control, mapping)
  assert.equal(omitted.status, 0, omitted.stderr)
  const controlPlan = join(control, 'review-plan.json')
  const old = JSON.parse(await readFile(controlPlan, 'utf8'))
  await writeFile(controlPlan, JSON.stringify({ ...old, phones: { version: plan.phones.version, regions } }))
  const mismatch = await run(worker, 'verify-review', control, mapping, '--phone-regions', 'US')
  assert.notEqual(mismatch.status, 0)
  assert.match(mismatch.stderr, /review requires the configured phone detector/)
  const audited = await run(worker, 'verify-review', control, mapping, '--phone-regions', regions.join(','))
  assert.notEqual(audited.status, 0)
  assert.match(audited.stderr, /phone number remains: identifier remains in raster OCR/)
  assert.ok(!(await Bun.file(join(control, 'review.pdf')).exists()))

  const invalid = createPrivatePdfReview(gate, scratch, python, { vaultRoot, phoneRegions: ['ZZ'] })
  await assert.rejects(invalid.prepare(job), UnverifiedRedactionError)
  const noMapping = createPrivatePdfReview(gate, scratch, python, { phoneRegions: [] })
  await assert.rejects(noMapping.prepare(job), InvalidPdfReviewError)
  assert.deepEqual(await readdir(scratch), [])
  console.log('PASS planted residual, changed/invalid region and missing private mapping refused; scratch cleared')
} finally {
  await rm(root, { recursive: true, force: true })
}

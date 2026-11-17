/** Exercise the private caller with generated PDFs and staged offline dependencies. */
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ComputeAdmission } from '../src/computeAdmission'
import { createExactMatchPdfRedactor } from '../src/redaction/exactMatchPdf'
import { UnverifiedRedactionError } from '../src/redaction/privateRedaction'

const python = process.argv[2]
assert.ok(python, 'usage: bun scripts/prove-structured-redaction.ts <staged python>')
const worker = fileURLToPath(new URL('../src/redaction/exact_match_pdf.py', import.meta.url))
const root = await mkdtemp(join(tmpdir(), 'girke-structured-pdf-fixture-'))
const scratch = join(root, 'worker')
const redact = createExactMatchPdfRedactor(new ComputeAdmission(), scratch, python)
const anchors = ['PUBLIC REFERENCE', 'END OF SAMPLE']
const settings = { identifiers: [], safeTextByPage: [anchors], structuredIdentifiers: true }

async function pythonCommand(...args: string[]) {
  const child = Bun.spawn([python, ...args], {
    stdout: 'ignore', stderr: 'pipe', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' }
  })
  const [status, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()])
  return { status, stderr }
}

const fixtures = `
import sys
from pathlib import Path

sys.path.insert(0, str(Path(sys.argv[1]).parent))
from exact_match_pdf import ocr, ocr_text, pdf, raster, structured_matches

root = Path(sys.argv[2])
# Invented BBAN with an unassigned bank code and an independently calculated check.
bban = "000000001111222233"
iban = f"DE{98 - int(bban + '131400') % 97:02d}{bban}"
# Published ELSTER TestID, including its leading zero.
tax = "02476291358"
valid = [iban, tax, "sample@example.invalid"]
invalid = [iban[:-1] + "4", tax[:-1] + "9", "sample..part@example.invalid"]
formatted = [" ".join(iban[i:i+4] for i in range(0, len(iban), 4)),
             "02 476 291 358", "case+tag @ example.invalid"]
assert [m.valid for m in structured_matches(iban + " 4")] == [False]
assert [m.valid for m in structured_matches("éname@example.invalid")] == [False]

def write(name, lines, scan, expected, values=None):
    with pdf.open() as typeset, pdf.open() as image:
        page = typeset.new_page(width=432, height=220)
        page.insert_text((48, 26), "PUBLIC REFERENCE", fontsize=16)
        for i, line in enumerate(lines):
            page.insert_text((48, 74 + 37 * i), line, fontsize=20)
        page.insert_text((48, 198), "END OF SAMPLE", fontsize=16)
        if scan:
            pixels = raster(page)
            page = image.new_page(width=432, height=220)
            page.insert_image(page.rect, pixmap=pixels)
            assert not page.get_text().strip(), name
            text = ocr_text(ocr(pixels, "eng", 6))
        else:
            text = page.get_text()
        matches = list(structured_matches(text))
        assert [m.valid for m in matches] == expected, (name, text, matches)
        if all(expected):
            # Check that every intended value, including OCR whitespace, was represented.
            def compact(value):
                return "".join(value.split()).casefold()
            assert {compact(text[m.start:m.end]) for m in matches} == set(map(compact, values or lines)), (name, text)
        output = image if scan else typeset
        output.set_metadata({"author": valid[2]})
        output.save(root / (name + ".pdf"), deflate=True)

for scan, media in [(False, "text"), (True, "scan")]:
    write(media + "-compact", valid, scan, [True, True, True])
    write(media + "-formatted", formatted, scan, [True, True, True])
    for index, value in enumerate(invalid):
        write(f"{media}-invalid-{index}", [value], scan, [False])
write("split-email", ["sample", "@example.invalid"], True, [True], [valid[2]])
`

const checkPixels = `
import sys
import pymupdf as pdf
with pdf.open(sys.argv[1]) as document:
    page = document[0]
    assert not page.get_text().strip()
    assert not document.metadata["author"]
    pixels = page.get_pixmap(clip=pdf.Rect(35, 47, 400, 162))
    assert min(pixels.samples) == 255, "ink remains within identifier regions"
`

try {
  await mkdir(scratch)
  const generated = await pythonCommand('-c', fixtures, worker, root)
  assert.equal(generated.status, 0, generated.stderr)
  const started = performance.now()
  for (const media of ['text', 'scan']) {
    for (const format of ['compact', 'formatted']) {
      const pdf = await readFile(join(root, `${media}-${format}.pdf`))
      const candidate = await redact({ ...settings, pdf })
      const audit = await pythonCommand('-c', checkPixels, candidate)
      assert.equal(audit.status, 0, audit.stderr)
      assert.deepEqual(await readFile(join(dirname(candidate), 'source.pdf')), pdf)
      await rm(dirname(candidate), { recursive: true })
      console.log(`PASS ${media} ${format} DE IBAN, IdNr and email removed with safe anchors retained`)
    }
    for (let i = 0; i < 3; i++) {
      const pdf = await readFile(join(root, `${media}-invalid-${i}.pdf`))
      await assert.rejects(redact({ ...settings, pdf }), UnverifiedRedactionError)
      assert.deepEqual(await readdir(scratch), [])
    }
    console.log(`PASS ${media} bad IBAN and IdNr checksums and malformed email refused; scratch cleared`)
  }

  const pdf = await readFile(join(root, 'split-email.pdf'))
  const control = join(root, 'audit-control')
  await mkdir(control)
  await writeFile(join(control, 'source.pdf'), pdf)
  await writeFile(join(control, 'dictionary.json'), JSON.stringify({ ...settings, language: 'eng' }))
  const unverified = await pythonCommand(worker, 'redact', control)
  assert.equal(unverified.status, 0, unverified.stderr)
  const audit = await pythonCommand(worker, 'verify', control)
  assert.notEqual(audit.status, 0)
  assert.match(audit.stderr, /structured identifier remains/)
  await assert.rejects(redact({ ...settings, pdf }), UnverifiedRedactionError)
  assert.deepEqual(await readdir(scratch), [])
  console.log(`PASS verifier caught missed split email and caller removed candidate; total caller checks ${((performance.now() - started) / 1000).toFixed(2)} s`)
} finally {
  await rm(root, { recursive: true, force: true })
}

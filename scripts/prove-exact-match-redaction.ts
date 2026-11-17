/** Use staged Python dependencies. Run in a disposable environment with network disabled. */
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createApp } from '../src/app'
import { ComputeAdmission } from '../src/computeAdmission'
import { OCR_MODEL } from '../src/ocr/ocrProcessor'
import { createExactMatchPdfRedactor } from '../src/redaction/exactMatchPdf'
import { UnverifiedRedactionError } from '../src/redaction/privateRedaction'
import { authHeaders, testApiTokenStore } from '../tests/helpers'

const python = process.argv[2]
assert.ok(python, 'usage: bun scripts/prove-exact-match-redaction.ts <staged python>')
const worker = fileURLToPath(new URL('../src/redaction/exact_match_pdf.py', import.meta.url))
const root = await mkdtemp(join(tmpdir(), 'girke-exact-pdf-fixture-'))
const scratch = join(root, 'worker')
const identifiers = ['ORCHID VECTOR', 'AMBER FIGMENT']
const safeTextByPage = [['PUBLIC REFERENCE', 'END OF SAMPLE'], ['PUBLIC INDEX', 'END OF SAMPLE']]
const hold = Promise.withResolvers<void>()
const ocrStarted = Promise.withResolvers<void>()
const admission = new ComputeAdmission()
const redact = createExactMatchPdfRedactor(admission, scratch, python)
const app = createApp({
  apiTokenStore: testApiTokenStore(), version: 'synthetic',
  ocrProcessor: { async recognize() {
    ocrStarted.resolve()
    await hold.promise
    return { text: 'invented OCR', lines: ['invented OCR'], processing_seconds: 1, model: OCR_MODEL }
  } }
}, admission)

async function pythonCommand(args: string[]) {
  const child = Bun.spawn([python, ...args], { stdout: 'ignore', stderr: 'pipe' })
  const [status, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()])
  return { status, stderr }
}

const fixture = `
import pymupdf as pdf
import sys
from pathlib import Path
root = Path(sys.argv[1])
for name in ("text", "scan", "missed"):
    with pdf.open() as document, pdf.open() as typeset:
        for i, anchor in enumerate(("PUBLIC REFERENCE", "PUBLIC INDEX")):
            width, height = (432, 216) if i == 0 else (446.28, 234.89)
            page = typeset.new_page(width=width, height=height)
            page.insert_text((54, 31), anchor, fontsize=16)
            page.insert_text((54, 185), "END OF SAMPLE", fontsize=16)
            if name == "missed" and i == 1:
                page.insert_text((54, 86), "AMBER", fontsize=27)
                page.insert_text((54, 127), "FIGMENT", fontsize=27)
            else:
                page.insert_text((54, 86), "ORCHID VECTOR", fontsize=27)
                page.insert_text((54, 127), "ORCHID VECTOR", fontsize=27)
            if name != "text":
                raster = document.new_page(width=width, height=height)
                raster.insert_image(raster.rect, pixmap=page.get_pixmap(dpi=300, alpha=False))
        output = typeset if name == "text" else document
        output.set_metadata({"author": "AMBER FIGMENT"})
        output.save(root / (name + ".pdf"), deflate=True)
`

const pending: Promise<unknown>[] = []
try {
  await mkdir(scratch)
  assert.deepEqual(await pythonCommand(['-c', fixture, root]), { status: 0, stderr: '' })
  const input = async (kind: string) => ({
    pdf: await readFile(join(root, kind + '.pdf')), identifiers, safeTextByPage
  })

  // Exercise the real caller while OCR owns the same gate.
  const form = new FormData()
  form.set('file', new File(['invented image'], 'image.png'))
  const ocr = Promise.resolve(app.request('/api/v1/ocr', { method: 'POST', headers: authHeaders, body: form }))
  pending.push(ocr)
  await ocrStarted.promise
  const text = await input('text')
  const started = performance.now()
  const candidate = redact(text)
  pending.push(candidate)
  assert.deepEqual(await readdir(scratch), [], 'redaction entered while OCR held the slot')
  hold.resolve()
  assert.equal((await ocr).status, 200)
  const textPath = await candidate
  assert.deepEqual(await readFile(join(dirname(textPath), 'source.pdf')), text.pdf)
  assert.ok(await Bun.file(textPath).exists())
  console.log(`PASS two text pages with repeated identifiers and safe text, ${((performance.now() - started) / 1000).toFixed(2)} s`)

  const scan = await input('scan')
  const scanStarted = performance.now()
  const scanPath = await redact(scan)
  assert.deepEqual(await readFile(join(dirname(scanPath), 'source.pdf')), scan.pdf)
  assert.ok(await Bun.file(scanPath).exists())
  console.log(`PASS two scanned pages with repeated identifiers and safe text, ${((performance.now() - scanStarted) / 1000).toFixed(2)} s`)

  // Show a genuine miss: redaction writes a candidate before the independent verifier sees the phrase.
  const missed = await input('missed')
  const control = join(root, 'miss-control')
  await mkdir(control)
  await writeFile(join(control, 'source.pdf'), missed.pdf)
  await writeFile(join(control, 'dictionary.json'), JSON.stringify({ identifiers, safeTextByPage, language: 'eng' }))
  assert.equal((await pythonCommand([worker, 'redact', control])).status, 0)
  assert.ok(await Bun.file(join(control, 'candidate.pdf')).exists())
  const audit = await pythonCommand([worker, 'verify', control])
  assert.notEqual(audit.status, 0)
  assert.match(audit.stderr, /identifier remains in raster OCR/)

  const previous = (await readdir(scratch)).sort()
  const missedStarted = performance.now()
  await assert.rejects(redact(missed), UnverifiedRedactionError)
  assert.deepEqual((await readdir(scratch)).sort(), previous)
  assert.deepEqual(await readFile(join(root, 'missed.pdf')), missed.pdf)
  console.log(`PASS missed cross-line identifier refused and candidate removed, ${((performance.now() - missedStarted) / 1000).toFixed(2)} s`)
} finally {
  hold.resolve()
  await Promise.allSettled(pending)
  await rm(root, { recursive: true, force: true })
}

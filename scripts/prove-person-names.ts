/** Synthetic labels only. Run the staging-independent inference proof with network denied. */
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ComputeAdmission } from '../src/computeAdmission'
import { createPrivatePdfReview, InvalidPdfReviewError } from '../src/redaction/privatePdfReview'

const [python, models] = process.argv.slice(2)
assert.ok(python && models, 'usage: bun scripts/prove-person-names.ts <staged python> <staged Paddle models>')
const paddleModels = resolve(models)
const worker = fileURLToPath(new URL('../src/redaction/exact_match_pdf.py', import.meta.url))
const root = await mkdtemp(join(tmpdir(), 'girke-spacy-fixture-'))
const scratch = join(root, 'private')
const vaultRoot = join(root, 'synthetic-mapping')
const gate = new ComputeAdmission()
const reviewer = createPrivatePdfReview(gate, scratch, python, { vaultRoot, paddleModels, personNames: true })
const fixtures = [
  {
    language: 'eng', model: 'en_core_web_sm-3.8.0', name: 'Mara Whitcombe', fallback: 'ysolde qev',
    lines: ['This is the public index.', 'Mara Whitcombe reviewed the draft.', 'filed by ysolde qev.',
      'contact: sample@example.invalid', 'reference code: private tag', 'end of sample.'],
    safe: ['public index', 'reviewed the draft', 'end of sample']
  },
  {
    language: 'deu', model: 'de_core_news_sm-3.8.0', name: 'Lena Falkenrath', fallback: 'kvellanth',
    lines: ['Dies ist der externe Index.', 'Lena Falkenrath hat den Entwurf gelesen.', 'gezeichnet von kvellanth.',
      'kontakt: sample@example.invalid', 'referenzcode: private tag', 'ende der probe.'],
    safe: ['externe Index', 'den Entwurf gelesen', 'ende der probe']
  }
] as const

const make = `
import json
import sys
import pymupdf as pdf

with pdf.open() as output, pdf.open() as typeset:
    page = typeset.new_page(width=540, height=260)
    for i, line in enumerate(json.loads(sys.argv[2])):
        page.insert_text((40, 33 + 39 * i), line, fontsize=20)
    output.insert_pdf(typeset)
    scan = output.new_page(width=540, height=260)
    scan.insert_image(scan.rect, pixmap=page.get_pixmap(dpi=300, alpha=False))
    assert not scan.get_text().strip()
    output.save(sys.argv[1], deflate=True)
`

const rawLabels = `
import json
import sys
from pathlib import Path
sys.path.insert(0, str(Path(sys.argv[1]).parent))
from exact_match_pdf import PersonNames, PaddleScan, pdf, raster, text_boxes

paddle = PaddleScan(Path(sys.argv[2]))
for case in json.loads(sys.argv[3]):
    names = PersonNames(case["language"])
    with pdf.open(case["source"]) as source:
        for page in source:
            lines = paddle.lines(page, raster(page)) if page.number else text_boxes(page)
            text = "\\n".join(" ".join(word for word, _ in line) for line in lines)
            print(json.dumps([case["language"], page.number,
                              [text[start:end] for start, end in names.spans(text)]]))
`

const checkCandidate = `
import json
import re
import sys
from pathlib import Path
sys.path.insert(0, str(Path(sys.argv[1]).parent))
from exact_match_pdf import check_identifiers, ocr, ocr_text, pdf, tokens
from placeholder_pixels import apply_patches

plan = json.loads(Path(sys.argv[4]).read_text())
with pdf.open(sys.argv[2]) as document:
    for page, placement in zip(document, plan["placements"], strict=True):
        assert not page.get_text().strip()
        image, = page.get_images()
        embedded = pdf.Pixmap(document, image[0])
        seen = ocr_text(ocr(embedded, sys.argv[3], 11))
        check_identifiers(seen, [tokens(value) for value in sys.argv[5:]], True, "ground truth leaked")
        assert apply_patches(embedded, placement, verify=True) == {
            "[PERSON_1]", "[PERSON_2]", "[EMAIL_1]", "[IDENTIFIER_1]"
        }
        for label in ("PERSON_1", "PERSON_2"):
            assert re.search(label.replace("_", "[ _]"), seen), seen
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

const norm = (text: string) => text.trim().replace(/\s+/g, ' ').toLowerCase()

try {
  await Promise.all([scratch, vaultRoot].map(path => mkdir(path, { mode: 0o700 })))
  const cases = []
  for (const fixture of fixtures) {
    const source = join(root, fixture.language + '.pdf')
    const generated = await run('-c', make, source, JSON.stringify(fixture.lines))
    assert.equal(generated.status, 0, generated.stderr)
    cases.push({ ...fixture, source })
  }
  const measured = await run('-c', rawLabels, worker, paddleModels, JSON.stringify(cases))
  assert.equal(measured.status, 0, measured.stderr)
  let rawMisses = 0
  let rawExtras = 0
  for (const line of measured.stdout.trim().split('\n')) {
    const [language, page, found] = JSON.parse(line) as [string, number, string[]]
    const expected = cases.find(test => test.language === language)
    assert.ok(expected)
    const truth = [expected.name, expected.fallback].map(norm)
    const detected = found.map(norm)
    const misses = truth.filter(name => !detected.includes(name)).length
    const extras = detected.filter(name => !truth.includes(name)).length
    rawMisses += misses
    rawExtras += extras
    console.log(`${language} ${page ? 'scan' : 'text'} raw NER ${2 - misses}/2 full names, ${extras} extra spans`)
  }
  assert.ok(rawMisses > 0, 'fixture must exercise the exact-name fallback')

  for (const fixture of cases) {
    const pdf = await readFile(fixture.source)
    const settings = {
      language: fixture.language, identifiers: [fixture.fallback, 'private tag'],
      identifierTypes: ['PERSON', 'IDENTIFIER'] as const, structuredIdentifiers: true,
      safeTextByPage: [fixture.safe, fixture.safe]
    }
    const start = performance.now()
    const review = await reviewer.prepare({ pdf, ...settings })
    const elapsed = (performance.now() - start) / 1000
    const [attempt] = await readdir(scratch)
    const plan = JSON.parse(await readFile(join(scratch, attempt, 'review-plan.json'), 'utf8'))
    assert.equal(plan.names.model, fixture.model)
    assert.equal(plan.names.calls, 3, 'one text extraction and two Paddle transcriptions')
    assert.ok(plan.names.detections >= 2)
    const reverse = JSON.parse(await readFile(join(vaultRoot, review.candidateSha256, 'mapping.json'), 'utf8'))
    assert.deepEqual(reverse.values, {
      '[PERSON_1]': fixture.name, '[PERSON_2]': fixture.fallback,
      '[EMAIL_1]': 'sample@example.invalid', '[IDENTIFIER_1]': 'private tag'
    })
    const approved = await reviewer.readApprovedCandidate(review, await reviewer.approve(review, await reviewer.inspect(review)))
    const candidate = join(root, fixture.language + '-approved.pdf')
    await writeFile(candidate, approved)
    const checked = await run('-c', checkCandidate, worker, candidate, fixture.language,
      join(scratch, attempt, 'review-plan.json'), fixture.name, fixture.fallback, 'private tag')
    assert.equal(checked.status, 0, checked.stderr)
    await reviewer.discard(review)
    console.log(`${fixture.language} reviewed in ${elapsed.toFixed(2)} s, model load + NER CPU ${(plan.names.loadCpuSeconds + plan.names.inferenceCpuSeconds).toFixed(3)} s, redactor peak ${(plan.names.peakRssBytes / 2 ** 20).toFixed(0)} MiB`)
  }

  const fixture = cases[0]
  const control = join(root, 'planted-miss')
  const privateMapping = join(vaultRoot, 'planted-miss')
  await Promise.all([control, privateMapping].map(path => mkdir(path, { mode: 0o700 })))
  await writeFile(join(control, 'source.pdf'), await readFile(fixture.source))
  await writeFile(join(control, 'dictionary.json'), JSON.stringify({
    language: fixture.language, identifiers: [fixture.fallback, 'private tag'],
    identifierTypes: ['PERSON', 'IDENTIFIER'], structuredIdentifiers: true,
    safeTextByPage: [fixture.safe, fixture.safe]
  }))
  // Produce a candidate with a planted omission, then run the real verifier in its configured mode.
  const omitted = await run(worker, 'redact-review', control, privateMapping)
  assert.equal(omitted.status, 0, omitted.stderr)
  const reviewPlan = join(control, 'review-plan.json')
  const plan = JSON.parse(await readFile(reviewPlan, 'utf8'))
  await writeFile(reviewPlan, JSON.stringify({ ...plan, names: { model: fixture.model } }))
  const check = await run(worker, 'verify-review', control, privateMapping, '--person-names')
  assert.notEqual(check.status, 0)
  assert.match(check.stderr, /person name remains in independent OCR/)
  assert.ok(!(await Bun.file(join(control, 'review.pdf')).exists()))
  const ambiguous = join(root, 'conflicting-name')
  const ambiguousMapping = join(vaultRoot, 'conflicting-name')
  await Promise.all([ambiguous, ambiguousMapping].map(path => mkdir(path, { mode: 0o700 })))
  await writeFile(join(ambiguous, 'source.pdf'), await readFile(fixture.source))
  await writeFile(join(ambiguous, 'dictionary.json'), JSON.stringify({
    language: fixture.language, identifiers: ['Mara'], identifierTypes: ['PERSON'],
    structuredIdentifiers: true, safeTextByPage: [fixture.safe, fixture.safe]
  }))
  const overlap = await run(worker, 'redact-review', ambiguous, ambiguousMapping, '--person-names')
  assert.notEqual(overlap.status, 0)
  assert.match(overlap.stderr, /conflicting identifier geometries/)
  assert.ok(!(await Bun.file(join(ambiguous, 'candidate.pdf')).exists()))
  const noVault = createPrivatePdfReview(gate, scratch, python, { personNames: true })
  await assert.rejects(noVault.prepare({ pdf: await readFile(fixture.source), identifiers: [], safeTextByPage: [] }),
    InvalidPdfReviewError)
  assert.deepEqual(await readdir(scratch), [])
  console.log(`PASS labeled corpus: ${rawMisses}/8 raw NER misses, ${rawExtras} extra spans, 0/8 approved name leaks; planted residual, conflicting spans and missing private mapping refused`)
} finally {
  await rm(root, { recursive: true, force: true })
}

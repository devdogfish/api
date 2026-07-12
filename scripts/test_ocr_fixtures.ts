import { readdir } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createTesseractOcrProcessor, OCR_MODEL } from '../src/ocr/ocrProcessor'

type OcrResponse = {
  text: string
  lines: string[]
  processing_seconds: number
  model: string
}

type Score = {
  image: string
  seconds: number
  tokenPrecision: number
  tokenRecall: number
  tokenF1: number
  tokenSetAccuracy: number
  charAccuracy: number
  refTokens: number
  outTokens: number
  missing: string[]
  extra: string[]
  text: string
}

const root = fileURLToPath(new URL('..', import.meta.url))
const dataDir = join(root, 'girke-ocr-research-bundle', 'data')
const apiUrl = argValue('--api-url')
const token = argValue('--token') ?? process.env.OCR_TEST_TOKEN ?? 'girke_valid'
const minAvgTokenF1 = numberFromEnv('OCR_MIN_AVG_TOKEN_F1', 0)
const minImageTokenF1 = numberFromEnv('OCR_MIN_IMAGE_TOKEN_F1', 0)
const minAvgTokenSetAccuracy = numberFromEnv('OCR_MIN_AVG_TOKEN_SET_ACCURACY', 0.65)
const minImageTokenSetAccuracy = numberFromEnv('OCR_MIN_IMAGE_TOKEN_SET_ACCURACY', 0.50)
const minAvgCharAccuracy = numberFromEnv('OCR_MIN_AVG_CHAR_ACCURACY', 0.25)

function argValue(name: string) {
  const prefix = `${name}=`
  const inline = process.argv.find((arg) => arg.startsWith(prefix))
  if (inline) return inline.slice(prefix.length)
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

function numberFromEnv(name: string, fallback: number) {
  const raw = process.env[name]
  if (!raw) return fallback
  const value = Number(raw)
  return Number.isFinite(value) ? value : fallback
}

function normalize(text: string) {
  return text
    .toLowerCase()
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function tokenSet(text: string) {
  return new Set(normalize(text).split(' ').filter(Boolean))
}

function ratio(a: string, b: string) {
  if (!a && !b) return 1
  if (!a || !b) return 0
  const distance = levenshtein(a, b)
  return Math.max(0, (a.length + b.length - distance) / (a.length + b.length))
}

function sortedJoin(tokens: string[]) {
  return [...tokens].sort().join(' ')
}

function tokenSetAccuracy(reference: string, output: string) {
  const ref = tokenSet(reference)
  const out = tokenSet(output)
  const intersection = [...ref].filter((token) => out.has(token))
  const refOnly = [...ref].filter((token) => !out.has(token))
  const outOnly = [...out].filter((token) => !ref.has(token))
  const common = sortedJoin(intersection)
  const refCombined = sortedJoin([...intersection, ...refOnly])
  const outCombined = sortedJoin([...intersection, ...outOnly])

  return Math.max(ratio(common, refCombined), ratio(common, outCombined), ratio(refCombined, outCombined))
}

function levenshtein(a: string, b: string) {
  const previous = Array.from({ length: b.length + 1 }, (_, i) => i)
  const current = new Array<number>(b.length + 1)

  for (let i = 1; i <= a.length; i += 1) {
    current[0] = i
    for (let j = 1; j <= b.length; j += 1) {
      current[j] = Math.min(
        previous[j] + 1,
        current[j - 1] + 1,
        previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      )
    }
    previous.splice(0, previous.length, ...current)
  }

  return previous[b.length]
}

function charAccuracy(reference: string, output: string) {
  const ref = normalize(reference)
  const out = normalize(output)
  if (!ref) return out ? 0 : 1
  return Math.max(0, 1 - levenshtein(ref, out) / ref.length)
}

function scoreText(image: string, reference: string, output: string, seconds: number): Score {
  const ref = tokenSet(reference)
  const out = tokenSet(output)
  const overlap = [...ref].filter((token) => out.has(token))
  const precision = out.size ? overlap.length / out.size : 0
  const recall = ref.size ? overlap.length / ref.size : 0
  const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0

  return {
    image,
    seconds,
    tokenPrecision: precision,
    tokenRecall: recall,
    tokenF1: f1,
    tokenSetAccuracy: tokenSetAccuracy(reference, output),
    charAccuracy: charAccuracy(reference, output),
    refTokens: ref.size,
    outTokens: out.size,
    missing: [...ref].filter((token) => !out.has(token)).slice(0, 18),
    extra: [...out].filter((token) => !ref.has(token)).slice(0, 18),
    text: output
  }
}

async function listImages() {
  const entries = await readdir(dataDir)
  return entries.filter((entry) => extname(entry).toLowerCase() === '.jpeg').sort()
}

async function recognizeDirect(imagePath: string): Promise<OcrResponse> {
  return await createTesseractOcrProcessor().recognize({ inputPath: imagePath, timeoutMs: 20_000 })
}

async function recognizeHttp(imagePath: string): Promise<OcrResponse> {
  if (!apiUrl) throw new Error('missing --api-url')
  const image = Bun.file(imagePath)
  const form = new FormData()
  form.set('file', new File([await image.arrayBuffer()], basename(imagePath), { type: 'image/jpeg' }))

  const res = await fetch(apiUrl.replace(/\/$/, ''), {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: form
  })
  const body = await res.json()
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${JSON.stringify(body)}`)
  }
  return body as OcrResponse
}

function fmt(value: number) {
  return value.toFixed(3)
}

async function main() {
  const scores: Score[] = []

  for (const image of await listImages()) {
    const imagePath = join(dataDir, image)
    const reference = await Bun.file(imagePath.replace(/\.jpeg$/i, '.txt')).text()
    const result = apiUrl ? await recognizeHttp(imagePath) : await recognizeDirect(imagePath)
    if (result.model !== OCR_MODEL) {
      throw new Error(`${image}: unexpected model ${result.model}`)
    }
    if (result.lines.join('\n') !== result.text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).join('\n')) {
      throw new Error(`${image}: lines do not match text`)
    }
    scores.push(scoreText(image, reference, result.text, result.processing_seconds))
  }

  const average = (pick: (score: Score) => number) => scores.reduce((sum, score) => sum + pick(score), 0) / scores.length
  const avgF1 = average((score) => score.tokenF1)
  const avgTokenSet = average((score) => score.tokenSetAccuracy)
  const avgChar = average((score) => score.charAccuracy)
  const slowest = Math.max(...scores.map((score) => score.seconds))
  const worst = [...scores].sort((a, b) => a.tokenSetAccuracy - b.tokenSetAccuracy).slice(0, 3)
  const f1Failures = scores.filter((score) => score.tokenF1 < minImageTokenF1)
  const tokenSetFailures = scores.filter((score) => score.tokenSetAccuracy < minImageTokenSetAccuracy)

  console.log(`mode=${apiUrl ? 'http' : 'direct'} images=${scores.length} model=${OCR_MODEL}`)
  console.log(
    `avg_token_set=${fmt(avgTokenSet)} min_token_set=${fmt(Math.min(...scores.map((score) => score.tokenSetAccuracy)))} avg_token_f1=${fmt(avgF1)} min_token_f1=${fmt(Math.min(...scores.map((score) => score.tokenF1)))} avg_char=${fmt(avgChar)} slowest_seconds=${fmt(slowest)}`
  )
  for (const score of scores) {
    console.log(
      `${score.image} token_set=${fmt(score.tokenSetAccuracy)} f1=${fmt(score.tokenF1)} recall=${fmt(score.tokenRecall)} precision=${fmt(score.tokenPrecision)} char=${fmt(score.charAccuracy)} seconds=${fmt(score.seconds)} tokens=${score.outTokens}/${score.refTokens}`
    )
  }
  console.log('worst_diffs=')
  for (const score of worst) {
    console.log(`--- ${score.image} token_set=${fmt(score.tokenSetAccuracy)} f1=${fmt(score.tokenF1)} char=${fmt(score.charAccuracy)}`)
    console.log(`missing: ${score.missing.join(' ')}`)
    console.log(`extra: ${score.extra.join(' ')}`)
    console.log(score.text.split(/\r?\n/).slice(0, 10).join('\n'))
  }

  if (
    avgTokenSet < minAvgTokenSetAccuracy ||
    avgF1 < minAvgTokenF1 ||
    avgChar < minAvgCharAccuracy ||
    tokenSetFailures.length > 0 ||
    f1Failures.length > 0
  ) {
    throw new Error(
      `OCR fixture quality below threshold: avg_token_set=${fmt(avgTokenSet)} token_set_failures=${tokenSetFailures.length} avg_f1=${fmt(avgF1)} f1_failures=${f1Failures.length} avg_char=${fmt(avgChar)}`
    )
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})

import { describe, expect, test } from 'bun:test'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApp } from '../src/app'
import { createTesseractOcrProcessor, OCR_MODEL, OcrProcessorError, type OcrProcessor, type OcrProcessorResult } from '../src/ocr/ocrProcessor'
import { authHeaders, testApiTokenStore } from './helpers'

function makeForm(file?: File) {
  const form = new FormData()
  if (file) form.set('file', file, file.name)
  return form
}

function makeImageFile(name = 'label.png', body = 'fake-image') {
  return new File([body], name, { type: 'image/png' })
}

function createOcrApp(processor: OcrProcessor, opts: { maxUploadBytes?: number; timeoutMs?: number } = {}) {
  return createApp({
    apiTokenStore: testApiTokenStore(),
    version: 'test-version',
    ocrProcessor: processor,
    ocrMaxUploadBytes: opts.maxUploadBytes,
    ocrTimeoutMs: opts.timeoutMs
  })
}

function successfulProcessor(result: OcrProcessorResult): OcrProcessor {
  return {
    async recognize() {
      return result
    }
  }
}

describe('OCR routes', () => {
  test('GET /api/v1/ocr requires auth and returns OCR metadata', async () => {
    const app = createOcrApp(successfulProcessor({ text: '', lines: [], processing_seconds: 0, model: OCR_MODEL }))

    const unauthorized = await app.request('/api/v1/ocr')
    expect(unauthorized.status).toBe(401)
    expect(await unauthorized.json()).toEqual({ error: 'unauthorized' })

    const res = await app.request('/api/v1/ocr', { headers: authHeaders })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      model: OCR_MODEL,
      timeout_seconds: 20,
      max_upload_bytes: 26214400,
      accepted_image_formats: ['jpg', 'jpeg', 'png', 'webp', 'tif', 'tiff', 'bmp']
    })
  })

  test('POST /api/v1/ocr returns recognized text from injected processor', async () => {
    let seenInputPath = ''
    let seenTimeoutMs = 0
    const app = createOcrApp({
      async recognize(input) {
        seenInputPath = input.inputPath
        seenTimeoutMs = input.timeoutMs
        expect(await Bun.file(input.inputPath).text()).toBe('fake-image')
        return {
          text: 'LOT 1234\nBest before 2027',
          lines: ['LOT 1234', 'Best before 2027'],
          processing_seconds: 0.123,
          model: OCR_MODEL
        }
      }
    })

    const res = await app.request('/api/v1/ocr', {
      method: 'POST',
      headers: authHeaders,
      body: makeForm(makeImageFile())
    })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      text: 'LOT 1234\nBest before 2027',
      lines: ['LOT 1234', 'Best before 2027'],
      processing_seconds: 0.123,
      model: OCR_MODEL
    })
    expect(seenInputPath.endsWith('label.png')).toBe(true)
    expect(seenTimeoutMs).toBe(20000)
  })

  test('POST /api/v1/ocr validates multipart upload before processing', async () => {
    let calls = 0
    const app = createOcrApp({
      async recognize() {
        calls += 1
        return { text: '', lines: [], processing_seconds: 0, model: OCR_MODEL }
      }
    }, { maxUploadBytes: 4 })

    const missingFile = await app.request('/api/v1/ocr', {
      method: 'POST',
      headers: authHeaders,
      body: makeForm()
    })
    expect(missingFile.status).toBe(400)
    expect(await missingFile.json()).toEqual({ error: 'file_required' })

    const tooLarge = await app.request('/api/v1/ocr', {
      method: 'POST',
      headers: authHeaders,
      body: makeForm(makeImageFile('label.png', '12345'))
    })
    expect(tooLarge.status).toBe(413)
    expect(await tooLarge.json()).toEqual({ error: 'upload_too_large', max_bytes: 4 })

    const unsupported = await app.request('/api/v1/ocr', {
      method: 'POST',
      headers: authHeaders,
      body: makeForm(makeImageFile('label.pdf', '1'))
    })
    expect(unsupported.status).toBe(415)
    expect(await unsupported.json()).toEqual({ error: 'unsupported_image_format' })
    expect(calls).toBe(0)
  })

  test('POST /api/v1/ocr maps processor errors', async () => {
    const cases = [
      { code: 'IMAGE_PREPROCESSING_FAILED' as const, status: 422, body: { error: 'image_processing_failed' } },
      { code: 'OCR_FAILED' as const, status: 502, body: { error: 'ocr_failed' } },
      { code: 'OCR_TIMED_OUT' as const, status: 504, body: { error: 'ocr_timed_out' } }
    ]

    for (const testCase of cases) {
      const app = createOcrApp({
        async recognize() {
          throw new OcrProcessorError(testCase.code, testCase.code)
        }
      })
      const res = await app.request('/api/v1/ocr', {
        method: 'POST',
        headers: authHeaders,
        body: makeForm(makeImageFile())
      })

      expect(res.status).toBe(testCase.status)
      expect(await res.json()).toEqual(testCase.body)
    }
  })
})

describe('Tesseract OCR processor', () => {
  test('uses script/Latin when Latin language data is nested under script tessdata', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'girke-ocr-processor-test-'))
    const ffmpegPath = join(dir, 'ffmpeg')
    const tesseractPath = join(dir, 'tesseract')
    const inputPath = join(dir, 'input.jpeg')

    await writeFile(inputPath, 'fake-image')
    await writeFile(
      ffmpegPath,
      `#!/bin/sh
set -eu
for out do :; done
printf 'gray' > "$out"
`
    )
    await writeFile(
      tesseractPath,
      `#!/bin/sh
set -eu
if [ "$1" = "--list-langs" ]; then
  printf 'List of available languages in "/tmp/tessdata" (2):\\neng\\nscript/Latin\\n'
  exit 0
fi
language=''
prev=''
for arg in "$@"; do
  if [ "$prev" = "-l" ]; then language="$arg"; fi
  prev="$arg"
done
if [ "$language" != "script/Latin" ]; then
  printf 'wrong language: %s\\n' "$language" >&2
  exit 9
fi
printf 'LOT 1234\\nBest before 2027\\n'
`
    )
    await chmod(ffmpegPath, 0o755)
    await chmod(tesseractPath, 0o755)

    try {
      const processor = createTesseractOcrProcessor({ ffmpegPath, tesseractPath })
      const result = await processor.recognize({ inputPath, timeoutMs: 5000 })

      expect(result).toMatchObject({
        text: 'LOT 1234\nBest before 2027',
        lines: ['LOT 1234', 'Best before 2027'],
        model: OCR_MODEL
      })
      expect(await Bun.file(`${inputPath}.gray.png`).exists()).toBe(false)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

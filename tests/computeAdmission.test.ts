import { expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApp, type AppConfig } from '../src/app'
import { OCR_MODEL, type OcrProcessorResult } from '../src/ocr/ocrProcessor'
import { InMemoryTranscriptionJobStore } from '../src/routes/transcription'
import { authHeaders, testApiTokenStore } from './helpers'

const ocr = '/api/v1/ocr'
const sync = '/api/v1/transcription/transcribe'
const jobs = '/api/v1/transcription/jobs'
const recognized: OcrProcessorResult = { text: 'invented label', lines: ['invented label'], model: OCR_MODEL, processing_seconds: 1 }

function transcript() {
  return Response.json({
    text: 'invented phrase',
    segments: [{ start: 0, end: 1, text: 'invented phrase' }],
    duration_seconds: 1, processing_seconds: 1, level: 'medium',
    language: 'auto', detected_language: 'en', model: 'fixture'
  })
}

async function post(app: ReturnType<typeof createApp>, path: string, name: string, signal?: AbortSignal) {
  const body = new FormData()
  body.set('file', new File(['invented media'], name))
  return app.request(path, { method: 'POST', headers: authHeaders, body, signal })
}

async function fixture(options: Partial<AppConfig>) {
  const uploads = await mkdtemp(join(tmpdir(), 'girke-admission-test-'))
  const store = new InMemoryTranscriptionJobStore()
  const app = createApp({
    apiTokenStore: testApiTokenStore(), version: 'test', transcriptionJobStore: store,
    transcriptionUploadDir: uploads,
    transcriptionDurationProbe: { async probe() { return { durationSeconds: 1 } } },
    transcriptionMediaProcessor: {
      async prepare(inputPath) {
        const chunk = inputPath + '.wav'
        await writeFile(chunk, 'invented chunk')
        return { normalizedAudioPath: chunk, durationSeconds: 1, chunks: [
          { chunkIndex: 0, startSeconds: 0, endSeconds: 1, path: chunk }
        ] }
      }
    },
    ...options
  })
  return { app, store, cleanup: () => rm(uploads, { recursive: true, force: true }) }
}

async function queueJob(app: ReturnType<typeof createApp>) {
  const res = await post(app, jobs, 'queued.wav')
  expect(res.status).toBe(202)
  return (await res.json()).job_id as string
}

async function cancelJob(app: ReturnType<typeof createApp>, id: string) {
  const res = await app.request(`${jobs}/${id}`, { method: 'DELETE', headers: authHeaders })
  expect(res.status).toBe(200)
  expect((await res.json()).status).toBe('cancelled')
}

function waitForOverflow(requests: Promise<Response>[]) {
  const overflow = Promise.withResolvers<Response[]>()
  const busy: Response[] = []
  for (const request of requests) {
    void request.then(response => {
      if (response.status === 503) {
        busy.push(response)
        if (busy.length === 2) overflow.resolve(busy)
      }
    }, overflow.reject)
  }
  return overflow.promise
}

test('direct OCR, queued Whisper, and sync Whisper share capacity and run in admission order', async () => {
  const ocrStarted = Promise.withResolvers<void>()
  const releaseOcr = Promise.withResolvers<void>()
  const calls: string[] = []
  const { app, store, cleanup } = await fixture({
    ocrProcessor: { async recognize() {
      calls.push('ocr')
      ocrStarted.resolve()
      await releaseOcr.promise
      return recognized
    } },
    whisperFetch: async (_url, init) => {
      const file = (init!.body as FormData).get('file') as File
      calls.push(await file.text() === 'invented chunk' ? 'job' : 'sync')
      return transcript()
    }
  })

  try {
    const engine = post(app, ocr, 'hold.png')
    await ocrStarted.promise
    const id = await queueJob(app)
    const direct = ['a.wav', 'b.wav', 'c.wav', 'd.wav'].map(name => post(app, sync, name))
    const busy = await waitForOverflow(direct)
    expect(await busy[0]!.json()).toEqual({ error: 'compute_busy' })
    expect((await store.findByPublicId(id))?.status).toBe('queued')
    expect(calls).toEqual(['ocr'])

    releaseOcr.resolve()
    expect((await engine).status).toBe(200)
    expect((await Promise.all(direct)).map(res => res.status).sort()).toEqual([200, 200, 503, 503])
    expect(calls).toEqual(['ocr', 'job', 'sync', 'sync'])
    expect((await store.findByPublicId(id))?.status).toBe('completed')
  } finally {
    releaseOcr.resolve()
    await cleanup()
  }
})

test('cancelling a queued Whisper job frees its wait without starting the engine', async () => {
  const started = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const calls: string[] = []
  const { app, store, cleanup } = await fixture({
    ocrProcessor: { async recognize() {
      started.resolve()
      await release.promise
      return recognized
    } },
    whisperFetch: async (_url, init) => {
      calls.push(((init!.body as FormData).get('file') as File).name)
      return transcript()
    }
  })
  try {
    const first = post(app, ocr, 'hold.png')
    await started.promise
    const id = await queueJob(app)
    expect((await store.findByPublicId(id))?.status).toBe('queued')
    await cancelJob(app, id)
    const next = post(app, sync, 'after.wav')
    release.resolve()
    expect((await first).status).toBe(200)
    expect((await next).status).toBe(200)
    expect(calls).toEqual(['after.wav'])
    const result = await app.request(`${jobs}/${id}/result`, { headers: authHeaders })
    expect(result.status).toBe(410)
    expect(await result.json()).toEqual({ error: 'job_cancelled' })
  } finally {
    release.resolve()
    await cleanup()
  }
})

test('client abort does not release an active Whisper slot while the engine is running', async () => {
  const started = Promise.withResolvers<void>()
  const stopped = Promise.withResolvers<void>()
  const controller = new AbortController()
  let ocrCalls = 0
  const { app, cleanup } = await fixture({
    ocrProcessor: { async recognize() {
      ocrCalls += 1
      return recognized
    } },
    whisperFetch: async (_url, init) => {
      expect(init?.signal).toBeUndefined()
      started.resolve()
      await stopped.promise
      return transcript()
    }
  })
  try {
    const active = post(app, sync, 'hold.wav', controller.signal)
    await started.promise
    controller.abort()
    const waiting = ['1.png', '2.png', '3.png', '4.png'].map(name => post(app, ocr, name))
    await waitForOverflow(waiting)
    expect(ocrCalls).toBe(0)
    stopped.resolve()
    await active
    expect((await Promise.all(waiting)).map(res => res.status).sort()).toEqual([200, 200, 503, 503])
    expect(ocrCalls).toBe(2)
  } finally {
    stopped.resolve()
    await cleanup()
  }
})

test('cancelling active async Whisper holds admission and prevents retry or result publication', async () => {
  const started = Promise.withResolvers<void>()
  const stopped = Promise.withResolvers<void>()
  let whisperCalls = 0
  let ocrCalls = 0
  const { app, store, cleanup } = await fixture({
    ocrProcessor: { async recognize() { ocrCalls += 1; return recognized } },
    whisperFetch: async () => {
      whisperCalls += 1
      started.resolve()
      await stopped.promise
      return new Response(null, { status: 500 })
    }
  })
  try {
    const id = await queueJob(app)
    await started.promise
    await cancelJob(app, id)
    const waiting = ['1.png', '2.png', '3.png', '4.png'].map(name => post(app, ocr, name))
    await waitForOverflow(waiting)
    expect(ocrCalls).toBe(0)
    stopped.resolve()
    expect((await Promise.all(waiting)).map(res => res.status).sort()).toEqual([200, 200, 503, 503])
    expect(whisperCalls).toBe(1)
    expect(await store.listChunks(id)).toEqual([])
    expect((await store.findByPublicId(id))?.status).toBe('cancelled')
  } finally {
    stopped.resolve()
    await cleanup()
  }
})

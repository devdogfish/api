import { createHmac } from 'node:crypto'
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import { createApp } from '../src/app'
import { InMemoryTranscriptionJobStore, InProcessTranscriptionWorker, type TranscriptionFetch } from '../src/routes/transcription'
import { TranscriptionMediaProcessorError, type TranscriptionMediaProcessor } from '../src/transcription/mediaProcessor'
import { authHeaders, testApiTokenStore } from './helpers'

function makeForm(fields: Record<string, string> = {}) {
  const form = new FormData()
  form.set('file', new File(['fake-audio'], 'clip.wav', { type: 'audio/wav' }))
  for (const [key, value] of Object.entries(fields)) {
    form.set(key, value)
  }
  return form
}

async function makeUploadDir() {
  return mkdtemp(join(tmpdir(), 'girke-transcription-test-'))
}

function singleChunkMediaProcessor(uploadDir: string, durationSeconds: number): TranscriptionMediaProcessor {
  return {
    async prepare() {
      const normalizedAudioPath = join(uploadDir, 'normalized.wav')
      const chunkPath = join(uploadDir, 'chunk-0.wav')
      await writeFile(normalizedAudioPath, 'normalized')
      await writeFile(chunkPath, 'chunk')
      return {
        normalizedAudioPath,
        durationSeconds,
        chunks: [{ chunkIndex: 0, startSeconds: 0, endSeconds: durationSeconds, path: chunkPath }]
      }
    }
  }
}

function chunkedMediaProcessor(uploadDir: string, durationSeconds: number, chunks: Array<{ startSeconds: number; endSeconds: number }>): TranscriptionMediaProcessor {
  return {
    async prepare() {
      const normalizedAudioPath = join(uploadDir, 'normalized.wav')
      await writeFile(normalizedAudioPath, 'normalized')
      const preparedChunks = []
      for (const [index, chunk] of chunks.entries()) {
        const chunkPath = join(uploadDir, `chunk-${index}.wav`)
        await writeFile(chunkPath, `chunk-${index}`)
        preparedChunks.push({
          chunkIndex: index,
          startSeconds: chunk.startSeconds,
          endSeconds: chunk.endSeconds,
          path: chunkPath
        })
      }
      return {
        normalizedAudioPath,
        durationSeconds,
        chunks: preparedChunks
      }
    }
  }
}

async function waitFor<T>(read: () => Promise<T>, predicate: (value: T) => boolean) {
  const deadline = Date.now() + 1000
  let latest = await read()
  while (!predicate(latest) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10))
    latest = await read()
  }
  return latest
}

describe('transcription capability', () => {
  test('returns supported levels and languages', async () => {
    const app = createApp({ apiTokenStore: testApiTokenStore(), version: 'test-version' })
    const res = await app.request('/api/v1/transcription', {
      headers: authHeaders
    })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      levels: ['low', 'medium', 'high'],
      languages: [
        { code: 'en', name: 'English' },
        { code: 'de', name: 'German' }
      ],
      default_level: 'medium',
      language_optional: true,
      accepted_media: {
        audio: ['wav', 'mp3', 'm4a', 'aac', 'ogg', 'opus', 'flac', 'webm'],
        video: ['mp4', 'mov', 'mkv', 'webm', 'avi']
      }
    })
  })

  test('requires an uploaded file', async () => {
    const app = createApp({ apiTokenStore: testApiTokenStore(), version: 'test-version' })
    const res = await app.request('/api/v1/transcription/transcribe', {
      method: 'POST',
      headers: authHeaders,
      body: new FormData()
    })

    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'file_required' })
  })

  test('forwards default medium level to the whisper sidecar', async () => {
    const calls: Array<{ url: string; level: FormDataEntryValue | null; language: FormDataEntryValue | null; file: FormDataEntryValue | null }> = []
    const whisperFetch: TranscriptionFetch = async (url, init) => {
      const body = init?.body as FormData
      calls.push({
        url: String(url),
        level: body.get('level'),
        language: body.get('language'),
        file: body.get('file')
      })
      return Response.json({
        text: 'hello',
        segments: [{ start: 0, end: 0.5, text: 'hello' }],
        duration_seconds: 0.5,
        processing_seconds: 0.2,
        level: 'medium',
        language: 'auto',
        detected_language: 'en',
        model: 'distil-small.en'
      })
    }
    const app = createApp({ apiTokenStore: testApiTokenStore(), version: 'test-version', whisperUrl: 'http://whisper.test', whisperFetch })

    const res = await app.request('/api/v1/transcription/transcribe', {
      method: 'POST',
      headers: authHeaders,
      body: makeForm()
    })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      text: 'hello',
      segments: [{ start: 0, end: 0.5, text: 'hello' }],
      duration_seconds: 0.5,
      processing_seconds: 0.2,
      level: 'medium',
      language: 'auto',
      detected_language: 'en',
      model: 'distil-small.en'
    })
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe('http://whisper.test/transcribe')
    expect(calls[0].level).toBe('medium')
    expect(calls[0].language).toBeNull()
    expect(calls[0].file).toBeInstanceOf(File)
  })

  test('normalizes English and German aliases before forwarding', async () => {
    const forwarded: Array<{ level: FormDataEntryValue | null; language: FormDataEntryValue | null }> = []
    const whisperFetch: TranscriptionFetch = async (_url, init) => {
      const body = init?.body as FormData
      forwarded.push({ level: body.get('level'), language: body.get('language') })
      return Response.json({
        text: 'ok',
        segments: [{ start: 0, end: 0.1, text: 'ok' }],
        duration_seconds: 0.1,
        processing_seconds: 0.05,
        level: body.get('level'),
        language: body.get('language') ?? 'auto',
        detected_language: body.get('language') ?? 'en',
        model: 'mock'
      })
    }
    const app = createApp({ apiTokenStore: testApiTokenStore(), version: 'test-version', whisperFetch })

    const english = await app.request('/api/v1/transcription/transcribe', {
      method: 'POST',
      headers: authHeaders,
      body: makeForm({ level: 'low', language: 'english' })
    })
    const german = await app.request('/api/v1/transcription/transcribe', {
      method: 'POST',
      headers: authHeaders,
      body: makeForm({ level: 'high', language: 'Deutsch' })
    })

    expect(english.status).toBe(200)
    expect(german.status).toBe(200)
    expect(forwarded).toEqual([
      { level: 'low', language: 'en' },
      { level: 'high', language: 'de' }
    ])
  })

  test('accepts auto language without forcing a sidecar language', async () => {
    const forwarded: Array<{ language: FormDataEntryValue | null }> = []
    const whisperFetch: TranscriptionFetch = async (_url, init) => {
      const body = init?.body as FormData
      forwarded.push({ language: body.get('language') })
      return Response.json({
        text: 'ok',
        segments: [{ start: 0, end: 0.1, text: 'ok' }],
        duration_seconds: 0.1,
        processing_seconds: 0.05,
        level: 'medium',
        language: 'auto',
        detected_language: 'en',
        model: 'mock'
      })
    }
    const app = createApp({ apiTokenStore: testApiTokenStore(), version: 'test-version', whisperFetch })

    const res = await app.request('/api/v1/transcription/transcribe', {
      method: 'POST',
      headers: authHeaders,
      body: makeForm({ language: 'auto' })
    })

    expect(res.status).toBe(200)
    expect(forwarded).toEqual([{ language: null }])
    expect((await res.json()).language).toBe('auto')
  })

  test('maps unsupported media format failures from the sidecar', async () => {
    const whisperFetch: TranscriptionFetch = async () => Response.json({ detail: 'unsupported_media_format' }, { status: 415 })
    const app = createApp({ apiTokenStore: testApiTokenStore(), version: 'test-version', whisperFetch })

    const res = await app.request('/api/v1/transcription/transcribe', {
      method: 'POST',
      headers: authHeaders,
      body: makeForm()
    })

    expect(res.status).toBe(415)
    expect(await res.json()).toEqual({ error: 'unsupported_media_format' })
  })

  test('rejects over-limit sync media before calling the whisper sidecar', async () => {
    let whisperCalls = 0
    const whisperFetch: TranscriptionFetch = async () => {
      whisperCalls += 1
      return Response.json({ detail: 'should not be called' }, { status: 500 })
    }
    const app = createApp({
      apiTokenStore: testApiTokenStore(),
      version: 'test-version',
      whisperFetch,
      transcriptionSyncMaxDurationSeconds: 300,
      transcriptionDurationProbe: {
        async probe() {
          return { durationSeconds: 301 }
        }
      }
    })

    const res = await app.request('/api/v1/transcription/transcribe', {
      method: 'POST',
      headers: authHeaders,
      body: makeForm()
    })

    expect(res.status).toBe(422)
    expect(await res.json()).toEqual({
      error: 'sync_media_too_long',
      max_duration_seconds: 300,
      jobs_url: '/api/v1/transcription/jobs'
    })
    expect(whisperCalls).toBe(0)
  })

  test('rejects invalid level and language', async () => {
    const app = createApp({ apiTokenStore: testApiTokenStore(), version: 'test-version' })

    const invalidLevel = await app.request('/api/v1/transcription/transcribe', {
      method: 'POST',
      headers: authHeaders,
      body: makeForm({ level: 'ultra' })
    })
    expect(invalidLevel.status).toBe(400)
    expect(await invalidLevel.json()).toEqual({ error: 'invalid_level' })

    const invalidLanguage = await app.request('/api/v1/transcription/transcribe', {
      method: 'POST',
      headers: authHeaders,
      body: makeForm({ language: 'french' })
    })
    expect(invalidLanguage.status).toBe(400)
    expect(await invalidLanguage.json()).toEqual({ error: 'invalid_language' })
  })

  test('creates async jobs and exposes completed results', async () => {
    const uploadDir = await makeUploadDir()
    const calls: Array<{ level: FormDataEntryValue | null; language: FormDataEntryValue | null; file: FormDataEntryValue | null }> = []
    const whisperFetch: TranscriptionFetch = async (_url, init) => {
      const body = init?.body as FormData
      calls.push({ level: body.get('level'), language: body.get('language'), file: body.get('file') })
      return Response.json({
        text: 'async transcript',
        segments: [{ start: 0, end: 1.25, text: 'async transcript' }],
        duration_seconds: 1.25,
        processing_seconds: 0.4,
        level: 'high',
        language: 'en',
        detected_language: 'en',
        model: 'large-v3-turbo'
      })
    }
    const app = createApp({
      apiTokenStore: testApiTokenStore(),
      version: 'test-version',
      whisperFetch,
      transcriptionUploadDir: uploadDir,
      transcriptionMediaProcessor: singleChunkMediaProcessor(uploadDir, 1.25)
    })

    try {
      const created = await app.request('/api/v1/transcription/jobs', {
        method: 'POST',
        headers: authHeaders,
        body: makeForm({ level: 'high', language: 'en' })
      })
      expect(created.status).toBe(202)
      const createdBody = await created.json()
      expect(createdBody.status).toBe('queued')
      expect(String(createdBody.job_id).startsWith('tr_')).toBe(true)
      expect(createdBody.result_url).toBe(`/api/v1/transcription/jobs/${createdBody.job_id}/result`)

      const completed = await waitFor(
        async () => {
          const res = await app.request(`/api/v1/transcription/jobs/${createdBody.job_id}`, { headers: authHeaders })
          return res.json()
        },
        (body: any) => body.status === 'completed'
      )
      expect(completed.status).toBe('completed')
      expect(completed.progress).toBe(1)
      expect(completed.duration_seconds).toBe(1.25)
      expect(completed.result_url).toBe(`/api/v1/transcription/jobs/${createdBody.job_id}/result`)

      const result = await app.request(`/api/v1/transcription/jobs/${createdBody.job_id}/result`, { headers: authHeaders })
      expect(result.status).toBe(200)
      expect(await result.json()).toEqual({
        job_id: createdBody.job_id,
        status: 'completed',
        text: 'async transcript',
        segments: [{ start: 0, end: 1.25, text: 'async transcript', chunk_index: 0 }],
        duration_seconds: 1.25,
        processing_seconds: 0.4,
        level: 'high',
        language: 'en',
        detected_language: 'en',
        model: 'large-v3-turbo'
      })
      expect(calls).toHaveLength(1)
      expect(calls[0].level).toBe('high')
      expect(calls[0].language).toBe('en')
      expect(calls[0].file).toBeInstanceOf(File)
      expect(await readdir(uploadDir)).toEqual([])
    } finally {
      await rm(uploadDir, { recursive: true, force: true })
    }
  })

  test('rejects async job creation when media duration exceeds the configured limit', async () => {
    const uploadDir = await makeUploadDir()
    const app = createApp({
      apiTokenStore: testApiTokenStore(),
      version: 'test-version',
      transcriptionUploadDir: uploadDir,
      transcriptionAsyncMaxDurationSeconds: 5,
      transcriptionDurationProbe: {
        async probe() {
          return { durationSeconds: 6 }
        }
      }
    })

    try {
      const res = await app.request('/api/v1/transcription/jobs', {
        method: 'POST',
        headers: authHeaders,
        body: makeForm()
      })
      const list = await app.request('/api/v1/transcription/jobs', { headers: authHeaders })

      expect(res.status).toBe(422)
      expect(await res.json()).toEqual({ error: 'media_duration_exceeded', max_duration_seconds: 5 })
      expect(await list.json()).toEqual({ jobs: [] })
      expect(await readdir(uploadDir)).toEqual([])
    } finally {
      await rm(uploadDir, { recursive: true, force: true })
    }
  })

  test('posts a signed webhook payload when an async job completes', async () => {
    const uploadDir = await makeUploadDir()
    const webhookCalls: Array<{ url: string; body: any; signature: string | null }> = []
    const webhookSecret = 'test-webhook-secret'
    const app = createApp({
      apiTokenStore: testApiTokenStore(),
      version: 'test-version',
      whisperFetch: async () =>
        Response.json({
          text: 'webhook transcript',
          segments: [{ start: 0, end: 1, text: 'webhook transcript' }],
          duration_seconds: 1,
          processing_seconds: 0.2,
          level: 'medium',
          language: 'auto',
          detected_language: 'en',
          model: 'mock'
        }),
      transcriptionUploadDir: uploadDir,
      transcriptionMediaProcessor: singleChunkMediaProcessor(uploadDir, 1),
      transcriptionWebhookSecret: webhookSecret,
      transcriptionWebhookFetch: async (url, init) => {
        const body = String(init?.body)
        webhookCalls.push({
          url: String(url),
          body: JSON.parse(body),
          signature: new Headers(init?.headers).get('x-girke-signature')
        })
        return Response.json({ ok: true })
      }
    })

    try {
      const form = makeForm({ webhook_url: 'https://hooks.test/transcription' })
      const created = await app.request('/api/v1/transcription/jobs', {
        method: 'POST',
        headers: authHeaders,
        body: form
      })
      const createdBody = await created.json()

      await waitFor(
        async () => {
          const res = await app.request(`/api/v1/transcription/jobs/${createdBody.job_id}`, { headers: authHeaders })
          return res.json()
        },
        (body: any) => body.status === 'completed'
      )
      const delivered = await waitFor(
        async () => webhookCalls,
        (calls) => calls.length === 1
      )

      const expectedBody = JSON.stringify(delivered[0].body)
      expect(delivered[0].url).toBe('https://hooks.test/transcription')
      expect(delivered[0].body).toMatchObject({
        event: 'transcription.job.completed',
        job: {
          job_id: createdBody.job_id,
          status: 'completed',
          progress: 1,
          result_url: `/api/v1/transcription/jobs/${createdBody.job_id}/result`
        }
      })
      expect(delivered[0].signature).toBe(`sha256=${createHmac('sha256', webhookSecret).update(expectedBody).digest('hex')}`)
    } finally {
      await rm(uploadDir, { recursive: true, force: true })
    }
  })

  test('retries webhook failures without changing completed job status', async () => {
    const uploadDir = await makeUploadDir()
    let webhookAttempts = 0
    const app = createApp({
      apiTokenStore: testApiTokenStore(),
      version: 'test-version',
      whisperFetch: async () =>
        Response.json({
          text: 'still completed',
          segments: [{ start: 0, end: 1, text: 'still completed' }],
          duration_seconds: 1,
          processing_seconds: 0.2,
          level: 'medium',
          language: 'auto',
          detected_language: 'en',
          model: 'mock'
        }),
      transcriptionUploadDir: uploadDir,
      transcriptionMediaProcessor: singleChunkMediaProcessor(uploadDir, 1),
      transcriptionWebhookRetryBaseDelayMs: 0,
      transcriptionWebhookFetch: async () => {
        webhookAttempts += 1
        return Response.json({ ok: false }, { status: 500 })
      }
    })

    try {
      const created = await app.request('/api/v1/transcription/jobs', {
        method: 'POST',
        headers: authHeaders,
        body: makeForm({ webhook_url: 'https://hooks.test/transcription' })
      })
      const createdBody = await created.json()
      const completed = await waitFor(
        async () => {
          const res = await app.request(`/api/v1/transcription/jobs/${createdBody.job_id}`, { headers: authHeaders })
          return res.json()
        },
        (body: any) => body.status === 'completed'
      )
      await waitFor(async () => webhookAttempts, (attempts) => attempts === 5)

      const result = await app.request(`/api/v1/transcription/jobs/${createdBody.job_id}/result`, { headers: authHeaders })
      expect(completed.status).toBe('completed')
      expect(webhookAttempts).toBe(5)
      expect(result.status).toBe(200)
    } finally {
      await rm(uploadDir, { recursive: true, force: true })
    }
  })

  test('async jobs split media into chunks and stitch absolute timestamp results', async () => {
    const uploadDir = await makeUploadDir()
    const mediaProcessor: TranscriptionMediaProcessor = {
      async prepare(inputPath) {
        const normalizedAudioPath = join(uploadDir, 'normalized.wav')
        const firstChunkPath = join(uploadDir, 'chunk-0.wav')
        const secondChunkPath = join(uploadDir, 'chunk-1.wav')
        await writeFile(normalizedAudioPath, 'normalized')
        await writeFile(firstChunkPath, 'first')
        await writeFile(secondChunkPath, 'second')

        return {
          normalizedAudioPath,
          durationSeconds: 125,
          chunks: [
            { chunkIndex: 0, startSeconds: 0, endSeconds: 60, path: firstChunkPath },
            { chunkIndex: 1, startSeconds: 60, endSeconds: 125, path: secondChunkPath }
          ]
        }
      }
    }
    const calls: Array<{ file: File }> = []
    const whisperFetch: TranscriptionFetch = async (_url, init) => {
      const file = (init?.body as FormData).get('file') as File
      calls.push({ file })
      const chunkIndex = calls.length - 1
      return Response.json({
        text: chunkIndex === 0 ? 'first chunk' : 'second chunk',
        segments: [{ start: 0, end: chunkIndex === 0 ? 2 : 3, text: chunkIndex === 0 ? 'first chunk' : 'second chunk' }],
        duration_seconds: chunkIndex === 0 ? 60 : 65,
        processing_seconds: chunkIndex === 0 ? 1.2 : 2.3,
        level: 'medium',
        language: 'auto',
        detected_language: 'en',
        model: 'mock'
      })
    }
    const app = createApp({
      apiTokenStore: testApiTokenStore(),
      version: 'test-version',
      whisperFetch,
      transcriptionUploadDir: uploadDir,
      transcriptionMediaProcessor: mediaProcessor
    })

    try {
      const created = await app.request('/api/v1/transcription/jobs', {
        method: 'POST',
        headers: authHeaders,
        body: makeForm()
      })
      const createdBody = await created.json()
      const completed = await waitFor(
        async () => {
          const res = await app.request(`/api/v1/transcription/jobs/${createdBody.job_id}`, { headers: authHeaders })
          return res.json()
        },
        (body: any) => body.status === 'completed'
      )
      const result = await app.request(`/api/v1/transcription/jobs/${createdBody.job_id}/result`, { headers: authHeaders })

      expect(completed.status).toBe('completed')
      expect(completed.current_chunk).toBe(2)
      expect(completed.total_chunks).toBe(2)
      expect(completed.duration_seconds).toBe(125)
      expect(completed.processing_seconds).toBe(3.5)
      expect(result.status).toBe(200)
      expect(await result.json()).toEqual({
        job_id: createdBody.job_id,
        status: 'completed',
        text: 'first chunk second chunk',
        segments: [
          { start: 0, end: 2, text: 'first chunk', chunk_index: 0 },
          { start: 60, end: 63, text: 'second chunk', chunk_index: 1 }
        ],
        duration_seconds: 125,
        processing_seconds: 3.5,
        level: 'medium',
        language: 'auto',
        detected_language: 'en',
        model: 'mock'
      })
      expect(calls.map((call) => call.file.name)).toEqual(['chunk-0.wav', 'chunk-1.wav'])
    } finally {
      await rm(uploadDir, { recursive: true, force: true })
    }
  })

  test('async worker resumes processing jobs from persisted completed chunks', async () => {
    const uploadDir = await makeUploadDir()
    const mediaProcessor: TranscriptionMediaProcessor = {
      async prepare() {
        const normalizedAudioPath = join(uploadDir, 'normalized.wav')
        const firstChunkPath = join(uploadDir, 'chunk-0.wav')
        const secondChunkPath = join(uploadDir, 'chunk-1.wav')
        await writeFile(normalizedAudioPath, 'normalized')
        await writeFile(firstChunkPath, 'first')
        await writeFile(secondChunkPath, 'second')

        return {
          normalizedAudioPath,
          durationSeconds: 120,
          chunks: [
            { chunkIndex: 0, startSeconds: 0, endSeconds: 60, path: firstChunkPath },
            { chunkIndex: 1, startSeconds: 60, endSeconds: 120, path: secondChunkPath }
          ]
        }
      }
    }
    const store = new InMemoryTranscriptionJobStore()
    const calls: File[] = []
    const whisperFetch: TranscriptionFetch = async (_url, init) => {
      const file = (init?.body as FormData).get('file') as File
      calls.push(file)
      return Response.json({
        text: 'resumed chunk',
        segments: [{ start: 0, end: 4, text: 'resumed chunk' }],
        duration_seconds: 60,
        processing_seconds: 2,
        level: 'medium',
        language: 'auto',
        detected_language: 'en',
        model: 'mock'
      })
    }
    const worker = new InProcessTranscriptionWorker({
      store,
      whisperUrl: 'http://whisper.test',
      whisperFetch,
      mediaProcessor,
      keepMedia: false,
      asyncMaxDurationSeconds: 300
    })
    const app = createApp({
      apiTokenStore: testApiTokenStore(),
      version: 'test-version',
      transcriptionJobStore: store,
      transcriptionWorker: null,
      transcriptionUploadDir: uploadDir,
      transcriptionMediaProcessor: mediaProcessor
    })

    try {
      const created = await app.request('/api/v1/transcription/jobs', {
        method: 'POST',
        headers: authHeaders,
        body: makeForm()
      })
      const createdBody = await created.json()
      await store.insertChunk({
        jobPublicId: createdBody.job_id,
        chunkIndex: 0,
        startSeconds: 0,
        endSeconds: 60,
        status: 'completed',
        text: 'persisted chunk',
        segmentsJson: [{ start: 0, end: 3, text: 'persisted chunk', chunk_index: 0 }],
        processingSeconds: 1,
        errorMessage: null
      })
      await store.update(createdBody.job_id, {
        status: 'processing',
        progress: 0.5,
        currentChunk: 1,
        totalChunks: 2,
        durationSeconds: 120,
        startedAt: new Date()
      })

      worker.enqueue(createdBody.job_id)

      const completed = await waitFor(
        async () => {
          const res = await app.request(`/api/v1/transcription/jobs/${createdBody.job_id}`, { headers: authHeaders })
          return res.json()
        },
        (body: any) => body.status === 'completed'
      )
      const result = await app.request(`/api/v1/transcription/jobs/${createdBody.job_id}/result`, { headers: authHeaders })

      expect(completed.status).toBe('completed')
      expect(calls.map((file) => file.name)).toEqual(['chunk-1.wav'])
      expect((await result.json()).segments).toEqual([
        { start: 0, end: 3, text: 'persisted chunk', chunk_index: 0 },
        { start: 60, end: 64, text: 'resumed chunk', chunk_index: 1 }
      ])
    } finally {
      await rm(uploadDir, { recursive: true, force: true })
    }
  })

  test('async job status reports persisted chunk progress while processing', async () => {
    const uploadDir = await makeUploadDir()
    const mediaProcessor = chunkedMediaProcessor(uploadDir, 120, [
      { startSeconds: 0, endSeconds: 60 },
      { startSeconds: 60, endSeconds: 120 }
    ])
    let finishSecondChunk!: () => void
    let resolveSecondChunkStarted!: () => void
    const secondChunkStarted = new Promise<void>((resolve) => {
      resolveSecondChunkStarted = resolve
    })
    const whisperFetch: TranscriptionFetch = async (_url, init) => {
      const file = (init?.body as FormData).get('file') as File
      if (file.name === 'chunk-0.wav') {
        return Response.json({
          text: 'first chunk',
          segments: [{ start: 0, end: 2, text: 'first chunk' }],
          duration_seconds: 60,
          processing_seconds: 1,
          level: 'medium',
          language: 'auto',
          detected_language: 'en',
          model: 'mock'
        })
      }

      resolveSecondChunkStarted()
      await new Promise<void>((resolve) => {
        finishSecondChunk = resolve
      })
      return Response.json({
        text: 'second chunk',
        segments: [{ start: 0, end: 2, text: 'second chunk' }],
        duration_seconds: 60,
        processing_seconds: 1,
        level: 'medium',
        language: 'auto',
        detected_language: 'en',
        model: 'mock'
      })
    }
    const app = createApp({
      apiTokenStore: testApiTokenStore(),
      version: 'test-version',
      whisperFetch,
      transcriptionUploadDir: uploadDir,
      transcriptionMediaProcessor: mediaProcessor
    })

    try {
      const created = await app.request('/api/v1/transcription/jobs', {
        method: 'POST',
        headers: authHeaders,
        body: makeForm()
      })
      const createdBody = await created.json()
      await secondChunkStarted

      const status = await app.request(`/api/v1/transcription/jobs/${createdBody.job_id}`, { headers: authHeaders })
      expect(await status.json()).toMatchObject({
        status: 'processing',
        progress: 0.5,
        current_chunk: 1,
        total_chunks: 2,
        duration_seconds: 120
      })

      finishSecondChunk()
      const completed = await waitFor(
        async () => {
          const res = await app.request(`/api/v1/transcription/jobs/${createdBody.job_id}`, { headers: authHeaders })
          return res.json()
        },
        (body: any) => body.status === 'completed'
      )
      expect(completed.status).toBe('completed')
    } finally {
      finishSecondChunk?.()
      await rm(uploadDir, { recursive: true, force: true })
    }
  })

  test('async jobs fail with retry-exhausted after a chunk fails three times', async () => {
    const uploadDir = await makeUploadDir()
    const mediaProcessor = chunkedMediaProcessor(uploadDir, 120, [
      { startSeconds: 0, endSeconds: 60 },
      { startSeconds: 60, endSeconds: 120 }
    ])
    const calls: string[] = []
    const whisperFetch: TranscriptionFetch = async (_url, init) => {
      const file = (init?.body as FormData).get('file') as File
      calls.push(file.name)
      if (file.name === 'chunk-0.wav') {
        return Response.json({
          text: 'first chunk',
          segments: [{ start: 0, end: 2, text: 'first chunk' }],
          duration_seconds: 60,
          processing_seconds: 1,
          level: 'medium',
          language: 'auto',
          detected_language: 'en',
          model: 'mock'
        })
      }

      return Response.json({ detail: 'temporary failure' }, { status: 503 })
    }
    const app = createApp({
      apiTokenStore: testApiTokenStore(),
      version: 'test-version',
      whisperFetch,
      transcriptionUploadDir: uploadDir,
      transcriptionMediaProcessor: mediaProcessor
    })

    try {
      const created = await app.request('/api/v1/transcription/jobs', {
        method: 'POST',
        headers: authHeaders,
        body: makeForm()
      })
      const createdBody = await created.json()
      const failed = await waitFor(
        async () => {
          const res = await app.request(`/api/v1/transcription/jobs/${createdBody.job_id}`, { headers: authHeaders })
          return res.json()
        },
        (body: any) => body.status === 'failed'
      )
      const result = await app.request(`/api/v1/transcription/jobs/${createdBody.job_id}/result`, { headers: authHeaders })

      expect(failed).toMatchObject({
        status: 'failed',
        progress: 0.5,
        current_chunk: 1,
        total_chunks: 2,
        error: {
          code: 'CHUNK_RETRY_EXHAUSTED'
        }
      })
      expect(result.status).toBe(422)
      expect(await result.json()).toMatchObject({
        error: {
          code: 'CHUNK_RETRY_EXHAUSTED'
        }
      })
      expect(calls).toEqual(['chunk-0.wav', 'chunk-1.wav', 'chunk-1.wav', 'chunk-1.wav'])
      expect(await readdir(uploadDir)).toEqual([])
    } finally {
      await rm(uploadDir, { recursive: true, force: true })
    }
  })

  test('async jobs expose media normalization failures from the processor', async () => {
    const uploadDir = await makeUploadDir()
    const mediaProcessor: TranscriptionMediaProcessor = {
      async prepare() {
        throw new TranscriptionMediaProcessorError('MEDIA_NORMALIZATION_FAILED', 'ffmpeg could not decode media')
      }
    }
    const app = createApp({
      apiTokenStore: testApiTokenStore(),
      version: 'test-version',
      transcriptionUploadDir: uploadDir,
      transcriptionMediaProcessor: mediaProcessor
    })

    try {
      const created = await app.request('/api/v1/transcription/jobs', {
        method: 'POST',
        headers: authHeaders,
        body: makeForm()
      })
      const createdBody = await created.json()
      const failed = await waitFor(
        async () => {
          const res = await app.request(`/api/v1/transcription/jobs/${createdBody.job_id}`, { headers: authHeaders })
          return res.json()
        },
        (body: any) => body.status === 'failed'
      )
      const result = await app.request(`/api/v1/transcription/jobs/${createdBody.job_id}/result`, { headers: authHeaders })

      expect(failed.error).toEqual({
        code: 'MEDIA_NORMALIZATION_FAILED',
        message: 'ffmpeg could not decode media'
      })
      expect(result.status).toBe(422)
      expect(await result.json()).toEqual({
        error: {
          code: 'MEDIA_NORMALIZATION_FAILED',
          message: 'ffmpeg could not decode media'
        }
      })
    } finally {
      await rm(uploadDir, { recursive: true, force: true })
    }
  })

  test('posts a webhook payload when an async job fails', async () => {
    const uploadDir = await makeUploadDir()
    const webhookBodies: any[] = []
    const mediaProcessor: TranscriptionMediaProcessor = {
      async prepare() {
        throw new TranscriptionMediaProcessorError('MEDIA_NORMALIZATION_FAILED', 'ffmpeg could not decode media')
      }
    }
    const app = createApp({
      apiTokenStore: testApiTokenStore(),
      version: 'test-version',
      transcriptionUploadDir: uploadDir,
      transcriptionMediaProcessor: mediaProcessor,
      transcriptionWebhookFetch: async (_url, init) => {
        webhookBodies.push(JSON.parse(String(init?.body)))
        return Response.json({ ok: true })
      }
    })

    try {
      const created = await app.request('/api/v1/transcription/jobs', {
        method: 'POST',
        headers: authHeaders,
        body: makeForm({ webhook_url: 'https://hooks.test/transcription' })
      })
      const createdBody = await created.json()

      await waitFor(
        async () => {
          const res = await app.request(`/api/v1/transcription/jobs/${createdBody.job_id}`, { headers: authHeaders })
          return res.json()
        },
        (body: any) => body.status === 'failed'
      )
      const delivered = await waitFor(async () => webhookBodies, (bodies) => bodies.length === 1)

      expect(delivered[0]).toMatchObject({
        event: 'transcription.job.failed',
        job: {
          job_id: createdBody.job_id,
          status: 'failed',
          error: {
            code: 'MEDIA_NORMALIZATION_FAILED',
            message: 'ffmpeg could not decode media'
          }
        }
      })
    } finally {
      await rm(uploadDir, { recursive: true, force: true })
    }
  })

  test('hides jobs from other API tokens', async () => {
    const uploadDir = await makeUploadDir()
    const tokenStore = {
      async findActiveByToken(token: string) {
        if (token === 'girke_a') return { id: 1, name: 'a' }
        if (token === 'girke_b') return { id: 2, name: 'b' }
        return null
      }
    }
    const app = createApp({ apiTokenStore: tokenStore, version: 'test-version', transcriptionUploadDir: uploadDir, transcriptionWorker: null })

    try {
      const created = await app.request('/api/v1/transcription/jobs', {
        method: 'POST',
        headers: { Authorization: 'Bearer girke_a' },
        body: makeForm()
      })
      const createdBody = await created.json()

      const owner = await app.request(`/api/v1/transcription/jobs/${createdBody.job_id}`, {
        headers: { Authorization: 'Bearer girke_a' }
      })
      const other = await app.request(`/api/v1/transcription/jobs/${createdBody.job_id}`, {
        headers: { Authorization: 'Bearer girke_b' }
      })

      expect(owner.status).toBe(200)
      expect(other.status).toBe(404)
      expect(await other.json()).toEqual({ error: 'not_found' })
    } finally {
      await rm(uploadDir, { recursive: true, force: true })
    }
  })

  test('retries async worker failures before completing a chunk', async () => {
    const uploadDir = await makeUploadDir()
    let attempts = 0
    const whisperFetch: TranscriptionFetch = async () => {
      attempts += 1
      if (attempts < 3) return Response.json({ detail: 'temporary failure' }, { status: 503 })
      return Response.json({
        text: 'retry success',
        segments: [{ start: 0, end: 0.5, text: 'retry success' }],
        duration_seconds: 0.5,
        processing_seconds: 0.2,
        level: 'medium',
        language: 'auto',
        detected_language: 'en',
        model: 'mock'
      })
    }
    const app = createApp({
      apiTokenStore: testApiTokenStore(),
      version: 'test-version',
      whisperFetch,
      transcriptionUploadDir: uploadDir,
      transcriptionMediaProcessor: singleChunkMediaProcessor(uploadDir, 0.5)
    })

    try {
      const created = await app.request('/api/v1/transcription/jobs', {
        method: 'POST',
        headers: authHeaders,
        body: makeForm()
      })
      const createdBody = await created.json()
      const completed = await waitFor(
        async () => {
          const res = await app.request(`/api/v1/transcription/jobs/${createdBody.job_id}`, { headers: authHeaders })
          return res.json()
        },
        (body: any) => body.status === 'completed'
      )

      expect(completed.status).toBe('completed')
      expect(attempts).toBe(3)
    } finally {
      await rm(uploadDir, { recursive: true, force: true })
    }
  })

  test('returns pending and cancelled result states for async jobs', async () => {
    const uploadDir = await makeUploadDir()
    const app = createApp({ apiTokenStore: testApiTokenStore(), version: 'test-version', transcriptionUploadDir: uploadDir, transcriptionWorker: null })

    try {
      const created = await app.request('/api/v1/transcription/jobs', {
        method: 'POST',
        headers: authHeaders,
        body: makeForm()
      })
      const createdBody = await created.json()

      const pendingResult = await app.request(`/api/v1/transcription/jobs/${createdBody.job_id}/result`, { headers: authHeaders })
      expect(pendingResult.status).toBe(409)
      expect(await pendingResult.json()).toEqual({ error: 'job_not_completed', status: 'queued' })

      const cancelled = await app.request(`/api/v1/transcription/jobs/${createdBody.job_id}`, {
        method: 'DELETE',
        headers: authHeaders
      })
      expect(cancelled.status).toBe(200)
      expect((await cancelled.json()).status).toBe('cancelled')

      const cancelledResult = await app.request(`/api/v1/transcription/jobs/${createdBody.job_id}/result`, { headers: authHeaders })
      expect(cancelledResult.status).toBe(410)
      expect(await cancelledResult.json()).toEqual({ error: 'job_cancelled' })
    } finally {
      await rm(uploadDir, { recursive: true, force: true })
    }
  })

  test('posts a webhook payload when a queued async job is cancelled', async () => {
    const uploadDir = await makeUploadDir()
    const webhookBodies: any[] = []
    const app = createApp({
      apiTokenStore: testApiTokenStore(),
      version: 'test-version',
      transcriptionUploadDir: uploadDir,
      transcriptionWorker: null,
      transcriptionWebhookFetch: async (_url, init) => {
        webhookBodies.push(JSON.parse(String(init?.body)))
        return Response.json({ ok: true })
      }
    })

    try {
      const created = await app.request('/api/v1/transcription/jobs', {
        method: 'POST',
        headers: authHeaders,
        body: makeForm({ webhook_url: 'https://hooks.test/transcription' })
      })
      const createdBody = await created.json()

      const cancelled = await app.request(`/api/v1/transcription/jobs/${createdBody.job_id}`, {
        method: 'DELETE',
        headers: authHeaders
      })

      expect(cancelled.status).toBe(200)
      expect(webhookBodies).toHaveLength(1)
      expect(webhookBodies[0]).toMatchObject({
        event: 'transcription.job.cancelled',
        job: {
          job_id: createdBody.job_id,
          status: 'cancelled',
          error: {
            code: 'JOB_CANCELLED',
            message: 'Job cancelled'
          }
        }
      })
    } finally {
      await rm(uploadDir, { recursive: true, force: true })
    }
  })
})

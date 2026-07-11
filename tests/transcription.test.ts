import { describe, expect, test } from 'bun:test'
import { createApp } from '../src/app'
import type { TranscriptionFetch } from '../src/routes/transcription'

function makeForm(fields: Record<string, string> = {}) {
  const form = new FormData()
  form.set('file', new File(['fake-audio'], 'clip.wav', { type: 'audio/wav' }))
  for (const [key, value] of Object.entries(fields)) {
    form.set(key, value)
  }
  return form
}

describe('transcription capability', () => {
  test('returns supported levels and languages', async () => {
    const app = createApp({ apiKey: 'secret', version: 'test-version' })
    const res = await app.request('/api/v1/transcription', {
      headers: { 'X-API-Key': 'secret' }
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
    const app = createApp({ apiKey: 'secret', version: 'test-version' })
    const res = await app.request('/api/v1/transcription/transcribe', {
      method: 'POST',
      headers: { 'X-API-Key': 'secret' },
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
      return Response.json({ text: 'hello', language: 'en', duration_seconds: 0.5, level: 'medium', model: 'distil-small.en' })
    }
    const app = createApp({ apiKey: 'secret', version: 'test-version', whisperUrl: 'http://whisper.test', whisperFetch })

    const res = await app.request('/api/v1/transcription/transcribe', {
      method: 'POST',
      headers: { 'X-API-Key': 'secret' },
      body: makeForm()
    })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ text: 'hello', language: 'en', duration_seconds: 0.5, level: 'medium', model: 'distil-small.en' })
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
      return Response.json({ text: 'ok', language: String(body.get('language')), duration_seconds: 0.1, level: body.get('level'), model: 'mock' })
    }
    const app = createApp({ apiKey: 'secret', version: 'test-version', whisperFetch })

    const english = await app.request('/api/v1/transcription/transcribe', {
      method: 'POST',
      headers: { 'X-API-Key': 'secret' },
      body: makeForm({ level: 'low', language: 'english' })
    })
    const german = await app.request('/api/v1/transcription/transcribe', {
      method: 'POST',
      headers: { 'X-API-Key': 'secret' },
      body: makeForm({ level: 'high', language: 'Deutsch' })
    })

    expect(english.status).toBe(200)
    expect(german.status).toBe(200)
    expect(forwarded).toEqual([
      { level: 'low', language: 'en' },
      { level: 'high', language: 'de' }
    ])
  })

  test('maps unsupported media format failures from the sidecar', async () => {
    const whisperFetch: TranscriptionFetch = async () => Response.json({ detail: 'unsupported_media_format' }, { status: 415 })
    const app = createApp({ apiKey: 'secret', version: 'test-version', whisperFetch })

    const res = await app.request('/api/v1/transcription/transcribe', {
      method: 'POST',
      headers: { 'X-API-Key': 'secret' },
      body: makeForm()
    })

    expect(res.status).toBe(415)
    expect(await res.json()).toEqual({ error: 'unsupported_media_format' })
  })

  test('rejects invalid level and language', async () => {
    const app = createApp({ apiKey: 'secret', version: 'test-version' })

    const invalidLevel = await app.request('/api/v1/transcription/transcribe', {
      method: 'POST',
      headers: { 'X-API-Key': 'secret' },
      body: makeForm({ level: 'ultra' })
    })
    expect(invalidLevel.status).toBe(400)
    expect(await invalidLevel.json()).toEqual({ error: 'invalid_level' })

    const invalidLanguage = await app.request('/api/v1/transcription/transcribe', {
      method: 'POST',
      headers: { 'X-API-Key': 'secret' },
      body: makeForm({ language: 'french' })
    })
    expect(invalidLanguage.status).toBe(400)
    expect(await invalidLanguage.json()).toEqual({ error: 'invalid_language' })
  })
})

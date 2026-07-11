import { Hono } from 'hono'
import { z } from 'zod'

const LEVELS = ['low', 'medium', 'high'] as const
const LANGUAGES = ['en', 'de'] as const

type TranscriptionLevel = (typeof LEVELS)[number]
type TranscriptionLanguage = (typeof LANGUAGES)[number]
export type TranscriptionFetch = (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => Promise<Response>

const whisperResponseSchema = z.object({
  text: z.string(),
  language: z.string().nullable().optional(),
  duration_seconds: z.number().nullable().optional(),
  level: z.enum(LEVELS).optional(),
  model: z.string().optional()
})

function normalizeLevel(value: FormDataEntryValue | null): TranscriptionLevel | null {
  if (value === null || value === '') return 'medium'
  if (typeof value !== 'string') return null
  const normalized = value.trim().toLowerCase()
  return LEVELS.includes(normalized as TranscriptionLevel) ? (normalized as TranscriptionLevel) : null
}

function normalizeLanguage(value: FormDataEntryValue | null): TranscriptionLanguage | undefined | null {
  if (value === null || value === '') return undefined
  if (typeof value !== 'string') return null

  const normalized = value.trim().toLowerCase()
  if (normalized === 'english') return 'en'
  if (normalized === 'german' || normalized === 'deutsch') return 'de'
  if (LANGUAGES.includes(normalized as TranscriptionLanguage)) return normalized as TranscriptionLanguage
  return null
}

export function transcriptionRoutes(opts: { whisperUrl?: string; whisperFetch?: TranscriptionFetch }) {
  const app = new Hono()
  const whisperUrl = opts.whisperUrl ?? 'http://whisper:8000'
  const whisperFetch = opts.whisperFetch ?? fetch

  app.get('/', (c) =>
    c.json({
      levels: [...LEVELS],
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
  )

  app.get('/jobs', (c) => c.json({ jobs: [] }))

  app.post('/transcribe', async (c) => {
    const form = await c.req.formData()
    const file = form.get('file')
    if (!(file instanceof File)) {
      return c.json({ error: 'file_required' }, 400)
    }

    const level = normalizeLevel(form.get('level'))
    if (level === null) {
      return c.json({ error: 'invalid_level' }, 400)
    }

    const language = normalizeLanguage(form.get('language'))
    if (language === null) {
      return c.json({ error: 'invalid_language' }, 400)
    }

    const outgoing = new FormData()
    outgoing.set('file', file, file.name)
    outgoing.set('level', level)
    if (language) {
      outgoing.set('language', language)
    }

    const response = await whisperFetch(`${whisperUrl}/transcribe`, {
      method: 'POST',
      body: outgoing
    })

    if (!response.ok) {
      if (response.status === 415) {
        return c.json({ error: 'unsupported_media_format' }, 415)
      }
      return c.json({ error: 'whisper_failed' }, 502)
    }

    const parsed = whisperResponseSchema.parse(await response.json())
    return c.json(parsed)
  })

  return app
}

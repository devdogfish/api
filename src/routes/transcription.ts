import { Hono } from 'hono'
import { z } from 'zod'

const whisperResponseSchema = z.object({
  text: z.string(),
  language: z.string().nullable().optional(),
  duration_seconds: z.number().nullable().optional()
})

export function transcriptionRoutes(opts: { whisperUrl?: string }) {
  const app = new Hono()
  const whisperUrl = opts.whisperUrl ?? 'http://whisper:8000'

  app.get('/jobs', (c) => c.json({ jobs: [] }))

  app.post('/transcribe', async (c) => {
    const form = await c.req.formData()
    const file = form.get('file')
    if (!(file instanceof File)) {
      return c.json({ error: 'file_required' }, 400)
    }

    const outgoing = new FormData()
    outgoing.set('file', file, file.name)

    const response = await fetch(`${whisperUrl}/transcribe`, {
      method: 'POST',
      body: outgoing
    })

    if (!response.ok) {
      return c.json({ error: 'whisper_failed' }, 502)
    }

    const parsed = whisperResponseSchema.parse(await response.json())
    return c.json(parsed)
  })

  return app
}

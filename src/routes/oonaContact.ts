import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { z } from 'zod'

const senderBaseUrl = 'https://api.sender.net/v2'
const allowedOrigin = 'https://gallery.oonakokopelli.com'

export type SenderConfig = {
  apiToken: string
  receivingEmail: string
  groupId: string
  fromEmail?: string
}

export type SenderFetch = (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => Promise<Response>

type OonaContactRoutesOptions = {
  sender?: SenderConfig
  senderFetch?: SenderFetch
}

const contactSchema = z.object({
  name: z.string().trim().min(1).max(200),
  email: z.string().trim().email().max(320),
  message: z.string().trim().min(1).max(5000),
  subscribe: z.boolean()
})

function escapeHtml(value: string) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;')
}

async function callSender(senderFetch: SenderFetch, token: string, path: string, body: unknown) {
  const res = await senderFetch(`${senderBaseUrl}${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json'
    },
    body: JSON.stringify(body)
  })

  let payload: any = null
  try {
    payload = await res.json()
  } catch {
    payload = null
  }

  if (!res.ok || payload?.success === false) {
    const message = typeof payload?.message === 'string' ? payload.message : 'unknown_sender_error'
    throw new Error(`Sender request failed: ${res.status}: ${message}`)
  }

  return payload
}

export function oonaContactRoutes(options: OonaContactRoutesOptions = {}) {
  const app = new Hono()
  const senderFetch = options.senderFetch ?? fetch

  app.use(
    '*',
    cors({
      origin: allowedOrigin,
      allowMethods: ['POST', 'OPTIONS'],
      allowHeaders: ['Content-Type'],
      maxAge: 86400
    })
  )

  app.post('/', async (c) => {
    if (!options.sender?.apiToken || !options.sender.receivingEmail || !options.sender.groupId) {
      return c.json({ success: false, error: 'missing_sender_config' }, 503)
    }

    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      return c.json({ success: false, error: 'invalid_request' }, 400)
    }

    const parsed = contactSchema.safeParse(body)
    if (!parsed.success) {
      return c.json({ success: false, error: 'invalid_request' }, 400)
    }

    const { name, email, message, subscribe } = parsed.data
    const fromEmail = options.sender.fromEmail || options.sender.receivingEmail
    const text = [
      `New Oona Kokopelli contact form message`,
      ``,
      `From: ${name} <${email}>`,
      `Newsletter opt-in: ${subscribe ? 'yes' : 'no'}`,
      ``,
      message
    ].join('\n')

    const html = `
      <p><strong>New Oona Kokopelli contact form message</strong></p>
      <p><strong>From:</strong> ${escapeHtml(name)} &lt;${escapeHtml(email)}&gt;</p>
      <p><strong>Newsletter opt-in:</strong> ${subscribe ? 'yes' : 'no'}</p>
      <p><strong>Message:</strong></p>
      <p>${escapeHtml(message).replaceAll('\n', '<br>')}</p>
    `

    try {
      await callSender(senderFetch, options.sender.apiToken, '/message/send', {
        from: { email: fromEmail, name: 'Oona Kokopelli Studio' },
        to: { email: options.sender.receivingEmail, name: 'Oona Kokopelli Studio' },
        subject: `Oona Kokopelli contact form: ${name}`,
        text,
        html,
        reply_to: email
      })

      if (subscribe) {
        await callSender(senderFetch, options.sender.apiToken, '/subscribers', {
          email,
          firstname: name,
          groups: [options.sender.groupId],
          trigger_automation: false
        })
      }
    } catch (err) {
      console.error(JSON.stringify({ level: 'error', msg: 'sender_request_failed', error: err instanceof Error ? err.message : String(err) }))
      return c.json({ success: false, error: 'sender_request_failed' }, 502)
    }

    return c.json({ success: true })
  })

  return app
}

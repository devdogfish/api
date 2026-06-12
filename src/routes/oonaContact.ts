import { Hono } from 'hono'
import { cors } from 'hono/cors'
import nodemailer from 'nodemailer'
import { z } from 'zod'

const senderBaseUrl = 'https://api.sender.net/v2'
const allowedOrigin = 'https://gallery.oonakokopelli.com'

export type SenderConfig = {
  apiToken: string
  groupId: string
}

export type SmtpConfig = {
  host: string
  port: number
  secure: boolean
  user: string
  password: string
  fromEmail: string
  toEmail: string
}

export type SenderFetch = (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => Promise<Response>
export type MailSender = (message: ContactEmailMessage) => Promise<void>

type ContactEmailMessage = {
  from: { email: string; name: string }
  to: { email: string; name: string }
  replyTo: string
  subject: string
  text: string
  html: string
}

type OonaContactRoutesOptions = {
  sender?: SenderConfig
  senderFetch?: SenderFetch
  smtp?: SmtpConfig
  mailSender?: MailSender
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

function createSmtpMailSender(smtp: SmtpConfig): MailSender {
  const transporter = nodemailer.createTransport({
    host: smtp.host,
    port: smtp.port,
    secure: smtp.secure,
    auth: {
      user: smtp.user,
      pass: smtp.password
    }
  })

  return async (message) => {
    await transporter.sendMail({
      from: { address: message.from.email, name: message.from.name },
      to: { address: message.to.email, name: message.to.name },
      replyTo: message.replyTo,
      subject: message.subject,
      text: message.text,
      html: message.html
    })
  }
}

export function oonaContactRoutes(options: OonaContactRoutesOptions = {}) {
  const app = new Hono()
  const senderFetch = options.senderFetch ?? fetch
  const mailSender = options.mailSender ?? (options.smtp ? createSmtpMailSender(options.smtp) : undefined)

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
    if (!mailSender || !options.smtp?.fromEmail || !options.smtp.toEmail) {
      return c.json({ success: false, error: 'missing_mail_config' }, 503)
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
      await mailSender({
        from: { email: options.smtp.fromEmail, name: 'Oona Kokopelli Website' },
        to: { email: options.smtp.toEmail, name: 'Oona Kokopelli Studio' },
        subject: `Oona Kokopelli contact form: ${name}`,
        text,
        html,
        replyTo: email
      })

      if (subscribe) {
        if (!options.sender?.apiToken || !options.sender.groupId) {
          return c.json({ success: false, error: 'missing_sender_config' }, 503)
        }

        await callSender(senderFetch, options.sender.apiToken, '/subscribers', {
          email,
          firstname: name,
          groups: [options.sender.groupId],
          trigger_automation: false
        })
      }
    } catch (err) {
      console.error(JSON.stringify({ level: 'error', msg: 'contact_delivery_failed', error: err instanceof Error ? err.message : String(err) }))
      return c.json({ success: false, error: 'contact_delivery_failed' }, 502)
    }

    return c.json({ success: true })
  })

  return app
}

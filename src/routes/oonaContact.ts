import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi'
import { cors } from 'hono/cors'
import { HTTPException } from 'hono/http-exception'
import nodemailer from 'nodemailer'
import type { AppEnv } from '../appEnv'
import { OONA_CONTACT_TAG } from '../openapi'

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

const contactRequestExample = {
  name: 'Jane Painter',
  email: 'jane@example.com',
  message: 'I love this work. Can I buy a print?',
  subscribe: true
} as const
const contactSuccessResponse = { success: true } as const
const invalidRequestResponse = { success: false, error: 'invalid_request' } as const
const missingMailConfigResponse = { success: false, error: 'missing_mail_config' } as const
const missingSenderConfigResponse = { success: false, error: 'missing_sender_config' } as const
const contactDeliveryFailedResponse = { success: false, error: 'contact_delivery_failed' } as const

const contactSchema = z
  .object({
    name: z.string().trim().min(1).max(200).openapi({ example: contactRequestExample.name }),
    email: z.string().trim().email().max(320).openapi({ example: contactRequestExample.email }),
    message: z.string().trim().min(1).max(5000).openapi({ example: contactRequestExample.message }),
    subscribe: z.boolean().openapi({ example: contactRequestExample.subscribe })
  })
  .openapi('OonaContactRequest')

const contactSuccessSchema = z
  .object({
    success: z.literal(true).openapi({ example: true })
  })
  .openapi('OonaContactSuccessResponse')

const invalidRequestResponseSchema = z
  .object({
    success: z.literal(false).openapi({ example: false }),
    error: z.literal('invalid_request').openapi({ example: 'invalid_request' })
  })
  .openapi('OonaContactInvalidRequestResponse')

const missingMailConfigResponseSchema = z
  .object({
    success: z.literal(false).openapi({ example: false }),
    error: z.literal('missing_mail_config').openapi({ example: 'missing_mail_config' })
  })
  .openapi('OonaContactMissingMailConfigResponse')

const missingSenderConfigResponseSchema = z
  .object({
    success: z.literal(false).openapi({ example: false }),
    error: z.literal('missing_sender_config').openapi({ example: 'missing_sender_config' })
  })
  .openapi('OonaContactMissingSenderConfigResponse')

const contactDeliveryFailedResponseSchema = z
  .object({
    success: z.literal(false).openapi({ example: false }),
    error: z.literal('contact_delivery_failed').openapi({ example: 'contact_delivery_failed' })
  })
  .openapi('OonaContactDeliveryFailedResponse')

const serviceUnavailableResponseSchema = z
  .union([missingMailConfigResponseSchema, missingSenderConfigResponseSchema])
  .openapi('OonaContactServiceUnavailableResponse')

const contactRoute = createRoute({
  method: 'post',
  path: '/',
  operationId: 'submitOonaContact',
  tags: [OONA_CONTACT_TAG.name],
  summary: 'Submit an Oona Kokopelli contact message',
  description: `Public JSON contact endpoint for the Oona Kokopelli site. CORS allows browser requests from ${allowedOrigin}.`,
  request: {
    required: true,
    body: {
      required: true,
      description: 'Contact form payload.',
      content: {
        'application/json': {
          schema: contactSchema,
          example: contactRequestExample
        }
      }
    }
  },
  responses: {
    200: {
      description: 'Contact email accepted and processed.',
      content: {
        'application/json': {
          schema: contactSuccessSchema,
          example: contactSuccessResponse
        }
      }
    },
    400: {
      description: 'Invalid contact request payload.',
      content: {
        'application/json': {
          schema: invalidRequestResponseSchema,
          example: invalidRequestResponse
        }
      }
    },
    502: {
      description: 'Contact delivery failed.',
      content: {
        'application/json': {
          schema: contactDeliveryFailedResponseSchema,
          example: contactDeliveryFailedResponse
        }
      }
    },
    503: {
      description: 'Required mail or Sender configuration is missing.',
      content: {
        'application/json': {
          schema: serviceUnavailableResponseSchema,
          example: missingMailConfigResponse
        }
      }
    }
  }
})

function hasMailConfig(options: OonaContactRoutesOptions, mailSender?: MailSender) {
  return Boolean(mailSender && options.smtp?.fromEmail && options.smtp.toEmail)
}

function isMalformedJsonError(err: unknown) {
  return err instanceof HTTPException && err.status === 400 && err.message === 'Malformed JSON in request body'
}

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
  const app = new OpenAPIHono<AppEnv>()
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

  app.onError((err, c) => {
    if (isMalformedJsonError(err)) {
      return c.json(invalidRequestResponse, 400)
    }

    console.error(JSON.stringify({ level: 'error', msg: err.message, stack: err.stack }))
    return c.json({ error: 'internal_server_error' }, 500)
  })

  app.openapi(
    {
      ...contactRoute,
      middleware: [
        async (c, next) => {
          if (!hasMailConfig(options, mailSender)) {
            return c.json(missingMailConfigResponse, 503)
          }

          await next()
        }
      ]
    },
    async (c) => {
      if (!mailSender || !options.smtp?.fromEmail || !options.smtp.toEmail) {
        return c.json(missingMailConfigResponse, 503)
      }

      const { name, email, message, subscribe } = c.req.valid('json')
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
            return c.json(missingSenderConfigResponse, 503)
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
        return c.json(contactDeliveryFailedResponse, 502)
      }

      return c.json(contactSuccessResponse, 200)
    },
    (result, c) => {
      if (!result.success) {
        return c.json(invalidRequestResponse, 400)
      }
    }
  )

  return app
}

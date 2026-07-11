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

type ContactErrorCode =
  | 'invalid_request'
  | 'missing_mail_config'
  | 'missing_sender_config'
  | 'contact_delivery_failed'
type MailDeliveryConfig = {
  sender: MailSender
  fromEmail: string
  toEmail: string
}
type SenderSubscriptionConfig = {
  apiToken: string
  groupId: string
}

const contactEmailFromName = 'Oona Kokopelli Website'
const contactEmailToName = 'Oona Kokopelli Studio'
const contactEmailSubjectPrefix = 'Oona Kokopelli contact form'

const contactRequestExample = {
  name: 'Jane Painter',
  email: 'jane@example.com',
  message: 'I love this work. Can I buy a print?',
  subscribe: true
} as const
const contactSuccessResponse = { success: true } as const

function createErrorResponse<Code extends ContactErrorCode>(error: Code) {
  return { success: false as const, error }
}

function createErrorResponseSchema<Code extends ContactErrorCode>(name: string, error: Code) {
  return z
    .object({
      success: z.literal(false).openapi({ example: false }),
      error: z.literal(error).openapi({ example: error })
    })
    .openapi(name)
}

function createJsonContent<TSchema>(schema: TSchema, example: unknown) {
  return {
    'application/json': {
      schema,
      example
    }
  }
}

const invalidRequestResponse = createErrorResponse('invalid_request')
const missingMailConfigResponse = createErrorResponse('missing_mail_config')
const missingSenderConfigResponse = createErrorResponse('missing_sender_config')
const contactDeliveryFailedResponse = createErrorResponse('contact_delivery_failed')

const contactSchema = z
  .object({
    name: z.string().trim().min(1).max(200).openapi({ example: contactRequestExample.name }),
    email: z.string().trim().email().max(320).openapi({ example: contactRequestExample.email }),
    message: z.string().trim().min(1).max(5000).openapi({ example: contactRequestExample.message }),
    subscribe: z.boolean().openapi({ example: contactRequestExample.subscribe })
  })
  .openapi('OonaContactRequest')
type ContactRequest = z.infer<typeof contactSchema>

const contactSuccessSchema = z
  .object({
    success: z.literal(true).openapi({ example: true })
  })
  .openapi('OonaContactSuccessResponse')

const invalidRequestResponseSchema = createErrorResponseSchema('OonaContactInvalidRequestResponse', 'invalid_request')

const missingMailConfigResponseSchema = createErrorResponseSchema(
  'OonaContactMissingMailConfigResponse',
  'missing_mail_config'
)

const missingSenderConfigResponseSchema = createErrorResponseSchema(
  'OonaContactMissingSenderConfigResponse',
  'missing_sender_config'
)

const contactDeliveryFailedResponseSchema = createErrorResponseSchema(
  'OonaContactDeliveryFailedResponse',
  'contact_delivery_failed'
)

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
      content: createJsonContent(contactSchema, contactRequestExample)
    }
  },
  responses: {
    200: {
      description: 'Contact email accepted and processed.',
      content: createJsonContent(contactSuccessSchema, contactSuccessResponse)
    },
    400: {
      description: 'Invalid contact request payload.',
      content: createJsonContent(invalidRequestResponseSchema, invalidRequestResponse)
    },
    502: {
      description: 'Contact delivery failed.',
      content: createJsonContent(contactDeliveryFailedResponseSchema, contactDeliveryFailedResponse)
    },
    503: {
      description: 'Required mail or Sender configuration is missing.',
      content: createJsonContent(serviceUnavailableResponseSchema, missingMailConfigResponse)
    }
  }
})

function resolveMailDeliveryConfig(
  options: OonaContactRoutesOptions,
  mailSender?: MailSender
): MailDeliveryConfig | null {
  if (!mailSender || !options.smtp?.fromEmail || !options.smtp.toEmail) {
    return null
  }

  return {
    sender: mailSender,
    fromEmail: options.smtp.fromEmail,
    toEmail: options.smtp.toEmail
  }
}

function resolveSenderSubscriptionConfig(sender?: SenderConfig): SenderSubscriptionConfig | null {
  if (!sender?.apiToken || !sender.groupId) {
    return null
  }

  return {
    apiToken: sender.apiToken,
    groupId: sender.groupId
  }
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function getSenderErrorMessage(payload: unknown) {
  if (isRecord(payload) && typeof payload.message === 'string') {
    return payload.message
  }

  return 'unknown_sender_error'
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

  let payload: unknown = null
  try {
    payload = await res.json()
  } catch {
    payload = null
  }

  if (!res.ok || (isRecord(payload) && payload.success === false)) {
    throw new Error(`Sender request failed: ${res.status}: ${getSenderErrorMessage(payload)}`)
  }

  return payload
}

function createContactEmailContent(contact: ContactRequest) {
  const newsletterOptIn = contact.subscribe ? 'yes' : 'no'
  const text = [
    `New Oona Kokopelli contact form message`,
    ``,
    `From: ${contact.name} <${contact.email}>`,
    `Newsletter opt-in: ${newsletterOptIn}`,
    ``,
    contact.message
  ].join('\n')

  const html = `
      <p><strong>New Oona Kokopelli contact form message</strong></p>
      <p><strong>From:</strong> ${escapeHtml(contact.name)} &lt;${escapeHtml(contact.email)}&gt;</p>
      <p><strong>Newsletter opt-in:</strong> ${newsletterOptIn}</p>
      <p><strong>Message:</strong></p>
      <p>${escapeHtml(contact.message).replaceAll('\n', '<br>')}</p>
    `

  return { text, html }
}

async function sendContactEmail(mailDelivery: MailDeliveryConfig, contact: ContactRequest) {
  const { text, html } = createContactEmailContent(contact)

  await mailDelivery.sender({
    from: { email: mailDelivery.fromEmail, name: contactEmailFromName },
    to: { email: mailDelivery.toEmail, name: contactEmailToName },
    subject: `${contactEmailSubjectPrefix}: ${contact.name}`,
    text,
    html,
    replyTo: contact.email
  })
}

async function subscribeContact(
  senderFetch: SenderFetch,
  senderSubscription: SenderSubscriptionConfig,
  contact: ContactRequest
) {
  await callSender(senderFetch, senderSubscription.apiToken, '/subscribers', {
    email: contact.email,
    firstname: contact.name,
    groups: [senderSubscription.groupId],
    trigger_automation: false
  })
}

function logContactDeliveryFailure(err: unknown) {
  console.error(
    JSON.stringify({
      level: 'error',
      msg: 'contact_delivery_failed',
      error: err instanceof Error ? err.message : String(err)
    })
  )
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
  const mailDelivery = resolveMailDeliveryConfig(options, mailSender)
  const senderSubscription = resolveSenderSubscriptionConfig(options.sender)

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
          if (!mailDelivery) {
            return c.json(missingMailConfigResponse, 503)
          }

          await next()
        }
      ]
    },
    async (c) => {
      if (!mailDelivery) {
        return c.json(missingMailConfigResponse, 503)
      }

      const contact = c.req.valid('json')

      try {
        await sendContactEmail(mailDelivery, contact)

        if (contact.subscribe) {
          if (!senderSubscription) {
            return c.json(missingSenderConfigResponse, 503)
          }

          await subscribeContact(senderFetch, senderSubscription, contact)
        }
      } catch (err) {
        logContactDeliveryFailure(err)
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

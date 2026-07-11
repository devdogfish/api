import { describe, expect, test } from 'bun:test'
import { createApp } from '../src/app'
import type { MailSender, SenderFetch } from '../src/routes/oonaContact'
import { testApiTokenStore } from './helpers'

const senderConfig = {
  apiToken: 'sender-token',
  groupId: 'group-123'
}

const smtpConfig = {
  host: 'mail.infomaniak.com',
  port: 465,
  secure: true,
  user: 'website@oonakokopelli.com',
  password: 'smtp-password',
  fromEmail: 'website@oonakokopelli.com',
  toEmail: 'studio@oonakokopelli.com'
}

describe('Oona Kokopelli contact form proxy', () => {
  test('allows Carrd landing page origin in CORS preflight', async () => {
    const app = createApp({ apiTokenStore: testApiTokenStore(), version: 'test-version', sender: senderConfig, smtp: smtpConfig })

    const res = await app.request('/api/v1/oona/contact', {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://gallery.oonakokopelli.com',
        'Access-Control-Request-Method': 'POST'
      }
    })

    expect(res.status).toBe(204)
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://gallery.oonakokopelli.com')
  })

  test('sends contact email through SMTP and subscribes opted-in visitors through Sender', async () => {
    const senderCalls: Array<{ url: string; body: any; authorization: string | null }> = []
    const smtpMessages: Array<any> = []
    const senderFetch: SenderFetch = async (url, init) => {
      senderCalls.push({
        url: String(url),
        body: JSON.parse(String(init?.body)),
        authorization: new Headers(init?.headers).get('Authorization')
      })
      return Response.json({ success: true })
    }
    const mailSender: MailSender = async (message) => {
      smtpMessages.push(message)
    }
    const app = createApp({ apiTokenStore: testApiTokenStore(), version: 'test-version', sender: senderConfig, senderFetch, smtp: smtpConfig, mailSender })

    const res = await app.request('/api/v1/oona/contact', {
      method: 'POST',
      headers: {
        Origin: 'https://gallery.oonakokopelli.com',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        name: 'Jane Painter',
        email: 'jane@example.com',
        message: 'I love this work. Can I buy a print?',
        subscribe: true
      })
    })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true })
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://gallery.oonakokopelli.com')
    expect(smtpMessages).toHaveLength(1)
    expect(smtpMessages[0].to.email).toBe('studio@oonakokopelli.com')
    expect(smtpMessages[0].from.email).toBe('website@oonakokopelli.com')
    expect(smtpMessages[0].from.name).toBe('Oona Kokopelli Website')
    expect(smtpMessages[0].replyTo).toBe('jane@example.com')
    expect(smtpMessages[0].subject).toContain('Oona Kokopelli contact form')
    expect(smtpMessages[0].text).toContain('Jane Painter <jane@example.com>')
    expect(smtpMessages[0].text).toContain('I love this work. Can I buy a print?')
    expect(senderCalls).toHaveLength(1)
    expect(senderCalls[0].url).toBe('https://api.sender.net/v2/subscribers')
    expect(senderCalls[0].authorization).toBe('Bearer sender-token')
    expect(senderCalls[0].body).toEqual({
      email: 'jane@example.com',
      firstname: 'Jane Painter',
      groups: ['group-123'],
      trigger_automation: false
    })
  })

  test('does not subscribe visitors who do not opt in', async () => {
    const senderCalls: Array<{ url: string; body: any }> = []
    const smtpMessages: Array<any> = []
    const senderFetch: SenderFetch = async (url, init) => {
      senderCalls.push({ url: String(url), body: JSON.parse(String(init?.body)) })
      return Response.json({ success: true })
    }
    const mailSender: MailSender = async (message) => {
      smtpMessages.push(message)
    }
    const app = createApp({ apiTokenStore: testApiTokenStore(), version: 'test-version', sender: senderConfig, senderFetch, smtp: smtpConfig, mailSender })

    const res = await app.request('/api/v1/oona/contact', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'No Thanks', email: 'no@example.com', message: 'Just saying hi', subscribe: false })
    })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true })
    expect(smtpMessages).toHaveLength(1)
    expect(senderCalls).toHaveLength(0)
  })

  test('returns a safe error for invalid payloads', async () => {
    const app = createApp({ apiTokenStore: testApiTokenStore(), version: 'test-version', sender: senderConfig, smtp: smtpConfig })

    const res = await app.request('/api/v1/oona/contact', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '', email: 'bad-email', message: '', subscribe: true })
    })

    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ success: false, error: 'invalid_request' })
  })

  test('returns a safe error when mail configuration is missing', async () => {
    const app = createApp({ apiTokenStore: testApiTokenStore(), version: 'test-version' })

    const res = await app.request('/api/v1/oona/contact', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Jane', email: 'jane@example.com', message: 'Hello', subscribe: false })
    })

    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({ success: false, error: 'missing_mail_config' })
  })

  test('returns a safe error when Sender configuration is missing for opt-in requests', async () => {
    const smtpMessages: Array<any> = []
    const mailSender: MailSender = async (message) => {
      smtpMessages.push(message)
    }
    const app = createApp({ apiTokenStore: testApiTokenStore(), version: 'test-version', smtp: smtpConfig, mailSender })

    const res = await app.request('/api/v1/oona/contact', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Jane', email: 'jane@example.com', message: 'Hello', subscribe: true })
    })

    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({ success: false, error: 'missing_sender_config' })
    expect(smtpMessages).toHaveLength(1)
  })

  test('returns a safe error when SMTP rejects a request', async () => {
    const mailSender: MailSender = async () => {
      throw new Error('smtp blocked')
    }
    const app = createApp({ apiTokenStore: testApiTokenStore(), version: 'test-version', sender: senderConfig, smtp: smtpConfig, mailSender })

    const res = await app.request('/api/v1/oona/contact', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Jane', email: 'jane@example.com', message: 'Hello', subscribe: false })
    })

    expect(res.status).toBe(502)
    expect(await res.json()).toEqual({ success: false, error: 'contact_delivery_failed' })
  })
})

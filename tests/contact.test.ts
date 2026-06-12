import { describe, expect, test } from 'bun:test'
import { createApp } from '../src/app'
import type { SenderFetch } from '../src/routes/oonaContact'

const senderConfig = {
  apiToken: 'sender-token',
  receivingEmail: 'studio@oonakokopelli.com',
  groupId: 'group-123',
  fromEmail: 'studio@oonakokopelli.com'
}

describe('Oona Kokopelli contact form proxy', () => {
  test('allows Carrd landing page origin in CORS preflight', async () => {
    const app = createApp({ apiKey: 'secret', version: 'test-version', sender: senderConfig })

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

  test('sends contact email and subscribes opted-in visitors through Sender', async () => {
    const calls: Array<{ url: string; body: any; authorization: string | null }> = []
    const senderFetch: SenderFetch = async (url, init) => {
      calls.push({
        url: String(url),
        body: JSON.parse(String(init?.body)),
        authorization: new Headers(init?.headers).get('Authorization')
      })
      return Response.json({ success: true })
    }
    const app = createApp({ apiKey: 'secret', version: 'test-version', sender: senderConfig, senderFetch })

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
    expect(calls).toHaveLength(2)
    expect(calls[0].url).toBe('https://api.sender.net/v2/message/send')
    expect(calls[0].authorization).toBe('Bearer sender-token')
    expect(calls[0].body.to.email).toBe('studio@oonakokopelli.com')
    expect(calls[0].body.subject).toContain('Oona Kokopelli contact form')
    expect(calls[0].body.reply_to).toBe('jane@example.com')
    expect(calls[0].body.headers).toBeUndefined()
    expect(calls[0].body.text).toContain('Jane Painter <jane@example.com>')
    expect(calls[0].body.text).toContain('I love this work. Can I buy a print?')
    expect(calls[1].url).toBe('https://api.sender.net/v2/subscribers')
    expect(calls[1].body).toEqual({
      email: 'jane@example.com',
      firstname: 'Jane Painter',
      groups: ['group-123'],
      trigger_automation: false
    })
  })

  test('does not subscribe visitors who do not opt in', async () => {
    const calls: Array<{ url: string; body: any }> = []
    const senderFetch: SenderFetch = async (url, init) => {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body)) })
      return Response.json({ success: true })
    }
    const app = createApp({ apiKey: 'secret', version: 'test-version', sender: senderConfig, senderFetch })

    const res = await app.request('/api/v1/oona/contact', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'No Thanks', email: 'no@example.com', message: 'Just saying hi', subscribe: false })
    })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true })
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe('https://api.sender.net/v2/message/send')
  })

  test('returns a safe error for invalid payloads', async () => {
    const app = createApp({ apiKey: 'secret', version: 'test-version', sender: senderConfig })

    const res = await app.request('/api/v1/oona/contact', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '', email: 'bad-email', message: '', subscribe: true })
    })

    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ success: false, error: 'invalid_request' })
  })

  test('returns a safe error when Sender rejects a request', async () => {
    const senderFetch: SenderFetch = async () => Response.json({ success: false, message: 'blocked' }, { status: 422 })
    const app = createApp({ apiKey: 'secret', version: 'test-version', sender: senderConfig, senderFetch })

    const res = await app.request('/api/v1/oona/contact', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Jane', email: 'jane@example.com', message: 'Hello', subscribe: false })
    })

    expect(res.status).toBe(502)
    expect(await res.json()).toEqual({ success: false, error: 'sender_request_failed' })
  })
})

import { describe, expect, test } from 'bun:test'
import { createApp } from '../src/app'
import { ComputeAdmission } from '../src/computeAdmission'
import { createLlamaServerClient, LLM_LIMITS, LlmError, type LlmClient } from '../src/llm/llmClient'
import { LlmRateLimiter } from '../src/llm/rateLimit'
import { authHeaders, testApiTokenStore } from './helpers'

const okResult = {
  content: 'hi',
  usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
  timings: { prompt_ms: 1, predicted_ms: 2, predicted_per_second: 9 }
}

function makeApp(client: LlmClient | undefined, extra: Partial<Parameters<typeof createApp>[0]> = {}, scopes = ['llm']) {
  return createApp({ apiTokenStore: testApiTokenStore('girke_valid', scopes), version: 't', llmClient: client, ...extra })
}

const post = (app: ReturnType<typeof makeApp>, body: unknown) =>
  app.request('/api/v1/llm/chat', {
    method: 'POST',
    headers: { ...authHeaders, 'content-type': 'application/json' },
    body: JSON.stringify(body)
  })
const hello = { messages: [{ role: 'user', content: 'hello' }] }

describe('LLM routes', () => {
  test('401 without token, 403 without llm scope', async () => {
    const app = makeApp({ chat: async () => okResult }, {}, [])
    expect((await app.request('/api/v1/llm')).status).toBe(401)
    expect((await app.request('/api/v1/llm', { headers: authHeaders })).status).toBe(403)
    expect((await post(app, hello)).status).toBe(403)
  })

  test('metadata reports the pinned model and limits', async () => {
    const res = await makeApp({ chat: async () => okResult }).request('/api/v1/llm', { headers: authHeaders })
    const body = (await res.json()) as any
    expect(res.status).toBe(200)
    expect(body.model.revision).toBe('bc640142c66e1fdd12af0bd68f40445458f3869b')
    expect(body.model.sha256).toStartWith('7485fe6f')
    expect(body.limits.max_output_tokens).toBe(1024)
    expect(body.available).toBe(true)
  })

  test('chat returns content, usage and timings, passing schema through', async () => {
    let seen: any
    const app = makeApp({ chat: async (input) => ((seen = input), okResult) })
    const res = await post(app, { ...hello, max_tokens: 50, json_schema: { type: 'object' } })
    expect(res.status).toBe(200)
    expect(((await res.json()) as any).content).toBe('hi')
    expect(seen.maxTokens).toBe(50)
    expect(seen.jsonSchema).toEqual({ type: 'object' })
  })

  test('validates input: max_tokens, both schema and grammar, oversize', async () => {
    const app = makeApp({ chat: async () => okResult })
    expect((await post(app, { ...hello, max_tokens: 1025 })).status).toBe(400)
    expect((await post(app, { ...hello, json_schema: {}, grammar: 'root ::= "a"' })).status).toBe(400)
    expect((await post(app, { messages: [] })).status).toBe(400)
    const big = await post(app, { messages: [{ role: 'user', content: 'x'.repeat(19_000) }] })
    expect(big.status).toBe(413)
  })

  test('rate limits per token with Retry-After', async () => {
    let now = 0
    const limiter = new LlmRateLimiter(() => now)
    const app = makeApp({ chat: async () => okResult }, { llmRateLimiter: limiter })
    for (let i = 0; i < LLM_LIMITS.requests_per_hour; i++) expect((await post(app, hello)).status).toBe(200)
    const limited = await post(app, hello)
    expect(limited.status).toBe(429)
    expect(Number(limited.headers.get('Retry-After'))).toBe(3600)
    now = 3_600_001
    expect((await post(app, hello)).status).toBe(200)
  })

  test('daily token budget returns 429', async () => {
    const limiter = new LlmRateLimiter(() => Date.UTC(2026, 10, 22, 12))
    limiter.recordTokens(12, LLM_LIMITS.tokens_per_day)
    const res = await post(makeApp({ chat: async () => okResult }, { llmRateLimiter: limiter }), hello)
    expect(res.status).toBe(429)
    expect(Number(res.headers.get('Retry-After'))).toBe(12 * 3600)
  })

  test('own queue: one running, two waiting, then 503 compute_busy; OCR admission untouched', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const app = makeApp({ chat: async () => (await gate, okResult) }, { llmAdmission: new ComputeAdmission(), llmRateLimiter: new LlmRateLimiter() })
    const inflight = [post(app, hello), post(app, hello), post(app, hello)]
    await Bun.sleep(20)
    const busy = await post(app, hello)
    expect(busy.status).toBe(503)
    expect(await busy.json()).toEqual({ error: 'compute_busy' })
    release()
    expect((await Promise.all(inflight)).map((r) => r.status)).toEqual([200, 200, 200])
  })

  test('maps upstream failures and never logs prompts', async () => {
    const lines: string[] = []
    const orig = console.log
    console.log = (m: string) => void lines.push(String(m))
    try {
      const secret = 'TOP-SECRET-PROMPT'
      const mk = (code: 'LLM_TIMED_OUT' | 'LLM_UNAVAILABLE' | 'LLM_FAILED') =>
        makeApp({ chat: async () => { throw new LlmError(code, 'x') } })
      const body = { messages: [{ role: 'user', content: secret }] }
      expect((await post(mk('LLM_TIMED_OUT'), body)).status).toBe(504)
      expect((await post(mk('LLM_UNAVAILABLE'), body)).status).toBe(502)
      expect((await post(mk('LLM_FAILED'), body)).status).toBe(502)
      expect((await post(makeApp({ chat: async () => ({ ...okResult, content: secret }) }), body)).status).toBe(200)
      expect(lines.join('\n')).not.toContain(secret)
      expect(lines.some((l) => l.includes('"llm_chat"') && l.includes('"token_id":12'))).toBe(true)
    } finally {
      console.log = orig
    }
  })

  test('no model configured: metadata says unavailable, chat 502', async () => {
    const app = makeApp(undefined)
    expect(((await (await app.request('/api/v1/llm', { headers: authHeaders })).json()) as any).available).toBe(false)
    expect((await post(app, hello)).status).toBe(502)
  })
})

describe('llama-server client', () => {
  test('sends the key, schema and no thinking; parses usage', async () => {
    let req: any
    const client = createLlamaServerClient({
      baseUrl: 'http://llm:8080/',
      apiKey: 'k',
      fetch: (async (url: string, init: any) => {
        req = { url, headers: init.headers, body: JSON.parse(init.body) }
        return Response.json({ choices: [{ message: { content: '{}' } }], usage: { prompt_tokens: 5, completion_tokens: 1 }, timings: { predicted_per_second: 9.5 } })
      }) as any
    })
    const out = await client.chat({ messages: [{ role: 'user', content: 'a' }], maxTokens: 10, jsonSchema: { type: 'object' } })
    expect(req.url).toBe('http://llm:8080/v1/chat/completions')
    expect(req.headers.authorization).toBe('Bearer k')
    expect(req.body.json_schema).toEqual({ type: 'object' })
    expect(req.body.chat_template_kwargs.enable_thinking).toBe(false)
    expect(out.usage.total_tokens).toBe(6)
    expect(out.timings.predicted_per_second).toBe(9.5)
  })

  test('connection failure becomes LLM_UNAVAILABLE', async () => {
    const client = createLlamaServerClient({ baseUrl: 'http://x', fetch: (async () => { throw new TypeError('down') }) as any })
    await expect(client.chat({ messages: [{ role: 'user', content: 'a' }], maxTokens: 1 })).rejects.toMatchObject({ code: 'LLM_UNAVAILABLE' })
  })
})

import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi'
import type { AppEnv } from '../appEnv'
import { ComputeAdmission, ComputeBusyError, computeBusy, computeBusySchema } from '../computeAdmission'
import {
  LLM_LIMITS,
  LLM_MODEL,
  LlmError,
  estimateTokens,
  type LlmClient
} from '../llm/llmClient'
import { LlmRateLimiter } from '../llm/rateLimit'
import { requireScope } from '../middleware/auth'
import {
  FORBIDDEN_ERROR_BODY,
  LLM_TAG,
  PROTECTED_BEARER_SECURITY,
  createJsonResponse,
  unauthorizedErrorResponse
} from '../openapi'

export const LLM_BASE_PATH = '/api/v1/llm'
export const LLM_SCOPE = 'llm'

export type LlmRouteOptions = {
  client?: LlmClient
  admission?: ComputeAdmission
  limiter?: LlmRateLimiter
}

const metadataSchema = z
  .object({
    model: z.object({
      name: z.string(),
      source: z.string(),
      revision: z.string(),
      sha256: z.string(),
      license: z.string(),
      runtime: z.string()
    }),
    limits: z.object({
      context_tokens: z.number().int(),
      max_output_tokens: z.number().int(),
      max_input_tokens: z.number().int(),
      requests_per_hour: z.number().int(),
      tokens_per_day: z.number().int(),
      timeout_seconds: z.number().int()
    }),
    available: z.boolean().openapi({ description: 'False when this deployment has no model server configured.' })
  })
  .openapi('LlmMetadataResponse')

const messageSchema = z.object({
  role: z.enum(['system', 'user', 'assistant']),
  content: z.string().min(1)
})

const chatRequestSchema = z
  .object({
    messages: z.array(messageSchema).min(1).max(32),
    max_tokens: z.number().int().min(1).max(LLM_LIMITS.max_output_tokens).default(256),
    json_schema: z.record(z.string(), z.unknown()).optional().openapi({ description: 'JSON Schema the output must follow.' }),
    grammar: z.string().max(8000).optional().openapi({ description: 'GBNF grammar the output must follow.' })
  })
  .refine((body) => !(body.json_schema && body.grammar), { message: 'Send json_schema or grammar, not both' })
  .openapi('LlmChatRequest')

const chatResponseSchema = z
  .object({
    content: z.string(),
    usage: z.object({ prompt_tokens: z.number(), completion_tokens: z.number(), total_tokens: z.number() }),
    timings: z.object({ prompt_ms: z.number(), predicted_ms: z.number(), predicted_per_second: z.number() }),
    model: z.string()
  })
  .openapi('LlmChatResponse')

const errorSchema = (name: string, codes: readonly [string, ...string[]]) =>
  z.object({ error: z.enum(codes) }).openapi(name)

const forbiddenResponse = createJsonResponse(
  'The token lacks the llm scope.',
  errorSchema('LlmForbiddenResponse', ['forbidden']),
  FORBIDDEN_ERROR_BODY
)

const metadataRoute = createRoute({
  method: 'get',
  path: '/',
  operationId: 'getLlmMetadata',
  tags: [LLM_TAG.name],
  summary: 'Get LLM metadata',
  description: 'Returns the pinned model, its revision and SHA-256, the context size and the limits.',
  security: PROTECTED_BEARER_SECURITY,
  responses: {
    200: createJsonResponse('LLM metadata.', metadataSchema, { model: LLM_MODEL, limits: LLM_LIMITS, available: true }),
    401: unauthorizedErrorResponse,
    403: forbiddenResponse
  }
})

const chatRoute = createRoute({
  method: 'post',
  path: '/chat',
  operationId: 'createLlmChat',
  tags: [LLM_TAG.name],
  summary: 'Chat with the shared local model',
  description:
    'Runs one chat completion on the shared local model. Work-space and public content only. Prompts and outputs are never logged or stored.',
  security: PROTECTED_BEARER_SECURITY,
  request: {
    body: { required: true, content: { 'application/json': { schema: chatRequestSchema } } }
  },
  responses: {
    200: createJsonResponse('Completion.', chatResponseSchema, {
      content: 'Hello.',
      usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 },
      timings: { prompt_ms: 400, predicted_ms: 330, predicted_per_second: 9.1 },
      model: LLM_MODEL.name
    }),
    400: createJsonResponse('Invalid request.', errorSchema('LlmInvalidRequestResponse', ['invalid_request']), { error: 'invalid_request' }),
    401: unauthorizedErrorResponse,
    403: forbiddenResponse,
    413: createJsonResponse('Input exceeds the token limit.', errorSchema('LlmInputTooLargeResponse', ['input_too_large']), {
      error: 'input_too_large'
    }),
    429: createJsonResponse('Rate limit reached. See Retry-After.', errorSchema('LlmRateLimitedResponse', ['rate_limited']), {
      error: 'rate_limited'
    }),
    502: createJsonResponse('Model server failed or is unreachable.', errorSchema('LlmFailedResponse', ['llm_failed', 'llm_unavailable']), {
      error: 'llm_unavailable'
    }),
    503: createJsonResponse('The LLM queue is full.', computeBusySchema, computeBusy),
    504: createJsonResponse('The model took too long.', errorSchema('LlmTimedOutResponse', ['llm_timed_out']), { error: 'llm_timed_out' })
  }
})

export function llmRoutes(opts: LlmRouteOptions = {}) {
  const app = new OpenAPIHono<AppEnv>()
  // Its own admission: one running, two waiting, apart from OCR and transcription.
  const admission = opts.admission ?? new ComputeAdmission()
  const limiter = opts.limiter ?? new LlmRateLimiter()

  app.use('*', requireScope(LLM_SCOPE))

  app.openapi(metadataRoute, (c) => c.json({ model: { ...LLM_MODEL }, limits: { ...LLM_LIMITS }, available: Boolean(opts.client) }, 200))

  app.openapi(
    chatRoute,
    async (c) => {
      if (!opts.client) return c.json({ error: 'llm_unavailable' as const }, 502)
      const body = c.req.valid('json')
      if (estimateTokens(body.messages) > LLM_LIMITS.max_input_tokens) return c.json({ error: 'input_too_large' as const }, 413)

      const token = c.get('apiToken')
      const decision = limiter.admit(token.id)
      if (!decision.ok) {
        c.header('Retry-After', String(decision.retryAfterSeconds))
        return c.json({ error: 'rate_limited' as const }, 429)
      }

      const signal = c.req.raw.signal
      const started = Date.now()
      let status = 200
      let tokens = { prompt: 0, completion: 0 }
      try {
        const result = await admission.run(
          () => opts.client!.chat({ messages: body.messages, maxTokens: body.max_tokens, jsonSchema: body.json_schema, grammar: body.grammar, signal }),
          signal
        )
        limiter.recordTokens(token.id, result.usage.total_tokens)
        tokens = { prompt: result.usage.prompt_tokens, completion: result.usage.completion_tokens }
        return c.json({ ...result, model: LLM_MODEL.name }, 200)
      } catch (err) {
        if (err instanceof ComputeBusyError) return c.json((status = 503, computeBusy), 503)
        if (err instanceof LlmError) {
          if (err.code === 'LLM_TIMED_OUT') return c.json((status = 504, { error: 'llm_timed_out' as const }), 504)
          return c.json((status = 502, { error: err.code === 'LLM_UNAVAILABLE' ? ('llm_unavailable' as const) : ('llm_failed' as const) }), 502)
        }
        if (signal.aborted) return c.json((status = 502, { error: 'llm_failed' as const }), 502)
        throw err
      } finally {
        // Counts and timing only. Never prompts or outputs.
        console.log(
          JSON.stringify({ level: 'info', msg: 'llm_chat', token_id: token.id, status, prompt_tokens: tokens.prompt, completion_tokens: tokens.completion, ms: Date.now() - started })
        )
      }
    },
    (result, c) => {
      if (result.success) return
      return c.json({ error: 'invalid_request' }, 400)
    }
  )

  return app
}

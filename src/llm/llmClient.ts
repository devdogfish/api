export const LLM_MODEL = {
  name: 'Qwen3-4B-Q4_K_M',
  file: 'Qwen3-4B-Q4_K_M.gguf',
  source: 'Qwen/Qwen3-4B-GGUF',
  revision: 'bc640142c66e1fdd12af0bd68f40445458f3869b',
  sha256: '7485fe6f11af29433bc51cab58009521f205840f5b4ae3a32fa7f92e8534fdf5',
  license: 'Apache-2.0',
  runtime: 'llama.cpp b11146'
} as const

export const LLM_LIMITS = {
  context_tokens: 8192,
  max_output_tokens: 1024,
  max_input_tokens: 6000,
  requests_per_hour: 60,
  tokens_per_day: 100_000,
  timeout_seconds: 180
} as const

export type ChatMessage = { role: 'system' | 'user' | 'assistant'; content: string }

export type LlmChatInput = {
  messages: ChatMessage[]
  maxTokens: number
  jsonSchema?: Record<string, unknown>
  grammar?: string
  signal?: AbortSignal
}

export type LlmChatResult = {
  content: string
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number }
  timings: { prompt_ms: number; predicted_ms: number; predicted_per_second: number }
}

export type LlmClient = {
  chat(input: LlmChatInput): Promise<LlmChatResult>
}

export class LlmError extends Error {
  constructor(readonly code: 'LLM_TIMED_OUT' | 'LLM_UNAVAILABLE' | 'LLM_FAILED', message: string) {
    super(message)
  }
}

/** Rough upper bound (about 3 characters per token) so oversized prompts fail before reaching the model. */
export function estimateTokens(messages: ChatMessage[]) {
  return Math.ceil(messages.reduce((sum, message) => sum + message.content.length + 8, 0) / 3)
}

const num = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : 0)

/** llama-server on `vm llm`, reachable only over the tailnet and behind a shared key. */
export function createLlamaServerClient(opts: { baseUrl: string; apiKey?: string; fetch?: typeof fetch }): LlmClient {
  const doFetch = opts.fetch ?? fetch
  return {
    async chat(input) {
      const body: Record<string, unknown> = {
        messages: input.messages,
        max_tokens: input.maxTokens,
        temperature: 0,
        stream: false,
        cache_prompt: false,
        chat_template_kwargs: { enable_thinking: false }
      }
      if (input.jsonSchema) body.json_schema = input.jsonSchema
      if (input.grammar) body.grammar = input.grammar

      const timeout = AbortSignal.timeout(LLM_LIMITS.timeout_seconds * 1000)
      const signal = input.signal ? AbortSignal.any([input.signal, timeout]) : timeout
      let response: Response
      try {
        response = await doFetch(`${opts.baseUrl.replace(/\/$/, '')}/v1/chat/completions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...(opts.apiKey ? { authorization: `Bearer ${opts.apiKey}` } : {}) },
          body: JSON.stringify(body),
          signal
        })
      } catch (err) {
        if (timeout.aborted) throw new LlmError('LLM_TIMED_OUT', 'Model request timed out')
        if (input.signal?.aborted) throw err
        throw new LlmError('LLM_UNAVAILABLE', 'Model server is unreachable')
      }
      if (!response.ok) throw new LlmError(response.status === 503 ? 'LLM_UNAVAILABLE' : 'LLM_FAILED', `Model server returned ${response.status}`)

      const data = (await response.json().catch(() => null)) as {
        choices?: { message?: { content?: unknown } }[]
        usage?: Record<string, unknown>
        timings?: Record<string, unknown>
      } | null
      const content = data?.choices?.[0]?.message?.content
      if (typeof content !== 'string') throw new LlmError('LLM_FAILED', 'Model server returned no content')
      const prompt = num(data?.usage?.prompt_tokens)
      const completion = num(data?.usage?.completion_tokens)
      return {
        content,
        usage: { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion },
        timings: {
          prompt_ms: num(data?.timings?.prompt_ms),
          predicted_ms: num(data?.timings?.predicted_ms),
          predicted_per_second: num(data?.timings?.predicted_per_second)
        }
      }
    }
  }
}

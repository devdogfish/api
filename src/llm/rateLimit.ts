import { LLM_LIMITS } from './llmClient'

const HOUR_MS = 3_600_000

export type RateDecision = { ok: true } | { ok: false; retryAfterSeconds: number }

/** Per-token request and daily token budgets, held in memory (one API process; a restart resets them). */
export class LlmRateLimiter {
  private requests = new Map<number, number[]>()
  private daily = new Map<number, { day: string; tokens: number }>()

  constructor(private now: () => number = Date.now) {}

  private dayOf(ms: number) {
    return new Date(ms).toISOString().slice(0, 10)
  }

  /** Reserves a request slot when allowed. */
  admit(tokenId: number): RateDecision {
    const now = this.now()
    const recent = (this.requests.get(tokenId) ?? []).filter((at) => now - at < HOUR_MS)
    const usage = this.daily.get(tokenId)
    if (usage && usage.day === this.dayOf(now) && usage.tokens >= LLM_LIMITS.tokens_per_day) {
      const midnight = Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), new Date(now).getUTCDate() + 1)
      return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil((midnight - now) / 1000)) }
    }
    if (recent.length >= LLM_LIMITS.requests_per_hour) {
      return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil((recent[0] + HOUR_MS - now) / 1000)) }
    }
    recent.push(now)
    this.requests.set(tokenId, recent)
    return { ok: true }
  }

  recordTokens(tokenId: number, tokens: number) {
    const day = this.dayOf(this.now())
    const usage = this.daily.get(tokenId)
    this.daily.set(tokenId, { day, tokens: (usage?.day === day ? usage.tokens : 0) + tokens })
  }
}

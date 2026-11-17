import { z } from '@hono/zod-openapi'

export const computeBusy = { error: 'compute_busy' } as const
export const computeBusySchema = z.object({ error: z.literal(computeBusy.error) })

export class ComputeBusyError extends Error {}

type Waiting = {
  background: boolean
  start(): void
}

/** One engine at a time, with one waiting place reserved for the serial async worker. */
export class ComputeAdmission {
  private active = false
  private waiting: Waiting[] = []

  run<T>(task: () => Promise<T>, signal?: AbortSignal, background = false): Promise<T> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(signal.reason)
        return
      }

      const start = () => {
        signal?.removeEventListener('abort', abort)
        this.active = true
        // Once started, only settlement of the underlying operation releases the slot.
        void Promise.resolve().then(task).then(resolve, reject).finally(() => {
          const next = this.waiting.shift()
          this.active = false
          next?.start()
        })
      }
      const entry = { background, start }
      const abort = () => {
        this.waiting.splice(this.waiting.indexOf(entry), 1)
        reject(signal!.reason)
      }
      if (!this.active) {
        start()
      } else if (this.waiting.filter(entry => entry.background === background).length >= (background ? 1 : 2)) {
        reject(new ComputeBusyError('Compute queue is full'))
      } else {
        this.waiting.push(entry)
        signal?.addEventListener('abort', abort, { once: true })
      }
    })
  }
}

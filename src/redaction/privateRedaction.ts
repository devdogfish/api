import { lstat, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { ComputeAdmission } from '../computeAdmission'

type RedactionProcessor<Job, Verified = true> = {
  redact(job: Job, candidatePath: string): Promise<void>
  verify(job: Job, candidatePath: string): Promise<Verified | false>
}

export class UnverifiedRedactionError extends Error {
  constructor() {
    super('Private redaction candidate was not verified.')
  }
}

/**
 * Compose only in a private process. The processor and scratch root belong to the caller.
 * The returned path is a local review candidate. A processor must await its engine's exit.
 */
export function createPrivateRedactionExecutor<Job>(
  admission: ComputeAdmission,
  scratchRoot: string,
  processor: RedactionProcessor<Job>
) {
  return createVerifiedPrivateRedactionExecutor<Job, string>(admission, scratchRoot, {
    redact: processor.redact,
    async verify(job, candidate) {
      return await processor.verify(job, candidate) === true ? candidate : false
    }
  })
}

export function createVerifiedPrivateRedactionExecutor<Job, Verified>(
  admission: ComputeAdmission,
  scratchRoot: string,
  processor: RedactionProcessor<Job, Verified>
) {
  return (job: Job, signal?: AbortSignal) => admission.run(async () => {
    signal?.throwIfAborted()
    const attempt = await mkdtemp(join(scratchRoot, 'redaction-'))
    const candidate = join(attempt, 'candidate.pdf')

    try {
      signal?.throwIfAborted()
      await processor.redact(job, candidate)
      signal?.throwIfAborted()

      const file = await lstat(candidate)
      if (!file.isFile() || file.size === 0 || file.nlink !== 1) throw new UnverifiedRedactionError()
      const verified = await processor.verify(job, candidate)
      if (verified === false) throw new UnverifiedRedactionError()

      signal?.throwIfAborted()
      return verified
    } catch {
      await rm(attempt, { recursive: true, force: true })
      signal?.throwIfAborted()
      // Redactor or verifier errors may contain original document content.
      throw new UnverifiedRedactionError()
    }
  }, signal)
}

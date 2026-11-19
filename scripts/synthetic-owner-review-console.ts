import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import type { Readable } from 'node:stream'
import type { ExactMatchPdf } from '../src/redaction/exactMatchPdf'
import type { ComputeAdmission } from '../src/computeAdmission'
import { withOwnerConsoleScratch } from './owner-console-scratch'
import { createPrivatePdfReview } from '../src/redaction/privatePdfReview'

type Status = 'prepared' | 'refused' | 'exported'

async function matchesPreview(path: string, expected: Buffer) {
  try {
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    try {
      const stat = await file.stat()
      if (!stat.isFile() || stat.nlink !== 1 || stat.size !== expected.length ||
          stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o600) return false
      const data = Buffer.allocUnsafe(Math.min(1024 * 1024, expected.length))
      const digest = createHash('sha256')
      let position = 0
      while (position < expected.length) {
        const count = Math.min(data.length, expected.length - position)
        const { bytesRead } = await file.read(data, 0, count, position)
        if (bytesRead === 0) return false
        digest.update(data.subarray(0, bytesRead))
        position += bytesRead
      }
      return (await file.stat()).size === expected.length &&
        digest.digest('hex') === createHash('sha256').update(expected).digest('hex')
    } finally {
      await file.close()
    }
  } catch {
    return false
  }
}

/** Synthetic one-document console. Run in the process that owns the admission queue. */
export async function syntheticOwnerReviewConsole(
  ownerInput: Readable,
  config: { admission: ComputeAdmission; scratch: string; vaultRoot: string; workRoot: string; python: string },
  job: ExactMatchPdf,
  notify: (status: Status, approvalLine?: string) => void
) {
  return withOwnerConsoleScratch(config.scratch, config.vaultRoot, config.workRoot, async (scratch, journal) => {
    const reviewer = createPrivatePdfReview(config.admission, scratch, config.python, {
      vaultRoot: config.vaultRoot, workRoot: config.workRoot
    })
    const privatePreview = join(scratch, 'preview.pdf')
    const lines = createInterface({ input: ownerInput, terminal: false })
    let review: Awaited<ReturnType<typeof reviewer.prepare>> | undefined
    let inspection: Awaited<ReturnType<typeof reviewer.inspect>> | undefined
    let approvalLine: string | undefined
    try {
      for await (const line of lines) {
        if (line === 'prepare' && !review) {
          review = await reviewer.prepare(job)
          inspection = await reviewer.inspect(review)
          await journal.prepared(inspection.candidateSha256)
          const preview = await open(privatePreview, 'wx', 0o600)
          try {
            await preview.writeFile(inspection.pdf)
          } finally {
            await preview.close()
          }
          approvalLine = `approve ${inspection.candidateSha256} ${inspection.reviewSha256} ${randomUUID()}`
          notify('prepared', approvalLine)
          continue
        }

        if (!review || !inspection || line !== approvalLine || !await matchesPreview(privatePreview, inspection.pdf)) {
          notify('refused')
          continue
        }

        const approval = await reviewer.approve(review, inspection)
        await journal.retain()
        const destination = await reviewer.exportApprovedCandidate(review, approval)
        notify('exported')
        return destination
      }
    } finally {
      lines.close()
    }
  })
}

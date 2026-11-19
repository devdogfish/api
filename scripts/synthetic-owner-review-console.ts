import { createHash } from 'node:crypto'
import { open, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import type { Readable } from 'node:stream'
import type { ExactMatchPdf } from '../src/redaction/exactMatchPdf'
import type { ComputeAdmission } from '../src/computeAdmission'
import { withOwnerConsoleScratch } from './owner-console-scratch'
import { createPrivatePdfReview } from '../src/redaction/privatePdfReview'

type Status = 'prepared' | 'refused' | 'exported'

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
    let previewCreated = false
    try {
      for await (const line of lines) {
        if (line === 'prepare' && !review) {
          review = await reviewer.prepare(job)
          inspection = await reviewer.inspect(review)
          const preview = await open(privatePreview, 'wx', 0o600)
          previewCreated = true
          try {
            await preview.writeFile(inspection.pdf)
          } finally {
            await preview.close()
          }
          await journal.prepared(inspection.candidateSha256)
          notify('prepared', `approve ${inspection.candidateSha256} ${inspection.reviewSha256}`)
          continue
        }

        if (!review || !inspection || line !== `approve ${inspection.candidateSha256} ${inspection.reviewSha256}` ||
            createHash('sha256').update(await readFile(privatePreview)).digest('hex') !== inspection.reviewSha256) {
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
      try {
        if (review) await reviewer.discard(review)
      } finally {
        if (previewCreated) await rm(privatePreview, { force: true })
      }
    }
  })
}

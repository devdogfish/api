import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { open, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { ComputeAdmission } from '../computeAdmission'
import { createPdfReviewPreparer, type ExactMatchPdf } from './exactMatchPdf'

type Review = Readonly<{ candidateSha256: string; reviewSha256: string }>
type Inspection = Readonly<Review & { pdf: Buffer }>
type Approval = Readonly<{ candidateSha256: string }>

const maxCandidateBytes = 8 * 12_000_000 * 3 + 2 * 1024 * 1024
const maxReviewBytes = 2 * maxCandidateBytes

export class InvalidPdfReviewError extends Error {
  constructor() {
    super('Private PDF review or approval is no longer valid.')
  }
}

async function checkPdf(path: string, digest: string, limit: number, snapshot = false) {
  try {
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    try {
      const info = await file.stat()
      if (!info.isFile() || info.nlink !== 1 || info.size <= 0 || info.size > limit) {
        throw new InvalidPdfReviewError()
      }
      const hash = createHash('sha256')
      const buffer = Buffer.allocUnsafe(snapshot ? info.size : Math.min(info.size, 1024 * 1024))
      let offset = 0
      while (offset < info.size) {
        const start = snapshot ? offset : 0
        const length = Math.min(1024 * 1024, info.size - offset)
        const { bytesRead } = await file.read(buffer, start, length, offset)
        if (!bytesRead) throw new InvalidPdfReviewError()
        hash.update(buffer.subarray(start, start + bytesRead))
        offset += bytesRead
      }
      if ((await file.stat()).size !== info.size || hash.digest('hex') !== digest) {
        throw new InvalidPdfReviewError()
      }
      return buffer
    } finally {
      await file.close()
    }
  } catch {
    throw new InvalidPdfReviewError()
  }
}

/** In-process boundary for the trusted local owner workflow. Handles expire on discard or restart. */
export function createPrivatePdfReview(admission: ComputeAdmission, scratchRoot: string, python: string) {
  const prepare = createPdfReviewPreparer(admission, scratchRoot, python)
  const reviews = new WeakMap<Review, { candidate: string; approval?: Approval }>()
  const inspections = new WeakMap<Inspection, Review>()

  function active(review: Review) {
    const record = reviews.get(review)
    if (!record) throw new InvalidPdfReviewError()
    return record
  }

  function checkCandidate(review: Review, path: string, snapshot = false) {
    return checkPdf(path, review.candidateSha256, maxCandidateBytes, snapshot)
  }

  function checkPreview(review: Review, path: string, snapshot = false) {
    return checkPdf(join(dirname(path), 'review.pdf'), review.reviewSha256, maxReviewBytes, snapshot)
  }

  return {
    async prepare(job: ExactMatchPdf, signal?: AbortSignal): Promise<Review> {
      const { candidate, candidateSha256, reviewSha256 } = await prepare(job, signal)
      const review = Object.freeze({ candidateSha256, reviewSha256 })
      reviews.set(review, { candidate })
      return review
    },

    async inspect(review: Review) {
      const { candidate } = active(review)
      await checkCandidate(review, candidate)
      const pdf = await checkPreview(review, candidate, true)
      active(review)
      const inspection = Object.freeze({ ...review, pdf })
      inspections.set(inspection, review)
      return inspection
    },

    async approve(review: Review, displayed: Inspection): Promise<Approval> {
      const { candidate } = active(review)
      if (inspections.get(displayed) !== review ||
          createHash('sha256').update(displayed.pdf).digest('hex') !== review.reviewSha256) {
        throw new InvalidPdfReviewError()
      }
      await checkCandidate(review, candidate)
      await checkPreview(review, candidate)
      const approval = Object.freeze({ candidateSha256: review.candidateSha256 })
      active(review).approval = approval
      return approval
    },

    async readApprovedCandidate(review: Review, approval: Approval) {
      const record = active(review)
      if (!record.approval || record.approval !== approval) throw new InvalidPdfReviewError()
      // Consume synchronously so concurrent reads cannot reuse the approval.
      delete record.approval
      await checkPreview(review, record.candidate)
      const pdf = await checkCandidate(review, record.candidate, true)
      active(review)
      return pdf
    },

    async discard(review: Review) {
      const { candidate } = active(review)
      reviews.delete(review)
      await rm(dirname(candidate), { recursive: true, force: true })
    }
  }
}

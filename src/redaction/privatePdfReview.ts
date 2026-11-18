import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { link, mkdir, mkdtemp, open, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'
import type { ComputeAdmission } from '../computeAdmission'
import { createPdfReviewPreparer, type ExactMatchPdf } from './exactMatchPdf'

type Review = Readonly<{ candidateSha256: string; reviewSha256: string }>
type Inspection = Readonly<Review & { pdf: Buffer }>
type Approval = Readonly<{ candidateSha256: string }>
type Mapping = { directory: string; digest: string; retained: boolean }
type ReviewRecord = { candidate: string; mapping?: Mapping; approval?: Approval }

const maxCandidateBytes = 8 * 12_000_000 * 3 + 2 * 1024 * 1024
const maxReviewBytes = 2 * maxCandidateBytes
const maxMappingBytes = 4 * 1024 * 1024

export class InvalidPdfReviewError extends Error {
  constructor() {
    super('Private PDF review or approval is no longer valid.')
  }
}

async function checkArtifact(path: string, digest: string, limit: number, snapshot = false) {
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

function contains(parent: string, child: string) {
  const path = relative(parent, child)
  return !isAbsolute(path) && path !== '..' && !path.startsWith('..' + sep)
}

async function privateVaultRoot(path: string, scratchRoot: string) {
  const [vault, scratch] = await Promise.all([realpath(path), realpath(scratchRoot)])
  const info = await stat(vault)
  if (!info.isDirectory() || (info.mode & 0o077) !== 0 || info.uid !== process.getuid?.() ||
      contains(vault, scratch) || contains(scratch, vault)) {
    throw new InvalidPdfReviewError()
  }
  return vault
}

async function workDirectory(path: string, vault: string, scratchRoot: string) {
  const [work, scratch] = await Promise.all([realpath(path), realpath(scratchRoot)])
  const info = await stat(work)
  if (!info.isDirectory() || (info.mode & 0o022) !== 0 || info.uid !== process.getuid?.() ||
      [vault, scratch].some(privateRoot => contains(work, privateRoot) || contains(privateRoot, work))) {
    throw new InvalidPdfReviewError()
  }
  return work
}

/** In-process boundary for the trusted local owner workflow. Handles expire on discard or restart. */
export function createPrivatePdfReview(
  admission: ComputeAdmission, scratchRoot: string, python: string, options?: { vaultRoot?: string; workRoot?: string; paddleModels?: string; personNames?: boolean; phoneRegions?: readonly string[] }
) {
  const phoneRegions = options?.phoneRegions?.slice()
  const prepare = createPdfReviewPreparer(admission, scratchRoot, python, { ...options, phoneRegions })
  const reviews = new WeakMap<Review, ReviewRecord>()
  const inspections = new WeakMap<Inspection, Review>()

  function active(review: Review) {
    const record = reviews.get(review)
    if (!record) throw new InvalidPdfReviewError()
    return record
  }

  function checkCandidate(review: Review, path: string, snapshot = false) {
    return checkArtifact(path, review.candidateSha256, maxCandidateBytes, snapshot)
  }

  function checkPreview(review: Review, path: string, snapshot = false) {
    return checkArtifact(join(dirname(path), 'review.pdf'), review.reviewSha256, maxReviewBytes, snapshot)
  }

  async function checkMapping(mapping?: Mapping) {
    if (mapping) await checkArtifact(join(mapping.directory, 'mapping.json'), mapping.digest, maxMappingBytes)
  }

  async function readApprovedCandidate(review: Review, approval: Approval) {
    const record = active(review)
    if (!record.approval || record.approval !== approval) throw new InvalidPdfReviewError()
    // Consume synchronously so concurrent reads cannot reuse the approval.
    delete record.approval
    await checkPreview(review, record.candidate)
    const pdf = await checkCandidate(review, record.candidate, true)
    await checkMapping(record.mapping)
    active(review)
    if (record.mapping) record.mapping.retained = true
    return pdf
  }

  return {
    async prepare(job: ExactMatchPdf, signal?: AbortSignal): Promise<Review> {
      let draft: string | undefined
      let candidate: string | undefined
      let mapping: Mapping | undefined
      try {
        signal?.throwIfAborted()
        const vault = options?.vaultRoot !== undefined && await privateVaultRoot(options.vaultRoot, scratchRoot)
        if ((options?.personNames || phoneRegions !== undefined) && !vault) throw new InvalidPdfReviewError()
        if (options?.workRoot !== undefined) {
          if (!vault) throw new InvalidPdfReviewError()
          await workDirectory(options.workRoot, vault, scratchRoot)
        }
        if (phoneRegions && (phoneRegions.length > 3 || new Set(phoneRegions).size !== phoneRegions.length ||
            phoneRegions.some(region => !/^[A-Z]{2}$/.test(region)))) {
          throw new InvalidPdfReviewError()
        }
        if (vault) draft = await mkdtemp(join(vault, '.draft-'))
        const prepared = await prepare(job, draft, signal)
        candidate = prepared.candidate
        const { candidateSha256, reviewSha256, mappingSha256 } = prepared
        if (vault) {
          if (!draft || !mappingSha256) throw new InvalidPdfReviewError()
          const directory = join(vault, candidateSha256)
          await mkdir(directory, { mode: 0o700 })
          mapping = { directory, digest: mappingSha256, retained: false }
          await rename(join(draft, 'mapping.json'), join(directory, 'mapping.json'))
          await checkMapping(mapping)
          await rm(draft, { recursive: true, force: true })
        }
        signal?.throwIfAborted()
        const review = Object.freeze({ candidateSha256, reviewSha256 })
        reviews.set(review, { candidate, mapping })
        return review
      } catch (error) {
        await Promise.all([
          draft && rm(draft, { recursive: true, force: true }),
          candidate && rm(dirname(candidate), { recursive: true, force: true }),
          mapping && rm(mapping.directory, { recursive: true, force: true })
        ])
        throw error
      }
    },

    async inspect(review: Review) {
      const { candidate, mapping } = active(review)
      await checkCandidate(review, candidate)
      const pdf = await checkPreview(review, candidate, true)
      await checkMapping(mapping)
      active(review)
      const inspection = Object.freeze({ ...review, pdf })
      inspections.set(inspection, review)
      return inspection
    },

    async approve(review: Review, displayed: Inspection): Promise<Approval> {
      const { candidate, mapping } = active(review)
      if (inspections.get(displayed) !== review ||
          createHash('sha256').update(displayed.pdf).digest('hex') !== review.reviewSha256) {
        throw new InvalidPdfReviewError()
      }
      await checkCandidate(review, candidate)
      await checkPreview(review, candidate)
      await checkMapping(mapping)
      const approval = Object.freeze({ candidateSha256: review.candidateSha256 })
      active(review).approval = approval
      return approval
    },

    readApprovedCandidate,

    async exportApprovedCandidate(review: Review, approval: Approval) {
      const { mapping } = active(review)
      if (!mapping || !options?.vaultRoot || options.workRoot === undefined) throw new InvalidPdfReviewError()
      const vault = await privateVaultRoot(options.vaultRoot, scratchRoot)
      if (dirname(mapping.directory) !== vault) throw new InvalidPdfReviewError()
      const work = await workDirectory(options.workRoot, vault, scratchRoot)
      const pdf = await readApprovedCandidate(review, approval)
      const destination = join(work, review.candidateSha256 + '.pdf')
      const staging = await mkdtemp(join(work, '.export-'))
      try {
        const temporary = join(staging, 'candidate.pdf')
        await writeFile(temporary, pdf, { flag: 'wx', mode: 0o640 })
        // Publish only complete bytes, without replacing an existing export.
        await link(temporary, destination)
        return destination
      } finally {
        await rm(staging, { recursive: true, force: true })
      }
    },

    async discard(review: Review) {
      const { candidate, mapping } = active(review)
      reviews.delete(review)
      await Promise.all([
        rm(dirname(candidate), { recursive: true, force: true }),
        mapping && !mapping.retained && rm(mapping.directory, { recursive: true, force: true })
      ])
    }
  }
}

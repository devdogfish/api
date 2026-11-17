import { writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ComputeAdmission } from '../computeAdmission'
import { createVerifiedPrivateRedactionExecutor } from './privateRedaction'

export type ExactMatchPdf = {
  pdf: Uint8Array
  identifiers: readonly string[]
  safeTextByPage: readonly (readonly string[])[]
  language?: 'eng' | 'deu'
  structuredIdentifiers?: boolean
}

const worker = fileURLToPath(new URL('./exact_match_pdf.py', import.meta.url))
const maxPdfBytes = 25 * 1024 * 1024

async function run(python: string, mode: string, candidate: string) {
  const child = Bun.spawn([python, worker, mode, dirname(candidate)], {
    stdin: 'ignore', stdout: 'pipe', stderr: 'ignore',
    env: { PATH: process.env.PATH ?? '', PYTHONNOUSERSITE: '1', PYTHONDONTWRITEBYTECODE: '1' }
  })
  const [status, output] = await Promise.all([child.exited, new Response(child.stdout).text()])
  return status === 0 ? output : false
}

function createPdfRedactor<Verified>(
  admission: ComputeAdmission, scratchRoot: string, python: string, review: boolean,
  verify: (candidate: string) => Promise<Verified | false>
) {
  return createVerifiedPrivateRedactionExecutor<ExactMatchPdf, Verified>(admission, scratchRoot, {
    async redact(job, candidate) {
      if (!job.pdf.byteLength || job.pdf.byteLength > maxPdfBytes || (!job.identifiers.length && job.structuredIdentifiers !== true) ||
          job.identifiers.length > 128 || job.safeTextByPage.length > 8 ||
          job.identifiers.some(value => typeof value !== 'string' || value.length > 256) ||
          job.safeTextByPage.some(page => !page.length || page.length > 32 ||
            page.some(value => typeof value !== 'string' || value.length > 256))) {
        throw new Error('PDF or exact-match dictionary is outside the supported bounds.')
      }

      const directory = dirname(candidate)
      await writeFile(join(directory, 'source.pdf'), job.pdf, { flag: 'wx', mode: 0o600 })
      await writeFile(join(directory, 'dictionary.json'), JSON.stringify({
        identifiers: job.identifiers,
        safeTextByPage: job.safeTextByPage,
        language: job.language ?? 'eng',
        structuredIdentifiers: job.structuredIdentifiers ?? false
      }), { flag: 'wx', mode: 0o600 })
      if (await run(python, review ? 'redact-review' : 'redact', candidate) === false) {
        throw new Error('Private PDF redaction failed.')
      }
    },
    verify(_job, candidate) {
      return verify(candidate)
    }
  })
}

/** Wire only into a private composition, with its existing OCR/Whisper admission instance. */
export function createExactMatchPdfRedactor(admission: ComputeAdmission, scratchRoot: string, python: string) {
  return createPdfRedactor<string>(admission, scratchRoot, python, false, async candidate =>
    await run(python, 'verify', candidate) === false ? false : candidate
  )
}

/** Digests are emitted only after the worker verifies the exact candidate bytes. */
export function createPdfReviewPreparer(admission: ComputeAdmission, scratchRoot: string, python: string) {
  type Prepared = { candidate: string; candidateSha256: string; reviewSha256: string }
  return createPdfRedactor<Prepared>(admission, scratchRoot, python, true, async candidate => {
    const output = await run(python, 'verify-review', candidate)
    const proof = output !== false && /^([0-9a-f]{64}) ([0-9a-f]{64})\n$/.exec(output)
    if (!proof) return false
    const [, candidateSha256, reviewSha256] = proof
    return { candidate, candidateSha256, reviewSha256 }
  })
}

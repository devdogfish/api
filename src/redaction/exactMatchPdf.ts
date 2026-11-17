import { writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ComputeAdmission } from '../computeAdmission'
import { createVerifiedPrivateRedactionExecutor } from './privateRedaction'

export type ExactMatchPdf = {
  pdf: Uint8Array
  identifiers: readonly string[]
  identifierTypes?: readonly ("PERSON" | "IDENTIFIER")[]
  safeTextByPage: readonly (readonly string[])[]
  language?: 'eng' | 'deu'
  structuredIdentifiers?: boolean
}

const worker = fileURLToPath(new URL('./exact_match_pdf.py', import.meta.url))
const maxPdfBytes = 25 * 1024 * 1024

async function run(python: string, mode: string, candidate: string, vaultDraft?: string) {
  const args = [python, worker, mode, dirname(candidate)]
  if (vaultDraft) args.push(vaultDraft)
  const child = Bun.spawn(args, {
    stdin: 'ignore', stdout: 'pipe', stderr: 'ignore',
    env: { PATH: process.env.PATH ?? '', PYTHONNOUSERSITE: '1', PYTHONDONTWRITEBYTECODE: '1' }
  })
  const [status, output] = await Promise.all([child.exited, new Response(child.stdout).text()])
  return status === 0 ? output : false
}

function createPdfRedactor<Verified>(
  admission: ComputeAdmission, scratchRoot: string, python: string, review: boolean,
  verify: (candidate: string, vaultDraft?: string) => Promise<Verified | false>
) {
  type Draft = { job: ExactMatchPdf; vaultDraft?: string }
  return createVerifiedPrivateRedactionExecutor<Draft, Verified>(admission, scratchRoot, {
    async redact({ job, vaultDraft }, candidate) {
      if (!job.pdf.byteLength || job.pdf.byteLength > maxPdfBytes || (!job.identifiers.length && job.structuredIdentifiers !== true) ||
          job.identifiers.length > 128 || job.safeTextByPage.length > 8 ||
          (vaultDraft && job.identifierTypes && (!Array.isArray(job.identifierTypes) ||
            job.identifierTypes.length !== job.identifiers.length ||
            job.identifierTypes.some(kind => kind !== 'PERSON' && kind !== 'IDENTIFIER'))) ||
          job.identifiers.some(value => typeof value !== 'string' || value.length > 256) ||
          job.safeTextByPage.some(page => !page.length || page.length > 32 ||
            page.some(value => typeof value !== 'string' || value.length > 256))) {
        throw new Error('PDF or exact-match dictionary is outside the supported bounds.')
      }

      const directory = dirname(candidate)
      await writeFile(join(directory, 'source.pdf'), job.pdf, { flag: 'wx', mode: 0o600 })
      await writeFile(join(directory, 'dictionary.json'), JSON.stringify({
        identifiers: job.identifiers,
        identifierTypes: vaultDraft ? job.identifierTypes : undefined,
        safeTextByPage: job.safeTextByPage,
        language: job.language ?? 'eng',
        structuredIdentifiers: job.structuredIdentifiers ?? false
      }), { flag: 'wx', mode: 0o600 })
      if (await run(python, review ? 'redact-review' : 'redact', candidate, vaultDraft) === false) {
        throw new Error('Private PDF redaction failed.')
      }
    },
    verify({ vaultDraft }, candidate) {
      return verify(candidate, vaultDraft)
    }
  })
}

/** Wire only into a private composition, with its existing OCR/Whisper admission instance. */
export function createExactMatchPdfRedactor(admission: ComputeAdmission, scratchRoot: string, python: string) {
  const execute = createPdfRedactor<string>(admission, scratchRoot, python, false, async candidate =>
    await run(python, 'verify', candidate) === false ? false : candidate
  )
  return (job: ExactMatchPdf, signal?: AbortSignal) => execute({ job }, signal)
}

/** Digests are emitted only after the worker verifies the exact candidate bytes. */
export function createPdfReviewPreparer(admission: ComputeAdmission, scratchRoot: string, python: string) {
  type Prepared = { candidate: string; candidateSha256: string; reviewSha256: string; mappingSha256?: string }
  const execute = createPdfRedactor<Prepared>(admission, scratchRoot, python, true, async (candidate, vaultDraft) => {
    const output = await run(python, 'verify-review', candidate, vaultDraft)
    const proof = output !== false && /^([0-9a-f]{64}) ([0-9a-f]{64})(?: ([0-9a-f]{64}))?\n$/.exec(output)
    if (!proof) return false
    const [, candidateSha256, reviewSha256, mappingSha256] = proof
    if (Boolean(mappingSha256) !== Boolean(vaultDraft)) return false
    return { candidate, candidateSha256, reviewSha256, mappingSha256 }
  })
  return (job: ExactMatchPdf, vaultDraft?: string, signal?: AbortSignal) => execute({ job, vaultDraft }, signal)
}

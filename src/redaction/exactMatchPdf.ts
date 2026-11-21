import { writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ComputeAdmission } from '../computeAdmission'
import type { DocumentType } from './documentTypes'
import { createVerifiedPrivateRedactionExecutor } from './privateRedaction'

export type ExactMatchPdf = {
  pdf: Uint8Array
  identifiers: readonly string[]
  identifierTypes?: readonly ("PERSON" | "IDENTIFIER")[]
  safeTextByPage: readonly (readonly string[])[]
  language?: 'eng' | 'deu'
  structuredIdentifiers?: boolean
  /** Required for review; Vault-only and unknown types are refused before any redacted copy exists. */
  documentType?: DocumentType
}

const worker = fileURLToPath(new URL('./exact_match_pdf.py', import.meta.url))
const maxPdfBytes = 25 * 1024 * 1024

type Detectors = { paddleModels?: string; personNames?: boolean; phoneRegions?: readonly string[]; llmNames?: string }

async function run(python: string, mode: string, candidate: string, vaultDraft?: string, detectors?: Detectors) {
  const { paddleModels, personNames, phoneRegions, llmNames } = detectors ?? {}
  const args = [python, worker, mode, dirname(candidate)]
  if (vaultDraft) args.push(vaultDraft)
  if (paddleModels !== undefined) args.push('--paddle-models', resolve(paddleModels))
  if (personNames) args.push('--person-names')
  if (phoneRegions !== undefined) args.push('--phone-regions', phoneRegions.join(','))
  if (llmNames !== undefined) args.push('--llm-names', resolve(llmNames))
  const env: Record<string, string> = { PATH: process.env.PATH ?? '', PYTHONNOUSERSITE: '1', PYTHONDONTWRITEBYTECODE: '1' }
  if (llmNames !== undefined && process.env.GIRKE_LLAMA_COMPLETION) env.GIRKE_LLAMA_COMPLETION = process.env.GIRKE_LLAMA_COMPLETION
  const child = Bun.spawn(args, {
    stdin: 'ignore', stdout: 'pipe', stderr: 'ignore',
    env: paddleModels === undefined ? env : { ...env, HOME: dirname(candidate) },
    // The local name model runs on CPU on vm ai and needs longer than the other detectors.
    timeout: llmNames !== undefined ? 1_800_000 : paddleModels !== undefined || personNames || phoneRegions !== undefined ? 300_000 : undefined,
    killSignal: 'SIGKILL'
  })
  const [status, output] = await Promise.all([child.exited, new Response(child.stdout).text()])
  return status === 0 ? output : false
}

function createPdfRedactor<Verified>(
  admission: ComputeAdmission, scratchRoot: string, python: string, review: boolean,
  verify: (candidate: string, vaultDraft?: string) => Promise<Verified | false>,
  detectors?: Detectors
) {
  type Draft = { job: ExactMatchPdf; vaultDraft?: string }
  return createVerifiedPrivateRedactionExecutor<Draft, Verified>(admission, scratchRoot, {
    async redact({ job, vaultDraft }, candidate) {
      if (!job.pdf.byteLength || job.pdf.byteLength > maxPdfBytes || (!job.identifiers.length && job.structuredIdentifiers !== true && !detectors?.personNames && detectors?.phoneRegions === undefined) ||
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
      if (await run(python, review ? 'redact-review' : 'redact', candidate, vaultDraft, detectors) === false) {
        throw new Error('Private PDF redaction failed.')
      }
    },
    verify({ vaultDraft }, candidate) {
      return verify(candidate, vaultDraft)
    }
  })
}

/** Wire only into a private composition, with its existing OCR/Whisper admission instance. */
export function createExactMatchPdfRedactor(
  admission: ComputeAdmission, scratchRoot: string, python: string, options?: { paddleModels: string }
) {
  const execute = createPdfRedactor<string>(admission, scratchRoot, python, false, async candidate =>
    await run(python, 'verify', candidate) === false ? false : candidate, options
  )
  return (job: ExactMatchPdf, signal?: AbortSignal) => execute({ job }, signal)
}

/** Digests are emitted only after the worker verifies the exact candidate bytes. */
export function createPdfReviewPreparer(
  admission: ComputeAdmission, scratchRoot: string, python: string, detectors?: Detectors
) {
  type Prepared = { candidate: string; candidateSha256: string; reviewSha256: string; mappingSha256?: string }
  const execute = createPdfRedactor<Prepared>(admission, scratchRoot, python, true, async (candidate, vaultDraft) => {
    const output = await run(python, 'verify-review', candidate, vaultDraft, {
      personNames: detectors?.personNames, phoneRegions: detectors?.phoneRegions
    })
    const proof = output !== false && /^([0-9a-f]{64}) ([0-9a-f]{64})(?: ([0-9a-f]{64}))?\n$/.exec(output)
    if (!proof) return false
    const [, candidateSha256, reviewSha256, mappingSha256] = proof
    if (Boolean(mappingSha256) !== Boolean(vaultDraft)) return false
    return { candidate, candidateSha256, reviewSha256, mappingSha256 }
  }, detectors)
  return (job: ExactMatchPdf, vaultDraft?: string, signal?: AbortSignal) => execute({ job, vaultDraft }, signal)
}

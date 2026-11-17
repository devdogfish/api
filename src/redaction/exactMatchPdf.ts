import { writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ComputeAdmission } from '../computeAdmission'
import { createPrivateRedactionExecutor } from './privateRedaction'

export type ExactMatchPdf = {
  pdf: Uint8Array
  identifiers: readonly string[]
  safeTextByPage: readonly (readonly string[])[]
  language?: 'eng' | 'deu'
}

const worker = fileURLToPath(new URL('./exact_match_pdf.py', import.meta.url))
const maxPdfBytes = 25 * 1024 * 1024

/** Wire only into a private composition, with its existing OCR/Whisper admission instance. */
export function createExactMatchPdfRedactor(admission: ComputeAdmission, scratchRoot: string, python: string) {
  async function run(mode: 'redact' | 'verify', candidate: string) {
    const child = Bun.spawn([python, worker, mode, dirname(candidate)], {
      stdin: 'ignore', stdout: 'ignore', stderr: 'ignore',
      env: { PATH: process.env.PATH ?? '', PYTHONNOUSERSITE: '1', PYTHONDONTWRITEBYTECODE: '1' }
    })
    return (await child.exited) === 0
  }

  return createPrivateRedactionExecutor<ExactMatchPdf>(admission, scratchRoot, {
    async redact(job, candidate) {
      if (!job.pdf.byteLength || job.pdf.byteLength > maxPdfBytes || !job.identifiers.length ||
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
        language: job.language ?? 'eng'
      }), { flag: 'wx', mode: 0o600 })
      if (!await run('redact', candidate)) throw new Error('Private PDF redaction failed.')
    },
    verify(_job, candidate) {
      return run('verify', candidate)
    }
  })
}

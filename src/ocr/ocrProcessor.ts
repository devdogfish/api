import { rm } from 'node:fs/promises'

export const OCR_MODEL = 'tesseract-latin-psm11-gray'
export const OCR_TIMEOUT_SECONDS = 20
export const OCR_TIMEOUT_MS = OCR_TIMEOUT_SECONDS * 1000
export const DEFAULT_OCR_MAX_UPLOAD_BYTES = 25 * 1024 * 1024
export const SUPPORTED_IMAGE_FORMATS = ['jpg', 'jpeg', 'png', 'webp', 'tif', 'tiff', 'bmp'] as const
export const SUPPORTED_IMAGE_EXTENSIONS = new Set<string>(SUPPORTED_IMAGE_FORMATS)

const TESSERACT_LATIN_SCRIPT_LANGUAGES = ['Latin', 'script/Latin'] as const
const OCR_PSM = '11'
const OCR_OEM = '1'

export type OcrProcessorResult = {
  text: string
  lines: string[]
  processing_seconds: number
  model: typeof OCR_MODEL
}

export type OcrProcessor = {
  recognize(input: { inputPath: string; timeoutMs: number }): Promise<OcrProcessorResult>
}

export type OcrProcessorErrorCode = 'OCR_TIMED_OUT' | 'IMAGE_PREPROCESSING_FAILED' | 'OCR_FAILED'

export class OcrProcessorError extends Error {
  constructor(
    readonly code: OcrProcessorErrorCode,
    message: string
  ) {
    super(message)
    this.name = 'OcrProcessorError'
  }
}

type CommandFailureCode = Exclude<OcrProcessorErrorCode, 'OCR_TIMED_OUT'>

type CommandResult = {
  stdout: string
  stderr: string
}

const cachedTesseractLanguages = new Map<string, string>()

function linesFromText(text: string) {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
}

function processingSeconds(startedAt: number) {
  return Number(((performance.now() - startedAt) / 1000).toFixed(3))
}

async function streamToText(stream: ReadableStream<Uint8Array> | null) {
  if (!stream) return ''
  return await new Response(stream).text()
}

async function runCommand(args: string[], timeoutMs: number, failureCode: CommandFailureCode): Promise<CommandResult> {
  if (timeoutMs <= 0) {
    throw new OcrProcessorError('OCR_TIMED_OUT', 'OCR processing timed out')
  }

  let process: Bun.Subprocess<'ignore', 'pipe', 'pipe'>
  try {
    process = Bun.spawn(args, {
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe'
    })
  } catch (err) {
    throw new OcrProcessorError(failureCode, err instanceof Error ? err.message : 'OCR processor command failed')
  }

  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    process.kill('SIGKILL')
  }, Math.max(1, Math.ceil(timeoutMs)))

  try {
    const [exitCode, stdout, stderr] = await Promise.all([
      process.exited,
      streamToText(process.stdout),
      streamToText(process.stderr)
    ])

    if (timedOut) {
      throw new OcrProcessorError('OCR_TIMED_OUT', 'OCR processing timed out')
    }
    if (exitCode !== 0) {
      throw new OcrProcessorError(failureCode, stderr.trim() || `OCR processor command exited with ${exitCode}`)
    }

    return { stdout, stderr }
  } finally {
    clearTimeout(timer)
  }
}

async function detectTesseractLatinLanguage(tesseractPath: string, timeoutMs: number) {
  const cached = cachedTesseractLanguages.get(tesseractPath)
  if (cached) return cached

  const { stdout } = await runCommand([tesseractPath, '--list-langs'], timeoutMs, 'OCR_FAILED')
  const languages = new Set(stdout.split(/\r?\n/).map((line) => line.trim()))
  const language = TESSERACT_LATIN_SCRIPT_LANGUAGES.find((candidate) => languages.has(candidate))
  if (!language) {
    throw new OcrProcessorError('OCR_FAILED', 'Tesseract Latin script language data is not installed')
  }

  cachedTesseractLanguages.set(tesseractPath, language)
  return language
}

export function createTesseractOcrProcessor(
  opts: {
    ffmpegPath?: string
    tesseractPath?: string
  } = {}
): OcrProcessor {
  const ffmpegPath = opts.ffmpegPath ?? 'ffmpeg'
  const tesseractPath = opts.tesseractPath ?? 'tesseract'

  return {
    async recognize(input) {
      const startedAt = performance.now()
      const deadline = startedAt + input.timeoutMs
      const grayscalePath = `${input.inputPath}.gray.png`
      const remainingMs = () => deadline - performance.now()

      try {
        await runCommand(
          [
            ffmpegPath,
            '-hide_banner',
            '-loglevel',
            'error',
            '-y',
            '-i',
            input.inputPath,
            '-frames:v',
            '1',
            '-vf',
            'format=gray',
            grayscalePath
          ],
          remainingMs(),
          'IMAGE_PREPROCESSING_FAILED'
        )

        const language = await detectTesseractLatinLanguage(tesseractPath, remainingMs())
        const { stdout } = await runCommand(
          [tesseractPath, grayscalePath, 'stdout', '-l', language, '--psm', OCR_PSM, '--oem', OCR_OEM],
          remainingMs(),
          'OCR_FAILED'
        )
        const text = stdout.trim()

        return {
          text,
          lines: linesFromText(text),
          processing_seconds: processingSeconds(startedAt),
          model: OCR_MODEL
        }
      } finally {
        await rm(grayscalePath, { force: true })
      }
    }
  }
}

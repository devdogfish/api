import { spawn } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { basename, join } from 'node:path'

export type TranscriptionMediaChunk = {
  chunkIndex: number
  startSeconds: number
  endSeconds: number
  path: string
}

export type PreparedTranscriptionMedia = {
  normalizedAudioPath: string
  durationSeconds: number
  chunks: TranscriptionMediaChunk[]
}

export type TranscriptionMediaProcessor = {
  prepare(inputPath: string): Promise<PreparedTranscriptionMedia>
}

export type TranscriptionDurationProbe = {
  probe(inputPath: string): Promise<{ durationSeconds: number | null }>
}

export type TranscriptionMediaProcessorErrorCode = 'UNSUPPORTED_MEDIA_FORMAT' | 'MEDIA_NORMALIZATION_FAILED'

export class TranscriptionMediaProcessorError extends Error {
  constructor(
    readonly code: TranscriptionMediaProcessorErrorCode,
    message: string
  ) {
    super(message)
  }
}

type CommandResult = {
  stdout: string
  stderr: string
}

type CommandRunner = (command: string, args: string[]) => Promise<CommandResult>

export type FfmpegMediaProcessorOptions = {
  chunkTargetSeconds?: number
  chunkOverlapSeconds?: number
  workDirForInput?: (inputPath: string) => string
  runCommand?: CommandRunner
}

function runCommand(command: string, args: string[]): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    child.stdout.on('data', (chunk) => stdout.push(Buffer.from(chunk)))
    child.stderr.on('data', (chunk) => stderr.push(Buffer.from(chunk)))
    child.on('error', reject)
    child.on('close', (code) => {
      const result = {
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8')
      }
      if (code === 0) {
        resolve(result)
        return
      }
      reject(new Error(`${command} exited ${code}: ${result.stderr.trim()}`))
    })
  })
}

function roundSeconds(value: number) {
  return Math.round(value * 1000) / 1000
}

export function createFfmpegDurationProbe(opts: Pick<FfmpegMediaProcessorOptions, 'runCommand'> = {}): TranscriptionDurationProbe {
  const run = opts.runCommand ?? runCommand

  return {
    async probe(inputPath) {
      try {
        const probe = await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', inputPath])
        const durationSeconds = roundSeconds(Number.parseFloat(probe.stdout.trim()))
        return {
          durationSeconds: Number.isFinite(durationSeconds) && durationSeconds > 0 ? durationSeconds : null
        }
      } catch {
        return { durationSeconds: null }
      }
    }
  }
}

export function createFfmpegMediaProcessor(opts: FfmpegMediaProcessorOptions = {}): TranscriptionMediaProcessor {
  const chunkTargetSeconds = opts.chunkTargetSeconds ?? 60
  const chunkOverlapSeconds = opts.chunkOverlapSeconds ?? 5
  const run = opts.runCommand ?? runCommand
  const workDirForInput = opts.workDirForInput ?? ((inputPath: string) => `${inputPath}.work`)

  return {
    async prepare(inputPath) {
      const workDir = workDirForInput(inputPath)
      await mkdir(workDir, { recursive: true })

      const normalizedAudioPath = join(workDir, `${basename(inputPath)}.normalized.wav`)
      try {
        await run('ffmpeg', ['-y', '-i', inputPath, '-vn', '-ac', '1', '-ar', '16000', '-f', 'wav', normalizedAudioPath])

        const probe = await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', normalizedAudioPath])
        const durationSeconds = roundSeconds(Number.parseFloat(probe.stdout.trim()))
        if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
          throw new Error('Unable to read normalized media duration')
        }

        const chunks: TranscriptionMediaChunk[] = []
        const stepSeconds = Math.max(1, chunkTargetSeconds - chunkOverlapSeconds)
        for (let startSeconds = 0; startSeconds < durationSeconds; startSeconds += stepSeconds) {
          const chunkIndex = chunks.length
          const endSeconds = roundSeconds(Math.min(startSeconds + chunkTargetSeconds, durationSeconds))
          const chunkPath = join(workDir, `chunk-${String(chunkIndex).padStart(5, '0')}.wav`)
          await run('ffmpeg', [
            '-y',
            '-ss',
            String(roundSeconds(startSeconds)),
            '-i',
            normalizedAudioPath,
            '-t',
            String(roundSeconds(endSeconds - startSeconds)),
            '-ac',
            '1',
            '-ar',
            '16000',
            '-f',
            'wav',
            chunkPath
          ])
          chunks.push({
            chunkIndex,
            startSeconds: roundSeconds(startSeconds),
            endSeconds,
            path: chunkPath
          })
        }

        return {
          normalizedAudioPath,
          durationSeconds,
          chunks
        }
      } catch (err) {
        if (err instanceof TranscriptionMediaProcessorError) throw err
        throw new TranscriptionMediaProcessorError('MEDIA_NORMALIZATION_FAILED', err instanceof Error ? err.message : 'Media normalization failed')
      }
    }
  }
}

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import { createFfmpegMediaProcessor, TranscriptionMediaProcessorError } from '../src/transcription/mediaProcessor'

describe('ffmpeg transcription media processor', () => {
  test('normalizes media and splits it into overlapping chunks', async () => {
    const workDir = await mkdtemp(join(tmpdir(), 'girke-media-processor-test-'))
    const commands: Array<{ command: string; args: string[] }> = []
    const processor = createFfmpegMediaProcessor({
      workDirForInput: () => workDir,
      runCommand: async (command, args) => {
        commands.push({ command, args })
        if (command === 'ffprobe') return { stdout: '125.4\n', stderr: '' }
        return { stdout: '', stderr: '' }
      }
    })

    try {
      const prepared = await processor.prepare('/tmp/input.mp4')

      expect(prepared.durationSeconds).toBe(125.4)
      expect(prepared.normalizedAudioPath).toBe(join(workDir, 'input.mp4.normalized.wav'))
      expect(prepared.chunks.map(({ chunkIndex, startSeconds, endSeconds, path }) => ({ chunkIndex, startSeconds, endSeconds, path }))).toEqual([
        { chunkIndex: 0, startSeconds: 0, endSeconds: 60, path: join(workDir, 'chunk-00000.wav') },
        { chunkIndex: 1, startSeconds: 55, endSeconds: 115, path: join(workDir, 'chunk-00001.wav') },
        { chunkIndex: 2, startSeconds: 110, endSeconds: 125.4, path: join(workDir, 'chunk-00002.wav') }
      ])
      expect(commands[0]).toEqual({
        command: 'ffmpeg',
        args: ['-y', '-i', '/tmp/input.mp4', '-vn', '-ac', '1', '-ar', '16000', '-f', 'wav', join(workDir, 'input.mp4.normalized.wav')]
      })
      expect(commands.filter((command) => command.command === 'ffmpeg')).toHaveLength(4)
      expect(commands.filter((command) => command.command === 'ffprobe')).toHaveLength(1)
    } finally {
      await rm(workDir, { recursive: true, force: true })
    }
  })

  test('wraps ffmpeg failures as media normalization failures', async () => {
    const workDir = await mkdtemp(join(tmpdir(), 'girke-media-processor-test-'))
    const processor = createFfmpegMediaProcessor({
      workDirForInput: () => workDir,
      runCommand: async () => {
        throw new Error('ffmpeg failed')
      }
    })

    try {
      await expect(processor.prepare('/tmp/input.mp4')).rejects.toEqual(new TranscriptionMediaProcessorError('MEDIA_NORMALIZATION_FAILED', 'ffmpeg failed'))
    } finally {
      await rm(workDir, { recursive: true, force: true })
    }
  })
})

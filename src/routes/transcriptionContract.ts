import { z } from '@hono/zod-openapi'

export const TRANSCRIPTION_LEVELS = ['low', 'medium', 'high'] as const
export const TRANSCRIPTION_LANGUAGE_CODES = ['en', 'de'] as const
export const TRANSCRIPTION_LANGUAGE_HINTS = ['auto', ...TRANSCRIPTION_LANGUAGE_CODES] as const
export const TRANSCRIPTION_JOB_STATUSES = ['queued', 'processing', 'completed', 'failed', 'cancelled'] as const
export const SUPPORTED_AUDIO_EXTENSIONS = ['wav', 'mp3', 'm4a', 'aac', 'ogg', 'opus', 'flac', 'webm'] as const
export const SUPPORTED_VIDEO_EXTENSIONS = ['mp4', 'mov', 'mkv', 'webm', 'avi'] as const
export const SUPPORTED_MEDIA_EXTENSIONS = new Set<string>([...SUPPORTED_AUDIO_EXTENSIONS, ...SUPPORTED_VIDEO_EXTENSIONS])
export const DEFAULT_TRANSCRIPTION_LEVEL = 'medium' as const
export const TRANSCRIPTION_LANGUAGE_OPTIONAL = true as const
export const TRANSCRIPTION_LANGUAGE_HINT_METADATA = [
  { code: 'en', name: 'English' },
  { code: 'de', name: 'German' }
] as const

export type TranscriptionLevel = (typeof TRANSCRIPTION_LEVELS)[number]
export type TranscriptionLanguageCode = (typeof TRANSCRIPTION_LANGUAGE_CODES)[number]
export type TranscriptionLanguage = (typeof TRANSCRIPTION_LANGUAGE_HINTS)[number]
export type TranscriptionJobStatus = (typeof TRANSCRIPTION_JOB_STATUSES)[number]

function buildTranscriptionMetadataResponse() {
  return {
    levels: [...TRANSCRIPTION_LEVELS],
    languages: TRANSCRIPTION_LANGUAGE_HINT_METADATA.map((language) => ({ ...language })),
    default_level: DEFAULT_TRANSCRIPTION_LEVEL,
    language_optional: TRANSCRIPTION_LANGUAGE_OPTIONAL,
    accepted_media: {
      audio: [...SUPPORTED_AUDIO_EXTENSIONS],
      video: [...SUPPORTED_VIDEO_EXTENSIONS]
    }
  }
}

export const transcriptionMetadataResponseExample = buildTranscriptionMetadataResponse()

export function createTranscriptionMetadataResponse() {
  return buildTranscriptionMetadataResponse()
}

export const transcriptionLanguageHintMetadataSchema = z
  .object({
    code: z
      .enum(TRANSCRIPTION_LANGUAGE_CODES)
      .openapi({ example: TRANSCRIPTION_LANGUAGE_HINT_METADATA[0].code, description: 'Language Hint code accepted by transcription requests.' }),
    name: z
      .string()
      .openapi({ example: TRANSCRIPTION_LANGUAGE_HINT_METADATA[0].name, description: 'Human-readable name for the supported Language Hint value.' })
  })
  .openapi('TranscriptionLanguageHintMetadata', {
    description:
      'Supported language metadata for request Language Hint values. This is distinct from the Detected Language returned after transcription.'
  })

export const transcriptionMetadataResponseSchema = z
  .object({
    levels: z
      .array(z.enum(TRANSCRIPTION_LEVELS))
      .openapi({ example: transcriptionMetadataResponseExample.levels, description: 'Supported transcription accuracy levels.' }),
    languages: z
      .array(transcriptionLanguageHintMetadataSchema)
      .openapi({
        example: transcriptionMetadataResponseExample.languages,
        description:
          'Supported request Language Hint values. These entries document client hints only and are separate from the Detected Language in transcription results.'
      }),
    default_level: z
      .enum(TRANSCRIPTION_LEVELS)
      .openapi({ example: transcriptionMetadataResponseExample.default_level, description: 'Default transcription level when the request omits level.' }),
    language_optional: z
      .literal(true)
      .openapi({ example: transcriptionMetadataResponseExample.language_optional, description: 'Whether the Language Hint request field is optional.' }),
    accepted_media: z
      .object({
        audio: z
          .array(z.enum(SUPPORTED_AUDIO_EXTENSIONS))
          .openapi({
            example: transcriptionMetadataResponseExample.accepted_media.audio,
            description: 'Accepted audio filename extensions for transcription uploads.'
          }),
        video: z
          .array(z.enum(SUPPORTED_VIDEO_EXTENSIONS))
          .openapi({
            example: transcriptionMetadataResponseExample.accepted_media.video,
            description: 'Accepted video filename extensions for transcription uploads.'
          })
      })
      .openapi({
        description: 'Accepted media extensions grouped by audio and video upload types.'
      })
  })
  .openapi('TranscriptionMetadataResponse')

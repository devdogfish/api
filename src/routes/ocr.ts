import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, extname, join } from 'node:path'
import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi'
import type { AppEnv } from '../appEnv'
import {
  DEFAULT_OCR_MAX_UPLOAD_BYTES,
  OCR_MODEL,
  OCR_TIMEOUT_MS,
  OCR_TIMEOUT_SECONDS,
  OcrProcessorError,
  SUPPORTED_IMAGE_EXTENSIONS,
  SUPPORTED_IMAGE_FORMATS,
  createTesseractOcrProcessor,
  type OcrProcessor
} from '../ocr/ocrProcessor'
import { createJsonResponse, OCR_TAG, PROTECTED_BEARER_SECURITY, unauthorizedErrorResponse } from '../openapi'

export type OcrRouteOptions = {
  processor?: OcrProcessor
  maxUploadBytes?: number
  timeoutMs?: number
}

const ocrResponseExample = {
  text: 'LOT 1234\nBest before 2027',
  lines: ['LOT 1234', 'Best before 2027'],
  processing_seconds: 2.6,
  model: OCR_MODEL
} as const

const ocrMetadataResponseExample = {
  model: OCR_MODEL,
  timeout_seconds: OCR_TIMEOUT_SECONDS,
  max_upload_bytes: DEFAULT_OCR_MAX_UPLOAD_BYTES,
  accepted_image_formats: SUPPORTED_IMAGE_FORMATS
} as const

const ocrMetadataResponseSchema = z
  .object({
    model: z.string().openapi({ example: ocrMetadataResponseExample.model, description: 'Fixed OCR model strategy used by OCR v1.' }),
    timeout_seconds: z.number().positive().openapi({
      example: ocrMetadataResponseExample.timeout_seconds,
      description: 'Maximum OCR processing time per request.'
    }),
    max_upload_bytes: z.number().int().positive().openapi({
      example: ocrMetadataResponseExample.max_upload_bytes,
      description: 'Maximum accepted OCR image upload size in bytes.'
    }),
    accepted_image_formats: z.array(z.enum(SUPPORTED_IMAGE_FORMATS)).openapi({
      example: ocrMetadataResponseExample.accepted_image_formats,
      description: 'Accepted image filename extensions.'
    })
  })
  .openapi('OcrMetadataResponse')

const ocrResponseSchema = z
  .object({
    text: z.string().openapi({ example: ocrResponseExample.text, description: 'Full extracted OCR text.' }),
    lines: z.array(z.string()).openapi({
      example: ocrResponseExample.lines,
      description: 'Non-empty extracted OCR text lines in returned order.'
    }),
    processing_seconds: z.number().nonnegative().openapi({
      example: ocrResponseExample.processing_seconds,
      description: 'OCR processing time in seconds.'
    }),
    model: z.literal(OCR_MODEL).openapi({
      example: ocrResponseExample.model,
      description: 'Fixed OCR model strategy used for this request.'
    })
  })
  .openapi('OcrResponse')

function createLiteralErrorSchema<Code extends string>(name: string, error: Code) {
  return z
    .object({
      error: z.literal(error).openapi({ example: error })
    })
    .openapi(name)
}

const ocrFileRequiredErrorSchema = createLiteralErrorSchema('OcrFileRequiredErrorResponse', 'file_required')

const ocrBadRequestResponseSchema = ocrFileRequiredErrorSchema.openapi('OcrBadRequestResponse')

const ocrUploadTooLargeExample = {
  error: 'upload_too_large',
  max_bytes: DEFAULT_OCR_MAX_UPLOAD_BYTES
} as const

const ocrUploadTooLargeResponseSchema = z
  .object({
    error: z.literal('upload_too_large').openapi({ example: ocrUploadTooLargeExample.error }),
    max_bytes: z.number().int().positive().openapi({
      example: ocrUploadTooLargeExample.max_bytes,
      description: 'Maximum accepted OCR upload size in bytes.'
    })
  })
  .openapi('OcrUploadTooLargeResponse')

const ocrUnsupportedImageResponseSchema = createLiteralErrorSchema('OcrUnsupportedImageResponse', 'unsupported_image_format')
const ocrImageProcessingFailedResponseSchema = createLiteralErrorSchema('OcrImageProcessingFailedResponse', 'image_processing_failed')
const ocrFailedResponseSchema = createLiteralErrorSchema('OcrFailedResponse', 'ocr_failed')
const ocrTimedOutResponseSchema = createLiteralErrorSchema('OcrTimedOutResponse', 'ocr_timed_out')

const ocrRequestSchema = z
  .object({
    file: z.file().openapi({
      type: 'string',
      format: 'binary',
      description: 'Image file uploaded for OCR recognition.'
    })
  })
  .openapi('OcrRequest', {
    description: 'Multipart OCR recognition upload fields.'
  })

function fileExtension(filename: string) {
  return extname(filename).replace('.', '').toLowerCase()
}

function isSupportedImage(filename: string) {
  return SUPPORTED_IMAGE_EXTENSIONS.has(fileExtension(filename))
}

function safeFilename(filename: string) {
  const cleaned = basename(filename || 'image').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 128)
  return cleaned || 'image'
}

async function writeTempUpload(file: File) {
  const dir = await mkdtemp(join(tmpdir(), 'girke-ocr-'))
  const path = join(dir, safeFilename(file.name))
  await mkdir(dir, { recursive: true })
  await writeFile(path, Buffer.from(await file.arrayBuffer()))
  return { dir, path }
}

function createOcrMetadataResponse(maxUploadBytes: number, timeoutMs: number) {
  return {
    model: OCR_MODEL,
    timeout_seconds: timeoutMs / 1000,
    max_upload_bytes: maxUploadBytes,
    accepted_image_formats: [...SUPPORTED_IMAGE_FORMATS]
  }
}

const ocrMetadataRoute = createRoute({
  method: 'get',
  path: '/',
  operationId: 'getOcrMetadata',
  tags: [OCR_TAG.name],
  summary: 'Get OCR metadata',
  description: 'Returns the fixed OCR model strategy, timeout, upload limit, and accepted image extensions.',
  security: PROTECTED_BEARER_SECURITY,
  responses: {
    200: createJsonResponse('Supported OCR metadata.', ocrMetadataResponseSchema, ocrMetadataResponseExample),
    401: unauthorizedErrorResponse
  }
})

const ocrRecognizeRoute = createRoute({
  method: 'post',
  path: '/',
  operationId: 'recognizeOcrText',
  tags: [OCR_TAG.name],
  summary: 'Recognize OCR text',
  description: 'Uploads one image and returns extracted OCR text inline using the fixed OCR v1 strategy.',
  security: PROTECTED_BEARER_SECURITY,
  request: {
    required: true,
    body: {
      required: true,
      description: 'Multipart OCR recognition upload fields.',
      content: {
        'multipart/form-data': {
          schema: ocrRequestSchema
        }
      }
    }
  },
  responses: {
    200: createJsonResponse('OCR recognition completed successfully.', ocrResponseSchema, ocrResponseExample),
    400: createJsonResponse('Missing image file.', ocrBadRequestResponseSchema, { error: 'file_required' }),
    401: unauthorizedErrorResponse,
    413: createJsonResponse('Upload exceeds the OCR body size limit.', ocrUploadTooLargeResponseSchema, ocrUploadTooLargeExample),
    415: createJsonResponse('Uploaded filename extension is not supported for OCR.', ocrUnsupportedImageResponseSchema, {
      error: 'unsupported_image_format'
    }),
    422: createJsonResponse('Uploaded image could not be decoded or preprocessed.', ocrImageProcessingFailedResponseSchema, {
      error: 'image_processing_failed'
    }),
    502: createJsonResponse('OCR processor failed while extracting text.', ocrFailedResponseSchema, { error: 'ocr_failed' }),
    504: createJsonResponse('OCR processing exceeded the configured timeout.', ocrTimedOutResponseSchema, { error: 'ocr_timed_out' })
  }
})

export function ocrRoutes(opts: OcrRouteOptions = {}) {
  const app = new OpenAPIHono<AppEnv>()
  const processor = opts.processor ?? createTesseractOcrProcessor()
  const maxUploadBytes = opts.maxUploadBytes ?? DEFAULT_OCR_MAX_UPLOAD_BYTES
  const timeoutMs = opts.timeoutMs ?? OCR_TIMEOUT_MS

  app.openapi(ocrMetadataRoute, (c) => c.json(createOcrMetadataResponse(maxUploadBytes, timeoutMs), 200))

  app.openapi(
    ocrRecognizeRoute,
    async (c) => {
      const form = c.req.valid('form')
      const file = form.file
      if (file.size > maxUploadBytes) {
        return c.json({ error: 'upload_too_large', max_bytes: maxUploadBytes }, 413)
      }
      if (!isSupportedImage(file.name)) {
        return c.json({ error: 'unsupported_image_format' }, 415)
      }

      const tempUpload = await writeTempUpload(file)
      try {
        const result = await processor.recognize({ inputPath: tempUpload.path, timeoutMs })
        return c.json(ocrResponseSchema.parse(result), 200)
      } catch (err) {
        if (err instanceof OcrProcessorError) {
          if (err.code === 'OCR_TIMED_OUT') return c.json({ error: 'ocr_timed_out' }, 504)
          if (err.code === 'IMAGE_PREPROCESSING_FAILED') return c.json({ error: 'image_processing_failed' }, 422)
          return c.json({ error: 'ocr_failed' }, 502)
        }

        throw err
      } finally {
        await rm(tempUpload.dir, { recursive: true, force: true })
      }
    },
    (result, c) => {
      if (result.success) return

      return c.json({ error: 'file_required' }, 400)
    }
  )

  return app
}

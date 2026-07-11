import { existsSync } from 'node:fs'
import { basename } from 'node:path'

const baseUrl = process.env.GIRKE_API_URL ?? 'http://127.0.0.1:3000'
const token = process.env.GIRKE_API_TOKEN
const mediaPath = process.env.TRANSCRIPTION_SMOKE_FILE ?? 'data/audio-10s.m4a'

if (!token) {
  throw new Error('GIRKE_API_TOKEN is required')
}

if (!existsSync(mediaPath)) {
  throw new Error(`Missing smoke fixture: ${mediaPath}`)
}

const form = new FormData()
form.set('file', new File([Bun.file(mediaPath)], basename(mediaPath)))
form.set('level', process.env.TRANSCRIPTION_SMOKE_LEVEL ?? 'medium')
form.set('language', process.env.TRANSCRIPTION_SMOKE_LANGUAGE ?? 'auto')

const response = await fetch(`${baseUrl}/api/v1/transcription/transcribe`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${token}` },
  body: form
})

console.log(response.status)
console.log(await response.text())

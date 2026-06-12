import { writeFileSync } from 'node:fs'

function wavSilence(seconds = 1, sampleRate = 16000) {
  const samples = seconds * sampleRate
  const dataSize = samples * 2
  const buffer = Buffer.alloc(44 + dataSize)
  buffer.write('RIFF', 0)
  buffer.writeUInt32LE(36 + dataSize, 4)
  buffer.write('WAVE', 8)
  buffer.write('fmt ', 12)
  buffer.writeUInt32LE(16, 16)
  buffer.writeUInt16LE(1, 20)
  buffer.writeUInt16LE(1, 22)
  buffer.writeUInt32LE(sampleRate, 24)
  buffer.writeUInt32LE(sampleRate * 2, 28)
  buffer.writeUInt16LE(2, 32)
  buffer.writeUInt16LE(16, 34)
  buffer.write('data', 36)
  buffer.writeUInt32LE(dataSize, 40)
  return buffer
}

writeFileSync('/tmp/silence.wav', wavSilence())
const form = new FormData()
form.set('file', new File([Bun.file('/tmp/silence.wav')], 'silence.wav', { type: 'audio/wav' }))
const response = await fetch('http://127.0.0.1:3000/api/v1/transcription/transcribe', {
  method: 'POST',
  headers: { 'X-API-Key': process.env.API_KEY ?? '' },
  body: form,
})
console.log(response.status)
console.log(await response.text())

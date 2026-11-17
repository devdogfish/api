/** Opt-in crash proof. Use a fresh, disposable Docker database named girke_restart_fixture. */
import assert from 'node:assert/strict'
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { drizzle } from 'drizzle-orm/postgres-js'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import postgres from 'postgres'
import { createApp } from '../src/app'
import { createPostgresTranscriptionJobStore } from '../src/transcription/postgresJobStore'
import { authHeaders, testApiTokenStore } from '../tests/helpers'

const [mode, connection, scratch, phase] = process.argv.slice(2)
const url = new URL(connection ?? '')
assert.equal(url.protocol, 'postgres:')
assert.equal(url.hostname, '127.0.0.1')
assert.ok(url.port && url.port !== '5432', 'use a disposable Docker port')
assert.equal(url.pathname, '/girke_restart_fixture')
assert.ok(!url.password && !url.search && !url.hash, 'use a fresh, local trust-auth fixture')
const sql = postgres(url.toString(), { max: 4, connect_timeout: 5 })
const db = drizzle(sql)
const store = createPostgresTranscriptionJobStore(db)
const jobs = '/api/v1/transcription/jobs'

async function until<T>(check: () => Promise<T | undefined>, label: string, timeout = 5_000): Promise<T> {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    const value = await check()
    if (value !== undefined) return value
    await Bun.sleep(50)
  }
  throw new Error(`timed out waiting for ${label}`)
}

async function serveFixture() {
  assert.ok(scratch && (phase === 'before' || phase === 'after'))
  const app = createApp({
    apiTokenStore: testApiTokenStore(),
    version: 'local-restart-fixture',
    recoverTranscriptionJobs: true,
    transcriptionJobStore: store,
    transcriptionUploadDir: scratch,
    transcriptionDurationProbe: { async probe() { return { durationSeconds: 2 } } },
    transcriptionMediaProcessor: {
      async prepare(inputPath, attemptDir) {
        assert.ok(attemptDir)
        const input = await readFile(inputPath, 'utf8')
        await mkdir(attemptDir, { recursive: true })
        const chunks = await Promise.all([0, 1].map(async chunkIndex => {
          const path = join(attemptDir, `part-${chunkIndex}.wav`)
          await writeFile(path, `${input}:${chunkIndex}`)
          return { path, chunkIndex, startSeconds: chunkIndex, endSeconds: chunkIndex + 1 }
        }))
        return { normalizedAudioPath: chunks[0]!.path, durationSeconds: 2, chunks }
      }
    },
    whisperFetch: async (_url, init) => {
      const media = (init?.body as FormData).get('file') as File
      const text = await media.text()
      await appendFile(join(scratch, `${phase}.calls`), text + '\n')
      if (text === 'interrupted:1') {
        if (phase === 'before') await new Promise(() => {})
        await until(async () => await Bun.file(join(scratch, 'release')).exists() ? true : undefined, 'test engine release')
      }
      return Response.json({
        text, segments: [{ start: 0, end: 0.5, text }],
        duration_seconds: 1, processing_seconds: 1,
        level: 'medium', language: 'auto', detected_language: 'en', model: 'fictional'
      })
    }
  })
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: app.fetch })
  await writeFile(join(scratch, `${phase}.port`), String(server.port))
}

async function prove() {
  const dir = await mkdtemp(join(tmpdir(), 'girke-restart-fixture-'))
  let child: ReturnType<typeof Bun.spawn> | undefined
  const calls = async (name: string) => {
    const file = Bun.file(join(dir, `${name}.calls`))
    return await file.exists() ? (await file.text()).trim().split('\n') : []
  }
  const stop = async () => {
    if (child && child.exitCode === null) child.kill('SIGKILL')
    await child?.exited
  }
  const boot = async (stage: 'before' | 'after') => {
    child = Bun.spawn([process.execPath, import.meta.path, 'serve', url.toString(), dir, stage], {
      stdout: 'ignore', stderr: 'inherit', env: { PATH: process.env.PATH ?? '' }
    })
    return await until(async () => {
      assert.equal(child?.exitCode, null, 'fixture API exited')
      const file = Bun.file(join(dir, `${stage}.port`))
      return await file.exists() ? `http://127.0.0.1:${await file.text()}` : undefined
    }, 'fixture API listener')
  }
  const submit = async (base: string, input: string) => {
    const body = new FormData()
    body.set('file', new File([input], `${input}.wav`))
    const res = await fetch(base + jobs, { method: 'POST', headers: authHeaders, body })
    assert.equal(res.status, 202)
    return (await res.json()).job_id as string
  }

  try {
    const [fresh] = await sql`select to_regclass('public.transcription_jobs') is null as empty`
    assert.ok(fresh?.empty, 'fixture database must be fresh')
    await migrate(db, { migrationsFolder: 'drizzle' })
    const api = await boot('before')
    const interrupted = await submit(api, 'interrupted')
    await until(async () => (await calls('before')).includes('interrupted:1') ? true : undefined, 'second chunk in flight')
    const first = await store.findByPublicId(interrupted)
    assert.ok(first?.claimToken)
    assert.deepEqual((await store.listChunks(interrupted)).map(chunk => chunk.text), ['interrupted:0'])
    const queued = await submit(api, 'queued')
    const cancelled = await submit(api, 'cancelled')
    const cancel = await fetch(`${api}${jobs}/${cancelled}`, { method: 'DELETE', headers: authHeaders })
    assert.equal(cancel.status, 200)
    assert.equal((await cancel.json()).status, 'cancelled')
    assert.equal((await store.findByPublicId(queued))?.status, 'queued')
    await stop()
    assert.equal(child?.signalCode, 'SIGKILL')
    assert.equal(await readFile(first.inputPath, 'utf8'), 'interrupted')

    const incompatiblePath = join(dir, 'incompatible.wav')
    await writeFile(incompatiblePath, 'incompatible')
    const incompatible = await store.create({
      apiTokenId: first.apiTokenId, inputPath: incompatiblePath, originalFilename: 'incompatible.wav',
      level: 'medium', language: 'auto', webhookUrl: null
    })
    await store.insertChunk({
      jobPublicId: incompatible.publicId, chunkIndex: 0, startSeconds: 0, endSeconds: 30,
      status: 'completed', text: 'bad boundaries', segmentsJson: [], processingSeconds: 1, errorMessage: null
    })

    const restarted = await boot('after')
    await until(async () => (await calls('after')).includes('interrupted:1') ? true : undefined, 'expired claim replay', 40_000)
    const reclaimed = await store.findByPublicId(interrupted)
    assert.ok(reclaimed?.claimToken && reclaimed.claimToken !== first.claimToken)
    const [checkpoint] = await store.listChunks(interrupted)
    assert.equal(await store.writeClaim(interrupted, first.claimToken, { status: 'completed' }, checkpoint), null)
    assert.equal(await store.renewClaim(interrupted, first.claimToken), false)
    assert.deepEqual((await store.listChunks(interrupted)).map(chunk => chunk.text), ['interrupted:0'])
    assert.equal(await readFile(first.inputPath, 'utf8'), 'interrupted')
    await writeFile(join(dir, 'release'), 'go')

    const recovered = await until(async () => {
      const job = await store.findByPublicId(interrupted)
      return job?.status === 'completed' && job.mediaCleanupStatus === 'deleted' ? job : undefined
    }, 'durable result and cleanup')
    assert.equal(recovered.resultJson?.text, 'interrupted:0 interrupted:1')
    assert.equal(recovered.resultJson?.model, 'fictional')
    assert.deepEqual((await store.listChunks(interrupted)).map(chunk => chunk.text), ['interrupted:0', 'interrupted:1'])
    assert.equal(await Bun.file(first.inputPath).exists(), false)
    assert.ok((await calls('after')).includes('queued:0'))
    assert.ok((await calls('after')).includes('queued:1'))
    assert.ok(!(await calls('after')).some(line => /^(interrupted:0|cancelled:|incompatible:)/.test(line)))
    assert.equal((await store.findByPublicId(queued))?.status, 'completed')
    const refused = await store.findByPublicId(incompatible.publicId)
    assert.equal(refused?.status, 'failed')
    assert.equal(refused?.mediaCleanupStatus, 'kept')
    assert.equal(await readFile(incompatiblePath, 'utf8'), 'incompatible')
    const cancelledResult = await fetch(`${restarted}${jobs}/${cancelled}/result`, { headers: authHeaders })
    assert.equal(cancelledResult.status, 410)
    console.log('PASS SIGKILL recovery, queued replay, checkpoint reuse, stale writer fencing, cancellation, and incompatible media preservation')
  } finally {
    await stop()
    await sql.end()
    await rm(dir, { recursive: true, force: true })
  }
}

if (mode === 'serve') await serveFixture()
else {
  assert.equal(mode, 'prove', 'use: bun scripts/prove-transcription-recovery.ts prove <fixture URL>')
  await prove()
}

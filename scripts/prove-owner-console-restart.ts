import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, stat, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { ComputeAdmission } from '../src/computeAdmission'
import { syntheticOwnerReviewConsole } from './synthetic-owner-review-console'

const [python, childRoot, stopAfterExport] = process.argv.slice(2)
assert.ok(python, 'staged Python required')
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

if (childRoot) {
  const scratch = join(childRoot, 'scratch')
  const vaultRoot = join(childRoot, 'vault')
  const workRoot = join(childRoot, 'work')
  await syntheticOwnerReviewConsole(
    process.stdin,
    { admission: new ComputeAdmission(), scratch, vaultRoot, workRoot, python },
    {
      pdf: await readFile(join(vaultRoot, 'synthetic.pdf')),
      identifiers: ['ORCHID VECTOR'],
      safeTextByPage: [['PUBLIC REFERENCE', 'END OF SAMPLE']]
    },
    (status, approvalLine) => {
      process.stdout.write(JSON.stringify({ status, approvalLine }) + '\n')
      if (stopAfterExport && status === 'exported') process.kill(process.pid, 'SIGSTOP')
    }
  )
} else {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'girke-owner-restart-')))
  const pids = new Set<number>()

  async function setup(name: string) {
    const base = join(root, name)
    const scratch = join(base, 'scratch')
    const vault = join(base, 'vault')
    const work = join(base, 'work')
    const source = join(vault, 'synthetic.pdf')
    await mkdir(base, { mode: 0o700 })
    await mkdir(scratch, { mode: 0o700 })
    await mkdir(vault, { mode: 0o700 })
    await mkdir(work, { mode: 0o700 })
    await chmod(work, process.platform === 'darwin' ? 0o750 : 0o2750)
    const generated = Bun.spawnSync([python, '-c', `
import sys
import pymupdf
with pymupdf.open() as doc:
    page = doc.new_page(width=550, height=350)
    page.insert_text((45, 75), "PUBLIC REFERENCE", fontsize=22)
    page.insert_text((45, 145), "ORCHID VECTOR", fontsize=24)
    page.insert_text((45, 225), "END OF SAMPLE", fontsize=22)
    doc.save(sys.argv[1])
`, source])
    assert.equal(generated.exitCode, 0)
    await chmod(source, 0o600)
    return { base, scratch, vault, work, source }
  }

  function start(base: string, suspendAfterExport = false) {
    const args = [process.argv[1]!, python!, base]
    if (suspendAfterExport) args.push('suspend')
    const proc = spawn(process.execPath, args, { stdio: ['pipe', 'pipe', 'pipe'] })
    proc.stderr.resume()
    const pid = proc.pid!
    pids.add(pid)
    const exited = once(proc, 'exit')
    proc.once('exit', () => pids.delete(pid))
    const reader = createInterface({ input: proc.stdout, terminal: false })
    const stdout = reader[Symbol.asyncIterator]()
    return {
      send: (line: string) => proc.stdin.write(line + '\n'),
      end: () => proc.stdin.end(),
      kill: () => proc.kill('SIGKILL'),
      exited,
      async next(expected: 'prepared' | 'refused' | 'exported') {
        const next = await stdout.next()
        assert.equal(next.done, false, 'console exited before reply')
        const reply: { status: string; approvalLine?: string } = JSON.parse(next.value)
        assert.equal(reply.status, expected)
        return reply.approvalLine
      }
    }
  }

  async function prepare(console: ReturnType<typeof start>, scratch: string) {
    console.send('prepare')
    const line = (await console.next('prepared'))!
    const [, candidate, preview] = line.split(' ')
    assert.match(line, /^approve [a-f0-9]{64} [a-f0-9]{64} [a-f0-9-]{36}$/)
    assert.equal(digest(await readFile(join(scratch, 'owner-console-session', 'preview.pdf'))), preview)
    return { line, candidate }
  }

  const watchdog = setTimeout(() => {
    for (const pid of pids) process.kill(pid, 'SIGKILL')
  }, 30_000)
  try {
    const graceful = await setup('graceful')
    const first = start(graceful.base)
    const old = await prepare(first, graceful.scratch)
    assert.deepEqual(await readdir(graceful.work), [])
    const concurrent = start(graceful.base)
    assert.deepEqual(await concurrent.exited, [1, null])
    assert.equal((await stat(join(graceful.scratch, 'owner-console-session', 'preview.pdf'))).mode & 0o777, 0o600)
    assert.equal((await stat(join(graceful.vault, old.candidate!, 'mapping.json'))).mode & 0o777, 0o600)
    first.end()
    assert.deepEqual(await first.exited, [0, null])
    assert.deepEqual(await readdir(graceful.scratch), ['.owner-console.lock'])
    assert.deepEqual(await readdir(graceful.vault), ['synthetic.pdf'])

    const second = start(graceful.base)
    second.send(old.line)
    await second.next('refused')
    assert.deepEqual(await readdir(graceful.work), [])
    const fresh = await prepare(second, graceful.scratch)
    second.send(fresh.line.split(' ').slice(0, 3).join(' ') + ' ' + old.line.split(' ')[3])
    await second.next('refused')
    assert.deepEqual(await readdir(graceful.work), [])
    second.send(fresh.line)
    await second.next('exported')
    assert.deepEqual(await second.exited, [0, null])
    assert.deepEqual(await readdir(graceful.work), [fresh.candidate + '.pdf'])
    assert.equal(digest(await readFile(join(graceful.work, fresh.candidate + '.pdf'))), fresh.candidate)
    assert.deepEqual(await readdir(graceful.scratch), ['.owner-console.lock'])
    assert.equal((await stat(join(graceful.vault, fresh.candidate!, 'mapping.json'))).mode & 0o777, 0o600)

    const interrupted = await setup('killed')
    const killed = start(interrupted.base)
    const pending = await prepare(killed, interrupted.scratch)
    killed.kill()
    assert.deepEqual(await killed.exited, [null, 'SIGKILL'])
    const session = join(interrupted.scratch, 'owner-console-session')
    const outside = join(graceful.work, fresh.candidate + '.pdf')
    const outsideDigest = digest(await readFile(outside))
    const alias = join(session, 'untrusted-alias')
    await symlink(outside, alias)
    const refusesAlias = start(interrupted.base)
    assert.deepEqual(await refusesAlias.exited, [1, null])
    assert.equal(digest(await readFile(outside)), outsideDigest)
    const unapprovedMap = join(interrupted.vault, pending.candidate!, 'mapping.json')
    assert.equal((await stat(unapprovedMap)).mode & 0o777, 0o600)
    const preview = join(session, 'preview.pdf')
    assert.equal((await stat(preview)).mode & 0o777, 0o600)
    await unlink(alias)

    const movedMap = join(interrupted.vault, 'held-mapping.json')
    const mapDigest = digest(await readFile(unapprovedMap))
    await rename(unapprovedMap, movedMap)
    await symlink(movedMap, unapprovedMap)
    const refusesMap = start(interrupted.base)
    assert.deepEqual(await refusesMap.exited, [1, null])
    assert.equal(digest(await readFile(movedMap)), mapDigest)
    assert.equal((await stat(preview)).mode & 0o777, 0o600)
    await unlink(unapprovedMap)
    await rename(movedMap, unapprovedMap)

    const journal = join(session, 'prepared.json')
    const recorded = await readFile(journal)
    await writeFile(journal, JSON.stringify({ ...JSON.parse(recorded.toString()), digest: '../scratch' }))
    const refusesTraversal = start(interrupted.base)
    assert.deepEqual(await refusesTraversal.exited, [1, null])
    assert.equal(digest(await readFile(unapprovedMap)), mapDigest)
    assert.equal(digest(await readFile(outside)), outsideDigest)
    await writeFile(journal, recorded)

    const restarted = start(interrupted.base)
    restarted.send(pending.line)
    await restarted.next('refused')
    restarted.end()
    assert.deepEqual(await restarted.exited, [0, null])
    assert.deepEqual(await readdir(interrupted.work), [])
    assert.deepEqual(await readdir(interrupted.scratch), ['.owner-console.lock'])
    assert.deepEqual(await readdir(interrupted.vault), ['synthetic.pdf'])

    const published = await setup('published')
    const afterLink = start(published.base, true)
    const approved = await prepare(afterLink, published.scratch)
    afterLink.send(approved.line)
    await afterLink.next('exported')
    afterLink.kill()
    assert.deepEqual(await afterLink.exited, [null, 'SIGKILL'])
    const retained = join(published.vault, approved.candidate!, 'mapping.json')
    const retainedDigest = digest(await readFile(retained))
    const afterCrash = start(published.base)
    afterCrash.send(approved.line)
    await afterCrash.next('refused')
    afterCrash.end()
    assert.deepEqual(await afterCrash.exited, [0, null])
    assert.deepEqual(await readdir(published.scratch), ['.owner-console.lock'])
    assert.equal(digest(await readFile(retained)), retainedDigest)
    assert.equal(digest(await readFile(join(published.work, approved.candidate + '.pdf'))), approved.candidate)

    const uncertain = await setup('uncertain')
    await mkdir(join(uncertain.scratch, 'owner-console-session'), { mode: 0o700 })
    const noJournal = start(uncertain.base)
    assert.deepEqual(await noJournal.exited, [1, null])
    assert.deepEqual((await readdir(uncertain.scratch)).sort(), ['.owner-console.lock', 'owner-console-session'])

  } finally {
    clearTimeout(watchdog)
    for (const pid of pids) process.kill(pid, 'SIGKILL')
    await rm(root, { recursive: true, force: true })
  }
  console.log('owner_console_cleanup=pass active_lock=1 scratch_and_mapping_symlinks_refused=1 journal_traversal_refused=1 deferred_sigkill_cleanup=1 retained_export_and_map=1 uncertain_session_preserved=1 stale_approval_refused=1')
}

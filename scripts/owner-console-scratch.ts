import { dlopen, FFIType } from 'bun:ffi'
import { constants } from 'node:fs'
import { lstat, mkdir, open, readdir, realpath, rmdir, unlink } from 'node:fs/promises'
import { dirname, join, relative, sep, isAbsolute } from 'node:path'

const c = dlopen(process.platform === 'darwin' ? 'libSystem.B.dylib' : 'libc.so.6', {
  flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 }
})
const LOCK_EX_NB = 2 | 4
const owner = process.getuid?.() ?? -1
const digestName = /^[a-f0-9]{64}$/
const refusal = () => new Error('Owner console scratch cannot be safely reconciled.')

function requireSafe(ok: unknown): asserts ok {
  if (!ok) throw refusal()
}

async function maybeStat(path: string) {
  try { return await lstat(path, { bigint: true }) }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
  }
}

function isWithin(parent: string, path: string) {
  const rel = relative(parent, path)
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + sep))
}

async function privateRoot(path: string) {
  requireSafe(await realpath(path) === path)
  for (let parent = dirname(path); ; parent = dirname(parent)) {
    const info = await lstat(parent)
    requireSafe(info.isDirectory() && (info.uid === owner || info.uid === 0) &&
      (!(info.mode & 0o022) || (info.mode & 0o1000)))
    if (parent === dirname(parent)) break
  }
  const info = await maybeStat(path)
  requireSafe(info && info.isDirectory() && info.uid === BigInt(owner) && (info.mode & 0o777n) === 0o700n)
  return info
}

async function privateDirectory(path: string, device: bigint) {
  const info = await maybeStat(path)
  requireSafe(info && info.isDirectory() && info.dev === device &&
    info.uid === BigInt(owner) && (info.mode & 0o777n) === 0o700n)
  return info
}

const workerFiles = new Set([
  'candidate.pdf', 'dictionary.json', 'rasters.json', 'review-plan.json', 'review.pdf', 'source.pdf'
])

async function inspectSlot(slot: string, device: bigint) {
  await privateDirectory(slot, device)
  const files: string[] = []
  const attempts: string[] = []
  for (const name of await readdir(slot)) {
    const path = join(slot, name)
    if (['prepared.json', 'retain', 'preview.pdf'].includes(name)) {
      await privateFile(path, device)
      files.push(path)
      continue
    }
    requireSafe(/^redaction-[a-zA-Z0-9]{6}$/.test(name) && attempts.length === 0)
    await privateDirectory(path, device)
    attempts.push(path)
    for (const child of await readdir(path)) {
      requireSafe(workerFiles.has(child))
      const file = join(path, child)
      await privateFile(file, device)
      files.push(file)
    }
  }
  return { files, attempts }
}

async function privateFile(path: string, device: bigint) {
  const info = await maybeStat(path)
  requireSafe(info && info.isFile() && info.nlink === 1n && info.dev === device &&
    info.uid === BigInt(owner) && (info.mode & 0o777n) === 0o600n)
  return info
}

async function writeMarker(path: string, content: string) {
  const file = await open(path, 'wx', 0o600)
  try {
    await file.writeFile(content)
    await file.sync()
  } finally {
    await file.close()
  }
}

export async function withOwnerConsoleScratch<T>(
  scratchRoot: string,
  vaultRoot: string,
  workRoot: string,
  run: (scratch: string, journal: {
    prepared(digest: string): Promise<void>
    retain(): Promise<void>
  }) => Promise<T>
) {
  requireSafe(!isWithin(scratchRoot, vaultRoot) && !isWithin(vaultRoot, scratchRoot))
  const work = await realpath(workRoot)
  requireSafe([scratchRoot, vaultRoot].every(root => !isWithin(root, work) && !isWithin(work, root)))
  const { dev: scratchDevice } = await privateRoot(scratchRoot)
  const { dev: vaultDevice, ino: vaultInode } = await privateRoot(vaultRoot)
  const lockPath = join(scratchRoot, '.owner-console.lock')
  const lock = await open(lockPath, constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600)
  try {
    const info = await privateFile(lockPath, scratchDevice)
    requireSafe((await lock.stat({ bigint: true })).ino === info.ino)
    requireSafe(c.symbols.flock(lock.fd, LOCK_EX_NB) === 0)
    const slot = join(scratchRoot, 'owner-console-session')
    const journal = join(slot, 'prepared.json')
    const retained = join(slot, 'retain')
    async function reconcile(allowEmpty: boolean) {
      const { files, attempts } = await inspectSlot(slot, scratchDevice)
      if (allowEmpty && files.length === 0 && attempts.length === 0) {
        await rmdir(slot)
        return
      }
      // Without a completed journal a worker may have outlived its console.
      const metadata = await privateFile(journal, scratchDevice)
      requireSafe(metadata.size <= 512n && metadata.size > 0n)
      const file = await open(journal, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
      let record: { digest: string; ino: string; fileIno: string; dev: string; vaultIno: string }
      try { record = JSON.parse(await file.readFile('utf8')) }
      finally { await file.close() }
      const vault = await privateRoot(vaultRoot)
      requireSafe(record && typeof record.digest === 'string' && digestName.test(record.digest) &&
        [record.ino, record.fileIno].every(value => typeof value === 'string' && /^[0-9]+$/.test(value)) &&
        record.dev === String(vault.dev) && record.vaultIno === String(vault.ino))
      if (!files.includes(retained)) {
        const mapping = join(vaultRoot, record.digest)
        if (await maybeStat(mapping)) {
          const existing = await privateDirectory(mapping, vault.dev)
          requireSafe(String(existing.ino) === record.ino)
          const members = await readdir(mapping)
          requireSafe(members.length === 0 || (members.length === 1 && members[0] === 'mapping.json'))
          if (members.length) {
            const map = join(mapping, 'mapping.json')
            requireSafe(String((await privateFile(map, vault.dev)).ino) === record.fileIno)
            await unlink(map)
          }
          await rmdir(mapping)
        }
      }
      // Keep the journal until the other artifacts have been removed.
      for (const path of files) {
        if (path !== journal && path !== retained) await unlink(path)
      }
      for (const path of attempts) await rmdir(path)
      // Once retention is set, removing this marker before the journal would
      // let a crash during cleanup make a later restart delete the exported map.
      await unlink(journal)
      if (files.includes(retained)) await unlink(retained)
      await rmdir(slot)
    }

    if (await maybeStat(slot)) await reconcile(false)
    await mkdir(slot, { mode: 0o700 })
    const result = await run(slot, {
      async prepared(digest) {
        requireSafe(digestName.test(digest))
        const vault = await privateRoot(vaultRoot)
        requireSafe(vault.dev === vaultDevice && vault.ino === vaultInode)
        const mapping = join(vaultRoot, digest)
        const dir = await privateDirectory(mapping, vault.dev)
        const map = await privateFile(join(mapping, 'mapping.json'), vault.dev)
        await writeMarker(journal, JSON.stringify({
          digest, ino: String(dir.ino), fileIno: String(map.ino), dev: String(vault.dev), vaultIno: String(vault.ino)
        }))
      },
      async retain() { await writeMarker(retained, 'retain\n') }
    })
    await reconcile(true)
    return result
  } finally {
    await lock.close()
  }
}

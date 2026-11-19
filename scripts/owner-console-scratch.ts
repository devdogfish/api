import { dlopen, FFIType } from 'bun:ffi'
import { constants } from 'node:fs'
import { lstat, mkdir, open, readdir, realpath, rm, rmdir, unlink } from 'node:fs/promises'
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
  return info.dev
}

async function inspectTree(path: string, device: bigint): Promise<void> {
  const info = await maybeStat(path)
  requireSafe(info && info.dev === device && info.uid === BigInt(owner) && !(info.mode & 0o077n))
  if (info.isDirectory()) {
    for (const name of await readdir(path)) await inspectTree(join(path, name), device)
  } else {
    requireSafe(info.isFile() && info.nlink === 1n)
  }
}

async function inspectSlot(path: string, device: bigint) {
  await inspectTree(path, device)
  for (const name of await readdir(path)) {
    requireSafe(['prepared.json', 'retain', 'preview.pdf'].includes(name) || /^redaction-[a-zA-Z0-9]{6}$/.test(name))
  }
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
  const scratchDevice = await privateRoot(scratchRoot)
  const vaultDevice = await privateRoot(vaultRoot)
  const lockPath = join(scratchRoot, '.owner-console.lock')
  const lock = await open(lockPath, constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600)
  try {
    const info = await privateFile(lockPath, scratchDevice)
    requireSafe((await lock.stat({ bigint: true })).ino === info.ino)
    requireSafe(c.symbols.flock(lock.fd, LOCK_EX_NB) === 0)
    const slot = join(scratchRoot, 'owner-console-session')
    const journal = join(slot, 'prepared.json')
    const retained = join(slot, 'retain')
    const oldSlot = await maybeStat(slot)
    if (oldSlot) {
      // An absent or incomplete journal can mean a worker outlived the console.
      // Keep that session intact for reconciliation after worker exit is proven.
      requireSafe(oldSlot.isDirectory())
      await inspectSlot(slot, scratchDevice)
      const metadata = await privateFile(journal, scratchDevice)
      requireSafe(metadata.size <= 256n && metadata.size > 0n)
      const file = await open(journal, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
      let record: { digest: string; ino: string; fileIno: string; dev: string }
      try { record = JSON.parse(await file.readFile('utf8')) }
      finally { await file.close() }
      requireSafe(record && typeof record.digest === 'string' && digestName.test(record.digest) &&
        [record.ino, record.fileIno, record.dev].every(value => typeof value === 'string' && /^[0-9]+$/.test(value)))
      if (await maybeStat(retained)) {
        await privateFile(retained, scratchDevice)
      } else {
        const mapping = join(vaultRoot, record.digest)
        const existing = await maybeStat(mapping)
        if (existing) {
          requireSafe(existing.isDirectory() && existing.ino.toString() === record.ino &&
            existing.dev === vaultDevice && existing.dev.toString() === record.dev)
          await inspectTree(mapping, vaultDevice)
          const members = await readdir(mapping)
          requireSafe(members.length === 0 || (members.length === 1 && members[0] === 'mapping.json'))
          if (members.length) {
            const map = join(mapping, 'mapping.json')
            requireSafe((await privateFile(map, vaultDevice)).ino.toString() === record.fileIno)
            await unlink(map)
          }
          await rmdir(mapping)
        }
      }
      await rm(slot, { recursive: true })
    }

    await mkdir(slot, { mode: 0o700 })
    const result = await run(slot, {
      async prepared(digest) {
        requireSafe(digestName.test(digest))
        const mapping = join(vaultRoot, digest)
        const dir = await maybeStat(mapping)
        requireSafe(dir && dir.isDirectory() && dir.dev === vaultDevice)
        await inspectTree(mapping, vaultDevice)
        const map = await privateFile(join(mapping, 'mapping.json'), vaultDevice)
        await writeMarker(journal, JSON.stringify({ digest, ino: String(dir.ino), fileIno: String(map.ino), dev: String(dir.dev) }))
      },
      // Mark retention before calling anything that can publish to Work.
      async retain() { await writeMarker(retained, 'retain\n') }
    })
    await inspectSlot(slot, scratchDevice)
    await rm(slot, { recursive: true })
    return result
  } finally {
    await lock.close()
  }
}

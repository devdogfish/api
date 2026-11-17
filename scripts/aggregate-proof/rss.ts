import { dlopen, FFIType } from 'bun:ffi'

type Sample = Map<number, number>

const darwin = process.platform === 'darwin' ? dlopen('/usr/lib/libproc.dylib', {
  proc_listchildpids: { args: [FFIType.int32_t, FFIType.ptr, FFIType.int32_t], returns: FFIType.int32_t },
  proc_pid_rusage: { args: [FFIType.int32_t, FFIType.int32_t, FFIType.ptr], returns: FFIType.int32_t }
}) : undefined

function darwinRss() {
  const sample: Sample = new Map()
  const pending = [process.pid]
  const children = new Int32Array(256)
  const usage = Buffer.alloc(96)
  while (pending.length) {
    const pid = pending.pop()!
    if (darwin!.symbols.proc_pid_rusage(pid, 0, usage) !== 0) continue
    // rusage_info_v0.ri_resident_size follows UUID and six uint64 fields.
    sample.set(pid, Number(usage.readBigUInt64LE(64)) / 1024)
    const count = darwin!.symbols.proc_listchildpids(pid, children, children.byteLength)
    if (count > 0) pending.push(...children.subarray(0, count))
  }
  return sample
}

function linuxRss() {
  const output = Bun.spawnSync(['ps', '-axo', 'pid=,ppid=,rss='])
  if (output.exitCode !== 0) return new Map<number, number>()
  const rows = output.stdout.toString().trim().split('\n').map(row => row.trim().split(/\s+/).map(Number))
  const tree = new Set([process.pid])
  let previous = 0
  while (previous !== tree.size) {
    previous = tree.size
    for (const [pid, parent] of rows) if (tree.has(parent)) tree.add(pid)
  }
  return new Map(rows.filter(([pid]) => tree.has(pid)).map(([pid, , rss]) => [pid, rss]))
}

export function currentRssKiB(): Sample {
  return darwin ? darwinRss() : linuxRss()
}

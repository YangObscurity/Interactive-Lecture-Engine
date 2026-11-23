/**
 * concepts/safeWrite.mts - the only way the concept workflows write or delete files (WP-F9 audit).
 *
 * - atomic: data goes to a temporary sibling file that is renamed over the target, so a crash never leaves half a file;
 * - confined: the target must sit inside one of the allowed roots (compared by real path, so a symlinked or
 *   junctioned folder pointing elsewhere is refused) and must not itself be a symbolic link.
 */
import fs from 'node:fs'
import path from 'node:path'

function realOrSelf(p: string): string {
  try {
    return fs.realpathSync.native(p)
  } catch {
    return path.resolve(p)
  }
}

function isInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child)
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

/** Throws unless `target` is a plain file path (or absent) inside one of `roots`. */
export function assertWritableTarget(target: string, roots: readonly string[]): void {
  const abs = path.resolve(target)
  if (/[\\/]\.\.[\\/]|\0/.test(abs)) throw new Error(`Unsafe path: ${target}`)
  let st: fs.Stats | null = null
  try {
    st = fs.lstatSync(abs)
  } catch {
    st = null
  }
  if (st?.isSymbolicLink()) throw new Error(`Refusing to write through a symbolic link: ${target}`)
  // the folder may not exist yet: walk up to the nearest existing ancestor and compare real paths
  let probe = path.dirname(abs)
  while (!fs.existsSync(probe) && path.dirname(probe) !== probe) probe = path.dirname(probe)
  const realDir = realOrSelf(probe)
  const allowed = roots.some((r) => isInside(realDir, realOrSelf(r)))
  if (!allowed) throw new Error(`Path outside the content directories: ${target}`)
}

/** Windows refuses a rename over a file another process has open for a moment (the content watcher copying the same
 * lecture, an editor, an indexer): EPERM / EACCES / EBUSY. Retry for about a second before giving up. */
const RENAME_RETRY_CODES = new Set(['EPERM', 'EACCES', 'EBUSY'])
function renameWithRetry(from: string, to: string, attempts = 12, waitMs = 80): void {
  for (let i = 1; ; i++) {
    try {
      fs.renameSync(from, to)
      return
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? ''
      if (i >= attempts || !RENAME_RETRY_CODES.has(code)) throw err
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, waitMs)
    }
  }
}

export function atomicWriteFile(target: string, data: string, roots: readonly string[]): void {
  assertWritableTarget(target, roots)
  const abs = path.resolve(target)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  const tmp = `${abs}.${process.pid}.${Date.now().toString(36)}.tmp`
  try {
    fs.writeFileSync(tmp, data, 'utf8')
    renameWithRetry(tmp, abs)
  } catch (err) {
    fs.rmSync(tmp, { force: true })
    throw err
  }
}

export function safeRemoveFile(target: string, roots: readonly string[]): void {
  assertWritableTarget(target, roots)
  fs.rmSync(path.resolve(target), { force: true })
}

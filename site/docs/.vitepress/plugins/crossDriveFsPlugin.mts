/**
 * Vite dev only, Windows only: serve `/@fs/<X>:/…` asset files that sit on another drive than the one
 * Vite's own `/@fs` handler reads from.
 *
 * Why: Vite 5's serveRawFsMiddleware strips the drive letter (`/@fs/C:/a/b.woff2` → `/a/b.woff2`) and
 * hands the rest to `sirv('/')`, whose root is `path.resolve('/')`, the root of the drive the server
 * was started on. A file on another drive is looked up on the wrong drive, is not found, falls through
 * to the SPA HTML fallback, and the browser gets `index.html` for a font ("Failed to decode downloaded
 * font"). `server.fs.allow` cannot help: the lookup fails before the allow check runs.
 * Vite writes such URLs when a dependency's real path is on another drive, e.g. `site/node_modules`
 * is a junction or symlink to `C:\…\node_modules` while the repo lives on `G:`. JS and CSS still work
 * (the transform middleware loads them by full path); only raw assets (fonts, images) break.
 *
 * Scope: GET/HEAD, no query string, a known asset extension, a drive letter that differs from the
 * served drive. Everything else goes on to Vite untouched, so a checkout whose dependencies are on
 * the same drive (no junction) behaves exactly as before. A file is served only if Vite's
 * `server.fs` rules allow it, or if it lies inside the real directory of a linked `node_modules`
 * between the Vite root and the filesystem root (the junction target, which `fs.allow` does not list).
 */
import fs from 'node:fs'
import path from 'node:path'
import { isFileServingAllowed, send, type Plugin, type ViteDevServer } from 'vite'

const MIME_BY_EXT: Record<string, string> = {
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.eot': 'application/vnd.ms-fontobject',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
}

/** Drive letter (upper case) of `path.resolve('/')`, the root Vite's `/@fs` handler reads from. */
export function servedDrive(resolveRoot: (p: string) => string = path.resolve): string {
  const m = /^([A-Za-z]):/.exec(resolveRoot('/'))
  return m?.[1]?.toUpperCase() ?? ''
}

/**
 * The file a `/@fs/<X>:/…` asset request names, when Vite would look for it on the wrong drive;
 * otherwise null (the request is left to Vite).
 */
export function crossDriveAssetPath(
  url: string,
  opts: { platform: NodeJS.Platform | string; drive: string },
): { file: string; mime: string } | null {
  if (opts.platform !== 'win32' || !opts.drive) return null
  if (!url.startsWith('/@fs/') || /[?#]/.test(url)) return null
  let rest: string
  try {
    rest = decodeURI(url.slice('/@fs/'.length))
  } catch {
    return null
  }
  const letter = /^([A-Za-z]):\//.exec(rest)?.[1]
  if (!letter || letter.toUpperCase() === opts.drive.toUpperCase()) return null
  const mime = MIME_BY_EXT[path.win32.extname(rest).toLowerCase()]
  if (!mime) return null
  return { file: path.win32.normalize(rest), mime }
}

function isInside(file: string, dir: string): boolean {
  const rel = path.win32.relative(dir.toLowerCase(), file.toLowerCase())
  return rel !== '' && !rel.startsWith('..') && !path.win32.isAbsolute(rel)
}

/** Real directories of linked `node_modules` folders from `root` up to the filesystem root. */
export function linkedNodeModules(root: string): string[] {
  const out: string[] = []
  let dir = path.resolve(root)
  for (;;) {
    const nm = path.join(dir, 'node_modules')
    try {
      const real = fs.realpathSync.native(nm)
      // compare with the real path of the parent, so 8.3 short names or a linked parent do not count
      const plain = path.join(fs.realpathSync.native(dir), 'node_modules')
      if (path.resolve(real).toLowerCase() !== path.resolve(plain).toLowerCase()) out.push(real)
    } catch {
      // no node_modules here
    }
    const parent = path.dirname(dir)
    if (parent === dir) return out
    dir = parent
  }
}

export function crossDriveFsPlugin(): Plugin {
  return {
    name: 'lecture:cross-drive-fs',
    apply: 'serve',
    configureServer(server: ViteDevServer) {
      if (process.platform !== 'win32') return
      const drive = servedDrive()
      const linked = linkedNodeModules(server.config.root)
      server.middlewares.use((req, res, next) => {
        const method = (req.method || 'GET').toUpperCase()
        if (method !== 'GET' && method !== 'HEAD') return next()
        const hit = crossDriveAssetPath(req.url || '', { platform: process.platform, drive })
        if (!hit) return next()
        const allowed = isFileServingAllowed(req.url || '', server) || linked.some((dir) => isInside(hit.file, dir))
        if (!allowed) return next()
        let body: Buffer
        try {
          if (!fs.statSync(hit.file).isFile()) return next()
          body = fs.readFileSync(hit.file)
        } catch {
          return next()
        }
        send(req, res, body, hit.mime, { headers: server.config.server.headers })
      })
    },
  }
}

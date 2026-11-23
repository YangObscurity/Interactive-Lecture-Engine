/**
 * A small static server for the `prod` and `access` e2e projects: serves a built dist with VitePress' clean URLs
 * (`/mea/L01` -> `mea/L01.html`, `/mea/` -> `mea/index.html`) and its 404 page. No gateway here: the access tests put theirs
 * in front with `page.route`.
 *
 *   node tests/e2e/access-server.mjs --dir <dist> --port <port>
 */
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.jpg': 'image/jpeg',
  '.webmanifest': 'application/manifest+json',
  '.wasm': 'application/wasm',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
}

/** The file a clean URL path stands for, or null. Never leaves `root`. */
export function resolveFile(root, urlPath) {
  let p
  try {
    p = decodeURIComponent(urlPath)
  } catch {
    return null
  }
  if (p.includes('\0')) return null
  const candidates = p.endsWith('/') ? [`${p}index.html`] : [p, `${p}.html`, `${p}/index.html`]
  for (const c of candidates) {
    const file = path.resolve(root, `.${c}`)
    const rel = path.relative(root, file)
    if (rel.startsWith('..') || path.isAbsolute(rel)) return null
    if (fs.existsSync(file) && fs.statSync(file).isFile()) return file
  }
  return null
}

export function createServer(root) {
  return http.createServer((req, res) => {
    const urlPath = (req.url ?? '/').split('?')[0]
    const file = resolveFile(root, urlPath)
    const target = file ?? path.join(root, '404.html')
    const status = file ? 200 : 404
    fs.readFile(target, (err, data) => {
      if (err) {
        res.writeHead(404, { 'Content-Type': 'text/plain' })
        res.end('not found')
        return
      }
      // HEAD gets the same headers as GET (Content-Length included), only without the body.
      res.writeHead(status, {
        'Content-Type': TYPES[path.extname(target).toLowerCase()] ?? 'application/octet-stream',
        'Content-Length': data.length,
        'Cache-Control': 'no-store',
      })
      res.end(req.method === 'HEAD' ? undefined : data)
    })
  })
}

function main() {
  const argv = process.argv.slice(2)
  const arg = (name) => {
    const i = argv.indexOf(name)
    return i > -1 ? argv[i + 1] : undefined
  }
  const dir = arg('--dir')
  const port = Number(arg('--port'))
  if (!dir || !port) {
    console.error('usage: node tests/e2e/access-server.mjs --dir <dist> --port <port>')
    process.exit(2)
  }
  const root = path.resolve(dir)
  if (!fs.existsSync(path.join(root, 'index.html'))) {
    console.error(`[access-server] no index.html in ${root}: run npm run build:e2e (prod) or npm run build:e2e:access (access) first`)
    process.exit(2)
  }
  createServer(root).listen(port, '127.0.0.1', () => console.log(`[access-server] ${root} on http://127.0.0.1:${port}/`))
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()

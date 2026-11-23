/**
 * S6 decision B: while the site shows the engine's demo content (no content folder of its own, `demo: true`), the dev
 * Dashboard refuses every write into the content folder (AI tool switches, companion prompts, site texts, concept
 * drafts / confirm / discard / delete) with 409 `demo_read_only` and the advice to run `npm run init` first; read
 * endpoints keep working. The token check still comes first.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createDashboardDevHandler,
  demoReadOnlyBody,
  DEMO_WRITE_ENDPOINTS,
} from '../../docs/.vitepress/plugins/dashboardDevPlugin.mts'
import { getSiteTextsPath } from '../../docs/.vitepress/site-texts.mts'

const DEMO_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'templates', 'demo-content')
const tmpDirs: string[] = []
afterEach(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

type Invoke = (o: { method: string; url: string; token?: string; body?: unknown }) => Promise<{ status: number; json: Record<string, unknown> | null }>

function makeInvoker(opts: Parameters<typeof createDashboardDevHandler>[0]): Invoke {
  const handler = createDashboardDevHandler({ token: 'demo-token', ...opts })
  return (o) =>
    new Promise((resolve) => {
      const req = new EventEmitter() as IncomingMessage
      req.method = o.method
      req.url = o.url
      req.headers = { host: '127.0.0.1', ...(o.token !== '' ? { 'x-lecture-dev-token': o.token ?? 'demo-token' } : {}) }
      req.socket = { remoteAddress: '127.0.0.1' } as IncomingMessage['socket']
      let status = 200
      let raw = ''
      const res = {
        setHeader() {
          return this
        },
        writeHead(code: number) {
          status = code
          return this
        },
        end(chunk?: string) {
          if (chunk) raw += String(chunk)
          let json: Record<string, unknown> | null = null
          try {
            json = JSON.parse(raw) as Record<string, unknown>
          } catch {
            json = null
          }
          resolve({ status, json })
        },
      } as unknown as ServerResponse
      void handler(req, res, () => resolve({ status: 0, json: null }))
      process.nextTick(() => {
        if (o.body !== undefined) req.emit('data', Buffer.from(JSON.stringify(o.body), 'utf8'))
        req.emit('end')
      })
    })
}

function hashTree(dir: string): string {
  const out: string[] = []
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) walk(p)
      else out.push(`${path.relative(dir, p)}:${fs.statSync(p).size}:${fs.readFileSync(p).toString('base64').slice(0, 64)}`)
    }
  }
  walk(dir)
  return out.sort().join('\n')
}

describe('dev Dashboard on the demo content is read only (S6 decision B)', () => {
  it('refuses every content write with 409 demo_read_only and the npm run init advice', async () => {
    const before = hashTree(DEMO_DIR)
    const invoke = makeInvoker({ demo: true })
    expect(DEMO_WRITE_ENDPOINTS).toEqual(
      expect.arrayContaining(['/tools', '/prompts', '/texts', '/concepts/draft', '/concepts/confirm', '/concepts/discard', '/concepts/delete']),
    )
    for (const sub of DEMO_WRITE_ENDPOINTS) {
      const r = await invoke({ method: 'POST', url: `/__lecture/api${sub}`, body: { slug: 'x', texts: {}, prompts: {} } })
      expect(r.status, sub).toBe(409)
      expect(r.json?.error, sub).toBe('demo_read_only')
      expect(String(r.json?.message), sub).toMatch(/npm run init/)
      expect(String(r.json?.messageZh), sub).toMatch(/npm run init/)
    }
    expect(hashTree(DEMO_DIR)).toBe(before)
  })

  it('checks the dev token first (403, not 409)', async () => {
    const invoke = makeInvoker({ demo: true })
    const r = await invoke({ method: 'POST', url: '/__lecture/api/texts', token: 'wrong', body: {} })
    expect(r.status).toBe(403)
  })

  it('keeps the read endpoints working', async () => {
    const invoke = makeInvoker({ demo: true })
    const author = await invoke({ method: 'GET', url: '/__lecture/api/concepts/author' })
    expect(author.status).toBe(200)
    expect(author.json?.ok).toBe(true)
    const prompts = await invoke({ method: 'GET', url: '/__lecture/api/prompts' })
    expect(prompts.status).toBe(200)
    const tools = await invoke({ method: 'GET', url: '/__lecture/api/tools' })
    expect(tools.status).toBe(200)
  })

  it('still writes when the content is a folder of its own (demo false)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'demo-ro-'))
    tmpDirs.push(dir)
    const invoke = makeInvoker({ demo: false, siteDir: dir })
    const texts = {
      version: 1,
      'zh-CN': { name: '我的站', tagline: '', footer: '', description: '' },
      en: { name: 'My site', tagline: '', footer: '', description: '' },
    }
    const r = await invoke({ method: 'POST', url: '/__lecture/api/texts', body: { texts } })
    expect(r.json?.error).not.toBe('demo_read_only')
    expect(r.status).not.toBe(409)
  })

  it('names the demo folder in the answer', () => {
    const body = demoReadOnlyBody('/x/templates/demo-content')
    expect(body).toMatchObject({ ok: false, error: 'demo_read_only' })
    expect(body.message).toContain('/x/templates/demo-content')
  })

  it('leaves the texts file of a temporary site folder alone when refused', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'demo-ro-'))
    tmpDirs.push(dir)
    const invoke = makeInvoker({ demo: true, siteDir: dir })
    const r = await invoke({ method: 'POST', url: '/__lecture/api/texts', body: { texts: {} } })
    expect(r.status).toBe(409)
    expect(fs.existsSync(getSiteTextsPath(dir))).toBe(false)
  })
})

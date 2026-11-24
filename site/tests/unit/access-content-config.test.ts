/**
 * Unit tests for content/access.json support, configuration precedence,
 * and dev Dashboard write endpoints (S6Z-2).
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveContent } from '../../docs/.vitepress/content/paths.mts'
import {
  loadLectureConfigInfo,
  stripJsonCommentsAndBom,
} from '../../docs/.vitepress/content/config.mts'
import { LectureConfigError } from '../../docs/.vitepress/lecture-config.mts'
import {
  createDashboardDevHandler,
  DEMO_WRITE_ENDPOINTS,
} from '../../docs/.vitepress/plugins/dashboardDevPlugin.mts'
import { resolveAuthPlan } from '../../docs/.vitepress/access/authExport.ts'
import { resolveBuildAccess } from '../../docs/.vitepress/access/build.mts'

const tmpDirs: string[] = []
afterEach(() => {
  for (const d of tmpDirs.splice(0)) {
    try {
      fs.rmSync(d, { recursive: true, force: true })
    } catch {
      // ignore cleanup errors
    }
  }
})

describe('ContentPaths.accessFile', () => {
  it('resolves <root>/access.json in content mode', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'content-paths-'))
    tmpDirs.push(dir)
    fs.writeFileSync(path.join(dir, 'site.config.ts'), 'export default { theme: "reader" }\n')
    const paths = resolveContent({ env: { LECTURE_CONTENT_DIR: dir } })
    expect(paths.mode).toBe('content')
    expect(paths.accessFile).toBe(path.join(dir, 'access.json'))
  })

  it('resolves <siteRoot>/access.json in in-place mode', () => {
    const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'content-inplace-'))
    tmpDirs.push(repoDir)
    fs.mkdirSync(path.join(repoDir, 'site', 'docs', '.vitepress'), { recursive: true })
    const paths = resolveContent({ repoRoot: repoDir, env: { LECTURE_DEMO: '0', LECTURE_CONTENT_DIR: '' } })
    expect(paths.mode).toBe('in-place')
    expect(paths.accessFile).toBe(path.join(paths.siteRoot, 'access.json'))
  })
})

describe('stripJsonCommentsAndBom', () => {
  it('removes UTF-8 BOM from start and within text', () => {
    const raw = '\uFEFF{"default":"public"}\uFEFF'
    const stripped = stripJsonCommentsAndBom(raw)
    expect(stripped).toBe('{"default":"public"}')
    expect(JSON.parse(stripped)).toEqual({ default: 'public' })
  })

  it('removes single-line and multi-line comments without altering string literals', () => {
    const raw = `
      // Top-level comment
      {
        /* block comment */
        "default": "public",
        "url": "https://example.com/api//not-a-comment/*nested*/" // trailing comment
      }
    `
    const stripped = stripJsonCommentsAndBom(raw)
    const parsed = JSON.parse(stripped) as Record<string, string>
    expect(parsed.default).toBe('public')
    expect(parsed.url).toBe('https://example.com/api//not-a-comment/*nested*/')
  })
})

describe('loadLectureConfigInfo with access.json', () => {
  it('falls back to site.config.ts access when access.json is missing', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cfg-fallback-'))
    tmpDirs.push(dir)
    fs.writeFileSync(
      path.join(dir, 'site.config.ts'),
      'export default { theme: "reader", access: { default: "authenticated", enforcement: "gateway" } }\n',
    )
    const paths = resolveContent({ env: { LECTURE_CONTENT_DIR: dir } })
    const info = loadLectureConfigInfo({ paths })
    expect(info.config.access?.default).toBe('authenticated')
    expect(info.config.access?.enforcement).toBe('gateway')
    expect(info.accessFile).toBeUndefined()
  })

  it('reads access.json and takes precedence over site.config.ts', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cfg-override-'))
    tmpDirs.push(dir)
    fs.writeFileSync(
      path.join(dir, 'site.config.ts'),
      'export default { theme: "reader", access: { default: "authenticated", enforcement: "gateway" } }\n',
    )
    const accessJson = {
      default: 'public',
      enforcement: 'none',
      groups: {
        G01: { read: 'public' },
      },
    }
    fs.writeFileSync(
      path.join(dir, 'access.json'),
      `// Custom access config\n\uFEFF${JSON.stringify(accessJson, null, 2)}\n/* end */\n`,
      'utf8',
    )
    const paths = resolveContent({ env: { LECTURE_CONTENT_DIR: dir } })
    const info = loadLectureConfigInfo({ paths })
    expect(info.config.access?.default).toBe('public')
    expect(info.config.access?.enforcement).toBe('none')
    expect(info.config.access?.groups?.G01?.read).toBe('public')
    expect(info.accessFile).toBe(path.join(dir, 'access.json'))
  })

  it('throws LectureConfigError on invalid JSON syntax in access.json', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cfg-invalid-json-'))
    tmpDirs.push(dir)
    fs.writeFileSync(path.join(dir, 'site.config.ts'), 'export default { theme: "reader" }\n')
    fs.writeFileSync(path.join(dir, 'access.json'), '{\n  "default": "public",\n', 'utf8')
    const paths = resolveContent({ env: { LECTURE_CONTENT_DIR: dir } })
    expect(() => loadLectureConfigInfo({ paths })).toThrow(LectureConfigError)
    expect(() => loadLectureConfigInfo({ paths })).toThrow(/is not valid JSON/)
  })

  it('throws LectureConfigError when access.json fails validateAccessConfig', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cfg-invalid-access-'))
    tmpDirs.push(dir)
    fs.writeFileSync(path.join(dir, 'site.config.ts'), 'export default { theme: "reader" }\n')
    fs.writeFileSync(path.join(dir, 'access.json'), '{"default": "unknown_tier"}', 'utf8')
    const paths = resolveContent({ env: { LECTURE_CONTENT_DIR: dir } })
    expect(() => loadLectureConfigInfo({ paths })).toThrow(LectureConfigError)
    expect(() => loadLectureConfigInfo({ paths })).toThrow(/access\.default/)
  })

  it('ensures LECTURE_ACCESS_JSON env override has highest priority over access.json', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cfg-env-priority-'))
    tmpDirs.push(dir)
    fs.writeFileSync(path.join(dir, 'site.config.ts'), 'export default { theme: "reader" }\n')
    fs.writeFileSync(
      path.join(dir, 'access.json'),
      JSON.stringify({ default: 'public', enforcement: 'none' }),
      'utf8',
    )
    const paths = resolveContent({ env: { LECTURE_CONTENT_DIR: dir } })
    const info = loadLectureConfigInfo({ paths })
    expect(info.config.access?.default).toBe('public')

    const envOverride = JSON.stringify({ default: 'authenticated', enforcement: 'gateway' })
    const groups = [{ id: 'G01', dir: 'g01' }]
    const plan = resolveBuildAccess(info.config.access, groups, { LECTURE_ACCESS_JSON: envOverride })
    expect(plan.defaultTier).toBe('authenticated')

    const authPlan = resolveAuthPlan(info.config.access, groups, { LECTURE_ACCESS_JSON: envOverride })
    expect(authPlan.defaultTier).toBe('authenticated')
  })
})

describe('dashboardDevPlugin access endpoints', () => {
  type Invoke = (o: {
    method: string
    url: string
    token?: string
    body?: unknown
  }) => Promise<{ status: number; json: Record<string, unknown> | null }>

  function makeInvoker(opts: Parameters<typeof createDashboardDevHandler>[0]): Invoke {
    const handler = createDashboardDevHandler({ token: 'test-token', ...opts })
    return (o) =>
      new Promise((resolve) => {
        const req = new EventEmitter() as IncomingMessage
        req.method = o.method
        req.url = o.url
        req.headers = {
          host: '127.0.0.1',
          ...(o.token !== '' ? { 'x-lecture-dev-token': o.token ?? 'test-token' } : {}),
        }
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

  it('includes /access in DEMO_WRITE_ENDPOINTS', () => {
    expect(DEMO_WRITE_ENDPOINTS).toContain('/access')
  })

  it('rejects POST /__lecture/api/access with 409 demo_read_only when demo: true', async () => {
    const invoke = makeInvoker({ demo: true })
    const r = await invoke({
      method: 'POST',
      url: '/__lecture/api/access',
      body: { default: 'public' },
    })
    expect(r.status).toBe(409)
    expect(r.json?.error).toBe('demo_read_only')
  })

  it('validates input and rejects invalid payload with 400', async () => {
    const target = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'access-val-')), 'access.json')
    tmpDirs.push(path.dirname(target))
    const invoke = makeInvoker({ demo: false, accessFilePath: target })
    const r = await invoke({
      method: 'POST',
      url: '/__lecture/api/access',
      body: { default: 'invalid_tier' },
    })
    expect(r.status).toBe(400)
    expect(r.json?.error).toBe('validation_failed')
    expect(fs.existsSync(target)).toBe(false)
  })

  it('atomically saves valid AccessConfig and returns 200', async () => {
    const targetDir = fs.mkdtempSync(path.join(os.tmpdir(), 'access-save-'))
    const target = path.join(targetDir, 'access.json')
    tmpDirs.push(targetDir)
    let changed: readonly string[] = []
    const invoke = makeInvoker({
      demo: false,
      accessFilePath: target,
      onFilesChanged: (files) => {
        changed = files
      },
    })
    const payload = {
      default: 'public',
      enforcement: 'none',
      groups: {},
    }
    const r = await invoke({
      method: 'POST',
      url: '/__lecture/api/access',
      body: { access: payload },
    })
    expect(r.status).toBe(200)
    expect(r.json?.ok).toBe(true)
    expect(fs.existsSync(target)).toBe(true)
    const written = JSON.parse(fs.readFileSync(target, 'utf8')) as Record<string, unknown>
    expect(written.default).toBe('public')
    expect(written.enforcement).toBe('none')
    expect(changed).toContain(target)
  })

  it('generates autheliaPreview via POST /__lecture/api/access/preview', async () => {
    const invoke = makeInvoker({ demo: false })
    const r = await invoke({
      method: 'POST',
      url: '/__lecture/api/access/preview',
      body: {
        access: {
          default: 'public',
          enforcement: 'none',
        },
      },
    })
    expect(r.status).toBe(200)
    expect(r.json?.ok).toBe(true)
    expect(r.json).toHaveProperty('autheliaPreview')
  })
})

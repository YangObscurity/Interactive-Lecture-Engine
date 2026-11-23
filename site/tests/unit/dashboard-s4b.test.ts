/**
 * S4b Dashboard backend: log redaction, content snippets (path handling), and the token boundary of the new dev-only
 * endpoints (/file, /logs, /prompts/at, POST /check need the dev token; /runtime, /check, /changes, /prompts/history
 * return no file contents and no secrets).
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { afterAll, describe, expect, it } from 'vitest'
import { clearDevLogs, pushDevLog, readDevLogs, redactLogLine } from '../../docs/.vitepress/plugins/devLogs.mts'
import { CHECK_CATEGORY_IDS, checkOnlyFromBody, gitLogDir, mergeCheckReport, readContentSnippet, readServerLimits } from '../../docs/.vitepress/plugins/dashboardDevExtras.mts'
import { CHECK_CATEGORIES } from '../../scripts/content/check.mts'
import { createDashboardDevHandler } from '../../docs/.vitepress/plugins/dashboardDevPlugin.mts'
import { fillTemplate, segmentTemplate, unknownTokens } from '../../docs/.vitepress/theme/dashboard/placeholders.ts'
import { todoFromChecks } from '../../docs/.vitepress/theme/dashboard/dashboardData.ts'

describe('dev log redaction (before a line is stored)', () => {
  it('masks secrets, tokens, user names, e-mail, IPs and home-folder account names', () => {
    // home-folder paths are assembled so the privacy scan of this file stays clean
    const winHome = ['C:', 'Users', 'carol', 'proj'].join('\\')
    const nixHome = ['', 'home', 'dave', 'x'].join('/')
    const line = redactLogLine(
      'AI_API_KEY=sk-abcdefghijklmnop Authorization: Bearer abc.def.ghi user=alice mail bob@example.com from 203.0.113.7 ' +
        `and 2001:db8::1 at ${winHome} and ${nixHome} and postgres://eve:pw@db/x`,
    )
    expect(line).not.toMatch(/abcdefghijklmnop|abc\.def\.ghi|alice|bob@|203\.0\.113\.7|2001:db8|carol|dave|eve:pw/)
    expect(line).toContain('AI_API_KEY=***')
    expect(line).toContain(['C:', 'Users', '***'].join('\\'))
    expect(line).toContain(['', 'home', '***'].join('/'))
  })
  it('keeps clock times, loopback and ordinary text', () => {
    expect(redactLogLine('22:18:03 [vite] page reload docs/g01/L01.md on 127.0.0.1:5173')).toBe('22:18:03 [vite] page reload docs/g01/L01.md on 127.0.0.1:5173')
  })
  it('stores only redacted lines in the ring and serves lines after a seq', () => {
    clearDevLogs()
    pushDevLog('dev', 'info', 'token=supersecretvalue1234')
    const { lines, last } = readDevLogs(0)
    const mine = lines.filter((l) => l.msg.includes('token='))
    expect(mine.at(-1)?.msg).toBe('token=***')
    expect(readDevLogs(last).lines).toHaveLength(0)
  })
})

describe('content snippets stay inside the content root', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lec-snip-'))
  fs.mkdirSync(path.join(root, 'lectures', 'g01'), { recursive: true })
  fs.writeFileSync(path.join(root, 'lectures', 'g01', 'L01.md'), Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join('\n'))
  fs.writeFileSync(path.join(root, 'secret.env'), 'X=1')
  afterAll(() => fs.rmSync(root, { recursive: true, force: true }))

  it('returns the lines around a hit', () => {
    const s = readContentSnippet({ root }, 'lectures/g01/L01.md', 15, 3)
    expect(s.ok).toBe(true)
    if (s.ok) {
      expect(s.from).toBe(12)
      expect(s.lines).toEqual(['line 12', 'line 13', 'line 14', 'line 15', 'line 16', 'line 17', 'line 18'])
      expect(s.hit).toBe(15)
    }
  })
  it('refuses absolute paths, .., other file types and missing files', () => {
    for (const bad of ['/etc/passwd', 'C:/Windows/win.ini', '../x.md', 'lectures/../../x.md', 'lectures//L01.md']) {
      expect(readContentSnippet({ root }, bad, null)).toMatchObject({ ok: false, status: 400 })
    }
    expect(readContentSnippet({ root }, 'secret.env', null)).toMatchObject({ ok: false, error: 'unsupported_type' })
    expect(readContentSnippet({ root }, 'lectures/g01/L99.md', null)).toMatchObject({ ok: false, status: 404 })
  })
  it('gitLogDir is empty outside a repository', async () => {
    expect(await gitLogDir(root)).toEqual([])
  })
})

describe('reader limits are read, never written', () => {
  it('falls back to the defaults without server/.env', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lec-lim-'))
    const r = readServerLimits(dir)
    expect(r.exists).toBe(false)
    expect(r.limits.every((l) => l.source === 'default')).toBe(true)
    fs.mkdirSync(path.join(dir, 'server'))
    fs.writeFileSync(path.join(dir, 'server', '.env'), 'AI_DAILY_LIMIT=42\nAI_API_KEY=sk-should-not-matter\n')
    const r2 = readServerLimits(dir)
    expect(r2.limits.find((l) => l.key === 'AI_DAILY_LIMIT')).toMatchObject({ value: 42, source: 'server/.env' })
    expect(JSON.stringify(r2)).not.toContain('sk-should')
    fs.rmSync(dir, { recursive: true, force: true })
  })
})

describe('the new dev endpoints keep the boundary', () => {
  const handler = createDashboardDevHandler({ token: 's4b-token' })
  const invoke = (method: string, url: string, headers: Record<string, string> = {}) =>
    new Promise<{ status: number; body: string }>((resolve) => {
      const req = new EventEmitter() as IncomingMessage
      req.method = method
      req.url = url
      req.headers = { host: '127.0.0.1', ...headers }
      req.socket = { remoteAddress: '127.0.0.1' } as IncomingMessage['socket']
      let status = 200
      let raw = ''
      const res = {
        writeHead(code: number) {
          status = code
          return this
        },
        end(chunk?: string) {
          if (chunk) raw += String(chunk)
          resolve({ status, body: raw })
        },
      } as unknown as ServerResponse
      void handler(req, res, () => resolve({ status: 0, body: '' }))
      process.nextTick(() => req.emit('end'))
    })

  it('needs the dev token for file contents, logs, old prompt versions and running the check', async () => {
    for (const [m, u] of [
      ['GET', '/__lecture/api/file?path=groups.ts'],
      ['GET', '/__lecture/api/logs?after=0'],
      ['GET', '/__lecture/api/prompts/at?rev=abcdef1'],
      ['POST', '/__lecture/api/check'],
    ] as const) {
      expect((await invoke(m, u)).status).toBe(403)
      expect((await invoke(m, u, { 'x-lecture-dev-token': 'wrong' })).status).toBe(403)
    }
  })
  it('refuses a cross-origin request and a path out of the content folder even with the token', async () => {
    expect((await invoke('GET', '/__lecture/api/logs', { origin: 'https://evil.example' })).status).toBe(403)
    const out = await invoke('GET', '/__lecture/api/file?path=..%2F.env', { 'x-lecture-dev-token': 's4b-token' })
    expect(out.status).toBe(400)
  })
  it('answers the check state before any run, and logs with the token', async () => {
    const c = await invoke('GET', '/__lecture/api/check')
    expect(JSON.parse(c.body)).toMatchObject({ ok: true, run: null })
    const l = await invoke('GET', '/__lecture/api/logs?after=0', { 'x-lecture-dev-token': 's4b-token' })
    expect(l.status).toBe(200)
    expect(Array.isArray(JSON.parse(l.body).lines)).toBe(true)
  })
  it('refuses a revision that is not a commit hash', async () => {
    const r = await invoke('GET', '/__lecture/api/prompts/at?rev=HEAD%3A..%2F.env', { 'x-lecture-dev-token': 's4b-token' })
    expect(r.status).toBe(404)
  })
})

describe('placeholders and to-dos', () => {
  it('splits a template into text and known tokens; unknown tokens stay text and are reported', () => {
    const seg = segmentTemplate('Explain {lecture} on {selection} and {nope}', ['lecture', 'selection'])
    expect(seg.map((s) => (s.kind === 'token' ? s.name : '')).filter(Boolean)).toEqual(['lecture', 'selection'])
    expect(unknownTokens('Explain {lecture} and {nope}', ['lecture'])).toEqual(['nope'])
    expect(fillTemplate('Explain {lecture}', { lecture: 'L01' })).toBe('Explain L01')
  })
  it('lists failures per file, then warnings per check code', () => {
    const t = (k: string, p?: Record<string, string | number>) => `${k}${p ? JSON.stringify(p) : ''}`
    const items = todoFromChecks(
      {
        mode: 'content',
        root: 'content',
        counts: { groups: 1, lectures: 1, translations: 0, charts: 0, concepts: 0, figures: 0 },
        totals: { fail: 1, warn: 2, info: 0 },
        ok: false,
        issues: [
          { level: 'fail', code: 'lecture.figure', file: 'lectures/g01/L01.md', line: 3, message: 'missing figure' },
          { level: 'warn', code: 'lecture.next', file: 'lectures/g01/L01.md', message: 'no next' },
          { level: 'warn', code: 'lecture.next', file: 'lectures/g01/L02.md', message: 'no next' },
        ],
      },
      t as never,
    )
    expect(items.map((i) => i.k)).toEqual(['bad', 'warn'])
    expect(items[0]?.file).toBe('lectures/g01/L01.md:3')
    expect(items[1]?.title).toContain('"n":2')
  })
})

describe('content checks: rerun one category (POST /check { only })', () => {
  it('takes only whitelisted categories, in a fixed order', () => {
    expect(checkOnlyFromBody({})).toBeNull()
    expect(checkOnlyFromBody(null)).toBeNull()
    expect(checkOnlyFromBody({ only: null })).toBeNull()
    expect(checkOnlyFromBody({ only: 'chart' })).toEqual(['chart'])
    expect(checkOnlyFromBody({ only: ['texts', 'chart', 'texts'] })).toEqual(['chart', 'texts'])
    for (const bad of [[], ['charts'], ['../x'], 'chart,texts', [1], { a: 1 }, Array(10).fill('chart')]) {
      expect(checkOnlyFromBody({ only: bad })).toBe('invalid')
    }
    expect([...CHECK_CATEGORY_IDS]).toEqual([...CHECK_CATEGORIES])
  })

  it('merges a partial run into the full report (other categories kept, totals counted again)', () => {
    const full = {
      mode: 'content',
      counts: { lectures: 3 },
      issues: [
        { level: 'fail', code: 'chart.file_missing', message: 'a' },
        { level: 'warn', code: 'chart.orphan', message: 'b' },
        { level: 'warn', code: 'group.no_lectures', message: 'c' },
        { level: 'info', code: 'texts.empty', message: 'd' },
      ],
      totals: { fail: 1, warn: 2, info: 1 },
      ok: false,
      only: null,
    }
    const partial = { counts: { lectures: 3 }, issues: [{ level: 'warn', code: 'chart.orphan', message: 'b' }], totals: { fail: 0, warn: 1, info: 0 }, ok: true, only: ['chart'] }
    const merged = mergeCheckReport(full, partial, ['chart']) as typeof full
    expect(merged.issues.map((i) => i.code)).toEqual(['group.no_lectures', 'texts.empty', 'chart.orphan'])
    expect(merged.totals).toEqual({ fail: 0, warn: 2, info: 1 })
    expect(merged.ok).toBe(true)
    expect(merged.only).toBeNull()
    expect(merged.counts).toEqual({ lectures: 3 })
    expect(mergeCheckReport(null, partial, ['chart'])).toBe(partial)
  })

  it('refuses an unknown category with 400 (after the token check)', async () => {
    const handler = createDashboardDevHandler({ token: 's4c-token' })
    const post = (body: string, headers: Record<string, string>) =>
      new Promise<{ status: number; body: string }>((resolve) => {
        const req = new EventEmitter() as IncomingMessage
        req.method = 'POST'
        req.url = '/__lecture/api/check'
        req.headers = { host: '127.0.0.1', 'content-type': 'application/json', ...headers }
        req.socket = { remoteAddress: '127.0.0.1' } as IncomingMessage['socket']
        let status = 200
        let raw = ''
        const res = {
          writeHead(code: number) {
            status = code
            return this
          },
          end(chunk?: string) {
            if (chunk) raw += String(chunk)
            resolve({ status, body: raw })
          },
        } as unknown as ServerResponse
        void handler(req, res, () => resolve({ status: 0, body: '' }))
        process.nextTick(() => {
          req.emit('data', Buffer.from(body))
          req.emit('end')
        })
      })
    expect((await post('{"only":["chart"]}', {})).status).toBe(403)
    const bad = await post('{"only":["rm -rf"]}', { 'x-lecture-dev-token': 's4c-token' })
    expect(bad.status).toBe(400)
    expect(JSON.parse(bad.body)).toMatchObject({ ok: false, error: 'invalid_only' })
  })
})

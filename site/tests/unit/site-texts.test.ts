import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import {
  assertSiteTexts,
  emptySiteTexts,
  fillLecturesToken,
  getExampleTextsPath,
  getSiteTextsPath,
  listEmptyFields,
  loadSiteTexts,
  resolveLocaleTexts,
  saveSiteTexts,
  siteTextsProblems,
  toSiteMeta,
  validateSiteTexts,
  type SiteTexts,
} from '../../docs/.vitepress/site-texts.mts'
import { pickSiteText } from '../../docs/.vitepress/i18n/index.ts'
import { runDoctor } from '../../scripts/config/doctor.mts'
import { createDashboardDevHandler } from '../../docs/.vitepress/plugins/dashboardDevPlugin.mts'

const tmpDirs: string[] = []
function tmpSiteDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'site-texts-test-'))
  tmpDirs.push(dir)
  return dir
}
afterEach(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

function texts(zh: Partial<SiteTexts['zh']>, en: Partial<SiteTexts['en']> = {}): SiteTexts {
  const t = emptySiteTexts()
  return { zh: { ...t.zh, ...zh }, en: { ...t.en, ...en } }
}

describe('template and loading', () => {
  it('the shipped example has every value empty (hints live in the schema, not in the values)', () => {
    const example = JSON.parse(fs.readFileSync(getExampleTextsPath(path.resolve(__dirname, '../..')), 'utf8')) as SiteTexts
    expect(example).toEqual(emptySiteTexts())
  })

  it('reads the texts file, else the example, else all empty; missing fields read as empty strings', () => {
    const dir = tmpSiteDir()
    expect(loadSiteTexts({ siteDir: dir })).toEqual(emptySiteTexts())
    fs.writeFileSync(getExampleTextsPath(dir), JSON.stringify(texts({ name: 'From example' })))
    expect(loadSiteTexts({ siteDir: dir }).zh.name).toBe('From example')
    fs.writeFileSync(getSiteTextsPath(dir), JSON.stringify({ zh: { name: 'Mine', tagline: 7 }, en: null }))
    const loaded = loadSiteTexts({ siteDir: dir })
    expect(loaded.zh).toEqual({ ...emptySiteTexts().zh, name: 'Mine' })
    expect(loaded.en).toEqual(emptySiteTexts().en)
  })

  it('a texts file that is not JSON throws and names the file', () => {
    const dir = tmpSiteDir()
    fs.writeFileSync(getSiteTextsPath(dir), '{ nope')
    expect(() => loadSiteTexts({ siteDir: dir })).toThrow(/site-texts\.json/)
  })

  it('saves atomically and round-trips; no temp file is left behind', () => {
    const dir = tmpSiteDir()
    const value = texts({ name: '站名', tagline: '标语' }, { name: 'Name' })
    saveSiteTexts(value, { siteDir: dir })
    expect(loadSiteTexts({ siteDir: dir })).toEqual(value)
    expect(fs.readdirSync(dir)).toEqual(['site-texts.json'])
  })
})

describe('empty-value rules', () => {
  it('short name falls back to the name, description to the tagline', () => {
    const r = resolveLocaleTexts({ name: 'N', shortName: '', navText: '', tagline: 'T', description: '' })
    expect(r.shortName).toBe('N')
    expect(r.description).toBe('T')
    const own = resolveLocaleTexts({ name: 'N', shortName: 'S', navText: 'V', tagline: 'T', description: 'D' })
    expect([own.shortName, own.navText, own.description]).toEqual(['S', 'V', 'D'])
  })

  it('description and tagline both empty: no description at all', () => {
    expect(resolveLocaleTexts(texts({ name: 'N' }).zh).description).toBe('')
  })

  it('site meta: no separate short title when it would equal the name; empty nav text and tagline stay empty', () => {
    const meta = toSiteMeta(texts({ name: 'N', tagline: 'T' }, { name: 'E' }))
    expect(meta.shortName).toBe('')
    expect(meta.text).toBe('')
    expect(meta.description).toBe('T')
    expect(meta.i18n?.en).toEqual({ name: 'E', shortName: '', text: '', tagline: '', description: '' })
  })

  it('an empty English field never falls back to the Chinese one (the home page renders nothing for it)', () => {
    const meta = toSiteMeta(texts({ name: 'N', navText: '导航', tagline: '标语' }, { name: 'E' }))
    expect(pickSiteText(meta, 'zh-CN', 'tagline')).toBe('标语')
    expect(pickSiteText(meta, 'en', 'tagline')).toBe('')
    expect(pickSiteText(meta, 'en', 'text')).toBe('')
    // legacy site meta without an `i18n` entry still falls back to the root language
    expect(pickSiteText({ tagline: '根' }, 'en', 'tagline')).toBe('根')
  })

  it('the home page does not render an empty title or tagline (v-if on the resolved text)', () => {
    const home = fs.readFileSync(path.resolve(__dirname, '../../docs/.vitepress/theme/HomeBody.vue'), 'utf8')
    expect(home).toMatch(/<h1 v-if="heroTitle"/)
    expect(home).toMatch(/<p v-if="heroTagline"/)
  })

  it('{lectures} is filled with the lecture count, left alone without a count', () => {
    expect(fillLecturesToken('共 {lectures} 讲', 404)).toBe('共 404 讲')
    expect(fillLecturesToken('共 {lectures} 讲', undefined)).toBe('共 {lectures} 讲')
  })

  it('lists every empty field per locale and marks the required one', () => {
    const list = listEmptyFields(texts({ name: 'N', shortName: 'S', navText: 'V', tagline: 'T', description: 'D' }, { name: '  ' }))
    expect(list.map((e) => `${e.locale}.${e.field}${e.required ? '!' : ''}`)).toEqual([
      'en.name!',
      'en.shortName',
      'en.navText',
      'en.tagline',
      'en.description',
    ])
  })
})

describe('validation', () => {
  const ok = texts({ name: 'N' }, { name: 'E' })

  it('only the name is required; empty optional fields are valid', () => {
    expect(validateSiteTexts(ok).valid).toBe(true)
    const res = validateSiteTexts(texts({ name: ' ' }, { name: 'E' }))
    expect(res.valid).toBe(false)
    expect(res.issues).toEqual([{ locale: 'zh', field: 'name', code: 'required' }])
  })

  it('rejects wrong shapes and non-string fields', () => {
    expect(validateSiteTexts(null).valid).toBe(false)
    expect(validateSiteTexts({ zh: {} }).issues.map((i) => i.code)).toContain('bad_shape')
    expect(validateSiteTexts({ zh: { ...ok.zh, name: 5 }, en: ok.en }).issues).toEqual([{ locale: 'zh', field: 'name', code: 'not_string' }])
  })

  it('enforces the length limits', () => {
    const res = validateSiteTexts(texts({ name: 'a'.repeat(61) }, { name: 'E' }))
    expect(res.issues).toEqual([{ locale: 'zh', field: 'name', code: 'too_long', detail: 60 }])
  })

  it('allows {lectures} in the description only and rejects every other token', () => {
    expect(validateSiteTexts(texts({ name: 'N', description: '共 {lectures} 讲' }, { name: 'E' })).valid).toBe(true)
    const inTagline = validateSiteTexts(texts({ name: 'N', tagline: '共 {lectures} 讲' }, { name: 'E' }))
    expect(inTagline.issues).toEqual([{ locale: 'zh', field: 'tagline', code: 'unknown_token', detail: '{lectures}' }])
    const unknown = validateSiteTexts(texts({ name: 'N', description: '{count} 讲' }, { name: 'E' }))
    expect(unknown.issues).toEqual([{ locale: 'zh', field: 'description', code: 'unknown_token', detail: '{count}' }])
  })

  it('does not treat bracket text as a placeholder any more', () => {
    expect(validateSiteTexts(texts({ name: '[站点名称]' }, { name: 'E' })).valid).toBe(true)
  })
})

describe('build gate and doctor', () => {
  it('an empty name fails the build with a message naming the field and the file', () => {
    const dir = tmpSiteDir()
    const empty = texts({}, { name: 'E' })
    expect(siteTextsProblems(empty)).toEqual(['zh.name: required, must not be empty'])
    expect(() => assertSiteTexts(empty, dir)).toThrow(/zh\.name[\s\S]*site-texts\.json|site-texts\.json[\s\S]*zh\.name/)
    expect(() => assertSiteTexts(texts({ name: 'N' }, { name: 'E' }), dir)).not.toThrow()
  })

  it('doctor lists every empty optional field per locale as a warning and an empty name as an error', async () => {
    const dir = tmpSiteDir()
    saveSiteTexts(texts({ name: 'N', tagline: 'T' }, { name: '' }), { siteDir: dir })
    const report = await runDoctor({ siteDir: dir })
    const textLines = (list: string[]) => list.filter((l) => l.startsWith('站点文案'))
    expect(textLines(report.errors)).toEqual(['站点文案 (en.name: required, must not be empty)'])
    const warned = textLines(report.warnings)
    // zh: shortName, navText, description empty; en: all but the (required, reported as error) name
    expect(warned.map((w) => w.slice(0, w.indexOf(':')))).toEqual([
      '站点文案 (zh.shortName)',
      '站点文案 (zh.navText)',
      '站点文案 (zh.description)',
      '站点文案 (en.shortName)',
      '站点文案 (en.navText)',
      '站点文案 (en.tagline)',
      '站点文案 (en.description)',
    ])
    expect(warned.find((w) => w.includes('zh.shortName'))).toContain('留空：手机顶栏沿用站名')
  })

  it('doctor reports no site-text line for a complete file', async () => {
    const dir = tmpSiteDir()
    saveSiteTexts(
      texts(
        { name: 'N', shortName: 'S', navText: 'V', tagline: 'T', description: 'D' },
        { name: 'E', shortName: 'S', navText: 'V', tagline: 'T', description: 'D' },
      ),
      { siteDir: dir },
    )
    const report = await runDoctor({ siteDir: dir })
    expect([...report.errors, ...report.warnings].filter((l) => l.startsWith('站点文案'))).toEqual([])
  })
})

describe('dashboard dev plugin: POST /texts', () => {
  function makeInvoker(siteDir: string) {
    const handler = createDashboardDevHandler({ token: 'test-token', siteDir })
    return (opts: { method: string; url: string; headers?: Record<string, string>; body?: string }) =>
      new Promise<{ status: number; body: string }>((resolve) => {
        const req = new EventEmitter() as IncomingMessage
        req.method = opts.method
        req.url = opts.url
        req.headers = { host: '127.0.0.1', ...(opts.headers ?? {}) }
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
          if (opts.body) req.emit('data', Buffer.from(opts.body, 'utf8'))
          req.emit('end')
        })
      })
  }
  const post = (body: unknown, token = 'test-token') => ({
    method: 'POST',
    url: '/__lecture/api/texts',
    headers: { 'x-lecture-dev-token': token },
    body: JSON.stringify(body),
  })

  it('needs the CSRF token and writes nothing without it', async () => {
    const dir = tmpSiteDir()
    const invoke = makeInvoker(dir)
    const res = await invoke(post({ texts: texts({ name: 'N' }, { name: 'E' }) }, 'wrong'))
    expect(res.status).toBe(403)
    expect(fs.existsSync(getSiteTextsPath(dir))).toBe(false)
  })

  it('rejects an empty name, unknown tokens and over-long values with 400 and does not touch the file', async () => {
    const dir = tmpSiteDir()
    const invoke = makeInvoker(dir)
    for (const bad of [
      texts({}, { name: 'E' }),
      texts({ name: 'N', tagline: '{x}' }, { name: 'E' }),
      texts({ name: 'a'.repeat(61) }, { name: 'E' }),
    ]) {
      const res = await invoke(post({ texts: bad }))
      expect(res.status).toBe(400)
      const body = JSON.parse(res.body) as { ok: boolean; errors: string[] }
      expect(body.ok).toBe(false)
      expect(body.errors.length).toBeGreaterThan(0)
    }
    expect(fs.existsSync(getSiteTextsPath(dir))).toBe(false)
  })

  it('saves a valid payload (optional fields may stay empty) to the texts file only', async () => {
    const dir = tmpSiteDir()
    const invoke = makeInvoker(dir)
    const value = texts({ name: ' 站名 ', description: '共 {lectures} 讲' }, { name: 'Name' })
    const res = await invoke(post({ texts: value }))
    expect(res.status).toBe(200)
    const saved = JSON.parse(fs.readFileSync(getSiteTextsPath(dir), 'utf8')) as SiteTexts
    expect(saved.zh.name).toBe('站名')
    expect(saved.zh.description).toBe('共 {lectures} 讲')
    expect(saved.en.tagline).toBe('')
    expect(fs.readdirSync(dir)).toEqual(['site-texts.json'])
  })
})

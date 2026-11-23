import { describe, expect, it } from 'vitest'
import { MODULES, SETTINGS, SITE_MODULES, namesOf, optionsOf, siteDefaults, toJSON, type SiteModuleId } from '../../config/schema.ts'
import { LectureConfigError, defineLectureConfig, resolveModules, type LectureConfig } from '../../docs/.vitepress/lecture-config.mts'
import { loadLectureConfig } from '../../docs/.vitepress/content/config.mts'

const siteConfig = loadLectureConfig()

const siteModuleIds = Object.keys(SITE_MODULES) as SiteModuleId[]

describe('config schema invariants', () => {
  it('every name (canonical keys and aliases) is unique', () => {
    const names = SETTINGS.flatMap(namesOf)
    expect(new Set(names).size).toBe(names.length)
  })

  it('env and secret keys are UPPER_SNAKE; site keys are <siteModule>.<field>', () => {
    for (const s of SETTINGS) {
      if (s.kind === 'site') {
        expect(s.key, s.key).toMatch(/^[a-zA-Z]+\.[a-zA-Z]+$/)
        expect(siteModuleIds, s.key).toContain(s.module)
      } else {
        for (const n of namesOf(s)) expect(n, n).toMatch(/^[A-Z][A-Z0-9_]*$/)
      }
    }
  })

  it('every setting belongs to a declared module and every module has settings', () => {
    const ids = MODULES.map((m) => m.id)
    for (const s of SETTINGS) expect(ids, s.key).toContain(s.module)
    for (const m of MODULES) expect(SETTINGS.some((s) => s.module === m.id), m.id).toBe(true)
    for (const m of MODULES) expect(m.site, m.id).toBe(siteModuleIds.includes(m.id as SiteModuleId))
  })

  it('secrets have no default and are never also "masked" (they are hidden entirely)', () => {
    for (const s of SETTINGS.filter((x) => x.kind === 'secret')) {
      expect(s.default, s.key).toBeUndefined()
      expect(s.masked, s.key).toBeUndefined()
    }
  })

  it('enums list their values and default to one of them', () => {
    for (const s of SETTINGS.filter((x) => x.type === 'enum')) {
      expect(s.values?.length, s.key).toBeGreaterThan(0)
      expect(s.values, s.key).toContain(s.default)
    }
  })

  it('neededBy points at a real site-module adapter', () => {
    for (const s of SETTINGS) {
      if (!s.neededBy) continue
      const spec = SITE_MODULES[s.neededBy.module]
      for (const a of s.neededBy.adapters) expect(spec.values as readonly string[], s.key).toContain(a)
    }
  })

  it('defaults and examples carry no real infrastructure: only localhost / 127.0.0.1 / example.com', () => {
    for (const s of SETTINGS) {
      for (const v of [s.default, s.example]) {
        if (typeof v !== 'string') continue
        for (const ip of v.match(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g) ?? []) expect(ip, s.key).toBe('127.0.0.1')
        for (const host of v.match(/\b(?:[a-z0-9-]+\.)+[a-z]{2,}\b/gi) ?? []) {
          if (/^\d/.test(host) || /\.(py|json|md|ts|mts)$/i.test(host)) continue
          const h = host.toLowerCase()
          expect(h === 'example.com' || h.endsWith('.example.com'), `${s.key}: ${host}`).toBe(true)
        }
      }
    }
  })

  it('toJSON is plain data that survives a JSON round trip', () => {
    const j = toJSON()
    expect(JSON.parse(JSON.stringify(j))).toEqual(j)
    expect(j.schemaVersion).toBe(1)
  })
})

describe('lecture.config.ts modules', () => {
  it('the site config validates', () => {
    expect(() => defineLectureConfig(siteConfig)).not.toThrow()
  })

  it('omitted modules resolve to the schema defaults', () => {
    const r = resolveModules({ theme: 'reader' })
    expect(r).toEqual(siteDefaults())
    expect(r.progress.adapter).toBe('local')
    expect(r.graph.source).toBe('merge')
  })

  it('a given choice wins over the default', () => {
    expect(resolveModules({ theme: 'reader', modules: { progress: { adapter: 'rest' } } }).progress.adapter).toBe('rest')
  })

  it('a wrong value fails with the allowed values in the message', () => {
    const bad = { theme: 'reader', modules: { companion: { adapter: 'dify' } } } as unknown as LectureConfig
    expect(() => defineLectureConfig(bad)).toThrow(LectureConfigError)
    expect(() => defineLectureConfig(bad)).toThrow(/off \| openai-compatible \| proxy/)
  })

  it('an unknown module or field fails', () => {
    expect(() => defineLectureConfig({ theme: 'reader', modules: { search: { adapter: 'x' } } } as unknown as LectureConfig)).toThrow(/unknown module "search"/)
    expect(() => defineLectureConfig({ theme: 'reader', modules: { graph: { adapter: 'merge' } } } as unknown as LectureConfig)).toThrow(/expected source/)
  })
})

describe('site module options (P3)', () => {
  it('are declared as site settings with a type and a default', () => {
    const row = (key: string) => SETTINGS.find((x) => x.key === key)
    expect(row('progress.endpoint')).toMatchObject({ module: 'progress', kind: 'site', type: 'path', default: '/api/db' })
    expect(row('progress.notionSync')).toMatchObject({ module: 'progress', kind: 'site', type: 'bool', default: false })
    expect(row('auth.sessionEndpoint')).toMatchObject({ module: 'auth', kind: 'site', type: 'path', default: '/api/auth/session' })
    expect(optionsOf('progress').map(([name]) => name)).toEqual(['endpoint', 'notionSync'])
    expect(optionsOf('graph')).toEqual([])
  })

  it('resolve to their defaults, with the adapter first, and match siteDefaults()', () => {
    const r = resolveModules({ theme: 'reader' })
    expect(r.progress).toEqual({ adapter: 'local', endpoint: '/api/db', notionSync: false })
    expect(r.auth).toEqual({ adapter: 'none', sessionEndpoint: '/api/auth/session' })
    expect(Object.keys(r.progress)[0]).toBe('adapter')
    expect(r).toEqual(siteDefaults())
  })

  it('a given option wins over the default, alone or together with the adapter', () => {
    expect(resolveModules({ theme: 'reader', modules: { progress: { notionSync: true } } }).progress).toEqual({ adapter: 'local', endpoint: '/api/db', notionSync: true })
    expect(resolveModules({ theme: 'reader', modules: { progress: { adapter: 'rest', endpoint: '/svc/db' }, auth: { adapter: 'trusted-header', sessionEndpoint: '/svc/who' } } })).toMatchObject({
      progress: { adapter: 'rest', endpoint: '/svc/db', notionSync: false },
      auth: { adapter: 'trusted-header', sessionEndpoint: '/svc/who' },
    })
  })

  it('an unknown option fails and lists what is allowed', () => {
    const bad = { theme: 'reader', modules: { progress: { adapter: 'rest', sync: true } } } as unknown as LectureConfig
    expect(() => defineLectureConfig(bad)).toThrow(LectureConfigError)
    expect(() => defineLectureConfig(bad)).toThrow('lecture.config.ts: modules.progress.sync is not a setting (expected adapter, endpoint, notionSync)')
    expect(() => defineLectureConfig({ theme: 'reader', modules: { auth: { endpoint: '/x' } } } as unknown as LectureConfig)).toThrow('(expected adapter, sessionEndpoint)')
  })

  it('a value of the wrong type fails with a readable message', () => {
    const cfg = (modules: unknown) => ({ theme: 'reader', modules }) as unknown as LectureConfig
    expect(() => defineLectureConfig(cfg({ progress: { notionSync: 'yes' } }))).toThrow('modules.progress.notionSync = "yes" must be true or false')
    expect(() => defineLectureConfig(cfg({ progress: { notionSync: 1 } }))).toThrow(/must be true or false/)
    expect(() => defineLectureConfig(cfg({ progress: { endpoint: 'api/db' } }))).toThrow('modules.progress.endpoint = "api/db" must be a path starting with "/"')
    expect(() => defineLectureConfig(cfg({ progress: { endpoint: '/api db' } }))).toThrow(/must be a path starting with "\/" and without spaces, e.g. "\/api\/db"/)
    expect(() => defineLectureConfig(cfg({ auth: { sessionEndpoint: 42 } }))).toThrow(/modules.auth.sessionEndpoint = 42 must be a path/)
    expect(() => defineLectureConfig(cfg({ progress: { adapter: 'sqlite' } }))).toThrow(/local \| rest/)
  })

  it('valid options pass validation', () => {
    expect(() => defineLectureConfig({ theme: 'reader', modules: { progress: { adapter: 'rest', endpoint: '/api/db', notionSync: true }, auth: { sessionEndpoint: '/api/auth/session' } } })).not.toThrow()
  })

  it('the site config resolves with the options filled in', () => {
    const r = resolveModules(siteConfig)
    expect(typeof r.progress.endpoint).toBe('string')
    expect(typeof r.progress.notionSync).toBe('boolean')
    expect(typeof r.auth.sessionEndpoint).toBe('string')
  })
})

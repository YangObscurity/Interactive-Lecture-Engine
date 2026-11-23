/**
 * S3 privacy gate (scripts/privacy/scan.mjs): path allowlist, generic patterns, personal terms kept outside git,
 * masked output, and the hook installer's refusal in a repository that tracks content/.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createJiti } from 'jiti'

// scan.mjs starts with a hashbang; vite-node wraps a module in a function, so a plain import fails with
// "Invalid or unexpected token". jiti strips the hashbang. The script has no types.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Fn = (...args: any[]) => any
const scanModule = (await createJiti(import.meta.url).import('../../../scripts/privacy/scan.mjs')) as Record<
  'loadAllowlist' | 'loadTerms' | 'pathAllowed' | 'scanEntries' | 'scanText',
  Fn
>
const { loadAllowlist, loadTerms, pathAllowed, scanEntries, scanText } = scanModule

const tmp: string[] = []
afterEach(() => {
  for (const d of tmp.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

type Hit = { file: string; line: number; rule: string; match: string }

describe('privacy scan', () => {
  it('allows engine folders, refuses content/, unknown top-level paths and excluded engine sub-folders', () => {
    const allow = ['site/', 'server/', 'README.md', '!site/docs/public/exports/']
    expect(pathAllowed('site/docs/.vitepress/config.mts', allow)).toBe(true)
    expect(pathAllowed('README.md', allow)).toBe(true)
    expect(pathAllowed('content/lectures/g01/L01.md', allow)).toBe(false)
    expect(pathAllowed('content', allow)).toBe(false)
    expect(pathAllowed('plans/plan_x.md', allow)).toBe(false)
    expect(pathAllowed('site/docs/public/exports/g01/L01.pdf', allow)).toBe(false)
    expect(pathAllowed('README.md.bak', allow)).toBe(false)
  })

  it('the shipped allowlist keeps the engine and refuses the private folders', () => {
    const allow = loadAllowlist() as string[]
    for (const p of ['site/package.json', 'server/src/app.ts', 'scripts/privacy/scan.mjs', 'AGENTS.md', '.github/workflows/privacy.yml']) {
      expect(pathAllowed(p, allow), p).toBe(true)
    }
    for (const p of ['workspaces/a.md', 'plans/plan.md', 'content-sources/x.md', 'design/spec-board.html', 'content/groups.ts']) {
      expect(pathAllowed(p, allow), p).toBe(false)
    }
  })

  it('finds generic shapes, masks them, and honours the per-line opt-out', () => {
    const text = [
      'see C:\\Users\\jdoe\\notes.md', // local-path // privacy-scan: allow
      'mail someone@corp.io', // email // privacy-scan: allow
      'contact docs@example.com', // allowed domain
      'key sk-abcdefghijklmnopqrstuvwx', // api-token // privacy-scan: allow
      'id 0123456789abcdef0123456789abcdef', // notion-id // privacy-scan: allow
      'C:\\Users\\x\\a.txt privacy-scan: allow', // opted out
    ].join('\n')
    const hits = scanText('docs/a.md', text, []) as Hit[]
    expect(hits.map((h) => `${h.line}:${h.rule}`)).toEqual(['1:local-path', '2:email', '4:api-token', '5:notion-id'])
    for (const h of hits) expect(h.match).toMatch(/\*/)
    expect(JSON.stringify(hits)).not.toContain('someone@corp.io') // privacy-scan: allow
  })

  it('personal terms match case-insensitively, cannot be opted out, and are never printed in full', () => {
    const hits = scanText('README.md', 'Built by JANE ROE for acme-host  privacy-scan: allow', ['Jane Roe', 'acme-host']) as Hit[]
    expect(hits.map((h) => h.rule)).toEqual(['personal-term', 'personal-term'])
    expect(JSON.stringify(hits)).not.toContain('Jane Roe')
    expect(JSON.stringify(hits)).not.toContain('acme-host')
  })

  it('skips uuid-shaped and author data in lock files and svg ids, and binary files', () => {
    const lock = scanText('site/package-lock.json', '"integrity": "0123456789abcdef0123456789abcdef", "author": "a@b.io"', []) as Hit[] // privacy-scan: allow
    expect(lock).toEqual([])
    const svg = scanText('site/docs/public/favicon.svg', '<g id="0123456789abcdef0123456789abcdef"/>', []) as Hit[] // privacy-scan: allow
    expect(svg).toEqual([])
    const entries = [{ rel: 'site/a.png', read: () => Buffer.from('C:\\Users\\x\\') }]
    expect(scanEntries(entries, { terms: [], allowlist: ['site/'], checkPaths: true })).toEqual([])
  })

  it('loads terms from the environment and from files outside the repository', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lec-privacy-'))
    tmp.push(home)
    fs.mkdirSync(path.join(home, '.config', 'lecture-engine'), { recursive: true })
    fs.writeFileSync(path.join(home, '.config', 'lecture-engine', 'privacy-terms.txt'), '# comment\nhost-one\n\nab\n', 'utf8')
    const terms = loadTerms({ env: { LECTURE_PRIVACY_TERMS: 'Name One, name-two\nthird' }, repoRoot: home, home }) as string[]
    expect(terms.sort()).toEqual(['Name One', 'host-one', 'name-two', 'third'])
  })

  it('reports a path outside the allowlist without reading it', () => {
    let read = false
    const entries = [{ rel: 'plans/x.md', read: () => ((read = true), Buffer.from('')) }]
    const hits = scanEntries(entries, { terms: [], allowlist: ['site/'], checkPaths: true }) as Hit[]
    expect(hits).toEqual([{ file: 'plans/x.md', line: 0, rule: 'path-not-allowed', match: '' }])
    expect(read).toBe(false)
  })

  it('leaves documented placeholders alone and still finds the real shapes next to them', () => {
    const rules = (text: string) => (scanText('docs/x.md', text, []) as Hit[]).map((h) => h.rule)
    // placeholders: Windows user folders of a made-up user, URL credentials, reserved domains, x-filled keys, zero uuids
    expect(rules(String.raw`C:\Users\me\data  C:\\Users\\Admin\\AppData  C:\Users\NAME~1\x  C:\Users\<you>\x`)).toEqual([]) // privacy-scan: allow
    expect(rules('postgres://user:password@db.host.io/x mailto:a@b.c owner@example.invalid esbuild@0.21.5')).toEqual([])
    expect(rules('app-xxxxxxxxxxxxxxxxxxxxxxxx sk-xxxxxxxxxxxxxxxxxxxxxxxx 00000000-0000-4000-8000-000000000101')).toEqual([])
    // the real shapes
    expect(rules(String.raw`C:\Users\jdoe\x`)).toEqual(['local-path']) // privacy-scan: allow
    expect(rules(String.raw`D:\work\notes  E:/proj/x`)).toEqual(['local-path', 'local-path']) // privacy-scan: allow
    expect(rules(String.raw`C:\Windows\System32  C:\Program Files\node  C:\Users\<you>\x  C:\x  C:\x.svg  C:\temp\pg  C:\My #1\key`)).toEqual([])
    expect(rules('write to jdoe@mail.io')).toEqual(['email']) // privacy-scan: allow
    expect(rules('key sk-a1B2c3D4e5F6g7H8i9J0k1L2')).toEqual(['api-token']) // privacy-scan: allow
    expect(rules('db deadbeefcafef00d0ddba11dfeedface')).toEqual(['notion-id']) // privacy-scan: allow
  })

  it('skips token shapes in shared dist bundles only, never personal terms or page bundles', () => {
    const line = 'const re = /sk-a1B2c3D4e5F6g7H8i9J0k1L2/; owner-name' // privacy-scan: allow
    const rules = (rel: string) => (scanText(rel, line.replace(' // privacy-scan: allow', ''), ['owner-name']) as Hit[]).map((h) => h.rule)
    expect(rules('assets/chunks/emacs-lisp.BX77sIaO.js')).toEqual(['personal-term'])
    expect(rules('assets/g01_L01.md.Ab12.js')).toEqual(['personal-term', 'api-token'])
    expect(rules('site/assets/chunks/x.js')).toEqual(['personal-term', 'api-token'])
  })

  it('takes regex syntax in a grammar for regex, not a drive, and still finds a drive path next to it', () => {
    const rules = (text: string) => (scanText('assets/chunks/vb.Cd05.js', text, []) as Hit[]).map((h) => h.rule)
    // as the shiki grammars of a built site have them: inline flag groups and an escaped class letter before a colon
    expect(rules(String.raw`{"match":"(?i:\\b(If|Then)\\b)","begin":"(?-i:\\s*\\"}`)).toEqual([])
    expect(rules(String.raw`"[.\\w:\\x{80}-\\x{10FFFF}]"`)).toEqual([])
    expect(rules(String.raw`"(?i:\\b(x))" and "D:\\work\\notes"`)).toEqual(['local-path']) // privacy-scan: allow
    expect(rules(String.raw`root = 'E:/proj/site'`)).toEqual(['local-path']) // privacy-scan: allow
  })

  it('names the LICENSE copyright holder only on that line of a LICENSE file', () => {
    const terms = ['owner-name']
    const rules = (rel: string, text: string) => (scanText(rel, text, terms) as Hit[]).map((h) => `${h.line}:${h.rule}`)
    const license = 'MIT License\n\nCopyright (c) 2026 owner-name\n\nThanks to owner-name for the idea.'
    expect(rules('LICENSE', license)).toEqual(['5:personal-term'])
    expect(rules('docs/engine-root/LICENSE', license)).toEqual(['5:personal-term'])
    expect(rules('README.md', 'Copyright (c) 2026 owner-name')).toEqual(['1:personal-term'])
    expect(rules('LICENSE.bak', 'Copyright (c) 2026 owner-name')).toEqual(['1:personal-term'])
  })
})

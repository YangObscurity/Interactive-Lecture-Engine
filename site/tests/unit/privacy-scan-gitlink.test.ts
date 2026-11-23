/**
 * scripts/privacy/scan.mjs on a repository with a submodule: a gitlink (mode 160000) is a folder in the work tree,
 * and `--tracked` used to readFileSync it (EISDIR). The scanner runs as a CLI in a throwaway repository: a copy of
 * scan.mjs under <tmp>/scripts/privacy/ takes <tmp> as its repository root.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { createJiti } from 'jiti'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Fn = (...args: any[]) => any
const SCAN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../scripts/privacy/scan.mjs')
const { parseLsFilesStage, parseDiffRaw, decodeText } = (await createJiti(import.meta.url).import(SCAN)) as Record<'parseLsFilesStage' | 'parseDiffRaw' | 'decodeText', Fn>

const OID = 'ab'.repeat(20)
const TERM = 'owner-name'

const tmp: string[] = []
afterEach(() => {
  for (const d of tmp.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

function makeRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lec-privacy-gitlink-'))
  tmp.push(root)
  const git = (...args: string[]) => execFileSync('git', ['-c', 'core.autocrlf=false', ...args], { cwd: root, encoding: 'utf8' })
  git('init', '-q')
  fs.mkdirSync(path.join(root, 'scripts', 'privacy'), { recursive: true })
  fs.copyFileSync(SCAN, path.join(root, 'scripts', 'privacy', 'scan.mjs'))
  fs.writeFileSync(path.join(root, 'scripts', 'privacy', 'engine-paths.txt'), 'site/\nscripts/\n', 'utf8')
  fs.mkdirSync(path.join(root, 'site', 'vendor'), { recursive: true })
  fs.writeFileSync(path.join(root, 'site', 'a.md'), `made by ${TERM}\n`, 'utf8')
  fs.writeFileSync(path.join(root, 'site', 'b.md'), 'nothing personal\n', 'utf8')
  git('add', 'scripts', 'site')
  // two submodules as a fresh clone has them: an index entry and an empty folder; one allowed, one outside the allowlist
  for (const sub of ['site/vendor', 'buffer']) {
    fs.mkdirSync(path.join(root, sub), { recursive: true })
    git('update-index', '--add', '--cacheinfo', `160000,${OID},${sub}`)
  }
  return { root, git }
}

function scan(root: string, ...args: string[]) {
  // personal terms only from the environment: no ~/.config term file of the machine running the test
  const env = { ...process.env, LECTURE_PRIVACY_TERMS: TERM, LECTURE_PRIVACY_TERMS_FILE: '', HOME: root, USERPROFILE: root }
  const r = spawnSync(process.execPath, [path.join(root, 'scripts', 'privacy', 'scan.mjs'), ...args], { cwd: root, env, encoding: 'utf8' })
  return { status: r.status, stdout: r.stdout, stderr: r.stderr }
}

type Report = { files: number; skipped: string[]; hits: { file: string; line: number; rule: string }[] }
const brief = (r: Report) => r.hits.map((h) => `${h.file}:${h.line}:${h.rule}`).sort()

describe('privacy scan with submodules', () => {
  it('parses staged and raw diff records with their modes', () => {
    const ls = `100644 ${OID} 0\tsite/a b.md\x00160000 ${OID} 0\tsub\x00`
    expect(parseLsFilesStage(ls)).toEqual([
      { mode: '100644', rel: 'site/a b.md' },
      { mode: '160000', rel: 'sub' },
    ])
    const zero = '0'.repeat(40)
    const raw = `:000000 100644 ${zero} ${OID} A\x00site/a.md\x00:000000 160000 ${zero} ${OID} A\x00sub\x00`
    expect(parseDiffRaw(raw)).toEqual([
      { mode: '100644', rel: 'site/a.md' },
      { mode: '160000', rel: 'sub' },
    ])
  })

  it('--tracked skips an allowed submodule, refuses one outside the allowlist, and still scans the real files', () => {
    const { root } = makeRepo()
    const r = scan(root, '--tracked', '--json')
    expect(r.stderr).not.toMatch(/EISDIR|Error/)
    expect(r.status).toBe(1)
    const rep = JSON.parse(r.stdout) as Report
    expect(rep.skipped).toEqual(['skipped submodule site/vendor'])
    expect(brief(rep)).toEqual(['buffer:0:path-not-allowed', 'site/a.md:1:personal-term'])
    expect(rep.files).toBe(6)
  })

  it('--tracked --no-paths reads no submodule folder and prints one line per skipped submodule', () => {
    const { root } = makeRepo()
    const r = scan(root, '--tracked', '--no-paths')
    expect(r.stderr).toBe('')
    expect(r.status).toBe(1)
    expect(r.stdout).toContain('[privacy-scan] skipped submodule site/vendor\n')
    expect(r.stdout).toContain('[privacy-scan] skipped submodule buffer\n')
    expect(r.stdout).toMatch(/^site\/a\.md:1 {2}personal-term {2}ow\*+e$/m)
    expect(r.stdout).not.toContain(TERM)
    expect(r.stdout).toContain('1 hit(s)')
  })

  it('--tracked passes on a clean tree with a submodule', () => {
    const { root, git } = makeRepo()
    git('rm', '-q', '--cached', 'buffer')
    fs.writeFileSync(path.join(root, 'site', 'a.md'), 'clean now\n', 'utf8')
    git('add', 'site/a.md')
    const r = scan(root, '--tracked')
    expect(r.stderr).toBe('')
    expect(r.stdout).toContain('[privacy-scan] skipped submodule site/vendor\n')
    expect(r.stdout).toContain('5 file(s), 1 personal term(s), 0 hit(s)')
    expect(r.status).toBe(0)
  })

  it('--staged skips a staged submodule and scans the staged files', () => {
    const { root } = makeRepo()
    const rep = JSON.parse(scan(root, '--staged', '--json').stdout) as Report
    expect(rep.skipped).toEqual(['skipped submodule site/vendor'])
    expect(brief(rep)).toEqual(['buffer:0:path-not-allowed', 'site/a.md:1:personal-term'])
  })

  it('a folder named on the command line is skipped, not read', () => {
    const { root } = makeRepo()
    const r = scan(root, path.join(root, 'site'), path.join(root, 'site', 'a.md'), '--json')
    expect(r.stderr).toBe('')
    const rep = JSON.parse(r.stdout) as Report
    expect(rep.skipped).toEqual(['skipped directory site'])
    expect(brief(rep)).toEqual(['site/a.md:1:personal-term'])
  })

  it('reads UTF-16 text with a byte order mark (a PowerShell 5.1 redirect) instead of taking it for binary', () => {
    const line = `made by ${TERM}\r\n`
    const le = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(line, 'utf16le')])
    const be = Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(line, 'utf16le').swap16()])
    expect(decodeText(le)).toBe(line)
    expect(decodeText(be)).toBe(line)
    expect(decodeText(Buffer.from([0x50, 0x00, 0x4b]))).toBeNull()
    const { root, git } = makeRepo()
    fs.writeFileSync(path.join(root, 'site', 'b.md'), le)
    git('add', 'site/b.md')
    const rep = JSON.parse(scan(root, '--tracked', '--json').stdout) as Report
    expect(brief(rep)).toEqual(['buffer:0:path-not-allowed', 'site/a.md:1:personal-term', 'site/b.md:1:personal-term'])
  })
})

import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { validateDoi, validateExternalUrl, validateSafeFigureRelPath } from '../../docs/.vitepress/figures/pathGuard.ts'
import { validateFiguresRegistry } from '../../docs/.vitepress/figures/validate.ts'

const dirs: string[] = []
function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'f8-reg-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  while (dirs.length) fs.rmSync(dirs.pop() as string, { recursive: true, force: true })
})

function validEntry(fileBuf: Buffer, overrides: Record<string, unknown> = {}) {
  const sha = createHash('sha256').update(fileBuf).digest('hex').slice(0, 12)
  return {
    id: 'fig-arch',
    file: 'L01/arch.svg',
    kind: 'figure',
    width: 400,
    height: 300,
    caption: { zh: '系统架构图', en: 'System architecture diagram' },
    source: { paper: 'Author et al. 2026', number: 'Fig. 1', page: 2 },
    doi: '10.1145/1234567.8901234',
    sha256: sha,
    ...overrides,
  }
}

// `python3` is a Microsoft Store stub on Windows
const PYTHON = process.platform === 'win32' ? 'python' : 'python3'

describe('figures/pathGuard', () => {
  it('accepts safe relative paths inside group dir', () => {
    expect(validateSafeFigureRelPath('arch.svg')).toEqual({ ok: true, normalized: 'arch.svg' })
    expect(validateSafeFigureRelPath('L04/pareto-fronts.webp')).toEqual({ ok: true, normalized: 'L04/pareto-fronts.webp' })
    expect(validateSafeFigureRelPath('L01/sub%20fig.png')).toEqual({ ok: true, normalized: 'L01/sub fig.png' })
  })

  it('rejects protocols, double slashes, traversal, backslashes, absolute paths, and repeated percent-encoding', () => {
    const bad = [
      'https://evil.example/x.png',
      'javascript:alert(1).svg',
      '//cdn.example/x.webp',
      'a//b.svg',
      '../secret/x.svg',
      'L01/../../x.svg',
      './x.svg',
      'L01\\x.webp',
      '/etc/passwd.png',
      'C:\\x.svg',
      'C:foo.svg',
      '%252e%252e/x.svg',
      'L01/%2e%2e/x.svg',
      'L01/%zz.svg',
      'L01/x.svg?v=1',
      'L01/x.svg#frag',
      'L01/x.exe',
    ]
    for (const p of bad) {
      expect(validateSafeFigureRelPath(p).ok, `expected rejection for ${p}`).toBe(false)
    }
  })

  it('validates external URLs and DOIs strictly', () => {
    expect(validateExternalUrl('https://doi.org/10.1145/123')).toBe(true)
    expect(validateExternalUrl('http://example.org/paper.pdf')).toBe(true)
    expect(validateExternalUrl('javascript:alert(1)')).toBe(false)
    expect(validateExternalUrl('data:text/html,hi')).toBe(false)
    expect(validateDoi('10.1109/CSCN67557.2025.11230707')).toBe(true)
    expect(validateDoi('https://doi.org/10.1109/123')).toBe(false)
  })
})

describe('figures/validate (Ajv schema + invariants)', () => {
  it('accepts valid registry with file + sha256 verification and no warnings', () => {
    const root = makeTempDir()
    const sub = path.join(root, 'L01')
    fs.mkdirSync(sub, { recursive: true })
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>')
    fs.writeFileSync(path.join(sub, 'arch.svg'), svg)

    const entry = validEntry(svg)
    const res = validateFiguresRegistry(
      { version: 1, group: 'lr', figures: [entry] },
      { expectedGroup: 'lr', groupDir: root, verifyFiles: true },
    )
    expect(res.ok).toBe(true)
    expect(res.errors).toEqual([])
    expect(res.warnings).toEqual([])
  })

  it('rejects licence and third-party fields: the engine keeps no licence bookkeeping (owner decision 2026-11-22)', () => {
    const buf = Buffer.from('abc')
    for (const field of ['licence', 'third-party']) {
      const res = validateFiguresRegistry({ version: 1, group: 'lr', figures: [validEntry(buf, { [field]: 'x' })] })
      expect(res.ok, field).toBe(false)
      expect(res.errors.some((e) => e.includes(field) || e.includes('additional')), field).toBe(true)
    }
  })

  it('rejects unknown fields via Ajv additionalProperties: false', () => {
    const buf = Buffer.from('abc')
    const res = validateFiguresRegistry({
      version: 1,
      group: 'lr',
      extraTop: 1,
      figures: [validEntry(buf, { rogueField: 'nope' })],
    })
    expect(res.ok).toBe(false)
    expect(res.errors.some((e) => e.includes('rogueField') || e.includes('extraTop') || e.includes('additional'))).toBe(true)
  })

  it('rejects duplicate figure ids in the same group, sha256 mismatches, and missing files', () => {
    const root = makeTempDir()
    const buf = Buffer.from('<svg/>')
    fs.mkdirSync(path.join(root, 'L01'), { recursive: true })
    fs.writeFileSync(path.join(root, 'L01/arch.svg'), buf)

    const dup = validateFiguresRegistry({
      version: 1,
      group: 'lr',
      figures: [validEntry(buf), validEntry(buf, { file: 'L01/other.svg' })],
    })
    expect(dup.ok).toBe(false)
    expect(dup.errors.some((e) => e.includes('duplicate id'))).toBe(true)

    const badSha = validateFiguresRegistry(
      { version: 1, group: 'lr', figures: [validEntry(buf, { sha256: '000000000000' })] },
      { expectedGroup: 'lr', groupDir: root, verifyFiles: true },
    )
    expect(badSha.ok).toBe(false)
    expect(badSha.errors.some((e) => e.includes('checksum mismatch'))).toBe(true)

  })

  it('import_figure.py imports vector SVG, records checksum/size, and refuses overwriting a different file with same id', () => {
    const tmp = makeTempDir()
    const figuresDir = path.join(tmp, 'figures')
    const srcSvg = path.join(tmp, 'diagram.svg')
    fs.writeFileSync(srcSvg, '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="160" viewBox="0 0 320 160"><rect width="320" height="160"/></svg>')

    const scriptPath = path.resolve(__dirname, '../../../scripts/figures/import_figure.py')
    execFileSync(
      PYTHON,
      [
        scriptPath,
        '--source',
        srcSvg,
        '--group',
        'demo',
        '--id',
        'circuit-a',
        '--out-rel',
        'L01/circuit-a.svg',
        '--figures-dir',
        figuresDir,
        '--caption-zh',
        '示例电路',
        '--caption-en',
        'Example circuit',
        '--paper',
        'Demo 2026',
      ],
      { encoding: 'utf8' },
    )

    const regPath = path.join(figuresDir, 'demo', 'figures.json')
    const reg = JSON.parse(fs.readFileSync(regPath, 'utf8'))
    const validated = validateFiguresRegistry(reg, {
      expectedGroup: 'demo',
      groupDir: path.join(figuresDir, 'demo'),
      verifyFiles: true,
    })
    expect(validated.ok, JSON.stringify(validated.errors)).toBe(true)

    const clash = spawnSync(
      PYTHON,
      [
        scriptPath,
        '--source',
        srcSvg,
        '--group',
        'demo',
        '--id',
        'circuit-a',
        '--out-rel',
        'L01/different-path.svg',
        '--figures-dir',
        figuresDir,
        '--caption-zh',
        '冲突图',
        '--caption-en',
        'Conflicting diagram',
        '--paper',
        'Demo 2026',
      ],
      { encoding: 'utf8' },
    )
    expect(clash.status).not.toBe(0)
    expect(clash.stderr).toContain('Refusing to overwrite existing figure id')
    expect(fs.existsSync(path.join(figuresDir, 'demo', 'L01/different-path.svg'))).toBe(false)
  })
})

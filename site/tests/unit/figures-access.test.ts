import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { finalizeDist } from '../../docs/.vitepress/access/build.mts'
import { resolveAccess } from '../../docs/.vitepress/access/tiers.ts'
import { buildFigureAuditAndGallery, emitFiguresDistArtifacts } from '../../docs/.vitepress/figures/gallery.ts'
import { checkAccessDist } from '../../scripts/check_access_dist.mjs'

const dirs: string[] = []
function mkTmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'f8-acc-'))
  dirs.push(d)
  return d
}

afterEach(() => {
  while (dirs.length) fs.rmSync(dirs.pop() as string, { recursive: true, force: true })
})

describe('figures/access tiers & gallery isolation', () => {
  it('splits restricted figures into _access/<tier>/figures/ and keeps restricted data out of the public gallery', () => {
    const root = mkTmp()
    const docsRoot = path.join(root, 'docs')
    const figuresDir = path.join(root, 'figures')
    const exampleFiguresDir = path.join(root, 'example-figures')
    const outDir = path.join(root, 'dist')

    const pubSvg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="120" height="80"/>')
    const privSvg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="240" height="160"/>')
    const pubSha = createHash('sha256').update(pubSvg).digest('hex').slice(0, 12)
    const privSha = createHash('sha256').update(privSvg).digest('hex').slice(0, 12)

    fs.mkdirSync(path.join(docsRoot, 'g06'), { recursive: true })
    fs.mkdirSync(path.join(docsRoot, 'g09'), { recursive: true })
    fs.mkdirSync(path.join(docsRoot, 'examples/g01'), { recursive: true })
    fs.writeFileSync(path.join(docsRoot, 'g06/L01.md'), '# G06\nSee [](fig:pub-fig).\n<LectureFigure id="pub-fig" />\n')
    fs.writeFileSync(path.join(docsRoot, 'g09/L01.md'), '# G09\nSee [](fig:priv-fig).\n<LectureFigure id="priv-fig" />\n')

    fs.mkdirSync(path.join(figuresDir, 'g06'), { recursive: true })
    fs.mkdirSync(path.join(figuresDir, 'g09'), { recursive: true })
    fs.mkdirSync(path.join(exampleFiguresDir, 'examples/g01'), { recursive: true })
    fs.writeFileSync(path.join(figuresDir, 'g06/pub.svg'), pubSvg)
    fs.writeFileSync(path.join(figuresDir, 'g09/secret-chip.svg'), privSvg)
    fs.writeFileSync(
      path.join(figuresDir, 'g06/figures.json'),
      JSON.stringify({
        version: 1,
        group: 'g06',
        figures: [
          {
            id: 'pub-fig',
            file: 'pub.svg',
            kind: 'figure',
            width: 120,
            height: 80,
            caption: { zh: '公开图示', en: 'Public circuit diagram' },
            source: { paper: 'Public Source 2026', number: 'Fig. 1', page: 1 },
            sha256: pubSha,
          },
        ],
      }),
    )
    fs.writeFileSync(
      path.join(figuresDir, 'g09/figures.json'),
      JSON.stringify({
        version: 1,
        group: 'g09',
        figures: [
          {
            id: 'priv-fig',
            file: 'secret-chip.svg',
            kind: 'figure',
            width: 240,
            height: 160,
            caption: { zh: '受限密钥控制芯片框图', en: 'Restricted key control chip layout diagram' },
            source: { paper: 'Restricted Hardware Monograph', number: 'Fig. 2', page: 4 },
            sha256: privSha,
          },
        ],
      }),
    )

    const GROUPS = [
      { id: 'G06', dir: 'g06', title: 'Public Group', summary: '' },
      { id: 'G09', dir: 'g09', title: 'Restricted Group', summary: '' },
    ]
    const plan = resolveAccess(
      {
        access: { default: 'public', enforcement: 'gateway', groups: { G09: { read: 'authenticated' } } },
        groupIds: ['G06', 'G09'],
      },
    )

    // Minimal dist skeleton mimicking VitePress build output before finalizeDist
    fs.mkdirSync(path.join(outDir, 'g06'), { recursive: true })
    fs.mkdirSync(path.join(outDir, 'g09'), { recursive: true })
    fs.mkdirSync(path.join(outDir, 'assets'), { recursive: true })
    fs.mkdirSync(path.join(outDir, 'search/root/shards'), { recursive: true })
    fs.mkdirSync(path.join(outDir, '_access/authenticated/search/root/shards'), { recursive: true })
    fs.mkdirSync(path.join(outDir, 'figures/g06'), { recursive: true })
    fs.mkdirSync(path.join(outDir, 'figures/g09'), { recursive: true })
    fs.copyFileSync(path.join(figuresDir, 'g06/pub.svg'), path.join(outDir, 'figures/g06/pub.svg'))
    fs.copyFileSync(path.join(figuresDir, 'g06/figures.json'), path.join(outDir, 'figures/g06/figures.json'))
    fs.copyFileSync(path.join(figuresDir, 'g09/secret-chip.svg'), path.join(outDir, 'figures/g09/secret-chip.svg'))
    fs.copyFileSync(path.join(figuresDir, 'g09/figures.json'), path.join(outDir, 'figures/g09/figures.json'))

    fs.writeFileSync(path.join(outDir, 'index.html'), '<html>home</html>')
    fs.writeFileSync(path.join(outDir, 'g06/L01.html'), '<html>public lecture</html>')
    fs.writeFileSync(path.join(outDir, 'g09/L01.html'), '<html>Restricted Secret Title</html>')
    fs.writeFileSync(path.join(outDir, 'assets/g09_L01.md.ABC12345.js'), 'export default "ok"')
    fs.writeFileSync(path.join(outDir, 'search/root/titles.json'), '{"v":1,"locale":"root","groups":[],"pages":[]}')
    fs.writeFileSync(path.join(outDir, 'search/root/manifest.json'), '{"v":1,"locale":"root","titleFile":"titles.json","titleBytes":44,"totalShardBytes":0,"totalRawShardBytes":0,"shards":[]}')
    fs.writeFileSync(path.join(outDir, '_access/authenticated/search/root/titles.json'), '{"v":1,"locale":"root","groups":[],"pages":[]}')
    fs.writeFileSync(path.join(outDir, '_access/authenticated/search/root/manifest.json'), '{"v":1,"locale":"root","titleFile":"titles.json","titleBytes":44,"totalShardBytes":0,"totalRawShardBytes":0,"shards":[]}')
    fs.writeFileSync(path.join(outDir, '_access/authenticated/graph.json'), '{"nodes":[],"edges":[]}')
    // tool data of the two tiers (concepts/toolFiles.mts); the gate reads every tier's files
    fs.mkdirSync(path.join(outDir, 'tools'), { recursive: true })
    fs.mkdirSync(path.join(outDir, '_access/authenticated/tools'), { recursive: true })
    fs.writeFileSync(path.join(outDir, 'tools/tiers.json'), '{"version":1,"tiers":[]}')
    for (const [dir, tier] of [['tools', 'public'], ['_access/authenticated/tools', 'authenticated']] as const) {
      fs.writeFileSync(path.join(outDir, dir, 'concepts.json'), JSON.stringify({ version: 1, tier, generatedAt: '', concepts: [] }))
      fs.writeFileSync(path.join(outDir, dir, 'lectures.json'), JSON.stringify({ version: 1, tier, lectures: [] }))
    }

    emitFiguresDistArtifacts(outDir, {
      paths: { figuresDir, exampleFiguresDir, lecturesDir: docsRoot, docsRoot },
      groups: GROUPS,
      localeKeys: [],
      accessPlan: plan,
    })

    const fakeSiteConfig = {
      outDir,
      pages: ['g06/L01.md', 'g09/L01.md'],
      site: { base: '/', themeConfig: { groups: GROUPS.map((g) => ({ ...g, lectures: [{ n: 1, text: g.id === 'G09' ? 'Restricted Secret Title' : 'Public', link: `/${g.dir}/L01` }] })), totals: { lectures: 2, charts: 0 } } },
    }
    const runtime = { plan, tiers: [{ info: plan.tiers[0]!, dirs: ['g09'], slice: { version: 1, tier: 'authenticated', groups: [], totals: { lectures: 1, charts: 0 }, locales: { root: { nav: [], sidebar: {}, i18nPages: {} } } }, names: ['Restricted Secret Title'], ambiguousNames: [] }] }
    finalizeDist(fakeSiteConfig as never, runtime as never, {
      plan,
      allGroups: GROUPS,
      groups: GROUPS as never,
      localeKeys: [],
      docsRoot,
      figuresDir,
    })

    // Public dir retains ONLY public figures; restricted folder moved to _access/authenticated/figures/g09
    expect(fs.existsSync(path.join(outDir, 'figures/g06/pub.svg'))).toBe(true)
    expect(fs.existsSync(path.join(outDir, 'figures/g09'))).toBe(false)
    expect(fs.existsSync(path.join(outDir, '_access/authenticated/figures/g09/secret-chip.svg'))).toBe(true)

    const pubGallery = fs.readFileSync(path.join(outDir, 'figures-gallery.json'), 'utf8')
    expect(pubGallery).toContain('pub-fig')
    expect(pubGallery).not.toContain('priv-fig')
    expect(pubGallery).not.toContain('secret-chip.svg')
    expect(pubGallery).not.toContain('Restricted key control chip layout diagram')

    const privGallery = fs.readFileSync(path.join(outDir, '_access/authenticated/figures-gallery.json'), 'utf8')
    expect(privGallery).toContain('priv-fig')
    expect(privGallery).toContain('/_access/authenticated/figures/g09/secret-chip.svg')

    const manifestPath = path.join(docsRoot, '..', '.lecture-build', 'access-manifest.json')
    const check = checkAccessDist({ dist: outDir, manifest: manifestPath })
    expect(check.ok, JSON.stringify(check.failures)).toBe(true)

    // Injecting restricted caption into public gallery must fail checkAccessDist
    fs.writeFileSync(path.join(outDir, 'figures-gallery.json'), JSON.stringify({ leak: 'Restricted key control chip layout diagram' }))
    const leaked = checkAccessDist({ dist: outDir, manifest: manifestPath })
    expect(leaked.ok).toBe(false)
    expect(leaked.failures.some((f) => f.includes('leaks restricted figure data'))).toBe(true)

    // Public page citing restricted figure must fail buildFigureAuditAndGallery
    fs.writeFileSync(path.join(docsRoot, 'g06/L01.md'), '# G06\nLeak [](fig:g09/priv-fig).\n')
    const crossTier = buildFigureAuditAndGallery({
      paths: { figuresDir, exampleFiguresDir, lecturesDir: docsRoot, docsRoot },
      groups: GROUPS,
      localeKeys: [],
      accessPlan: plan,
    })
    expect(crossTier.ok).toBe(false)
    expect(crossTier.errors.some((e) => e.includes('restricted figure'))).toBe(true)
  })
})

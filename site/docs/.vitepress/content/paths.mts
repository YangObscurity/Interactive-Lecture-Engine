/**
 * content/paths.mts — single source of truth for resolving content vs in-place paths.
 * Node only; never imported by client/browser code.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const DEFAULT_REPO_ROOT = path.resolve(here, '..', '..', '..', '..')

/**
 * A directory counts as a content root only if it holds `site.config.ts` or `groups.ts`.
 * Anything else named `content/` (notes, an empty folder) is ignored: in-place mode stays active.
 */
const CONTENT_ROOT_MARKERS = ['site.config.ts', 'groups.ts'] as const

export type ContentMode = 'content' | 'in-place'

export interface GraphPaths {
  dir: string
  graph: string
  graphNotion: string
  graphBindings: string
  notionKnowledgeGraph: string
}

export interface ContentPaths {
  mode: ContentMode
  /** S6: true when nothing else is configured and the engine's demo content (templates/demo-content) is the root. */
  demo?: boolean
  root: string
  repoRoot: string
  siteRoot: string
  docsRoot: string
  vpRoot: string
  siteConfig: string
  defaultSiteConfig: string
  /** Site texts file (F10): `<root>/site-texts.json` in content mode, `site/site-texts.json` in-place. */
  siteTexts: string
  /** Engine template read when `siteTexts` does not exist. */
  siteTextsExample: string
  groups: string
  lecturesDir: string
  chartsDir: string
  figuresDir: string
  conceptsDir: string
  graphDir: GraphPaths
  /** AI companion prompts file (F7): `<root>/prompts/companion.json` in content mode, `site/prompts/companion.json` in-place. */
  promptsFile: string
  /** Engine template read when `promptsFile` does not exist. */
  promptsExample: string
  /** AI tools & external MCP config (K2 §8.4): `<root>/ai-tools.json` in content mode, `site/ai-tools.json` in-place. */
  aiToolsFile: string
  /** Engine template for AI tools config (`site/ai-tools.example.json`). */
  aiToolsExample: string
  /** `<repo>/content` when it exists but is not a content root (no `site.config.ts`, no `groups.ts`); else null. */
  ignoredContentDir: string | null
  themeDir: string
  publicDir: string
  /** Where `npm run init` creates a content root: `LECTURE_CONTENT_DIR` when set, else `<repo>/content`. */
  initTarget: string
  /** The engine's template for a new content repository (`<repo>/templates/content`). */
  templateDir: string
  /** Optional per-site rules of `npm run check:content` (`<root>/check.config.json`; in-place `site/check.config.json`). */
  checkConfig: string
  /** The owner's own authoring rules read by coding agents (`<root>/AUTHORING.local.md`). */
  authoringLocal: string
}

export interface ResolveContentOptions {
  repoRoot?: string
  env?: Readonly<Record<string, string | undefined>>
}

function isContentRoot(dir: string): boolean {
  return CONTENT_ROOT_MARKERS.some((marker) => fs.existsSync(path.join(dir, marker)))
}

/** The site-level files that stay in `site/` in-place mode (and the engine templates in every mode). */
export function siteFilesIn(siteRoot: string): {
  siteTexts: string
  siteTextsExample: string
  promptsFile: string
  promptsExample: string
  aiToolsFile: string
  aiToolsExample: string
} {
  return {
    siteTexts: path.join(siteRoot, 'site-texts.json'),
    siteTextsExample: path.join(siteRoot, 'site-texts.example.json'),
    promptsFile: path.join(siteRoot, 'prompts', 'companion.json'),
    promptsExample: path.join(siteRoot, 'prompts', 'companion.example.json'),
    aiToolsFile: path.join(siteRoot, 'ai-tools.json'),
    aiToolsExample: path.join(siteRoot, 'ai-tools.example.json'),
  }
}

function isDirectory(dir: string): boolean {
  try {
    return fs.existsSync(dir) && fs.statSync(dir).isDirectory()
  } catch {
    return false
  }
}

function buildContentModePaths(
  root: string,
  repoRoot: string,
  siteRoot: string,
  docsRoot: string,
  vpRoot: string,
  defaultSiteConfig: string,
): ContentPaths {
  const engineFiles = siteFilesIn(siteRoot)
  const graphBase = path.join(root, 'graph')
  return {
    mode: 'content',
    root,
    repoRoot,
    siteRoot,
    docsRoot,
    vpRoot,
    siteConfig: path.join(root, 'site.config.ts'),
    defaultSiteConfig,
    siteTexts: path.join(root, 'site-texts.json'),
    siteTextsExample: engineFiles.siteTextsExample,
    groups: path.join(root, 'groups.ts'),
    lecturesDir: path.join(root, 'lectures'),
    chartsDir: path.join(root, 'charts'),
    figuresDir: path.join(root, 'figures'),
    conceptsDir: path.join(root, 'concepts'),
    graphDir: {
      dir: graphBase,
      graph: path.join(graphBase, 'graph.json'),
      graphNotion: path.join(graphBase, 'graph-notion.json'),
      graphBindings: path.join(graphBase, 'graph-bindings.json'),
      notionKnowledgeGraph: path.join(graphBase, 'notion_knowledge_graph.json'),
    },
    promptsFile: path.join(root, 'prompts', 'companion.json'),
    promptsExample: engineFiles.promptsExample,
    aiToolsFile: path.join(root, 'ai-tools.json'),
    aiToolsExample: engineFiles.aiToolsExample,
    ignoredContentDir: null,
    themeDir: path.join(root, 'theme'),
    publicDir: path.join(root, 'public'),
    initTarget: root,
    templateDir: templateDirOf(repoRoot),
    checkConfig: path.join(root, 'check.config.json'),
    authoringLocal: path.join(root, 'AUTHORING.local.md'),
  }
}

function templateDirOf(repoRoot: string): string {
  return path.join(repoRoot, 'templates', 'content')
}

/** The engine's demo content (S6): the fallback content root and the content of the e2e suites. */
export function demoContentDirOf(repoRoot: string = DEFAULT_REPO_ROOT): string {
  return path.join(repoRoot, 'templates', 'demo-content')
}

/** A translation tree of the lectures: `<lecturesDir>/<locale key>/<group dir>/` (`en/g01/L03.md`). */
export function translationDirOf(paths: Pick<ContentPaths, 'lecturesDir'>, localeKey: string, groupDir = ''): string {
  return groupDir ? path.join(paths.lecturesDir, localeKey, groupDir) : path.join(paths.lecturesDir, localeKey)
}

/**
 * Resolve content root and all engine/content paths.
 * Priority: env `LECTURE_CONTENT_DIR` (always content mode) > `<repo>/content` when it is a content root
 * (holds `site.config.ts` or `groups.ts`) > the engine's demo content `<repo>/templates/demo-content` (content mode,
 * `demo: true`, `initTarget` still `<repo>/content`; off with `LECTURE_DEMO=0`) > in-place mode.
 */
export function resolveContent(options: ResolveContentOptions = {}): ContentPaths {
  const repoRoot = options.repoRoot ? path.resolve(options.repoRoot) : DEFAULT_REPO_ROOT
  const env = options.env ?? process.env
  const siteRoot = path.join(repoRoot, 'site')
  const docsRoot = path.join(siteRoot, 'docs')
  const vpRoot = path.join(docsRoot, '.vitepress')
  const defaultSiteConfig = path.join(siteRoot, 'lecture.config.ts')

  const envRaw = (env.LECTURE_CONTENT_DIR ?? '').trim()
  if (envRaw !== '') {
    const root = path.isAbsolute(envRaw) ? path.resolve(envRaw) : path.resolve(repoRoot, envRaw)
    return buildContentModePaths(root, repoRoot, siteRoot, docsRoot, vpRoot, defaultSiteConfig)
  }

  const repoContentDir = path.join(repoRoot, 'content')
  const repoContentExists = isDirectory(repoContentDir)
  if (repoContentExists && isContentRoot(repoContentDir)) {
    return buildContentModePaths(repoContentDir, repoRoot, siteRoot, docsRoot, vpRoot, defaultSiteConfig)
  }

  // S6: no content of its own -> the engine's demo content (templates/demo-content), read like a content root.
  // `npm run init` still targets <repo>/content, which takes over once it exists. LECTURE_DEMO=0 keeps in-place mode.
  const demoDir = demoContentDirOf(repoRoot)
  if ((env.LECTURE_DEMO ?? '').trim() !== '0' && isDirectory(demoDir) && isContentRoot(demoDir)) {
    return {
      ...buildContentModePaths(demoDir, repoRoot, siteRoot, docsRoot, vpRoot, defaultSiteConfig),
      demo: true,
      ignoredContentDir: repoContentExists ? repoContentDir : null,
      initTarget: repoContentDir,
    }
  }

  const dataDir = path.join(siteRoot, 'data')
  const publicDir = path.join(docsRoot, 'public')
  return {
    mode: 'in-place',
    root: repoRoot,
    repoRoot,
    siteRoot,
    docsRoot,
    vpRoot,
    siteConfig: defaultSiteConfig,
    defaultSiteConfig,
    ...siteFilesIn(siteRoot),
    groups: path.join(vpRoot, 'groups.mts'),
    lecturesDir: docsRoot,
    chartsDir: path.join(publicDir, 'charts'),
    figuresDir: path.join(publicDir, 'figures'),
    conceptsDir: path.join(docsRoot, 'concepts'),
    graphDir: {
      dir: dataDir,
      graph: path.join(dataDir, 'graph.json'),
      graphNotion: path.join(dataDir, 'graph-notion.json'),
      graphBindings: path.join(dataDir, 'graph-bindings.json'),
      notionKnowledgeGraph: path.join(publicDir, 'notion_knowledge_graph.json'),
    },
    ignoredContentDir: repoContentExists ? repoContentDir : null,
    themeDir: path.join(vpRoot, 'themes'),
    publicDir,
    initTarget: repoContentDir,
    templateDir: templateDirOf(repoRoot),
    checkConfig: path.join(siteRoot, 'check.config.json'),
    authoringLocal: path.join(repoRoot, 'AUTHORING.local.md'),
  }
}

/**
 * Format a file path for VitePress data loader `watch` entries:
 * relative (forward-slash) in in-place mode, normalized absolute path in content mode.
 */
export function watchGlobFrom(fromDir: string, targetFile: string, mode: ContentMode): string {
  if (mode === 'in-place') {
    const rel = path.relative(fromDir, targetFile).replace(/\\/g, '/')
    return rel.startsWith('.') ? rel : `./${rel}`
  }
  return path.resolve(targetFile).replace(/\\/g, '/')
}

/**
 * Filter `targets` to existing files when in `content` mode before formatting via `watchGlobFrom`,
 * avoiding VitePress 1.6.4's bundled glob crawling `/` on missing absolute paths.
 */
export function watchExistingFrom(fromDir: string, targets: readonly string[], mode: ContentMode): string[] {
  return targets
    .filter((target) => mode === 'in-place' || fs.existsSync(target))
    .map((target) => watchGlobFrom(fromDir, target, mode))
}

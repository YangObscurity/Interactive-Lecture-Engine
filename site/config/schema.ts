/**
 * config/schema.ts — the single source of truth for this engine's configuration
 * (docs-dev/CONFIG.md).
 *
 * Every setting is declared once here. Everything else is derived from it and must not be edited by hand:
 *   config/schema.json      generated, read by scripts/config.py
 *   ../.env.example         generated, grouped by module, Chinese comments
 *   npm run setup / doctor  read the same table
 *
 * Kinds
 *   site    non-secret, part of the built site; set in site/lecture.config.ts (`modules` block)
 *   env     deployment / tooling setting; read from the real environment or the repo-root .env, never bundled
 *   secret  like env, but its value is never printed, logged, or written anywhere except .env
 *
 * Values that identify real infrastructure or private data (hosts, domains, Notion ids, key paths) have no
 * real default here: only neutral placeholders, or nothing.
 */

export interface Text {
  zh: string
  en: string
}

/** Site modules: an adapter chosen in lecture.config.ts. */
export type SiteModuleId = 'progress' | 'companion' | 'graph' | 'contentSync' | 'auth'
/** Tooling modules: groups of env settings used by scripts in this repo. */
export type ToolModuleId = 'notion' | 'deploy' | 'toolsService' | 'mirror' | 'tests' | 'paths' | 'meta'
export type ModuleId = SiteModuleId | ToolModuleId

export type SettingKind = 'site' | 'env' | 'secret'
export type SettingType = 'enum' | 'string' | 'int' | 'bool' | 'path' | 'url' | 'host' | 'domain' | 'id' | 'list' | 'pem'

/** Connectivity tests `setup` / `doctor --probe` may run (read-only, with a timeout). */
export type ProbeId = 'notion-users-me' | 'tcp' | 'https-head' | 'http-get'

export interface ModuleSpec {
  id: ModuleId
  site: boolean
  title: Text
  summary: Text
}

export interface Setting {
  /** Site settings: `<module>.<field>`; env / secret settings: UPPER_SNAKE environment variable name. */
  key: string
  module: ModuleId
  kind: SettingKind
  type: SettingType
  /** Allowed values of an enum. */
  values?: readonly string[]
  /** Neutral default; absent means "no default" (must be provided when required). */
  default?: string | number | boolean
  /** Placeholder written into .env.example when there is no default. */
  example?: string
  /** Required whenever its module is in use. */
  required?: boolean
  /** A site-module adapter that puts this tool module in use, e.g. contentSync = notion needs NOTION_TOKEN. */
  neededBy?: { module: SiteModuleId; adapters: readonly string[] }
  /** Older names still read; the canonical key wins when both are set. */
  aliases?: readonly string[]
  /** Show only a masked form in doctor / describe (infrastructure identifiers that are not secrets). */
  masked?: boolean
  probe?: ProbeId
  description: Text
}

export const MODULES: readonly ModuleSpec[] = [
  { id: 'progress', site: true, title: { zh: '学习进度', en: 'Reading progress' }, summary: { zh: 'local 只存浏览器；rest 按 backend-handoff 契约同步到服务端', en: 'local keeps it in the browser; rest syncs with the server per the backend-handoff contract' } },
  { id: 'companion', site: true, title: { zh: '伴读', en: 'Reading companion' }, summary: { zh: 'off 关闭；openai-compatible 读者自带密钥，浏览器直连；proxy 经服务端代理', en: 'off; openai-compatible with the reader\'s own key from the browser; proxy through the server' } },
  { id: 'graph', site: true, title: { zh: '先修图', en: 'Prerequisite graph' }, summary: { zh: '来源：讲义 frontmatter、graph.json，或两者合并', en: 'Source: lecture frontmatter, graph.json, or both merged' } },
  { id: 'contentSync', site: true, title: { zh: '内容同步', en: 'Content sync' }, summary: { zh: 'none 不同步；notion 由服务端或本机脚本只读拉取', en: 'none; notion pulled read-only by the server or local scripts' } },
  { id: 'auth', site: true, title: { zh: '认证', en: 'Authentication' }, summary: { zh: 'none；trusted-header 信任网关注入的身份头；oidc 仅预留', en: 'none; trusted-header trusts the identity header set by the gateway; oidc reserved' } },
  { id: 'notion', site: false, title: { zh: 'Notion 只读接口', en: 'Notion (read-only)' }, summary: { zh: '本仓库对 Notion 全程只读', en: 'This repository only ever reads from Notion' } },
  { id: 'deploy', site: false, title: { zh: '部署目标', en: 'Deployment target' }, summary: { zh: '远程前端机的 SSH 与站点目录', en: 'SSH access and site directories of the web host' } },
  { id: 'toolsService', site: false, title: { zh: '远端微服务', en: 'Remote tools service' }, summary: { zh: '讲义检索与 Notion 进度同步 API', en: 'Lecture search and Notion progress sync API' } },
  { id: 'mirror', site: false, title: { zh: '源码镜像同步', en: 'Source mirror' }, summary: { zh: '仓库根 sync.py 使用的工作副本位置', en: 'Working copies used by sync.py at the repository root' } },
  { id: 'tests', site: false, title: { zh: '测试', en: 'Tests' }, summary: { zh: '端到端测试的目标地址与数据', en: 'Targets and data for end-to-end tests' } },
  { id: 'paths', site: false, title: { zh: '其它路径', en: 'Other paths' }, summary: { zh: '原先硬编码绝对路径的替代', en: 'Replacements for formerly hard-coded absolute paths' } },
  { id: 'meta', site: false, title: { zh: '配置本身', en: 'Configuration itself' }, summary: { zh: '本机启用了哪些工具模块', en: 'Which tool modules this checkout uses' } },
]

/** An extra option of a site module (besides its adapter choice): a typed value with a neutral default. */
export interface SiteOptionSpec {
  /** `path` is a site-absolute URL path such as `/api/db`; `bool` is a true / false switch. */
  type: 'path' | 'bool'
  default: string | boolean
  description: Text
}

/**
 * Site modules and their choices, declared once. `lecture-config.mts` derives the types of the `modules` block
 * from this object, and SETTINGS below derives the site rows from it, so the two cannot drift apart.
 * `options` are the detailed fields of an adapter (endpoints, switches); they arrive with the phase that
 * implements it (progress and auth in P3, the rest in P6).
 */
export const SITE_MODULES = {
  progress: {
    field: 'adapter', values: ['local', 'rest'], default: 'local',
    description: { zh: '进度存在哪里：local 只在本机浏览器，rest 按 docs/backend-handoff 契约同步到服务端', en: 'Where progress lives: local in the browser only, rest synced per the docs/backend-handoff contract' },
    options: {
      endpoint: {
        type: 'path', default: '/api/db',
        description: { zh: 'rest 适配器的基础路径（同源，不带结尾斜杠），其下是 /progress 与 /progress/batch', en: 'Base path of the rest adapter (same origin, no trailing slash); /progress and /progress/batch live below it' },
      },
      notionSync: {
        type: 'bool', default: false,
        description: { zh: '进度写入后经现有 Notion 同步代理回写 Notion（令牌只在服务端）', en: 'After a progress write, also update Notion through the existing sync proxy (the token stays server-side)' },
      },
    },
  },
  companion: {
    field: 'adapter', values: ['off', 'openai-compatible', 'proxy'], default: 'off',
    description: { zh: '伴读后端：off 关闭；openai-compatible 读者自带密钥、浏览器直连；proxy 走服务端代理（本站 Dify）', en: 'Companion backend: off; openai-compatible with the reader\'s own key; proxy through the server' },
  },
  graph: {
    field: 'source', values: ['frontmatter', 'graph-json', 'merge'], default: 'merge',
    description: { zh: '先修关系来源：讲义 frontmatter 的 requires、site/data/graph.json，或两者合并', en: 'Prerequisites from lecture frontmatter `requires`, site/data/graph.json, or both merged' },
  },
  contentSync: {
    field: 'adapter', values: ['none', 'notion'], default: 'none',
    description: { zh: '内容同步：none 不同步；notion 只读拉取（需要 notion 模块的令牌与数据库 ID）', en: 'Content sync: none, or notion pulled read-only (needs the notion module token and database id)' },
  },
  auth: {
    field: 'adapter', values: ['none', 'trusted-header', 'oidc'], default: 'none',
    description: { zh: '认证：none；trusted-header 信任网关注入的身份头；oidc 仅预留', en: 'Authentication: none; trusted-header from the gateway; oidc reserved' },
    options: {
      sessionEndpoint: {
        type: 'path', default: '/api/auth/session',
        description: { zh: '身份接口路径：返回当前请求者是谁（adapter 为 none 时前端不请求）', en: 'Path of the identity endpoint that says who the requester is (not requested when adapter is none)' },
      },
    },
  },
} as const satisfies Record<SiteModuleId, { field: string; values: readonly string[]; default: string; description: Text; options?: Readonly<Record<string, SiteOptionSpec>> }>

/**
 * Top-level blocks of lecture.config.ts that are not site modules (no adapter choice): the `access` block of P3b
 * (docs-dev/ACCESS.md). Declared once here; docs/.vitepress/access/tiers.ts validates against
 * these values and lecture-config.mts types the block from them. Not part of `SETTINGS`: nothing here is an env
 * variable or a module setting, so `setup` / `doctor` do not list it.
 */
export const SITE_BLOCKS = {
  access: {
    description: {
      zh: '访问分档：声明谁能读哪个课程组。构建产物保证受限组的讲名、正文、图表数据、知识图谱节点与搜索内容只出现在该档受保护的路径下（网关按路径前缀拦截）',
      en: 'Access tiers: declares who may read which course group. The build guarantees that titles, text, chart data, graph nodes and search content of a restricted group appear only under the protected paths of its tier (a gateway blocks by path prefix)',
    },
    fields: {
      default: {
        type: 'enum', values: ['public', 'authenticated'], default: 'public',
        description: { zh: '未单独声明的课程组所属的档，也是首页与非组页面的档', en: 'Tier of every course group that is not listed under `groups`, and of the home page and other non-group pages' },
      },
      enforcement: {
        type: 'enum', values: ['none', 'gateway'], default: 'none',
        description: { zh: 'gateway：部署在认证网关之后，允许存在受限内容；none：没有网关，构建遇到受限内容就失败', en: 'gateway: deployed behind an authenticating gateway, restricted content is allowed; none: no gateway, the build fails on restricted content' },
      },
      groups: {
        type: 'map', default: {},
        description: { zh: '课程组 id -> { read }，read 为 public、authenticated 或网关用户组名数组（不能为空）', en: 'Course group id -> { read }; read is public, authenticated, or a non-empty array of gateway user-group names' },
      },
    },
  },
  home: {
    description: {
      zh: '首页：地图默认显示模式（速览 / 依赖画布）以及速览地图默认展开到哪一档。读者自己的选择优先于这里的默认值',
      en: 'Home page: default home map mode (atlas / graph) and how far the overview map is expanded by default. A reader\'s own choice wins over this default',
    },
    fields: {
      map: {
        type: 'enum', values: ['atlas', 'graph'], default: 'atlas',
        description: { zh: 'atlas：课程速览横向思维导图；graph：课程依赖画布（显示先修连线与追踪）', en: 'atlas: horizontal overview mind map; graph: prerequisite dependency canvas' },
      },
      atlasExpand: {
        type: 'enum', values: ['reading', 'progress', 'all', 'none'], default: 'reading',
        description: { zh: 'reading：在读的组展开到读到的阶段；progress：有已读或在读讲次的组和阶段都展开；all：全部展开；none：全部收起', en: 'reading: groups being read open down to the phase being read; progress: every group and phase with a read or reading lecture; all: everything; none: everything collapsed' },
      },
    },
  },
} as const

type SiteModulesTable = typeof SITE_MODULES
type OptionValueOf<O> = O extends { type: 'bool' } ? boolean : string
/** The option values of one site module (empty object type when it has none): `{ endpoint: string; notionSync: boolean }`. */
export type SiteModuleOptions<M extends SiteModuleId> = SiteModulesTable[M] extends { options: infer O }
  ? { [K in keyof O]: OptionValueOf<O[K]> }
  : Record<never, never>

/** The options of a module as `[name, spec]` pairs, in declaration order (empty when it has none). */
export function optionsOf(module: SiteModuleId): Array<[string, SiteOptionSpec]> {
  const spec = SITE_MODULES[module] as { options?: Readonly<Record<string, SiteOptionSpec>> }
  return Object.entries(spec.options ?? {})
}

const SITE_SETTINGS: Setting[] = (Object.keys(SITE_MODULES) as SiteModuleId[]).flatMap((m) => {
  const spec = SITE_MODULES[m]
  const adapter: Setting = { key: `${m}.${spec.field}`, module: m, kind: 'site', type: 'enum', values: spec.values, default: spec.default, description: spec.description }
  const options: Setting[] = optionsOf(m).map(([name, o]) => ({ key: `${m}.${name}`, module: m, kind: 'site', type: o.type, default: o.default, description: o.description }))
  return [adapter, ...options]
})

export const SETTINGS: readonly Setting[] = [
  // ---------------------------------------------------------------- site modules (lecture.config.ts → modules)
  ...SITE_SETTINGS,

  // ---------------------------------------------------------------- notion
  { key: 'NOTION_TOKEN', module: 'notion', kind: 'secret', type: 'string', required: true, neededBy: { module: 'contentSync', adapters: ['notion'] }, example: '<ntn_ 开头的内部集成令牌>', probe: 'notion-users-me', description: { zh: 'Notion 内部集成令牌（ntn_ 开头）。在 notion.so/my-integrations 创建，并在目标数据库「连接」里添加该集成，否则接口返回 404。本仓库对 Notion 只读；令牌泄露过就立刻吊销重建', en: 'Notion internal integration token (starts with ntn_). Add the integration to the database\'s connections or the API returns 404. Read-only use; revoke it if it ever leaks' } },
  { key: 'NOTION_API_VERSION', module: 'notion', kind: 'env', type: 'string', default: '2022-06-28', description: { zh: 'Notion REST API 版本号，协议约定值，一般不用改', en: 'Notion REST API version; a protocol constant, rarely changed' } },
  { key: 'NOTION_DB_ID', module: 'notion', kind: 'secret', type: 'id', required: true, neededBy: { module: 'contentSync', adapters: ['notion'] }, example: '<32 位十六进制数据库 ID>', description: { zh: '知识节点数据库 ID（32 位十六进制，带不带连字符均可），私有工作区标识', en: 'Knowledge-node database id (32 hex digits, dashes optional); a private workspace identifier' } },
  { key: 'NOTION_ARCHIVE_PAGE_ID', module: 'notion', kind: 'secret', type: 'id', example: '<页面 ID，可留空>', description: { zh: '教学法归档目标页面 ID，只有归档脚本使用', en: 'Archive target page id, used only by the archiving script' } },

  // ---------------------------------------------------------------- deploy
  { key: 'DEPLOY_HOST', module: 'deploy', kind: 'env', type: 'host', required: true, default: 'localhost', masked: true, probe: 'tcp', description: { zh: '目标主机地址。真实地址只写在 .env 或环境变量里，不要写回代码', en: 'Target host. Keep the real address in .env or the environment, never in code' } },
  { key: 'DEPLOY_PORT', module: 'deploy', kind: 'env', type: 'int', default: 22, description: { zh: 'SSH 端口', en: 'SSH port' } },
  { key: 'DEPLOY_USER', module: 'deploy', kind: 'env', type: 'string', default: 'root', description: { zh: 'SSH 登录用户', en: 'SSH user' } },
  { key: 'DEPLOY_SSH_KEY', module: 'deploy', kind: 'env', type: 'path', default: '~/.ssh/id_ed25519', aliases: ['DEPLOY_KEY'], masked: true, description: { zh: 'SSH 私钥路径。留空用跨平台默认 ~/.ssh/id_ed25519；不要写死某个用户名', en: 'SSH private key path; defaults to ~/.ssh/id_ed25519 on every platform' } },
  { key: 'DEPLOY_SSH_KEY_PEM', module: 'deploy', kind: 'secret', type: 'pem', example: '', description: { zh: 'SSH 私钥内容（PEM 全文）。CI 或沙箱挂不了文件时整段注入，与 DEPLOY_SSH_KEY 同时存在时优先；多行值用双引号包裹', en: 'SSH private key content (full PEM) for CI; wins over DEPLOY_SSH_KEY; wrap multi-line values in double quotes' } },
  { key: 'DEPLOY_WEBROOT', module: 'deploy', kind: 'env', type: 'path', required: true, example: '/var/www/example.com', description: { zh: '远端站点根目录（部署产物落地处，通常是 nginx 的 root）', en: 'Remote site root (where the build lands; usually the nginx root)' } },
  { key: 'DEPLOY_LOCAL_DIST', module: 'deploy', kind: 'env', type: 'path', example: 'site/docs/.vitepress/dist', description: { zh: '本地待部署的 dist 目录（相对仓库根或绝对路径）', en: 'Local dist directory to deploy (relative to the repo root, or absolute)' } },
  { key: 'DEPLOY_SOURCE_DIST', module: 'deploy', kind: 'env', type: 'path', example: '', description: { zh: '本地↔线上逐文件比对用的基线 dist 目录；留空回退到 DEPLOY_LOCAL_DIST', en: 'Baseline dist for local-vs-remote comparison; falls back to DEPLOY_LOCAL_DIST' } },
  { key: 'DEPLOY_SITE_DOMAIN', module: 'deploy', kind: 'env', type: 'domain', aliases: ['DEPLOY_DOMAIN'], masked: true, example: 'example.com', probe: 'https-head', description: { zh: '生产站点域名（只写主机名，不带 https:// 与结尾斜杠）。留空时跳过服务端可达性自测', en: 'Production site host name (no scheme, no trailing slash); empty skips the reachability check' } },
  { key: 'DEPLOY_AUTH_DOMAIN', module: 'deploy', kind: 'env', type: 'domain', masked: true, example: 'auth.example.com', probe: 'https-head', description: { zh: '认证网关域名（Authelia 等登录页），用于可达性自测；不用可留空', en: 'Auth gateway host name (e.g. Authelia), for the reachability check; optional' } },
  { key: 'SITE_URL', module: 'deploy', kind: 'env', type: 'url', masked: true, example: '', description: { zh: '公开站点的完整地址，如 https://lectures.example.org；设置后生成 sitemap.xml 与 hreflang 互指。私有站留空', en: 'Full public address of the site, e.g. https://lectures.example.org; when set, sitemap.xml and hreflang cross-links are generated. Leave empty for a private site' } },
  { key: 'DEPLOY_HOST_LABEL', module: 'deploy', kind: 'env', type: 'string', example: '', description: { zh: '部署目标的显示名，只用于日志，不参与连接', en: 'Display name of the target, for logs only' } },
  { key: 'DEPLOY_ENV_FILE', module: 'deploy', kind: 'env', type: 'path', example: '', description: { zh: '旧版部署配置文件位置（默认 scripts/deploy.local.env，仍兼容读取）；新配置请写 .env', en: 'Legacy deploy config file (default scripts/deploy.local.env, still read); put new settings in .env' } },

  // ---------------------------------------------------------------- tools service
  { key: 'LECTURE_TOOLS_HOST', module: 'toolsService', kind: 'env', type: 'host', default: '127.0.0.1', description: { zh: '微服务监听地址', en: 'Tools service listen address' } },
  { key: 'LECTURE_TOOLS_PORT', module: 'toolsService', kind: 'env', type: 'int', default: 8099, description: { zh: '微服务监听端口', en: 'Tools service listen port' } },
  { key: 'NGINX_SITES_AVAILABLE', module: 'toolsService', kind: 'env', type: 'path', default: '/etc/nginx/sites-available', description: { zh: '远端 nginx 站点配置目录（部署微服务时注入 location 用）', en: 'Remote nginx sites directory (for injecting the service location)' } },
  { key: 'REMOTE_SERVER_PY', module: 'toolsService', kind: 'env', type: 'path', default: '/opt/lecture-tools/server.py', description: { zh: '远端微服务源码落地路径', en: 'Remote path of the tools service source' } },

  // ---------------------------------------------------------------- mirror
  { key: 'LECTURE_SITE', module: 'mirror', kind: 'env', type: 'path', example: '', description: { zh: '真实工作副本目录（VitePress 站点源码）。留空则 sync.py 以本仓库 site/ 为工作副本', en: 'Working copy of the VitePress site; empty makes sync.py use this repo\'s site/' } },
  { key: 'PROJECT_MEMORY', module: 'mirror', kind: 'env', type: 'path', example: '', description: { zh: '上游知识库工作副本根目录，没有默认值', en: 'Root of the upstream knowledge-base working copy; no default' } },

  // ---------------------------------------------------------------- tests
  { key: 'TEST_BASE_URL', module: 'tests', kind: 'env', type: 'url', required: true, masked: true, example: 'https://example.com', description: { zh: '端到端测试打的站点根 URL（含 https://，不带结尾斜杠）；留空时测试明确报缺配置', en: 'Site root URL for end-to-end tests (with https://, no trailing slash)' } },
  { key: 'TEST_PAGE_ID', module: 'tests', kind: 'secret', type: 'id', example: '<Notion 页面 ID>', description: { zh: '端到端测试用的 Notion 页面 ID，属个人数据，没有默认值', en: 'Notion page id used by end-to-end tests; personal data, no default' } },
  { key: 'TEST_SYNC_API_URL', module: 'tests', kind: 'env', type: 'url', masked: true, example: 'https://example.com/api/progress/notion-sync', description: { zh: '进度同步 API 完整端点（本地直连测试用）；留空则脚本明确报错', en: 'Full progress-sync endpoint for the direct test; empty makes the script fail clearly' } },

  // ---------------------------------------------------------------- paths
  { key: 'GRAPH_LOCAL_PATH', module: 'paths', kind: 'env', type: 'path', example: '', description: { zh: '本地知识图谱 JSON 路径；留空回退到 site/docs/public/notion_knowledge_graph.json', en: 'Local knowledge-graph JSON; defaults to site/docs/public/notion_knowledge_graph.json' } },
  { key: 'AI_PROMPTS_FILE', module: 'paths', kind: 'env', type: 'path', example: 'prompts/companion.json', description: { zh: 'AI 伴读提示词与快捷动作 JSON 路径；留空回退到 site/prompts/companion.json', en: 'Path to the AI companion prompts JSON file; defaults to site/prompts/companion.json' } },

  // ---------------------------------------------------------------- meta
  { key: 'LECTURE_MODULES', module: 'meta', kind: 'env', type: 'list', example: 'notion,deploy', description: { zh: '本机使用的工具模块（逗号分隔，由 npm run setup 写入）；留空时 doctor 按已设置的键推断', en: 'Tool modules this checkout uses (comma-separated, written by setup); empty lets doctor infer them' } },
]

/** Settings of one module, in declaration order. */
export function settingsOf(module: ModuleId): Setting[] {
  return SETTINGS.filter((s) => s.module === module)
}

/** Every name a setting may be read under: the canonical key first, then aliases. */
export function namesOf(setting: Setting): string[] {
  return [setting.key, ...(setting.aliases ?? [])]
}

/** Site-module defaults, e.g. { progress: { adapter: 'local' }, ... }. */
export function siteDefaults(): Record<SiteModuleId, Record<string, string | number | boolean>> {
  const out = {} as Record<SiteModuleId, Record<string, string | number | boolean>>
  for (const s of SETTINGS) {
    if (s.kind !== 'site') continue
    const [mod, field] = s.key.split('.') as [SiteModuleId, string]
    if (s.default !== undefined) (out[mod] ??= {})[field] = s.default
  }
  return out
}

/**
 * The JSON form written to config/schema.json for scripts/config.py and the CLIs.
 * Version bumps when the shape (not the content) changes.
 */
export function toJSON() {
  return { schemaVersion: 1, modules: MODULES, settings: SETTINGS, blocks: SITE_BLOCKS }
}

/**
 * access/authExport.ts — Gateway rule generator for P6.5 (`npm run auth:export authelia`,
 * plan_v2_amend_01_generic_engine.md §4.7–§4.8 & plan_v2_p3b_access.md §3).
 *
 * Pure: consumes `AccessPlan` (`tiers.ts`), course group dirs, and locale prefixes; emits
 * deterministic Authelia `access_control` YAML fragments or generic nginx `auth_request` snippets.
 * Never imports VitePress or `.vue` files; keeps explicit file extensions on relative runtime imports
 * so plain Node CLI tools (`scripts/auth_export.mjs`) can run without a bundler.
 */
import {
  AccessConfigError,
  TIER_PUBLIC,
  assertBuildGuards,
  assertNoNestedDirs,
  chunkPatternsOf,
  parseAccessJson,
  parseIdList,
  resolveAccess,
  tierBasePath,
  validateAccessConfig,
  type AccessConfig,
  type AccessPlan,
  type GroupDir,
} from './tiers.ts'

/**
 * Node-safe replica of `resolveBuildAccess` using `./tiers.ts` only (no bundler-only curriculum imports).
 */
export function resolveAuthPlan(
  access: AccessConfig | undefined,
  groups: readonly GroupDir[],
  env: Readonly<Record<string, string | undefined>> = process.env,
): AccessPlan {
  const audienceRaw = (env.LECTURE_AUDIENCE ?? '').trim()
  if (audienceRaw !== '' && audienceRaw !== 'public') {
    throw new AccessConfigError(
      `LECTURE_AUDIENCE = ${JSON.stringify(audienceRaw)} is not supported (only: public). Use: npm run build -- --audience public`,
    )
  }
  const audience = audienceRaw === 'public' ? ('public' as const) : undefined
  const buildGroups = parseIdList(env.LECTURE_BUILD_GROUPS)
  const accessJson = env.LECTURE_ACCESS_JSON
  const groupIds = groups.map((g) => g.id)
  const block =
    accessJson !== undefined && accessJson.trim() !== ''
      ? parseAccessJson(accessJson, groupIds)
      : validateAccessConfig(access, groupIds)
  const plan = resolveAccess({
    access: block,
    groupIds,
    ...(audience ? { audience } : {}),
    ...(buildGroups ? { buildGroups } : {}),
    source: accessJson !== undefined && accessJson.trim() !== '' ? 'LECTURE_ACCESS_JSON' : 'lecture.config.ts',
  })
  assertNoNestedDirs(
    groups.filter((g) => plan.keptGroupIds.includes(g.id)),
    plan.tierOfGroup,
  )
  assertBuildGuards(plan)
  return plan
}

export type AuthExportFormat = 'authelia' | 'nginx'

export interface ParsedAuthExportArgs {
  format: AuthExportFormat
  domain: string | undefined
  adminGroups: string[] | undefined
  authorGroups: string[] | undefined
  accessJson: string | undefined
  buildGroups: string | undefined
  outFile: string | undefined
  factor: AutheliaFactor | undefined
  help: boolean
}

export function parseAuthExportArgs(argv: readonly string[]): ParsedAuthExportArgs {
  let formatRaw = 'authelia'
  let domain: string | undefined
  let adminGroupsRaw: string | undefined
  let authorGroupsRaw: string | undefined
  let accessJson: string | undefined
  let buildGroups: string | undefined
  let outFile: string | undefined
  let factorRaw: string | undefined
  let help = false

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? ''
    if (arg === '--help' || arg === '-h') {
      help = true
    } else if (arg === 'authelia' || arg === 'nginx') {
      formatRaw = arg
    } else if (arg === '--format') {
      formatRaw = argv[++i] ?? ''
    } else if (arg.startsWith('--format=')) {
      formatRaw = arg.slice('--format='.length)
    } else if (arg === '--domain') {
      domain = argv[++i]
    } else if (arg.startsWith('--domain=')) {
      domain = arg.slice('--domain='.length)
    } else if (arg === '--admin-groups') {
      adminGroupsRaw = argv[++i]
    } else if (arg.startsWith('--admin-groups=')) {
      adminGroupsRaw = arg.slice('--admin-groups='.length)
    } else if (arg === '--author-groups') {
      authorGroupsRaw = argv[++i]
    } else if (arg.startsWith('--author-groups=')) {
      authorGroupsRaw = arg.slice('--author-groups='.length)
    } else if (arg === '--access-json') {
      accessJson = argv[++i]
    } else if (arg.startsWith('--access-json=')) {
      accessJson = arg.slice('--access-json='.length)
    } else if (arg === '--build-groups') {
      buildGroups = argv[++i]
    } else if (arg.startsWith('--build-groups=')) {
      buildGroups = arg.slice('--build-groups='.length)
    } else if (arg === '--factor') {
      factorRaw = argv[++i]
    } else if (arg.startsWith('--factor=')) {
      factorRaw = arg.slice('--factor='.length)
    } else if (arg === '--out') {
      outFile = argv[++i]
    } else if (arg.startsWith('--out=')) {
      outFile = arg.slice('--out='.length)
    } else {
      throw new Error(`Unknown argument: ${arg}`)
    }
  }

  if (formatRaw !== 'authelia' && formatRaw !== 'nginx') {
    throw new Error(`Unsupported format ${JSON.stringify(formatRaw)} (expected: authelia | nginx)`)
  }
  if (factorRaw !== undefined && factorRaw !== 'one_factor' && factorRaw !== 'two_factor') {
    throw new Error(`Unsupported factor ${JSON.stringify(factorRaw)} (expected: one_factor | two_factor)`)
  }

  return {
    format: formatRaw,
    domain,
    adminGroups: adminGroupsRaw
      ? adminGroupsRaw.split(',').map((s) => s.trim()).filter(Boolean)
      : undefined,
    authorGroups: authorGroupsRaw
      ? authorGroupsRaw.split(',').map((s) => s.trim()).filter(Boolean)
      : undefined,
    accessJson,
    buildGroups,
    outFile,
    factor: factorRaw === 'one_factor' || factorRaw === 'two_factor' ? factorRaw : undefined,
    help,
  }
}

export type AutheliaPolicy = 'bypass' | 'one_factor' | 'two_factor' | 'deny'

export interface AutheliaRule {
  comment: string
  domain?: string | string[]
  resources: string[]
  policy: AutheliaPolicy
  subject?: string[]
}

export interface AuthExportInput {
  plan: AccessPlan
  groups: readonly GroupDir[]
  localeKeys: readonly string[]
  adminGroups?: readonly string[]
  authorGroups?: readonly string[]
  domain?: string
  includeDefaultUserApiRule?: boolean
  /** Authentication level for every non-bypass rule (default `two_factor`, the stronger one). */
  factor?: AutheliaFactor
}

export type AutheliaFactor = 'one_factor' | 'two_factor'

const DEFAULT_ADMIN_GROUPS = ['admins', 'admin'] as const
const DEFAULT_AUTHOR_GROUPS = ['authors', 'author'] as const

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function uniqueStrings(values: readonly string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const v of values) {
    const t = v.trim()
    if (!t || seen.has(t)) continue
    seen.add(t)
    out.push(t)
  }
  return out
}

function groupPrefixPatterns(dir: string, localeKeys: readonly string[]): string[] {
  const cleanDir = dir.replace(/^\/+|\/+$/g, '')
  const out = [`^/${escapeRegex(cleanDir)}(?:/.*)?$`]
  for (const key of localeKeys) {
    const cleanKey = key.replace(/^\/+|\/+$/g, '')
    if (cleanKey) out.push(`^/${escapeRegex(cleanKey)}/${escapeRegex(cleanDir)}(?:/.*)?$`)
  }
  return out
}

function resourcesForGroups(
  groupIds: readonly string[],
  groupsById: ReadonlyMap<string, GroupDir>,
  localeKeys: readonly string[],
  tierAssetPrefix?: string,
): string[] {
  const resources: string[] = []
  if (tierAssetPrefix) {
    resources.push(`^${escapeRegex(tierAssetPrefix)}/.*$`)
  }
  for (const id of groupIds) {
    const g = groupsById.get(id)
    if (!g) continue
    resources.push(...groupPrefixPatterns(g.dir, localeKeys))
    resources.push(...chunkPatternsOf(g.dir, localeKeys).map((pat) => `${pat}.*$`))
  }
  return uniqueStrings(resources)
}

function formatSubjectName(groupName: string): string {
  const trimmed = groupName.trim()
  if (trimmed.startsWith('group:') || trimmed.startsWith('user:')) return trimmed
  return `group:${trimmed}`
}

/**
 * Build ordered Authelia `access_control` rules from top priority to catch-all (every rule carries
 * `domain`, which is required; subjects list one group per inner list, i.e. groups are OR'ed):
 *   0. `/api/health`, `/api/tool/`, `/api/mcp` -> `bypass`; `/api/auth/session` too, only when the site has public content
 *      (on a login-only site every reader is authenticated, and a bypass rule must not be what answers for them)
 *   1a. Author+Admin content APIs (`/api/admin/overview|checks|figures|texts|companion`) -> factor + author/admin subjects,
 *       then `deny` for the same resources
 *   1b. Strict Admin endpoints (remaining `/api/admin/*`, `/api/progress/`, `/api/notion/`) -> factor + admin subject,
 *       then `deny` for the same resources
 *   1c. Authenticated Dashboard UI (`/dashboard`, localized `/dashboard`) & personal `/api/me/*`, `/api/auth/*` -> factor
 *   2. Restricted gateway-group tiers (`grp-*`, sorted deterministically by tier id) -> factor + `group:<name>`,
 *      then `deny` for the same resources
 *   3. Restricted `authenticated` tiers -> factor
 *   4. Explicit `public` groups (when `defaultTier === 'authenticated'`) -> `bypass`
 *   5. Authenticated reader API endpoints (`/api/db`, `/api/ai`, `/api/tools`) -> factor
 *   6. Catch-all (`^/.*$`) matching `plan.defaultTier` (factor or `bypass`)
 *
 * Authelia applies the first rule whose criteria ALL match, and `subject` is a criterion: a user outside the subject
 * skips that rule and falls through to the next one (the catch-all would let them in). That is why every
 * subject-restricted rule is followed by a `deny` rule for the same resources.
 * `factor` is `two_factor` unless the caller asks for `one_factor`.
 */
export function buildAutheliaRules(input: AuthExportInput): AutheliaRule[] {
  const { plan, groups, localeKeys } = input
  const domain = input.domain?.trim() || undefined
  if (!domain) {
    throw new AccessConfigError(
      'auth:export authelia requires --domain <host>: Authelia rejects access_control rules without `domain`. Example: npm run auth:export authelia -- --domain docs.example.com',
    )
  }
  const adminSubjects = uniqueStrings(
    (input.adminGroups && input.adminGroups.length > 0 ? input.adminGroups : DEFAULT_ADMIN_GROUPS).map(formatSubjectName),
  )
  const authorSubjects = uniqueStrings([
    ...adminSubjects,
    ...(input.authorGroups && input.authorGroups.length > 0 ? input.authorGroups : DEFAULT_AUTHOR_GROUPS).map(
      formatSubjectName,
    ),
  ])
  const groupsById = new Map<string, GroupDir>(groups.map((g) => [g.id, g]))
  const withDomain = (rule: AutheliaRule): AutheliaRule => ({ ...rule, domain })
  const factor: AutheliaFactor = input.factor ?? 'two_factor'
  const hasPublicContent =
    plan.defaultTier === TIER_PUBLIC || plan.keptGroupIds.some((id) => plan.tierOfGroup[id] === TIER_PUBLIC)

  const rules: AutheliaRule[] = []
  /** A subject-restricted rule plus the `deny` that keeps everyone else out (see the doc comment). */
  const pushRestricted = (rule: AutheliaRule & { subject: string[] }): void => {
    rules.push(withDomain(rule))
    rules.push(
      withDomain({
        comment: `Everyone else: deny (${rule.comment ?? 'restricted resources'})`,
        resources: rule.resources,
        policy: 'deny',
      }),
    )
  }

  // 0. Paths that must never be gated: the public health check, Dify tool / MCP endpoints;
  //    session discovery only when anonymous visitors can actually reach content.
  rules.push(
    withDomain({
      comment: hasPublicContent
        ? 'Public: /api/auth/session, /api/health, /api/tool/ (nginx token) and /api/mcp (bearer token in lecture-api)'
        : 'Public: /api/health, /api/tool/ (nginx token) and /api/mcp (bearer token in lecture-api)',
      resources: hasPublicContent
        ? ['^/api/auth/session/?$', '^/api/health/?$', '^/api/tool(?:/.*)?$', '^/api/mcp$']
        : ['^/api/health/?$', '^/api/tool(?:/.*)?$', '^/api/mcp$'],
      policy: 'bypass',
    }),
  )

  // 1a. Author + Admin Dashboard content APIs (must precede the catch-all /api/admin/* rule below)
  pushRestricted({
    comment: 'Author/Admin tier: Dashboard content APIs (overview, checks, figures, texts, companion)',
    resources: ['^/api/admin/overview/?$', '^/api/admin/(?:checks|figures|texts|companion)(?:/.*)?$'],
    policy: factor,
    subject: authorSubjects,
  })

  // 1b. Strict Admin system/site APIs (/api/admin/*) and legacy Notion service paths
  pushRestricted({
    comment: 'Admin tier: system /api/admin/* routes, /api/progress/* and /api/notion/* (legacy Notion service)',
    resources: ['^/api/admin(?:/.*)?$', '^/api/(?:progress|notion)(?:/.*)?$'],
    policy: factor,
    subject: adminSubjects,
  })

  // 1c. Authenticated Dashboard pages (/dashboard, localized) and personal self-service APIs (/api/me/*, /api/auth/*)
  const dashboardResources = ['^/dashboard(?:/.*)?$']
  for (const key of localeKeys) {
    const cleanKey = key.replace(/^\/+|\/+$/g, '')
    if (cleanKey) dashboardResources.push(`^/${escapeRegex(cleanKey)}/dashboard(?:/.*)?$`)
  }
  dashboardResources.push('^/api/me(?:/.*)?$', '^/api/auth(?:/.*)?$')
  rules.push(
    withDomain({
      comment: 'Authenticated user tier: Lecture Dashboard (/dashboard) and personal /api/me/*, /api/auth/* APIs',
      resources: uniqueStrings(dashboardResources),
      policy: factor,
    }),
  )

  // 2 & 3. Restricted tiers: group-restricted tiers first, then authenticated tiers
  const orderedTiers = [...plan.tiers].sort((a, b) => {
    const rankA = a.rule.kind === 'groups' ? 0 : 1
    const rankB = b.rule.kind === 'groups' ? 0 : 1
    return rankA - rankB || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  })
  for (const tier of orderedTiers) {
    const resources = resourcesForGroups(tier.groupIds, groupsById, localeKeys, tierBasePath(tier.id))
    if (resources.length === 0) continue
    if (tier.rule.kind === 'groups') {
      pushRestricted({
        comment: `Restricted tier ${tier.id} (${tier.groupIds.join(', ')}): groups [${tier.rule.groups.join(', ')}]`,
        resources,
        policy: factor,
        subject: uniqueStrings(tier.rule.groups.map(formatSubjectName)),
      })
    } else {
      rules.push(
        withDomain({
          comment: `Restricted tier ${tier.id} (${tier.groupIds.join(', ')}): any authenticated user`,
          resources,
          policy: factor,
        }),
      )
    }
  }

  // 4. Explicit public groups when the site default is authenticated
  if (plan.defaultTier !== TIER_PUBLIC) {
    const publicGroupIds = plan.keptGroupIds.filter((id) => plan.tierOfGroup[id] === TIER_PUBLIC)
    const publicResources = resourcesForGroups(publicGroupIds, groupsById, localeKeys)
    if (publicResources.length > 0) {
      rules.push(
        withDomain({
          comment: `Explicit public groups (${publicGroupIds.join(', ')}) under authenticated default`,
          resources: publicResources,
          policy: 'bypass',
        }),
      )
    }
  }

  // 5. User interactive APIs (progress writes, AI companion, AI tools REST mirror)
  if (input.includeDefaultUserApiRule !== false) {
    rules.push(
      withDomain({
        comment: 'User tier: authenticated interactive APIs (/api/db, /api/ai, /api/tools)',
        resources: ['^/api/(?:db|ai)(?:/.*)?$', '^/api/tools(?:/.*)?$'],
        policy: factor,
      }),
    )
  }

  // 6. Site default catch-all rule
  rules.push(
    withDomain({
      comment: `Site default tier (${plan.defaultTier})`,
      resources: ['^/.*$'],
      policy: plan.defaultTier === 'authenticated' ? factor : 'bypass',
    }),
  )

  return rules
}

function yamlQuote(value: string): string {
  return JSON.stringify(value)
}

/**
 * Render Authelia v4 `access_control` YAML fragment from the resolved `AccessPlan`.
 */
export function formatAutheliaYaml(input: AuthExportInput): string {
  const { plan } = input
  const rules = buildAutheliaRules(input)
  const lines: string[] = [
    '# Generated by `npm run auth:export authelia` — do not edit by hand.',
    `# Access plan: default=${plan.defaultTier} inline=${plan.inlineTier} enforcement=${plan.enforcement} restricted=${plan.tiers.map((t) => t.id).join(',') || 'none'}`,
    'access_control:',
    '  default_policy: deny',
    '  rules:',
  ]

  for (const rule of rules) {
    lines.push(`    # ${rule.comment}`)
    let first = true
    const field = (key: string): string => {
      const prefix = first ? '    - ' : '      '
      first = false
      return `${prefix}${key}:`
    }
    if (rule.domain !== undefined) {
      const domains = Array.isArray(rule.domain) ? rule.domain : [rule.domain]
      lines.push(field('domain'))
      for (const d of domains) lines.push(`        - ${yamlQuote(d)}`)
    }
    lines.push(field('resources'))
    for (const r of rule.resources) lines.push(`        - ${yamlQuote(r)}`)
    lines.push(`${field('policy')} ${rule.policy}`)
    if (rule.subject && rule.subject.length > 0) {
      // Authelia: inner list = AND, outer list = OR. One group per inner list means "any of these".
      lines.push(field('subject'))
      for (const subj of rule.subject) lines.push(`        - - ${yamlQuote(subj)}`)
    }
  }

  return `${lines.join('\n')}\n`
}

const SERVER_BEGIN = '# ##### SERVER-LEVEL BEGIN #####'
const SERVER_END = '# ##### SERVER-LEVEL END #####'
const HTTP_BEGIN = '# ##### HTTP-LEVEL BEGIN #####'
const HTTP_END = '# ##### HTTP-LEVEL END #####'

function between(text: string, begin: string, end: string): string | undefined {
  const a = text.indexOf(begin)
  const b = text.indexOf(end)
  if (a < 0 || b < a) return undefined
  return text.slice(a + begin.length, b).replace(/^\r?\n/, '').replace(/\s+$/, '')
}

/** The part of `server/deploy/nginx-locations.conf` that belongs inside `server { }`. */
export function extractServerSection(template: string): string | undefined {
  return between(template, SERVER_BEGIN, SERVER_END)
}

/** The part of the template that belongs in the `http { }` block (upstreams, limit_req_zone). */
export function extractHttpSection(template: string): string | undefined {
  return between(template, HTTP_BEGIN, HTTP_END)
}

/** With a public default tier the catch-all `location /` must not require auth; edit that block only. */
function relaxCatchAll(serverSection: string): string {
  const lines = serverSection.split('\n')
  const out: string[] = []
  let inCatchAll = false
  for (const line of lines) {
    if (/^\s*location\s+\/\s*\{\s*$/.test(line)) inCatchAll = true
    if (inCatchAll && /^\s*(auth_request\s|error_page\s+401)/.test(line)) continue
    if (inCatchAll && /^\s*\}\s*$/.test(line)) inCatchAll = false
    out.push(line)
  }
  return out.join('\n')
}

/**
 * Render the nginx side derived from the same `AccessPlan`.
 *
 * The API locations (identity-header overrides, SSE, limits, legacy service) are NOT written here:
 * they are copied verbatim from `server/deploy/nginx-locations.conf` (pass its text as
 * `template`), so the printed snippet cannot drift from the template that the unit test checks.
 * This function only adds the per-tier static-content locations. Without `template` it prints a
 * pointer to the file instead.
 */
export function formatNginxAuthSnippet(input: AuthExportInput, template?: string): string {
  const { plan, groups, localeKeys } = input
  const groupsById = new Map<string, GroupDir>(groups.map((g) => [g.id, g]))
  const lines: string[] = [
    '# Generated by `npm run auth:export -- --format nginx` — do not edit by hand.',
    `# Access plan: default=${plan.defaultTier} inline=${plan.inlineTier} restricted=${plan.tiers.map((t) => t.id).join(',') || 'none'}`,
    '# Who may open which path is decided by Authelia (`npm run auth:export authelia -- --domain <host>`,',
    '# the rules see the original URI via X-Original-URL); nginx only has to call auth_request.',
    '',
  ]

  const http = template ? extractHttpSection(template) : undefined
  const server = template ? extractServerSection(template) : undefined
  if (http && server) {
    lines.push('# ===== 1. Paste into the http { } block =====', http, '')
    lines.push('# ===== 2. Paste inside the server { } block (copied from server/deploy/nginx-locations.conf) =====')
    lines.push(plan.defaultTier === 'authenticated' ? server : relaxCatchAll(server))
  } else {
    lines.push(
      '# API locations: copy the HTTP-LEVEL and SERVER-LEVEL sections of server/deploy/nginx-locations.conf',
      '# (every proxying location there overwrites Remote-User/Groups/Email/Name).',
    )
  }

  for (const tier of plan.tiers) {
    const resources = resourcesForGroups(tier.groupIds, groupsById, localeKeys, tierBasePath(tier.id))
    if (resources.length === 0) continue
    const combined = resources.map((r) => r.replace(/^\^/, '').replace(/\$$/, '')).join('|')
    const guardNote =
      tier.rule.kind === 'groups'
        ? `# Restricted groups (${tier.rule.groups.join(', ')}) for tier ${tier.id}: enforced by the Authelia rule`
        : `# Authenticated user required for tier ${tier.id}`
    lines.push('')
    lines.push(guardNote)
    lines.push(`location ~ ^(?:${combined})$ {`)
    lines.push('    auth_request /internal/authelia/authz;')
    lines.push('    error_page 401 =302 https://auth.example.com/?rd=$target_url;')
    lines.push('    try_files $uri $uri/ $uri.html =404;')
    lines.push('}')
  }

  return `${lines.join('\n')}\n`
}

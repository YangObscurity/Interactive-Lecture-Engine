/**
 * access/tiers.ts - the tier model of P3b (docs-dev/ACCESS.md). Pure: no VitePress, no Node
 * imports, so the build (access/build.mts), the unit tests and the client (WP-A2) share one implementation.
 *
 * A tier is who may read a piece of content:
 *   - `public`                   everybody
 *   - `authenticated`            any signed-in user
 *   - `grp-<8 hex>`              members of a set of gateway user groups; the id is `grp-` + fnv1a(sorted group
 *                                names joined by "\n"), so the same set of names always gives the same id
 * Order: public < authenticated < every grp tier (grp tiers are not comparable with each other).
 *
 * The inline tier is the lowest tier of the default tier (home page and every non-group page) and of all built
 * groups. Everything in the inline tier ships inside every page (themeConfig); every tier above it is restricted
 * and lives only under its protected paths (`/_access/<tier>/...`, the group folders).
 */
import { fnv1a } from '../theme/core/hash.ts'
import { SITE_BLOCKS } from '../../../config/schema.ts'

export type DefaultTier = (typeof SITE_BLOCKS.access.fields.default.values)[number]
export type Enforcement = (typeof SITE_BLOCKS.access.fields.enforcement.values)[number]
/** `read` of one group: a named tier or a non-empty list of gateway user-group names. */
export type ReadRule = 'public' | 'authenticated' | string[]

export interface AccessGroupConfig {
  read: ReadRule
}

/** The `access` block of lecture.config.ts (everything optional; see SITE_BLOCKS for defaults). */
export interface AccessConfig {
  default?: DefaultTier
  groups?: Record<string, AccessGroupConfig>
  enforcement?: Enforcement
}

export const TIER_PUBLIC = 'public'
export const TIER_AUTHENTICATED = 'authenticated'
export const TIER_GROUP_PREFIX = 'grp-'

/** A config problem (bad value, unknown group id, empty list). The message names the key and the valid choices. */
export class AccessConfigError extends Error {
  override name = 'AccessConfigError'
}

/** A build guard fired (restricted content without a gateway, or nothing public to build). */
export class AccessGuardError extends Error {
  override name = 'AccessGuardError'
}

/** Group names trimmed, de-duplicated and sorted; throws on a non-string or empty name. */
export function normalizeGroupNames(names: readonly unknown[], where = 'read'): string[] {
  const out = new Set<string>()
  names.forEach((n, i) => {
    if (typeof n !== 'string' || n.trim() === '') {
      throw new AccessConfigError(`${where}[${i}] = ${JSON.stringify(n)} must be a non-empty gateway user-group name`)
    }
    out.add(n.trim())
  })
  return [...out].sort()
}

/** Tier id of a `read` rule. Throws AccessConfigError on an invalid rule. */
export function tierOfRead(read: unknown, where = 'read'): string {
  if (read === TIER_PUBLIC || read === TIER_AUTHENTICATED) return read
  if (Array.isArray(read)) {
    if (read.length === 0) throw new AccessConfigError(`${where} is an empty array: list at least one gateway user-group name, or use 'public' / 'authenticated'`)
    return `${TIER_GROUP_PREFIX}${fnv1a(normalizeGroupNames(read, where).join('\n'))}`
  }
  throw new AccessConfigError(`${where} = ${JSON.stringify(read)} is not valid: use 'public', 'authenticated' or a non-empty array of gateway user-group names`)
}

/** 0 public, 1 authenticated, 2 any group tier. */
export function tierRank(tier: string): number {
  if (tier === TIER_PUBLIC) return 0
  if (tier === TIER_AUTHENTICATED) return 1
  return 2
}

export function isGroupTier(tier: string): boolean {
  return tier.startsWith(TIER_GROUP_PREFIX)
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/**
 * Check an `access` block. `source` prefixes every message (`lecture.config.ts`, `LECTURE_ACCESS_JSON`);
 * `groupIds` (when given) are the valid keys of `access.groups`. Returns the block unchanged.
 */
export function validateAccessConfig(access: unknown, groupIds?: readonly string[], source = 'lecture.config.ts'): AccessConfig {
  if (access === undefined) return {}
  const f = SITE_BLOCKS.access.fields
  if (!isRecord(access)) throw new AccessConfigError(`${source}: access must be an object like { default: 'public', enforcement: 'none', groups: { G01: { read: 'authenticated' } } }`)
  const known = ['default', 'groups', 'enforcement']
  for (const k of Object.keys(access)) {
    if (!known.includes(k)) throw new AccessConfigError(`${source}: access.${k} is not a setting (expected ${known.join(', ')})`)
  }
  if (access.default !== undefined && !(f.default.values as readonly string[]).includes(access.default as string)) {
    throw new AccessConfigError(`${source}: access.default = ${JSON.stringify(access.default)} is not one of ${f.default.values.join(' | ')}`)
  }
  if (access.enforcement !== undefined && !(f.enforcement.values as readonly string[]).includes(access.enforcement as string)) {
    throw new AccessConfigError(`${source}: access.enforcement = ${JSON.stringify(access.enforcement)} is not one of ${f.enforcement.values.join(' | ')}`)
  }
  if (access.groups !== undefined) {
    if (!isRecord(access.groups)) throw new AccessConfigError(`${source}: access.groups must be an object { <group id>: { read } }`)
    for (const [id, rule] of Object.entries(access.groups)) {
      const where = `${source}: access.groups.${id}`
      if (groupIds && !groupIds.includes(id)) {
        throw new AccessConfigError(`${where} is not a course group (valid ids: ${groupIds.join(', ') || 'none'})`)
      }
      if (!isRecord(rule) || !('read' in rule)) throw new AccessConfigError(`${where} must be an object like { read: 'authenticated' }`)
      const extra = Object.keys(rule).filter((k) => k !== 'read')
      if (extra.length) throw new AccessConfigError(`${where}.${extra[0]} is not a setting (expected read)`)
      tierOfRead(rule.read, `${where}.read`)
    }
  }
  return access as AccessConfig
}

/** `LECTURE_BUILD_GROUPS` / `LECTURE_ACCESS_JSON` style helpers -------------------------------------------------- */

/** Comma separated ids -> trimmed, non-empty, unique. */
export function parseIdList(raw: string | undefined): string[] | undefined {
  if (raw === undefined || raw.trim() === '') return undefined
  return [...new Set(raw.split(',').map((s) => s.trim()).filter(Boolean))]
}

/** Parse and validate the JSON of `LECTURE_ACCESS_JSON` (replaces the `access` block, validated like the config). */
export function parseAccessJson(raw: string, groupIds?: readonly string[]): AccessConfig {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch (e) {
    throw new AccessConfigError(`LECTURE_ACCESS_JSON is not valid JSON: ${(e as Error).message}`)
  }
  return validateAccessConfig(value, groupIds, 'LECTURE_ACCESS_JSON')
}

/** The rule a gateway enforces for a restricted tier. */
export type TierRule = { kind: 'authenticated' } | { kind: 'groups'; groups: string[] }

export interface TierInfo {
  id: string
  rule: TierRule
  /** Ids of the built groups in this tier, in declaration order. */
  groupIds: string[]
}

export interface ResolveInput {
  access?: AccessConfig
  /** Every course group id in declaration order. Default: the ids named in `access.groups`. */
  groupIds?: readonly string[]
  /** `public`: build only public groups (`LECTURE_AUDIENCE=public`). */
  audience?: 'public'
  /** `LECTURE_BUILD_GROUPS`: build only these groups. */
  buildGroups?: readonly string[]
  /** Prefix of config error messages. */
  source?: string
}

export interface AccessPlan {
  default: DefaultTier
  enforcement: Enforcement
  audience: 'all' | 'public'
  /** Tier of the home page, of non-group pages and of every group without its own `read`. */
  defaultTier: string
  inlineTier: string
  /** Restricted tiers (rank above the inline tier) that contain at least one built group, sorted by id. */
  tiers: TierInfo[]
  /** Built groups, in declaration order. */
  keptGroupIds: string[]
  /** Groups left out of the build (audience, LECTURE_BUILD_GROUPS). */
  removedGroupIds: string[]
  /** Tier of every built group. */
  tierOfGroup: Record<string, string>
  /** Every course group id known to the plan (declaration order); see `lookupTier`. */
  knownGroupIds: string[]
  /** `LECTURE_BUILD_GROUPS`, or null when the build is not limited. */
  buildGroups: string[] | null
}

/** Lowest tier by rank; ties keep the first. */
function lowestTier(tiers: readonly string[]): string {
  let best = tiers[0] as string
  for (const t of tiers) if (tierRank(t) < tierRank(best)) best = t
  return best
}

/**
 * Work out the tiers of one build. Pure. Throws AccessConfigError (bad config, unknown ids) or AccessGuardError
 * (`--audience public` with `default: 'authenticated'`). The enforcement guard is `assertBuildGuards`.
 */
export function resolveAccess(input: ResolveInput = {}): AccessPlan {
  const source = input.source ?? 'lecture.config.ts'
  const access = validateAccessConfig(input.access, input.groupIds, source)
  const ruleOf = access.groups ?? {}
  const allIds = [...(input.groupIds ?? Object.keys(ruleOf))]
  const def: DefaultTier = access.default ?? SITE_BLOCKS.access.fields.default.default
  const enforcement: Enforcement = access.enforcement ?? SITE_BLOCKS.access.fields.enforcement.default
  const audience = input.audience === 'public' ? 'public' : 'all'

  if (input.buildGroups) {
    if (input.buildGroups.length === 0) throw new AccessConfigError('LECTURE_BUILD_GROUPS is empty: list course group ids such as G01,LR')
    if (input.groupIds) {
      const unknown = input.buildGroups.filter((id) => !allIds.includes(id))
      if (unknown.length) throw new AccessConfigError(`LECTURE_BUILD_GROUPS names unknown course group(s) ${unknown.join(', ')} (valid ids: ${allIds.join(', ')})`)
    }
  }

  const tierOfAll: Record<string, string> = {}
  for (const id of allIds) tierOfAll[id] = ruleOf[id] ? tierOfRead(ruleOf[id].read, `${source}: access.groups.${id}.read`) : def

  if (audience === 'public' && def === TIER_AUTHENTICATED) {
    throw new AccessGuardError(
      "Access guard: --audience public (LECTURE_AUDIENCE=public) was requested but access.default is 'authenticated', so the home page and every group without its own `read` is not public: there is no public content to build.\n" +
        "Set access.default to 'public' and mark the private groups under access.groups, or build without --audience public behind a gateway (access.enforcement: 'gateway').",
    )
  }

  let kept = allIds.filter((id) => !input.buildGroups || input.buildGroups.includes(id))
  if (audience === 'public') kept = kept.filter((id) => tierOfAll[id] === TIER_PUBLIC)
  const removed = allIds.filter((id) => !kept.includes(id))

  const defaultTier = def
  const inlineTier = lowestTier([defaultTier, ...kept.map((id) => tierOfAll[id] as string)])
  const tierOfGroup: Record<string, string> = {}
  for (const id of kept) tierOfGroup[id] = tierOfAll[id] as string

  const byTier = new Map<string, string[]>()
  for (const id of kept) {
    const t = tierOfGroup[id] as string
    if (tierRank(t) > tierRank(inlineTier)) byTier.set(t, [...(byTier.get(t) ?? []), id])
  }
  const tiers: TierInfo[] = [...byTier.entries()]
    .map(([id, groupIds]): TierInfo => {
      const first = groupIds[0] as string
      const read = ruleOf[first]?.read
      const rule: TierRule = Array.isArray(read) ? { kind: 'groups', groups: normalizeGroupNames(read) } : { kind: 'authenticated' }
      return { id, rule, groupIds }
    })
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))

  return { default: def, enforcement, audience, defaultTier, inlineTier, tiers, keptGroupIds: kept, removedGroupIds: removed, tierOfGroup, knownGroupIds: allIds, buildGroups: input.buildGroups ? [...input.buildGroups] : null }
}

/**
 * Tier of a group id, or null when the group is not part of this build. Case-insensitive on the id. An id the plan
 * does not know (a graph node of a group that is not in groups.mts) gets the default tier, unless the build is
 * limited with `LECTURE_BUILD_GROUPS` and does not list it.
 */
export function lookupTier(plan: AccessPlan, groupId: string): string | null {
  const lower = groupId.toLowerCase()
  const id = plan.knownGroupIds.find((k) => k.toLowerCase() === lower) ?? groupId
  const tier = plan.tierOfGroup[id]
  if (tier !== undefined) return tier
  if (plan.removedGroupIds.includes(id)) return null
  if (plan.buildGroups && !plan.buildGroups.some((b) => b.toLowerCase() === lower)) return null
  return plan.defaultTier
}

/**
 * Guard 1: restricted tiers (or `default: 'authenticated'`) without `enforcement: 'gateway'` fail the build.
 * Guard 2 (`--audience public` with a non-public default) is raised by `resolveAccess`.
 */
export function assertBuildGuards(plan: AccessPlan): void {
  if (plan.enforcement === 'gateway') return
  const restricted = plan.tiers.length > 0
  if (!restricted && plan.default !== TIER_AUTHENTICATED) return
  const why = [
    restricted ? `restricted tier(s) ${plan.tiers.map((t) => t.id).join(', ')}` : '',
    plan.default === TIER_AUTHENTICATED ? "access.default is 'authenticated'" : '',
  ].filter(Boolean).join(' and ')
  throw new AccessGuardError(
    `Access guard: this build has restricted content (${why}) but access.enforcement is not 'gateway'.\n` +
      'Without an authenticating gateway in front of the site that content would be served to everyone. Pick one:\n' +
      "  - set access: { enforcement: 'gateway' } in lecture.config.ts, if the deployment has an authenticating gateway, or\n" +
      '  - build only the public content: npm run build -- --audience public',
  )
}

/** `{ inlineTier, tiers }` for `themeConfig.lectureAccess`: tier ids only, never group names or lecture titles. */
export interface LectureAccess {
  inlineTier: string
  tiers: string[]
}

export function lectureAccessOf(plan: AccessPlan): LectureAccess {
  return { inlineTier: plan.inlineTier, tiers: plan.tiers.map((t) => t.id) }
}

// ---- paths ----------------------------------------------------------------------------------------------------

export interface GroupDir {
  id: string
  /** Folder under docs/, may contain "/" (`examples/g01`). */
  dir: string
}

/** Two groups whose folders nest (`a` and `a/b`) cannot be told apart by a path-prefix gateway unless they share a tier. */
export function assertNoNestedDirs(groups: readonly GroupDir[], tierOfGroup: Readonly<Record<string, string>>): void {
  for (const a of groups) {
    for (const b of groups) {
      if (a.id === b.id || !b.dir.startsWith(`${a.dir}/`)) continue
      if (tierOfGroup[a.id] !== tierOfGroup[b.id]) {
        throw new AccessConfigError(`Course group folders nest: ${b.id} (${b.dir}/) is inside ${a.id} (${a.dir}/) but they are in different tiers; a path-prefix gateway cannot separate them. Move one folder.`)
      }
    }
  }
}

export interface PathOwner {
  groupId: string
  dir: string
  /** Locale key of the page (`en`), or null for the root language. */
  locale: string | null
}

/**
 * Which group a page path belongs to. `rel` is a docs-relative path with or without `.md`, with or without a
 * leading "/" (`g01/L01.md`, `/en/g01/L01`). The longest folder wins. Null for the home page and other non-group pages.
 */
export function ownerOfPath(rel: string, groups: readonly GroupDir[], localeKeys: readonly string[]): PathOwner | null {
  const p = rel.replace(/^\/+/, '')
  const sorted = [...groups].sort((a, b) => b.dir.length - a.dir.length)
  const candidates: Array<{ locale: string | null; path: string }> = [{ locale: null, path: p }]
  for (const key of localeKeys) if (p.startsWith(`${key}/`)) candidates.unshift({ locale: key, path: p.slice(key.length + 1) })
  for (const c of candidates) {
    const g = sorted.find((x) => c.path.startsWith(`${x.dir}/`))
    if (g) return { groupId: g.id, dir: g.dir, locale: c.locale }
  }
  return null
}

/** `/<dir>/` and `/<key>/<dir>/` for every locale: what a gateway matches. */
export function pathPrefixesOf(dir: string, localeKeys: readonly string[]): string[] {
  return [`/${dir}/`, ...localeKeys.map((k) => `/${k}/${dir}/`)]
}

/** Prefix of the page chunk file names of a group: `g01_`, `examples_g01_`; with a locale `en_g01_`. */
export function chunkPrefixOf(dir: string, locale: string | null = null): string {
  const base = `${dir.replace(/\//g, '_')}_`
  return locale ? `${locale}_${base}` : base
}

/** Gateway path regexes for the bundled page chunks of a group, root language first (`^/assets/g01_`, `^/assets/en_g01_`). */
export function chunkPatternsOf(dir: string, localeKeys: readonly string[]): string[] {
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return [`^/assets/${esc(chunkPrefixOf(dir))}`, ...localeKeys.map((k) => `^/assets/${esc(chunkPrefixOf(dir, k))}`)]
}

/** Where the files of a restricted tier live: `/_access/<tier>/`. */
export function tierBasePath(tier: string): string {
  return `/_access/${tier}`
}

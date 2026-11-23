// @vitest-environment happy-dom
/**
 * P3b WP-A2: the access store asks the gateway again when the signed-in user changes (and only then).
 * The session client runs for real against a stubbed `fetch`; the gateway is a script.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { shallowRef } from 'vue'
import type { SiteLike } from '../../docs/.vitepress/access/siteData'
import { splitSiteData } from '../../docs/.vitepress/access/siteData'
import { resolveAccess as planAccess } from '../../docs/.vitepress/access/tiers'
import { configureAccess, startAccess } from '../../docs/.vitepress/theme/access/store'
import { configureSession, getSession, resetSession } from '../../docs/.vitepress/theme/auth/session'

const GROUPS = [
  { id: 'G06', dir: 'g06' },
  { id: 'G12', dir: 'g12' },
]
const plan = planAccess({ access: { default: 'public', enforcement: 'gateway', groups: { G12: { read: ['staff'] } } }, groupIds: ['G06', 'G12'] })
const TIER = plan.tiers[0]?.id as string

function site(): SiteLike {
  const groups = GROUPS.map((g) => ({ id: g.id, dir: g.dir, title: g.id, lectures: [], lectureCount: 0, chartCount: 0 }))
  return {
    themeConfig: {
      nav: [{ text: 'Home', link: '/' }, { text: 'Groups', items: groups.map((g) => ({ text: g.id, link: `/${g.dir}/` })) }],
      sidebar: Object.fromEntries(groups.map((g) => [`/${g.dir}/`, []])),
      groups,
      totals: { lectures: 0, charts: 0 },
    },
    locales: {},
  }
}

const settle = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) await Promise.resolve()
  await new Promise((r) => setTimeout(r, 0))
}

describe('access store and the session', () => {
  let sessionBody: unknown
  let allowStaff = false
  let accessCalls = 0
  let ref: { value: unknown }

  beforeEach(() => {
    sessionBody = { authenticated: false, user: null, roles: [], groups: [], logoutUrl: null }
    allowStaff = false
    accessCalls = 0
    const split = splitSiteData(site(), { groups: GROUPS, tierOfGroup: (id) => plan.tierOfGroup[id] as string, inlineTier: plan.inlineTier, localeKeys: [] })
    const inline = split.inline
    ;(inline.themeConfig as Record<string, unknown>).lectureAccess = { inlineTier: plan.inlineTier, tiers: [TIER] }
    ref = shallowRef<unknown>(inline)
    const gateway: typeof fetch = async () => {
      accessCalls++
      if (!allowStaff) return new Response('no', { status: 403 })
      return new Response(JSON.stringify(split.slices[TIER]), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify(sessionBody), { status: 200, headers: { 'content-type': 'application/json' } }))
    configureSession({ adapter: 'cookie' })
    configureAccess({ siteData: ref, withBase: (p) => p, fetch: gateway })
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    resetSession()
  })

  const groupIds = (): string[] => ((ref.value as SiteLike).themeConfig?.groups as Array<{ id: string }>).map((g) => g.id)

  it('re-resolves when a user signs in, merges the newly readable tier, and not on an unchanged identity', async () => {
    const stop = startAccess()
    await settle()
    expect(groupIds()).toEqual(['G06'])
    expect(accessCalls).toBe(1)

    // same (anonymous) identity answered again: no new request
    resetSession()
    await getSession()
    await settle()
    expect(accessCalls).toBe(1)

    // a user signs in and the gateway now lets the staff tier through
    sessionBody = { authenticated: true, user: { id: 'u1', name: null, email: null }, roles: [], groups: ['staff'], logoutUrl: null }
    allowStaff = true
    resetSession()
    await getSession()
    await settle()
    expect(accessCalls).toBe(2)
    expect(groupIds()).toEqual(['G06', 'G12'])

    // another user, tier no longer readable: the merged data goes back to the inline data
    sessionBody = { authenticated: true, user: { id: 'u2', name: null, email: null }, roles: [], groups: [], logoutUrl: null }
    allowStaff = false
    resetSession()
    await getSession()
    await settle()
    expect(accessCalls).toBe(3)
    expect(groupIds()).toEqual(['G06'])
    stop()
  })
})

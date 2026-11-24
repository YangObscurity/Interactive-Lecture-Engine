import { describe, expect, it } from 'vitest'
import { showDashboardEntry } from '../../docs/.vitepress/theme/auth/dashboardEntry'
import type { SessionState } from '../../docs/.vitepress/theme/auth/session'

const user = { id: 'u', name: null, email: null }
const authed = (roles: string[]): SessionState => ({ status: 'authenticated', user, roles, groups: [], logoutUrl: null })

describe('Dashboard entry visibility', () => {
  it('online: any signed-in user (reader, author, admin) sees the entry', () => {
    expect(showDashboardEntry(authed(['admin']), false)).toBe(true)
    expect(showDashboardEntry(authed(['admin', 'reader']), false)).toBe(true)
    expect(showDashboardEntry(authed(['author']), false)).toBe(true)
    expect(showDashboardEntry(authed(['reader']), false)).toBe(true)
    expect(showDashboardEntry(authed([]), false)).toBe(true)
    expect(showDashboardEntry(authed(['reader', 'administrator']), false)).toBe(true)
  })

  it('anonymous, unknown and unavailable sessions never see it', () => {
    const states: SessionState[] = [
      { status: 'unknown' },
      { status: 'anonymous', source: 'none' },
      { status: 'anonymous', source: 'server' },
      { status: 'unavailable', reason: 'unauthorized' },
      { status: 'unavailable', reason: 'network' },
    ]
    for (const s of states) expect(showDashboardEntry(s, false)).toBe(false)
  })

  it('local author mode always shows it', () => {
    expect(showDashboardEntry({ status: 'unknown' }, true)).toBe(true)
    expect(showDashboardEntry({ status: 'anonymous', source: 'none' }, true)).toBe(true)
    expect(showDashboardEntry({ status: 'unavailable', reason: 'unauthorized' }, true)).toBe(true)
    expect(showDashboardEntry(authed(['reader']), true)).toBe(true)
  })
})

/**
 * auth/dashboardEntry.ts - who sees the top-bar entry to the Dashboard.
 *
 * Online: any authenticated user (`reader`, `author`, or `admin`). Local development (`import.meta.env.DEV`):
 * always, when the dev middleware answers (`fetchDevDashboardStatus`). Anonymous, unknown, and unavailable
 * sessions never see it.
 */
import type { SessionState } from './session'

export function showDashboardEntry(session: SessionState, devAuthor: boolean): boolean {
  if (devAuthor) return true
  return session.status === 'authenticated'
}

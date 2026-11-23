/**
 * auth/dashboardEntry.ts - who sees the top-bar entry to the Dashboard.
 *
 * Online: only a signed-in session that carries the `admin` role (the gateway lets only the `admins` group open `/dashboard`;
 * the Dashboard page checks the same role). Local development (`import.meta.env.DEV`): always, when the dev middleware answers
 * (`fetchDevDashboardStatus`, the same test the Dashboard uses for its author mode). Anonymous, unknown, unavailable and non-admin
 * sessions never see it.
 */
import type { SessionState } from './session'

export function showDashboardEntry(session: SessionState, devAuthor: boolean): boolean {
  if (devAuthor) return true
  return session.status === 'authenticated' && session.roles.includes('admin')
}

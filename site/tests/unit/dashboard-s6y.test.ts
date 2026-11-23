/**
 * S6Y Dashboard fixes (audit-dashboard.md): the pure parts behind the e2e tests in dashboard-s6y.spec.ts.
 *   #1  the prompts watcher tells the Dashboard's own write (no full reload) from any other edit (reload)
 *   #7  one short time format for the Dashboard (prototype `11-21 15:58`), never the browser's en-US default
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { isPromptsSelfWrite, notePromptsSelfWrite } from '../../docs/.vitepress/plugins/companionPromptsPlugin.mts'
import { shortDateTime } from '../../docs/.vitepress/theme/dashboard/dashboardData.ts'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dash-s6y-'))
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }))

describe('companion prompts watcher: own write vs. other edits (audit #1)', () => {
  it('the text the dev API wrote is recognised; any other text, file or a missing file is not', () => {
    const file = path.join(tmp, 'companion.json')
    const text = '{"version":3}\n'
    notePromptsSelfWrite(file, text)
    expect(isPromptsSelfWrite(file, text)).toBe(true)
    expect(isPromptsSelfWrite(file, '{"version":4}\n')).toBe(false) // edited in an editor afterwards
    expect(isPromptsSelfWrite(path.join(tmp, 'other.json'), text)).toBe(false)
    expect(isPromptsSelfWrite(file, null)).toBe(false) // deleted / unreadable
  })
})

describe('Dashboard short time (audit #7, prototype `11-21 15:58`)', () => {
  it('formats MM-DD HH:mm in local time and passes through what is not a date', () => {
    const d = new Date(2026, 10, 21, 15, 58, 13)
    expect(shortDateTime(d.toISOString())).toBe('11-21 15:58')
    expect(shortDateTime(d.getTime())).toBe('11-21 15:58')
    expect(shortDateTime('not a date')).toBe('not a date')
  })
  it('never produces the en-US form (no AM/PM, no slashes)', () => {
    expect(shortDateTime(new Date(2026, 0, 2, 21, 4).toISOString())).toBe('01-02 21:04')
  })
})

// S6Y decision (limits read-only): the client's fallback table must match what the dev API reads from server/.env
describe('reader limit defaults shown without runtime numbers', () => {
  it('equals LIMIT_KEYS of the dev API', async () => {
    const { LIMIT_KEYS } = await import('../../docs/.vitepress/plugins/dashboardDevExtras.mts')
    const { READER_LIMIT_DEFAULTS } = await import('../../docs/.vitepress/theme/dashboard/dashboardData.ts')
    expect(READER_LIMIT_DEFAULTS).toEqual(LIMIT_KEYS.map((k) => ({ ...k })))
  })
})

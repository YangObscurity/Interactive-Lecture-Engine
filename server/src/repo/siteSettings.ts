import type { Db, DbClient } from '../db/types.js'

export const RESERVED_DOMAIN_SETTING_KEYS: ReadonlySet<string> = new Set([
  'access',
  'texts',
  'look',
  'ai_tools',
  'companion_prompts',
  'last_check_report',
  'gateway_auth_seen',
])

export interface SiteSettingRow<T = unknown> {
  key: string
  value: T
  updated_by: string
  updated_at: string
}

export interface SiteSettingHistoryRow<T = unknown> {
  id: string
  setting_key: string
  previous_value: T | null
  new_value: T
  updated_by: string
  updated_at: string
}

export async function getSetting<T>(db: DbClient, key: string): Promise<T | null> {
  const res = await db.query<{ value: T | null }>(
    `SELECT value FROM site_settings WHERE key = $1`,
    [key],
  )
  if (res.rowCount === 0 || !res.rows[0]) return null
  return res.rows[0].value ?? null
}

export async function setSetting<T>(
  db: Db,
  key: string,
  value: T,
  updatedBy = 'admin',
): Promise<void> {
  await db.tx(async (txClient) => {
    // 1. Fetch current value
    const curRes = await txClient.query<{ value: unknown }>(
      `SELECT value FROM site_settings WHERE key = $1`,
      [key],
    )
    const prevVal = curRes.rowCount > 0 && curRes.rows[0] ? curRes.rows[0].value : null

    // 2. Upsert site_settings
    await txClient.query(
      `INSERT INTO site_settings (key, value, updated_by, updated_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (key) DO UPDATE
       SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = NOW()`,
      [key, JSON.stringify(value), updatedBy],
    )

    // 3. Insert history record
    await txClient.query(
      `INSERT INTO site_settings_history (setting_key, previous_value, new_value, updated_by, updated_at)
       VALUES ($1, $2, $3, $4, NOW())`,
      [key, prevVal !== null ? JSON.stringify(prevVal) : null, JSON.stringify(value), updatedBy],
    )
  })
}

export async function getSettingHistory(
  db: DbClient,
  key: string,
  limit = 20,
): Promise<SiteSettingHistoryRow[]> {
  const res = await db.query<SiteSettingHistoryRow>(
    `SELECT id, setting_key, previous_value, new_value, updated_by, updated_at
     FROM site_settings_history
     WHERE setting_key = $1
     ORDER BY updated_at DESC, id DESC
     LIMIT $2`,
    [key, limit],
  )
  return res.rows
}

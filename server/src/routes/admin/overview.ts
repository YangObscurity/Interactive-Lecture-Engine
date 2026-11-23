import type { Context } from 'hono'
import type { AppEnv } from '../../app.js'
import type { Db } from '../../db/types.js'

export function createAdminOverviewHandler(db: Db) {
  return async (c: Context<AppEnv>): Promise<Response> => {
    c.header('Cache-Control', 'no-store')
    c.header('Date', new Date().toUTCString())

    // 1. Totals
    const usersRes = await db.query<{ cnt: number }>(`
      SELECT COUNT(DISTINCT user_id)::int AS cnt FROM (
        SELECT user_id FROM progress
        UNION
        SELECT user_id FROM ai_sessions
        UNION
        SELECT user_id FROM ai_review_checklists
      ) u
    `)

    const progressRowsRes = await db.query<{ cnt: number }>(
      'SELECT COUNT(*)::int AS cnt FROM progress',
    )

    const completedLecturesRes = await db.query<{ cnt: number }>(
      "SELECT COUNT(*)::int AS cnt FROM progress WHERE status = '已完成'",
    )

    const sessionsRes = await db.query<{ cnt: number }>(
      'SELECT COUNT(*)::int AS cnt FROM ai_sessions',
    )

    const messagesRes = await db.query<{ cnt: number }>(
      'SELECT COUNT(*)::int AS cnt FROM ai_messages',
    )

    const checklistItemsRes = await db.query<{ cnt: number }>(
      'SELECT COUNT(*)::int AS cnt FROM ai_review_checklists',
    )

    const completedChecklistItemsRes = await db.query<{ cnt: number }>(
      'SELECT COUNT(*)::int AS cnt FROM ai_review_checklists WHERE is_completed = true',
    )

    // 2. By status
    const statusRowsRes = await db.query<{ status: string; cnt: number }>(
      'SELECT status, COUNT(*)::int AS cnt FROM progress GROUP BY status',
    )
    const byStatus: Record<string, number> = {
      未开始: 0,
      学习中: 0,
      已完成: 0,
    }
    for (const row of statusRowsRes.rows) {
      byStatus[row.status] = Number(row.cnt)
    }

    // 3. By group
    const byGroupRes = await db.query<{
      group_id: string
      total_rows: number
      completed: number
      in_progress: number
      not_started: number
    }>(`
      SELECT
        group_id,
        COUNT(*)::int AS total_rows,
        SUM(CASE WHEN status = '已完成' THEN 1 ELSE 0 END)::int AS completed,
        SUM(CASE WHEN status = '学习中' THEN 1 ELSE 0 END)::int AS in_progress,
        SUM(CASE WHEN status = '未开始' THEN 1 ELSE 0 END)::int AS not_started
      FROM progress
      GROUP BY group_id
      ORDER BY group_id ASC
    `)
    const byGroup = byGroupRes.rows.map((row) => ({
      group_id: row.group_id,
      total_rows: Number(row.total_rows ?? 0),
      completed: Number(row.completed ?? 0),
      in_progress: Number(row.in_progress ?? 0),
      not_started: Number(row.not_started ?? 0),
    }))

    // 4. Recent activity
    const progressActivityRes = await db.query<{ cnt: number }>(
      "SELECT COUNT(*)::int AS cnt FROM progress WHERE updated_at >= now() - interval '24 hours'",
    )
    const sessionsActivityRes = await db.query<{ cnt: number }>(
      "SELECT COUNT(*)::int AS cnt FROM ai_sessions WHERE created_at >= now() - interval '24 hours'",
    )
    const messagesActivityRes = await db.query<{ cnt: number }>(
      "SELECT COUNT(*)::int AS cnt FROM ai_messages WHERE created_at >= now() - interval '24 hours'",
    )

    const responseData = {
      generatedAt: new Date().toISOString(),
      totals: {
        users: Number(usersRes.rows[0]?.cnt ?? 0),
        progressRows: Number(progressRowsRes.rows[0]?.cnt ?? 0),
        completedLectures: Number(completedLecturesRes.rows[0]?.cnt ?? 0),
        sessions: Number(sessionsRes.rows[0]?.cnt ?? 0),
        messages: Number(messagesRes.rows[0]?.cnt ?? 0),
        checklistItems: Number(checklistItemsRes.rows[0]?.cnt ?? 0),
        completedChecklistItems: Number(completedChecklistItemsRes.rows[0]?.cnt ?? 0),
      },
      byStatus,
      byGroup,
      recentActivity: {
        progressUpdatedLast24h: Number(progressActivityRes.rows[0]?.cnt ?? 0),
        sessionsCreatedLast24h: Number(sessionsActivityRes.rows[0]?.cnt ?? 0),
        messagesCreatedLast24h: Number(messagesActivityRes.rows[0]?.cnt ?? 0),
      },
    }

    return c.json(responseData, 200)
  }
}

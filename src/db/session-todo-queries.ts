/**
 * SQL-side query for a single session's todo list (per-session todo panel).
 *
 * 口径（🟡 推断）：直接读 `todo` 表按 `session_id = ?` 收窄，行序按
 * `position ASC`（todo 表内 position 即用户在列表里摆放的顺序）。这里
 * **不做** `session_v2` 锚定：调用方传入的就是宿主给的真实 sessionID，
 * 孤儿排除不属于本查询的职责（与 session-outcome 的「全部会话口径」不同，
 * 那是跨会话聚合才需要的约束）。也不吃 `?session=`，因为它本身就是
 * 单会话视图。
 *
 * 返回空数组（不是 null）当且仅当 db 连接缺失或该会话没有 todo 行；
 * 契约上「空列表」与「无 db」在调用方看来都是「没有可展示的 todo」。
 *
 * 同步 API（node:sqlite 的 prepare/all 都是同步的），不返回 Promise。
 */

import type { SqliteReadConnection } from "./types.ts"
import { asRecord, coerceNumber, coerceText } from "./rows.ts"

/**
 * One todo row of a session, raw wire values (no status normalization: the
 * caller decides how to bucket unknown statuses). `time_created` /
 * `time_updated` are epoch-ms (or 0 when the column is missing/unusable).
 */
export interface SessionTodoItem {
  readonly content: string
  /** 原始 status 值，不做规范化——未知值交由上层 stats 层防御。 */
  readonly status: string
  readonly priority: string
  readonly position: number
  readonly timeCreated: number
  readonly timeUpdated: number
}

/**
 * The todo list of one session, ordered by position ascending. 列名已在
 * 活库实测确认（content / status / priority / position / time_created /
 * time_updated / session_id）。
 */
const SESSION_TODO_ITEMS_SQL = `
  SELECT content, status, priority, position, time_created, time_updated
  FROM todo
  WHERE session_id = ?
  ORDER BY position ASC`

/**
 * Query the todo rows of `sessionId`. Returns `[]` when the db connection is
 * missing (never null) or when the session has no todo rows.
 */
export function querySessionTodos(
  db: SqliteReadConnection | null,
  sessionId: string,
): SessionTodoItem[] {
  if (db === null) return []

  const rawRows = db.prepare(SESSION_TODO_ITEMS_SQL).all(sessionId)
  const todoItems: SessionTodoItem[] = []
  for (const rawRow of rawRows) {
    const rowRecord = asRecord(rawRow)
    if (rowRecord === null) continue
    todoItems.push({
      content: coerceText(rowRecord["content"]),
      status: coerceText(rowRecord["status"]),
      priority: coerceText(rowRecord["priority"]),
      position: coerceNumber(rowRecord["position"]),
      timeCreated: coerceNumber(rowRecord["time_created"]),
      timeUpdated: coerceNumber(rowRecord["time_updated"]),
    })
  }
  return todoItems
}

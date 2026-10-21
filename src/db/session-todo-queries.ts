/**
 * SQL-side query for a single session's todo list (per-session todo panel).
 *
 * 口径：直接读 `todo` 表按 `session_id = ?` 收窄，行序按
 * `position ASC`（todo 表内 position 即用户在列表里摆放的顺序）。
 *
 * **为什么这里仍然锚定 `session_v2`（事实纠正，别再改回去）**：早先的注释写
 * 「孤儿排除不属于本查询的职责，因为调用方传入的就是宿主给的真实
 * sessionID」——这个论证是错的，错在它假设本查询会继承 `session_v2`
 * 的删除。实测 DDL：
 *
 *   CONSTRAINT fk_todo_session_id_session_id_fk FOREIGN KEY (session_id)
 *     REFERENCES `session`(`id`) ON DELETE CASCADE
 *
 * 外键指向的是**旧表 `session`**，不是 `session_v2`。因此只要 `session` 行还在，
 * 而同一 id 已从 `session_v2` 消失，此会话的 todo 行就会留下——真实库里
 * `session` 确实有 2 行不在 `session_v2`（目前这两行 todos=0，尚无可见症状）。
 * 不看锚定的话，这类 id 会让侧栏渲染出 Todos 块、回放页却报「旧表会话 404」，
 * 同一个 id 两处意见相反，且 1s 轮询让它一直挂着。
 *
 * 不做 `session_v2` 锚定不是「职责划分」问题，而是会造成上面那个不一致，
 * 所以查询里显式加上 `session_id IN (SELECT id FROM session_v2)`。
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
    AND session_id IN (SELECT id FROM session_v2)
  ORDER BY position ASC`

/** 不含锚定的退化版本：仅用于库里没有 `session_v2` 表的旧库 / 测试夹具。 */
const SESSION_TODO_ITEMS_SQL_WITHOUT_ANCHOR = `
  SELECT content, status, priority, position, time_created, time_updated
  FROM todo
  WHERE session_id = ?
  ORDER BY position ASC`

/**
 * Query the todo rows of `sessionId`. Returns `[]` when the db connection is
 * missing (never null) or when the session has no todo rows.
 *
 * 旧库 / 夹具没有 `session_v2` 表时，锚定查询会抛 `no such table`：此时退回
 * 不带锚定的版本，让侧栏照旧工作。宁可少一层防御，也不要因为一张表和侧栏
 * 一起崩——这是 per-session view 的既有姿态。
 */
export function querySessionTodos(
  db: SqliteReadConnection | null,
  sessionId: string,
): SessionTodoItem[] {
  if (db === null) return []

  let rawRows: unknown[]
  try {
    rawRows = db.prepare(SESSION_TODO_ITEMS_SQL).all(sessionId)
  } catch {
    // 表不存在的退化路径：见上方注释。
    rawRows = db.prepare(SESSION_TODO_ITEMS_SQL_WITHOUT_ANCHOR).all(sessionId)
  }
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

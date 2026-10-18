/**
 * SQL-side query for GET /api/session-outcomes (v0.22.0 B 档): how sessions
 * ended — clean vs interrupted — plus the error-type mix and the most recent
 * interrupted sessions.
 *
 * 全部会话口径，锚定 session_v2：所有会话级计数都限定
 * `session_id IN (SELECT id FROM session_v2)`，把孤儿消息（会话已删、消息
 * 残留）排除在外，与 v0.21.0 三个分布同锚（真库孤儿为 0，此约束只防未来
 * 不一致）。不吃 ?session=。
 *
 * 口径（🟡 推断）：
 * - sessionsWithSteps = 至少一条 assistant 行的会话数（纯行数谓词
 *   `type = 'assistant'`，无 JSON 解析，DISTINCT 会话去重），与
 *   /api/step-distribution 的「有步骤的会话」样本集合**同一口径**——那张卡
 *   也叫「有步骤的会话」，两处各写一套就会同名不同数（parity 由
 *   test/session-outcome.test.ts 锁定）。
 * - 一个会话「以错误收尾」当且仅当它最后一条 **object** assistant 消息
 *   （PARTITION BY session_id ORDER BY seq DESC 取 rn = 1）的 data 携带
 *   `$.error`。错误推断要 json_extract 一条合法 JSON 对象，故该 CTE 只保留
 *   `json_valid` 且 `json_type(data) = 'object'` 的 assistant 行：真库无
 *   非对象 assistant 行，所以「最后一条 object 消息」即「最后一条消息」；
 *   「只有非对象 assistant 行的会话」仍计入 sessionsWithSteps，只是永不判为
 *   收尾错误（边界见 parity 夹具）。
 * - interruptedSessions = 收尾行里 has_error 的会话数（⊆ sessionsWithSteps）。
 * - byErrorType 是**会话级**计数——每个收尾会话只贡献一次其**终局错误类型**
 *   （最后一条 assistant 消息的 `$.error.type`），故 Σ byErrorType.count ==
 *   interruptedSessions（终局错误缺 type 的收尾会话仍计入 interruptedSessions，
 *   但不进任何类型桶），按 count 降序 + type 升序。
 *
 * 返回 null 当且仅当 db 连接缺失（API 层统一答 503）；空库返回零载荷
 * （totalSessions 0），不是 null。
 */

import type { SqliteReadConnection } from "./types.ts"
import { asRecord, coerceNumber, coerceText, readRowNumber } from "./rows.ts"
import {
  buildSessionOutcomeStats,
  type RecentInterruptedSession,
  type SessionOutcomeErrorType,
  type SessionOutcomeStats,
} from "../stats/session-outcome.ts"

/** recentInterrupted 榜长（对齐卡片 MAX_RECENT_SESSIONS = 5，别再白传）。 */
const RECENT_INTERRUPTED_LIMIT = 5

/**
 * 「有步骤的会话」计数：至少一条 assistant 行的会话数，锚定 session_v2。
 * 与 /api/step-distribution 的样本集合同一口径——纯 type 等值谓词、
 * DISTINCT 会话去重、零 JSON 解析（步数分布也只做行计数），两处同名同数。
 */
const SESSIONS_WITH_STEPS_SQL = `
  SELECT COUNT(DISTINCT session_id) AS sessions_with_steps
  FROM session_message
  WHERE type = 'assistant'
    AND session_id IN (SELECT id FROM session_v2)`

/**
 * 每会话最后一条 assistant **对象**消息，JOIN session_v2 补展示字段：
 * - has_error = `$.error` 是否非 NULL（0/1），决定该会话是否以错误收尾；
 * - error_type / error_message 取自同一条消息（NULL 降级为 ""）；
 * - title 取 session_v2，time_updated 用于 recentInterrupted（排序键 + 展示值）。
 *
 * `ORDER BY seq DESC` 契约指定；PARTITION BY session_id 保证每个锚定会话
 * 恰一行（rn = 1）。json_extract 需要合法 JSON 对象，故只保留 object 行。
 */
const LAST_ASSISTANT_MESSAGE_SQL = `
  WITH ordered_last_assistant AS (
    SELECT session_id, data,
           ROW_NUMBER() OVER (PARTITION BY session_id ORDER BY seq DESC) AS row_rank
    FROM session_message
    WHERE type = 'assistant'
      AND json_valid(data) AND json_type(data) = 'object'
      AND session_id IN (SELECT id FROM session_v2)
  )
  SELECT l.session_id AS session_id,
         json_extract(l.data, '$.error') IS NOT NULL AS has_error,
         json_extract(l.data, '$.error.type') AS error_type,
         json_extract(l.data, '$.error.message') AS error_message,
         s.title AS title,
         s.time_updated AS session_time_updated
  FROM ordered_last_assistant l
  JOIN session_v2 s ON s.id = l.session_id
  WHERE l.row_rank = 1`

/** One last-assistant-message row for an interrupted session. */
interface InterruptedSessionRow {
  sessionId: string
  title: string
  errorType: string
  errorMessage: string
  /** session_v2.time_updated：recentInterrupted 的排序键（降序）兼展示值。 */
  timeUpdated: number
}

/**
 * Session outcome for GET /api/session-outcomes. Returns null when the db
 * connection is missing (the API layer surfaces that as the shared 503).
 */
export function querySessionOutcome(
  db: SqliteReadConnection | null,
): SessionOutcomeStats | null {
  if (db === null) return null

  const totalSessions = readRowNumber(
    db.prepare("SELECT COUNT(*) AS total_sessions FROM session_v2").get(),
    "total_sessions",
  )

  // 「有步骤的会话」走与步数分布同一口径的独立计数（见 SESSIONS_WITH_STEPS_SQL）。
  const sessionsWithSteps = readRowNumber(
    db.prepare(SESSIONS_WITH_STEPS_SQL).get(),
    "sessions_with_steps",
  )

  const lastAssistantRows = db.prepare(LAST_ASSISTANT_MESSAGE_SQL).all()

  let interruptedSessions = 0
  const interruptedRows: InterruptedSessionRow[] = []
  // 会话级终局错误类型计数：每个收尾会话仅贡献一次（其终局错误类型）。
  const errorTypeCountByType = new Map<string, number>()
  for (const rawRow of lastAssistantRows) {
    const rowRecord = asRecord(rawRow)
    if (rowRecord === null) continue
    // Every row is rn = 1: one terminal object message per anchored session.
    if (coerceNumber(rowRecord["has_error"]) === 0) continue
    interruptedSessions += 1
    const errorType = coerceText(rowRecord["error_type"])
    // 缺 type 的终局错误仍计入 interruptedSessions，但不进任何类型桶。
    if (errorType !== "") {
      errorTypeCountByType.set(errorType, (errorTypeCountByType.get(errorType) ?? 0) + 1)
    }
    interruptedRows.push({
      sessionId: coerceText(rowRecord["session_id"]),
      title: coerceText(rowRecord["title"]),
      errorType,
      errorMessage: coerceText(rowRecord["error_message"]),
      timeUpdated: coerceNumber(rowRecord["session_time_updated"]),
    })
  }

  // 最近错误收尾：按 time_updated 降序（与卡片展示的 timeUpdated 一致），
  // session_id 升序决胜（确定性），取前 RECENT_INTERRUPTED_LIMIT（= 5）。
  const recentInterrupted: RecentInterruptedSession[] = [...interruptedRows]
    .sort(
      (leftRow, rightRow) =>
        rightRow.timeUpdated - leftRow.timeUpdated ||
        (leftRow.sessionId < rightRow.sessionId ? -1 : leftRow.sessionId > rightRow.sessionId ? 1 : 0),
    )
    .slice(0, RECENT_INTERRUPTED_LIMIT)
    .map((interruptedRow) => ({
      sessionId: interruptedRow.sessionId,
      title: interruptedRow.title,
      errorType: interruptedRow.errorType,
      errorMessage: interruptedRow.errorMessage,
      timeUpdated: interruptedRow.timeUpdated,
    }))

  const errorTypeCounts: SessionOutcomeErrorType[] = []
  for (const [type, count] of errorTypeCountByType) {
    errorTypeCounts.push({ type, count })
  }

  return buildSessionOutcomeStats({
    totalSessions,
    sessionsWithSteps,
    interruptedSessions,
    errorTypeCounts,
    recentInterrupted,
  })
}

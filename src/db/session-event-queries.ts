/**
 * SQL-side query for GET /api/session/:id/events (A2/A3 会话事件):
 * the session's compaction / model-switched / system rows in seq order.
 *
 * 口径（冻结）：
 * - 只取 `type IN ('compaction', 'model-switched', 'system')` 三类；
 *   seq / time_created 直接取列。这三个 type 字符串此前没有任何 SQL 读取
 *   （本文件是第一个读者），全仓无共享常量，故此处用内联字面量。
 * - compaction：detail = json_extract(data, '$.reason')，用 json_valid
 *   AND IS NOT NULL 守卫（与 behavior-queries.ts 同形）；缺失 → "unknown"
 *   （复用 UNKNOWN_COMPACTION_REASON 语义）。
 * - model-switched：detail = `data.model.id → data.previous.id`。
 * - system：detail = data.text 的前若干字符（截断到安全长度）。
 * - 会话级扫描锚定 session_v2（SESSION_V2_ANCHOR_PREDICATE_SQL），把
 *   「会话已删、消息残留」的孤儿排除在外。
 *
 * 返回 null 当且仅当 db 连接缺失（API 层统一答 503）；会话不存在时由路由
 * 先做存在性探针答 404，本函数对不存在 / 无事件的会话都返回空数组。
 */

import type { SqliteReadConnection } from "./types.ts"
import { asRecord, coerceNumber, coerceText, UNKNOWN_MODEL_ID } from "./rows.ts"

/** 无可用 reason 的 compaction 行归入此桶（与 behavior-queries 同语义）。 */
const UNKNOWN_COMPACTION_REASON = "unknown"

/** system 事件 detail 的截断长度（按 code point，避免切断代理对）。 */
const SYSTEM_EVENT_DETAIL_MAX_LENGTH = 200

/**
 * 孤儿锚定：会话级消息扫描一律限定 session_id IN (SELECT id FROM session_v2)，
 * 与 tool-token-queries.ts / 各分布查询同锚。
 */
const SESSION_V2_ANCHOR_PREDICATE_SQL = "session_id IN (SELECT id FROM session_v2)"

/** 会话事件类型（wire type 列，仅这三类）。 */
export type SessionEventType = "compaction" | "model-switched" | "system"

/** One session event row of GET /api/session/:id/events. */
export interface SessionEventRecord {
  seq: number
  timeCreated: number
  type: SessionEventType
  /** compaction → reason；model-switched → "from → to"；system → 文本前缀。 */
  detail: string
}

/**
 * 从 json_extract 产物拼 model-switched 的 detail：`from → to`，缺失侧
 * 回退 "unknown"（用 rows.ts 的 UNKNOWN_MODEL_ID，与模型口径同占位符）。
 */
function buildModelSwitchDetail(
  switchedFromModel: unknown,
  switchedToModel: unknown,
): string {
  const fromModelId = coerceText(switchedFromModel) || UNKNOWN_MODEL_ID
  const toModelId = coerceText(switchedToModel) || UNKNOWN_MODEL_ID
  return `${fromModelId} → ${toModelId}`
}

/** 按 code point 截断文本，避免切断代理对（emoji）留下孤立高代理项。 */
function truncateDetailPrefix(detailText: string): string {
  if (detailText.length <= SYSTEM_EVENT_DETAIL_MAX_LENGTH) return detailText
  return [...detailText].slice(0, SYSTEM_EVENT_DETAIL_MAX_LENGTH).join("")
}

/**
 * All compaction / model-switched / system events of one session, ordered
 * by seq ascending. Returns null when the db connection is missing (the
 * API layer surfaces the shared 503); unknown / event-less sessions yield
 * an empty array.
 */
export function querySessionEvents(
  db: SqliteReadConnection | null,
  sessionId: string,
): SessionEventRecord[] | null {
  if (db === null) return null
  const rawRows = db
    .prepare(
      `SELECT seq,
              time_created,
              type,
              CASE
                WHEN json_valid(data) AND json_extract(data, '$.reason') IS NOT NULL
                  THEN json_extract(data, '$.reason')
                ELSE '${UNKNOWN_COMPACTION_REASON}'
              END AS compaction_reason,
              CASE WHEN json_valid(data) THEN json_extract(data, '$.model.id') END AS switched_to_model,
              CASE WHEN json_valid(data) THEN json_extract(data, '$.previous.id') END AS switched_from_model,
              CASE WHEN json_valid(data) THEN json_extract(data, '$.text') END AS system_text
       FROM session_message
       WHERE session_id = ?
         AND type IN ('compaction', 'model-switched', 'system')
         AND ${SESSION_V2_ANCHOR_PREDICATE_SQL}
       ORDER BY seq ASC`,
    )
    .all(sessionId)

  const sessionEvents: SessionEventRecord[] = []
  for (const rawRow of rawRows) {
    const rowRecord = asRecord(rawRow)
    if (rowRecord === null) continue
    const rawType = coerceText(rowRecord["type"])
    let eventType: SessionEventType
    let detail: string
    if (rawType === "compaction") {
      eventType = "compaction"
      detail = coerceText(rowRecord["compaction_reason"]) || UNKNOWN_COMPACTION_REASON
    } else if (rawType === "model-switched") {
      eventType = "model-switched"
      detail = buildModelSwitchDetail(
        rowRecord["switched_from_model"],
        rowRecord["switched_to_model"],
      )
    } else if (rawType === "system") {
      eventType = "system"
      detail = truncateDetailPrefix(coerceText(rowRecord["system_text"]))
    } else {
      // WHERE 已限定三类；防御性跳过任何意外 type。
      continue
    }
    sessionEvents.push({
      seq: coerceNumber(rowRecord["seq"]),
      timeCreated: coerceNumber(rowRecord["time_created"]),
      type: eventType,
      detail,
    })
  }
  return sessionEvents
}

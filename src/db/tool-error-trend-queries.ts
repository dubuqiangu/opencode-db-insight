/**
 * SQL-side query for GET /api/tool-error-trend (v0.22.0 B 档): tool call
 * counts and error counts bucketed per local day over every assistant
 * message of every session.
 *
 * The tool-part extraction (two-tier json_extract() fast pass vs the
 * json_each fallback, name resolution, non-string status → "unknown")
 * lives in the shared tool-part-extraction.ts module, which
 * GET /api/tool-health runs too — the two endpoints must agree on which
 * parts count as tool calls, or the Σ-conservation between their
 * tool-call totals silently breaks. This file keeps only its own sample
 * mapping (status + the message's time_created) and SQL.
 *
 * Unlike the leaderboard this scan also reads the message's time_created and
 * buckets each part into its local day (bucketDailyToolErrors, JS Date —
 * SQLite date() has no local timezone). The scan floor is the shared
 * days-pushdown with the +1-day DST slack (buildScanFloorEpochMs); rows the
 * slack lets through but that sit below the window are dropped JS-side by the
 * date-key map.
 *
 * 全部会话口径，锚定 session_v2：扫描限定
 * session_id IN (SELECT id FROM session_v2)，排除「会话已删、消息残留」的
 * 孤儿消息，与 v0.21.0 三个分布及 session-outcome-queries.ts 同锚（真库
 * 孤儿为 0，此约束只防未来不一致——否则与 tool-health 的分母/错误数会分叉）。
 * 不吃 ?session=。返回 null 当且仅当 db 连接缺失（API 层统一
 * 答 503）；空库返回零载荷（连续补零的日序列），不是 null。
 */

import type { SqliteReadConnection } from "./types.ts"
import { asRecord, coerceNumber } from "./rows.ts"
import { ASSISTANT_OBJECT_DATA_PREDICATE, buildScanFloorEpochMs } from "./scan-conventions.ts"
import {
  buildToolPartFieldPaths,
  extractToolParts,
  TOOL_PART_FAST_PATH_LIMIT,
} from "./tool-part-extraction.ts"
import { MAX_TREND_DAYS } from "../stats/daily-buckets.ts"
import {
  bucketDailyToolErrors,
  type ToolErrorSample,
  type ToolErrorTrendPoint,
} from "../stats/tool-error-trend.ts"

/**
 * 孤儿锚定：会话级消息扫描一律限定 session_id IN (SELECT id FROM session_v2)，
 * 把「会话已删、消息残留」的孤儿消息排除出「全部会话口径」——与 v0.21.0 三个
 * 分布及 session-outcome-queries.ts / tool-health-queries.ts 同锚。真库孤儿为
 * 0，此约束只防未来不一致。与本端点的 ?session=「不吃」口径各自独立：锚定只
 * 收敛样本全集，本端点不叠加任何会话过滤。
 */
const SESSION_V2_ANCHOR_PREDICATE_SQL = "session_id IN (SELECT id FROM session_v2)"

/** Payload of GET /api/tool-error-trend. */
export interface ToolErrorTrendStats {
  /** The bounded window actually used (0..MAX_TREND_DAYS). */
  days: number
  /** Consecutive local days, oldest → newest, ending today. */
  points: ToolErrorTrendPoint[]
}

/**
 * Tool error trend for GET /api/tool-error-trend?days=30, aggregated from one
 * assistant scan that never materializes message bodies or tool outputs.
 * days is clamped to 1..MAX_TREND_DAYS; a non-positive/non-finite days skips
 * the database and yields an empty series. Returns null when the db
 * connection is missing (the API layer surfaces that as the shared 503).
 */
export function queryToolErrorTrend(
  db: SqliteReadConnection | null,
  days: number = 30,
): ToolErrorTrendStats | null {
  if (db === null) return null

  const boundedDays =
    Number.isFinite(days) && days > 0 ? Math.min(Math.floor(days), MAX_TREND_DAYS) : 0
  if (boundedDays === 0) return { days: 0, points: bucketDailyToolErrors([], 0) }

  const scanFloorMs = buildScanFloorEpochMs(boundedDays)
  const rawRows = db
    .prepare(
      `SELECT time_created,
              CASE
                WHEN COALESCE(json_array_length(data, '$.content'), 0) <= ${TOOL_PART_FAST_PATH_LIMIT}
                THEN json_extract(data, ${buildToolPartFieldPaths().join(", ")})
                ELSE (SELECT json_group_array(json_extract(c.value, '$.type', '$.name', '$.tool', '$.state.status'))
                      FROM json_each(m.data, '$.content') c)
              END AS tool_part_fields
       FROM session_message m
       WHERE ${ASSISTANT_OBJECT_DATA_PREDICATE}
         AND ${SESSION_V2_ANCHOR_PREDICATE_SQL}
         AND time_created >= ?`,
    )
    .all(scanFloorMs)

  const toolErrorSamples: ToolErrorSample[] = []
  for (const rawRow of rawRows) {
    const rowRecord = asRecord(rawRow)
    if (rowRecord === null) continue
    const timeCreated = coerceNumber(rowRecord["time_created"])
    for (const toolPart of extractToolParts(rowRecord["tool_part_fields"])) {
      toolErrorSamples.push({ timeCreated, status: toolPart.status })
    }
  }

  return { days: boundedDays, points: bucketDailyToolErrors(toolErrorSamples, boundedDays) }
}

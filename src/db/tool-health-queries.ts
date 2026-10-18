/**
 * SQL-side query for GET /api/tool-health: per-tool success/error
 * counters over every tool call part of every assistant message.
 *
 * The two-tier tool-part extraction (fast-path json_extract() vs the
 * json_each fallback, name resolution, non-string status → "unknown")
 * lives in the shared tool-part-extraction.ts module, together with the
 * byte-identical extraction GET /api/tool-error-trend runs — both
 * endpoints must agree on which parts count as tool calls, or the
 * Σ-conservation between their tool-call totals silently breaks. The
 * agent-stats extraction stays deliberately independent (see that
 * module); this file keeps only its own sample mapping and SQL.
 */

import type { SqliteReadConnection } from "./types.ts"
import { asRecord } from "./rows.ts"
import {
  ASSISTANT_OBJECT_DATA_PREDICATE,
  buildSessionFilterSqlFragments,
} from "./scan-conventions.ts"
import {
  buildToolPartFieldPaths,
  extractToolParts,
  TOOL_PART_FAST_PATH_LIMIT,
} from "./tool-part-extraction.ts"
import {
  computeToolHealth,
  type ToolHealthSample,
  type ToolHealthStat,
} from "../stats/tool-health.ts"

/**
 * 孤儿锚定：会话级消息扫描一律限定 session_id IN (SELECT id FROM session_v2)，
 * 把「会话已删、消息残留」的孤儿消息排除出「全部会话口径」——与 v0.21.0 三个
 * 分布（session-distribution-queries.ts）及 session-outcome-queries.ts 同锚。
 * 真库孤儿为 0，此约束只防未来不一致（同为全部会话口径的卡片分母/错误数一旦
 * 无锚就会在有孤儿的库上分叉）。这是**无条件**口径锚定，与可选的 ?session=
 * 过滤互相独立：锚定收敛样本全集，?session= 只在全集内再选一个会话，二者
 * 不混用、各自成立。
 */
const SESSION_V2_ANCHOR_PREDICATE_SQL = "session_id IN (SELECT id FROM session_v2)"

/**
 * Per-tool health leaderboard for GET /api/tool-health, aggregated
 * from one assistant scan that never materializes message bodies or
 * tool outputs. Returns null when the db connection is missing (the
 * API layer surfaces that as the shared 503).
 *
 * 口径：全部会话、锚定 session_v2（见 SESSION_V2_ANCHOR_PREDICATE_SQL）。
 * v0.20.0 ?session= 过滤：sessionFilterId 非空时扫描再前置
 * session_id = ?（共享片段）——在锚定后的全集上只统计目标会话的工具调用。
 * 缺省不过滤。
 */
export function queryToolHealth(
  db: SqliteReadConnection | null,
  sessionFilterId: string | null = null,
): ToolHealthStat[] | null {
  if (db === null) return null
  const sessionFilter = buildSessionFilterSqlFragments(sessionFilterId)

  const rawRows = db
    .prepare(
      `SELECT CASE
                WHEN COALESCE(json_array_length(data, '$.content'), 0) <= ${TOOL_PART_FAST_PATH_LIMIT}
                THEN json_extract(data, ${buildToolPartFieldPaths().join(", ")})
                ELSE (SELECT json_group_array(json_extract(c.value, '$.type', '$.name', '$.tool', '$.state.status'))
                      FROM json_each(m.data, '$.content') c)
              END AS tool_part_fields
       FROM session_message m
       WHERE ${sessionFilter.stepPredicatePrefixSql}${ASSISTANT_OBJECT_DATA_PREDICATE}
         AND ${SESSION_V2_ANCHOR_PREDICATE_SQL}`,
    )
    .all(...(sessionFilter.sessionFilterId === null ? [] : [sessionFilter.sessionFilterId]))

  const toolHealthSamples: ToolHealthSample[] = []
  for (const rawRow of rawRows) {
    const rowRecord = asRecord(rawRow)
    if (rowRecord === null) continue
    toolHealthSamples.push(...extractToolParts(rowRecord["tool_part_fields"]))
  }

  return computeToolHealth(toolHealthSamples)
}

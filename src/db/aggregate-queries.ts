/**
 * SQL-side aggregation queries for the four statistics routes (P0-1).
 *
 * The previous pipeline materialized the whole `data` JSON of every
 * assistant message and aggregated in JS (~1s per scan at 25k rows, four
 * independent scans on first paint). Here SQLite does the extraction with
 * json_extract() so only small numeric/text fields ever cross into JS —
 * message bodies, reasoning passages and tool outputs are never selected.
 *
 * Field-for-field parity with the old JS aggregation is a hard requirement:
 * every predicate below mirrors what parseAssistantStepRow accepted
 * (assistant type + valid JSON object data), extraction values run through
 * the same coercions, and local-midnight "today" boundaries are computed
 * in JS and passed as parameters because SQLite date() has no local
 * timezone. Trend bucketing and per-model percentiles intentionally stay
 * in JS (they need the raw numeric sequences and the local-timezone
 * bucket keys), fed from lightweight numeric rows.
 */

import type { OverviewStats, SqliteReadConnection } from "./types.ts"
import {
  asRecord,
  coerceNumber,
  coerceText,
  parseExtractedFieldList,
  readAgentName,
  readRowNumber,
  UNKNOWN_MODEL_ID,
} from "./rows.ts"
import {
  ASSISTANT_OBJECT_DATA_PREDICATE,
  buildScanFloorEpochMs,
  buildSessionFilterSqlFragments,
  buildWindowStartEpochMs,
  DAY_MS,
} from "./scan-conventions.ts"
import { hitRate } from "../stats/hit-rate.ts"
import {
  bucketDailyTrend,
  MAX_TREND_DAYS,
  toLocalDateKey,
  type DailyTrendPoint,
  type DailyTrendSample,
} from "../stats/daily-buckets.ts"
import {
  attachPreviousWindowTokens,
  computeModelMetrics,
  type ModelMetric,
  type ModelMetricComparison,
  type ModelUsageSample,
} from "../stats/model-metrics.ts"
import {
  computeAgentStats,
  type AgentSessionMembershipSample,
  type AgentStat,
  type AgentStepUsageSample,
} from "../stats/agent-fingerprint.ts"

/**
 * Content arrays longer than this fall back to a json_each walk for tool
 * name extraction. Measured on a 24k-message opencode.db: 97% of assistant
 * messages carry ≤4 content parts and 100% carry ≤8, so the direct-path
 * fast pass below covers everything but a handful of rows while avoiding
 * json_each's per-part materialization entirely (that materialization —
 * serializing and re-parsing every content part including multi-KB tool
 * states — dominated the route at ~3.7s; the fast pass runs the same scan
 * in ~640ms). Correctness never depends on the bound: longer arrays take
 * the json_each branch, which sees every part.
 */
const TOOL_NAME_FAST_PATH_PART_LIMIT = 8

/**
 * SQL path list for the tool-name fast pass: [type, name, tool] for every
 * content index below TOOL_NAME_FAST_PATH_PART_LIMIT. Direct path lookups
 * walk the (parse-cached) JSON document and return only the small field
 * values — content parts are never serialized.
 */
function buildContentPartFieldPaths(): string {
  const partFieldPaths: string[] = []
  for (let partIndex = 0; partIndex < TOOL_NAME_FAST_PATH_PART_LIMIT; partIndex += 1) {
    partFieldPaths.push(
      `'$.content[${partIndex}].type'`,
      `'$.content[${partIndex}].name'`,
      `'$.content[${partIndex}].tool'`,
    )
  }
  return partFieldPaths.join(", ")
}

/**
 * Resolve tool names from one message's extracted part fields. The fast
 * pass yields a flat [type0, name0, tool0, type1, ...] list (missing
 * indices are null); the json_each fallback yields one [type, name, tool]
 * triple per part — flat() normalizes both to the same stride-3 walk.
 * Resolution mirrors parseAssistantStepRow exactly: only type==="tool"
 * parts count, "name" wins, an empty name falls back to the legacy "tool"
 * key, and a still-empty result is dropped.
 */
function extractToolNamesFromPartFields(rawPartFields: unknown): string[] {
  const partFields = parseExtractedFieldList(rawPartFields)
  const flatPartFields = partFields.length > 0 && Array.isArray(partFields[0])
    ? partFields.flat()
    : partFields
  const toolNames: string[] = []
  for (let fieldIndex = 0; fieldIndex + 2 < flatPartFields.length; fieldIndex += 3) {
    if (coerceText(flatPartFields[fieldIndex]) !== "tool") continue
    let toolName = coerceText(flatPartFields[fieldIndex + 1])
    if (toolName === "") toolName = coerceText(flatPartFields[fieldIndex + 2])
    if (toolName !== "") toolNames.push(toolName)
  }
  return toolNames
}

/**
 * KPI overview for GET /api/overview, aggregated from the same lightweight
 * extracted rows as the other three routes. A "step" is one assistant
 * message. This route deliberately does NOT sum tokens or compare
 * timestamps inside SQL: SQLite's numeric coercion prefix-parses JSON
 * text ("12abc" → 12) and turns booleans into 1, while the old JS
 * coerceNumber mapped both to 0 — and CAST(time_created AS REAL) had the
 * same prefix-parsing hazard for text-stored timestamps. Instead the
 * multi-path json_extract array is coerced value-by-value in JS and the
 * local-midnight "today" boundary is a toLocalDateKey comparison,
 * exactly like the old JS aggregation (P1-1 parity fix).
 *
 * v0.20.0 ?session= 过滤：sessionFilterId 非空时 step 扫描前置
 * session_id = ?（共享片段，见 scan-conventions），session_v2 的
 * COUNT/SUM 追加 WHERE id = ?——单会话视图的 KPI 只统计该会话
 * （sessionCount 退化为 1）。缺省不过滤，SQL 字节与现行全量口径
 * 一致。
 */
export function queryOverview(
  db: SqliteReadConnection | null,
  sessionFilterId: string | null = null,
): OverviewStats | null {
  if (db === null) return null
  const sessionFilter = buildSessionFilterSqlFragments(sessionFilterId)

  const rawRows = db
    .prepare(
      `SELECT time_created,
              json_extract(data, '$.tokens.input', '$.tokens.output', '$.tokens.cache.read') AS token_fields
       FROM session_message
       WHERE ${sessionFilter.stepPredicatePrefixSql}${ASSISTANT_OBJECT_DATA_PREDICATE}`,
    )
    .all(...(sessionFilter.sessionFilterId === null ? [] : [sessionFilter.sessionFilterId]))

  const todayDateKey = toLocalDateKey(Date.now())
  let stepCount = 0
  let totalTokens = 0
  let todayTokens = 0
  let todayCacheRead = 0
  let todayInput = 0

  for (const rawRow of rawRows) {
    const rowRecord = asRecord(rawRow)
    if (rowRecord === null) continue
    const [inputValue, outputValue, cacheReadValue] = parseExtractedFieldList(rowRecord["token_fields"])
    const tokenInput = coerceNumber(inputValue)
    const tokenOutput = coerceNumber(outputValue)
    const tokenCacheRead = coerceNumber(cacheReadValue)
    const stepTokens = tokenInput + tokenOutput + tokenCacheRead
    stepCount += 1
    totalTokens += stepTokens
    if (toLocalDateKey(coerceNumber(rowRecord["time_created"])) === todayDateKey) {
      todayTokens += stepTokens
      todayCacheRead += tokenCacheRead
      todayInput += tokenInput
    }
  }

  const sessionCountRow = db
    .prepare(`SELECT COUNT(*) AS sessionCount FROM session_v2${sessionFilter.sessionRowWhereSql}`)
    .get(...(sessionFilter.sessionFilterId === null ? [] : [sessionFilter.sessionFilterId]))
  const totalCostRow = db
    .prepare(`SELECT SUM(cost) AS totalCost FROM session_v2${sessionFilter.sessionRowWhereSql}`)
    .get(...(sessionFilter.sessionFilterId === null ? [] : [sessionFilter.sessionFilterId]))

  return {
    todayTokens,
    totalTokens,
    todayHitRate: hitRate(todayCacheRead, todayInput),
    sessionCount: readRowNumber(sessionCountRow, "sessionCount"),
    stepCount,
    totalCost: readRowNumber(totalCostRow, "totalCost"),
  }
}

/**
 * Daily trend series for GET /api/trend?days=30. SQL extracts only the
 * lightest numeric columns and prunes rows older than the window
 * (days pushdown); the local-timezone bucketing itself stays in
 * bucketDailyTrend (JS Date), which is why the series still matches the
 * old JS 口径 exactly. days <= 0 yields an empty series without touching
 * the database.
 *
 * v0.11.0 byModel: the same scan now also extracts `$.model.id` so
 * bucketDailyTrend can bucket per (day, model). The per-model token
 * 口径 is the SAME row-level assistant extraction as the point totals —
 * the same three token paths coerced value-by-value in JS — and NOT the
 * session_v2 session-summary columns (a session's v2 tokens belong to
 * the session's primary model only, and they keep the compaction-pruned
 * message-level history, so they never split per (day, model) like the
 * row-level extraction does). A missing or empty model id
 * maps to the shared "unknown" fallback exactly like
 * parseAssistantStepRow (rows.ts), so the SQL-side pipeline stays
 * field-for-field parity with the full-row JS pipeline (locked by
 * test/sql-aggregation-parity.test.ts).
 *
 * v0.20.0 ?session= 过滤：sessionFilterId 非空时 step 扫描前置
 * session_id = ?（共享片段）。单会话下序列自然退化为单点/少数点，
 * 后端不特判（面板显隐由前端管）。
 */
export function queryDailyTrend(
  db: SqliteReadConnection | null,
  days: number = 30,
  sessionFilterId: string | null = null,
): DailyTrendPoint[] | null {
  if (db === null) return null
  if (!Number.isFinite(days) || days <= 0) return []
  const boundedDays = Math.min(Math.floor(days), MAX_TREND_DAYS)
  const scanFloorMs = buildScanFloorEpochMs(boundedDays)
  const sessionFilter = buildSessionFilterSqlFragments(sessionFilterId)

  const rawRows = db
    .prepare(
      `SELECT time_created,
              json_extract(data, '$.model.id',
                                 '$.tokens.input', '$.tokens.output', '$.tokens.cache.read') AS trend_fields
       FROM session_message
       WHERE ${sessionFilter.stepPredicatePrefixSql}${ASSISTANT_OBJECT_DATA_PREDICATE} AND time_created >= ?`,
    )
    .all(
      ...(sessionFilter.sessionFilterId === null ? [] : [sessionFilter.sessionFilterId]),
      scanFloorMs,
    )

  const trendSamples: DailyTrendSample[] = []
  for (const rawRow of rawRows) {
    const rowRecord = asRecord(rawRow)
    if (rowRecord === null) continue
    const [modelIdValue, inputValue, outputValue, cacheReadValue] = parseExtractedFieldList(
      rowRecord["trend_fields"],
    )
    const rawModelId = coerceText(modelIdValue)
    trendSamples.push({
      timeCreated: coerceNumber(rowRecord["time_created"]),
      modelId: rawModelId === "" ? UNKNOWN_MODEL_ID : rawModelId,
      tokens: {
        input: coerceNumber(inputValue),
        cacheRead: coerceNumber(cacheReadValue),
        output: coerceNumber(outputValue),
      },
    })
  }
  return bucketDailyTrend(trendSamples, days)
}

/**
 * Per-model leaderboard for GET /api/models. SQL returns one lightweight
 * row per assistant message (timestamp + the extracted model and token
 * numbers); medians and p95 need the raw numeric sequences, so they stay
 * in computeModelMetrics (JS), exactly as before.
 *
 * Optional days window (?days=N on the route): when given, the scan
 * mirrors queryHourHeatmap's pushdown + reclaim pair — the SQL carries a
 * `time_created >= ?` floor with the shared +1-day DST slack
 * (buildScanFloorEpochMs), and the local-midnight window lower bound
 * (buildWindowStartEpochMs) is enforced JS-side so the slack rows above
 * the floor but below the window never land in a metric. days is clamped
 * to 1..MAX_TREND_DAYS like the trend/heatmap windows; undefined (or a
 * non-positive/non-finite value, which the route layer never passes)
 * keeps the historical full-history scan.
 *
 * v0.20.0 ?session= 过滤：sessionFilterId 非空时 step 扫描前置
 * session_id = ?（共享片段），排行的行只来自目标会话。缺省不过滤。
 *
 * 环比（windowOffset，B-part-2）：默认 0 = 现行窗口，SQL 与 JS 上下界
 * 逐字节不变（无上界，下界 = buildWindowStartEpochMs）。windowOffset=k≥1
 * 表示把同一 n 天窗口整体再往前挪 k 个窗口长度，取「上一等长窗口」——
 * floor/L 各回退 k*n 天，并新增排他上界 U_k = 当前窗口起点再回退
 * (k-1) 个窗口；只有带 days 的请求才有意义（days 未定时恒为 0）。
 */
export function queryModelMetrics(
  db: SqliteReadConnection | null,
  days?: number,
  sessionFilterId: string | null = null,
  windowOffset = 0,
): ModelMetric[] | null {
  if (db === null) return null

  const boundedDays =
    days !== undefined && Number.isFinite(days) && days > 0
      ? Math.min(Math.floor(days), MAX_TREND_DAYS)
      : undefined
  const scanFloorMs = boundedDays === undefined ? null : buildScanFloorEpochMs(boundedDays)
  const windowStartEpochMs = boundedDays === undefined ? null : buildWindowStartEpochMs(boundedDays)
  const sessionFilter = buildSessionFilterSqlFragments(sessionFilterId)

  // 环比整窗平移：windowOffset=k≥1 时 floor/L 各回退 k*n 天，并给出排他
  // 上界 U_k（当前窗口起点再回退 k-1 个窗口）。k=0 时三者保持现行值、
  // 上界为 null——SQL 与 JS 逐字节不变（缺省逐字节不变契约）。
  let shiftedScanFloorMs = scanFloorMs
  let shiftedWindowStartMs = windowStartEpochMs
  let exclusiveWindowEndMs: number | null = null
  if (
    boundedDays !== undefined &&
    scanFloorMs !== null &&
    windowStartEpochMs !== null &&
    Number.isFinite(windowOffset) &&
    windowOffset > 0
  ) {
    const windowOffsetSteps = Math.floor(windowOffset)
    const offsetSpanMs = windowOffsetSteps * boundedDays * DAY_MS
    shiftedScanFloorMs = scanFloorMs - offsetSpanMs
    shiftedWindowStartMs = windowStartEpochMs - offsetSpanMs
    exclusiveWindowEndMs = windowStartEpochMs - (windowOffsetSteps - 1) * boundedDays * DAY_MS
  }

  const sqlFloorClause = shiftedScanFloorMs === null ? "" : " AND time_created >= ?"
  const sqlCeilingClause = exclusiveWindowEndMs === null ? "" : " AND time_created < ?"

  const rawRows = db
    .prepare(
      `SELECT time_created,
              json_extract(data, '$.model.id', '$.model.providerID', '$.model.variant',
                                '$.tokens.input', '$.tokens.output', '$.tokens.reasoning',
                                '$.tokens.cache.read', '$.tokens.cache.write') AS usage_fields
       FROM session_message
       WHERE ${sessionFilter.stepPredicatePrefixSql}${ASSISTANT_OBJECT_DATA_PREDICATE}${sqlFloorClause}${sqlCeilingClause}`,
    )
    .all(
      ...(sessionFilter.sessionFilterId === null ? [] : [sessionFilter.sessionFilterId]),
      ...(shiftedScanFloorMs === null ? [] : [shiftedScanFloorMs]),
      ...(exclusiveWindowEndMs === null ? [] : [exclusiveWindowEndMs]),
    )

  const modelSamples: ModelUsageSample[] = []
  for (const rawRow of rawRows) {
    const rowRecord = asRecord(rawRow)
    if (rowRecord === null) continue
    const timeCreated = coerceNumber(rowRecord["time_created"])
    // Reclaim the floor's +1-day DST slack: steps older than the local
    // midnight of the window's oldest day drop out here, so a days=7
    // leaderboard counts exactly 7 local days — not 8.
    if (shiftedWindowStartMs !== null && timeCreated < shiftedWindowStartMs) continue
    // 环比的排他上界（仅 windowOffset≥1 存在）：落在本窗口起点及以后的
    // step 属于更晚的窗口，必须剔除，否则相邻窗口会重复计数。
    if (exclusiveWindowEndMs !== null && timeCreated >= exclusiveWindowEndMs) continue
    const [
      modelIdValue,
      providerIdValue,
      variantValue,
      inputValue,
      outputValue,
      reasoningValue,
      cacheReadValue,
      cacheWriteValue,
    ] = parseExtractedFieldList(rowRecord["usage_fields"])
    const modelId = coerceText(modelIdValue)
    modelSamples.push({
      timeCreated,
      modelId: modelId === "" ? UNKNOWN_MODEL_ID : modelId,
      providerId: coerceText(providerIdValue),
      variant: coerceText(variantValue),
      tokens: {
        input: coerceNumber(inputValue),
        output: coerceNumber(outputValue),
        reasoning: coerceNumber(reasoningValue),
        cacheRead: coerceNumber(cacheReadValue),
        cacheWrite: coerceNumber(cacheWriteValue),
      },
    })
  }
  return computeModelMetrics(modelSamples)
}

/**
 * 模型排行榜的环比载荷（GET /api/models）：在现行窗口榜行上逐行附上
 * 「上一等长窗口」的同键 token 合计（previousTokens，环比基数）。
 *
 * - db 为空 → null（与其余聚合一致）；
 * - days 未定义（全历史）→ 没有「上一等长窗口」，直接返回现行行、
 *   previousTokens 一律 0（前端渲染 "— 环比"）；
 * - 否则 current = 现行窗口，previous = windowOffset=1 的等长前一窗口，
 *   用 attachPreviousWindowTokens 按复合键对齐。
 *
 * 注意：offset=0 的 queryModelMetrics 结果与改动前逐字节一致（parity
 * 测试锁），缺省逐字节不变契约由 queryModelMetrics 自身保证。
 */
export function queryModelMetricsComparison(
  db: SqliteReadConnection | null,
  days: number | undefined,
  sessionFilterId: string | null = null,
): ModelMetricComparison[] | null {
  if (db === null) return null
  const currentMetrics = queryModelMetrics(db, days, sessionFilterId)
  if (currentMetrics === null) return null
  if (days === undefined) {
    // 全历史无前一等长窗口可比：环比基数归 0。
    return currentMetrics.map((currentMetric) => ({ ...currentMetric, previousTokens: 0 }))
  }
  const previousMetrics = queryModelMetrics(db, days, sessionFilterId, 1)
  return attachPreviousWindowTokens(currentMetrics, previousMetrics ?? [])
}

/**
 * Per-agent usage and tool fingerprint for GET /api/agents (P0-1).
 *
 * Membership rows come from session_v2 as before. Usage and tool names are
 * extracted from ONE combined assistant scan that never materializes
 * message bodies, reasoning passages or tool outputs:
 * - per message, one multi-path json_extract returns [agent, tokens.input,
 *   tokens.output, tokens.cache.read] — the same values the old JS parser
 *   coerced, so the shared computeAgentStats keeps both pipelines' 口径
 *   identical;
 * - tool names per message come from a two-tier extraction (see
 *   TOOL_NAME_FAST_PATH_PART_LIMIT below): direct path lookups for the
 *   short content arrays that dominate real data, json_each only for the
 *   rare long arrays.
 *
 * v0.20.0 ?session= 过滤：membership 扫描（session_v2）追加 WHERE id = ?，
 * step 扫描（session_message）前置 session_id = ?（共享片段）——榜上
 * 只剩目标会话归属的 agent，单会话下通常一个 agent，自然退化不特判。
 */
export function queryAgentStats(
  db: SqliteReadConnection | null,
  sessionFilterId: string | null = null,
): AgentStat[] | null {
  if (db === null) return null
  const sessionFilter = buildSessionFilterSqlFragments(sessionFilterId)

  const rawSessionRows = db
    .prepare(`SELECT id, agent FROM session_v2${sessionFilter.sessionRowWhereSql}`)
    .all(...(sessionFilter.sessionFilterId === null ? [] : [sessionFilter.sessionFilterId]))
  const memberships: AgentSessionMembershipSample[] = rawSessionRows.flatMap((rawRow): AgentSessionMembershipSample[] => {
    const rowRecord = asRecord(rawRow)
    if (rowRecord === null) return []
    return [{ agent: readAgentName(rowRecord["agent"]), sessionId: coerceText(rowRecord["id"]) }]
  })

  const rawMessageRows = db
    .prepare(
      `SELECT session_id,
              json_extract(data, '$.agent', '$.tokens.input', '$.tokens.output', '$.tokens.cache.read') AS usage_fields,
              CASE WHEN COALESCE(json_array_length(data, '$.content'), 0) <= ${TOOL_NAME_FAST_PATH_PART_LIMIT}
                   THEN json_extract(data, ${buildContentPartFieldPaths()})
                   ELSE (SELECT json_group_array(json_extract(c.value, '$.type', '$.name', '$.tool'))
                         FROM json_each(m.data, '$.content') c)
              END AS tool_part_fields
       FROM session_message m
       WHERE ${sessionFilter.stepPredicatePrefixSql}${ASSISTANT_OBJECT_DATA_PREDICATE}`,
    )
    .all(...(sessionFilter.sessionFilterId === null ? [] : [sessionFilter.sessionFilterId]))

  const stepUsageSamples: AgentStepUsageSample[] = []
  for (const rawRow of rawMessageRows) {
    const rowRecord = asRecord(rawRow)
    if (rowRecord === null) continue
    const [agentValue, inputValue, outputValue, cacheReadValue] = parseExtractedFieldList(
      rowRecord["usage_fields"],
    )
    stepUsageSamples.push({
      agent: readAgentName(agentValue),
      sessionId: coerceText(rowRecord["session_id"]),
      tokens: {
        input: coerceNumber(inputValue),
        output: coerceNumber(outputValue),
        cacheRead: coerceNumber(cacheReadValue),
      },
      toolNames: extractToolNamesFromPartFields(rowRecord["tool_part_fields"]),
    })
  }

  return computeAgentStats(memberships, stepUsageSamples)
}

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
  readAgentName,
  readRowNumber,
  UNKNOWN_MODEL_ID,
} from "./rows.ts"
import { hitRate } from "../stats/hit-rate.ts"
import {
  bucketDailyTrend,
  MAX_TREND_DAYS,
  type DailyTrendPoint,
  type DailyTrendSample,
} from "../stats/daily-buckets.ts"
import { computeModelMetrics, type ModelMetric, type ModelUsageSample } from "../stats/model-metrics.ts"
import {
  computeAgentStats,
  type AgentSessionMembershipSample,
  type AgentStat,
  type AgentStepUsageSample,
} from "../stats/agent-fingerprint.ts"

/** One day in milliseconds; only used for the trend scan floor. */
const DAY_MS = 24 * 60 * 60 * 1000

/**
 * Shared SQL predicate selecting exactly the rows the old JS pipeline
 * accepted as steps: assistant messages whose `data` is a valid JSON
 * object. Rows failing it were skipped by parseAssistantStepRow, so every
 * aggregate here must apply the same filter to stay comparable.
 */
const ASSISTANT_OBJECT_DATA_PREDICATE =
  "type = 'assistant' AND json_valid(data) AND json_type(data) = 'object'"

/**
 * Parse the JSON array text produced by the multi-path json_extract()
 * (one JSON parse per row, returning only the small extracted values).
 * Anything unexpected degrades to an empty list, i.e. all-zero tokens —
 * matching how the old parser degraded unparseable rows.
 */
function parseExtractedFieldList(rawFieldList: unknown): unknown[] {
  if (typeof rawFieldList !== "string") return []
  try {
    const parsedFields: unknown = JSON.parse(rawFieldList)
    return Array.isArray(parsedFields) ? parsedFields : []
  } catch {
    return []
  }
}

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
 * Local-timezone [start, next-day-start) window of the calendar day
 * containing nowMs. Computed in JS (never via SQL date(), which has no
 * local-timezone concept) so "today" matches toLocalDateKey exactly.
 */
function localDayWindowMs(nowMs: number): { dayStartMs: number; nextDayStartMs: number } {
  const nowDate = new Date(nowMs)
  const dayStart = new Date(nowDate.getFullYear(), nowDate.getMonth(), nowDate.getDate())
  const nextDayStart = new Date(nowDate.getFullYear(), nowDate.getMonth(), nowDate.getDate() + 1)
  return { dayStartMs: dayStart.getTime(), nextDayStartMs: nextDayStart.getTime() }
}

/**
 * KPI overview for GET /api/overview, aggregated in SQL. A "step" is one
 * assistant message. `today` is the local calendar day of the query time,
 * bounded by [midnight, next midnight) — identical to the old
 * toLocalDateKey comparison, including exclusion of clock-skewed future
 * rows. CAST(... AS REAL) keeps text-stored timestamps out of the today
 * sums the same way coerceNumber mapped them to 0 before.
 */
export function queryOverview(db: SqliteReadConnection | null): OverviewStats | null {
  if (db === null) return null
  const { dayStartMs, nextDayStartMs } = localDayWindowMs(Date.now())

  const usageRow = db
    .prepare(
      `SELECT
         COUNT(*) AS step_count,
         COALESCE(SUM(token_input + token_output + token_cache_read), 0) AS total_tokens,
         COALESCE(SUM(CASE WHEN CAST(time_created AS REAL) >= ? AND CAST(time_created AS REAL) < ?
                           THEN token_input + token_output + token_cache_read ELSE 0 END), 0) AS today_tokens,
         COALESCE(SUM(CASE WHEN CAST(time_created AS REAL) >= ? AND CAST(time_created AS REAL) < ?
                           THEN token_cache_read ELSE 0 END), 0) AS today_cache_read,
         COALESCE(SUM(CASE WHEN CAST(time_created AS REAL) >= ? AND CAST(time_created AS REAL) < ?
                           THEN token_input ELSE 0 END), 0) AS today_input
       FROM (
         SELECT time_created,
                COALESCE(json_extract(data, '$.tokens.input'), 0) AS token_input,
                COALESCE(json_extract(data, '$.tokens.output'), 0) AS token_output,
                COALESCE(json_extract(data, '$.tokens.cache.read'), 0) AS token_cache_read
         FROM session_message
         WHERE ${ASSISTANT_OBJECT_DATA_PREDICATE}
       )`,
    )
    .get(dayStartMs, nextDayStartMs, dayStartMs, nextDayStartMs, dayStartMs, nextDayStartMs)

  const sessionCountRow = db.prepare("SELECT COUNT(*) AS sessionCount FROM session_v2").get()
  const totalCostRow = db.prepare("SELECT SUM(cost) AS totalCost FROM session_v2").get()

  return {
    todayTokens: readRowNumber(usageRow, "today_tokens"),
    totalTokens: readRowNumber(usageRow, "total_tokens"),
    todayHitRate: hitRate(
      readRowNumber(usageRow, "today_cache_read"),
      readRowNumber(usageRow, "today_input"),
    ),
    sessionCount: readRowNumber(sessionCountRow, "sessionCount"),
    stepCount: readRowNumber(usageRow, "step_count"),
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
 */
export function queryDailyTrend(
  db: SqliteReadConnection | null,
  days: number = 30,
): DailyTrendPoint[] | null {
  if (db === null) return null
  if (!Number.isFinite(days) || days <= 0) return []
  const boundedDays = Math.min(Math.floor(days), MAX_TREND_DAYS)
  // One extra day of slack so the floor is always below the window start
  // even across DST transitions; rows outside the window are dropped by
  // the bucket date-key map anyway.
  const scanFloorMs = Date.now() - (boundedDays + 1) * DAY_MS

  const rawRows = db
    .prepare(
      `SELECT time_created,
              json_extract(data, '$.tokens.input', '$.tokens.output', '$.tokens.cache.read') AS token_fields
       FROM session_message
       WHERE ${ASSISTANT_OBJECT_DATA_PREDICATE} AND time_created >= ?`,
    )
    .all(scanFloorMs)

  const trendSamples: DailyTrendSample[] = []
  for (const rawRow of rawRows) {
    const rowRecord = asRecord(rawRow)
    if (rowRecord === null) continue
    const [inputValue, outputValue, cacheReadValue] = parseExtractedFieldList(rowRecord["token_fields"])
    trendSamples.push({
      timeCreated: coerceNumber(rowRecord["time_created"]),
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
 */
export function queryModelMetrics(db: SqliteReadConnection | null): ModelMetric[] | null {
  if (db === null) return null

  const rawRows = db
    .prepare(
      `SELECT time_created,
              json_extract(data, '$.model.id', '$.model.providerID',
                                '$.tokens.input', '$.tokens.output', '$.tokens.reasoning',
                                '$.tokens.cache.read', '$.tokens.cache.write') AS usage_fields
       FROM session_message
       WHERE ${ASSISTANT_OBJECT_DATA_PREDICATE}`,
    )
    .all()

  const modelSamples: ModelUsageSample[] = []
  for (const rawRow of rawRows) {
    const rowRecord = asRecord(rawRow)
    if (rowRecord === null) continue
    const [
      modelIdValue,
      providerIdValue,
      inputValue,
      outputValue,
      reasoningValue,
      cacheReadValue,
      cacheWriteValue,
    ] = parseExtractedFieldList(rowRecord["usage_fields"])
    const modelId = coerceText(modelIdValue)
    modelSamples.push({
      timeCreated: coerceNumber(rowRecord["time_created"]),
      modelId: modelId === "" ? UNKNOWN_MODEL_ID : modelId,
      providerId: coerceText(providerIdValue),
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
 */
export function queryAgentStats(db: SqliteReadConnection | null): AgentStat[] | null {
  if (db === null) return null

  const rawSessionRows = db.prepare("SELECT id, agent FROM session_v2").all()
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
       WHERE ${ASSISTANT_OBJECT_DATA_PREDICATE}`,
    )
    .all()

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

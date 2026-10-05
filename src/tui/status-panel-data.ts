/**
 * Data acquisition for the /insight-status panel (DESIGN.md §8, task T6.2).
 *
 * The panel talks to the query layer in-process (same approach as the
 * export command). One scan of the assistant messages feeds every panel
 * widget: today totals + hit rate, today's model TOP5 and the 7-day trend.
 *
 * Layering note: src/db/queries.ts keeps its fetchAssistantStepRows private
 * and exposes no per-model-today query, so this module issues the same
 * read-only statement and reuses the exported row parser and the stats
 * aggregation functions. Everything downstream stays pure.
 */

import type { AssistantStepRow, SqliteReadConnection } from "../db/types.ts"
import { asRecord, parseAssistantStepRow } from "../db/rows.ts"
import { computeModelMetrics } from "../stats/model-metrics.ts"
import { bucketDailyTrend, toLocalDateKey, type DailyTrendPoint } from "../stats/daily-buckets.ts"
import { hitRate, totalUsageTokens } from "../stats/hit-rate.ts"

/** How many models the panel leaderboard shows. */
export const STATUS_PANEL_MODEL_LIMIT = 5

/** How many days the panel trend chart covers. */
export const STATUS_PANEL_TREND_DAYS = 7

/** One model row of the panel leaderboard. */
export interface TodayModelUsage {
  modelId: string
  /** Σ input+output+cache.read of this model's steps today. */
  tokens: number
}

/** Everything one panel refresh needs, computed from a single scan. */
export interface StatusPanelData {
  todayTokens: number
  todayHitRate: number
  todayModelTopFive: TodayModelUsage[]
  weekTrend: DailyTrendPoint[]
}

/**
 * Collect the panel data from one read-only scan of assistant messages.
 * Returns null when the database is unavailable; database read errors
 * propagate so the controller can show its unavailable line.
 */
export function collectStatusPanelData(
  database: SqliteReadConnection | null,
  nowMs: number = Date.now(),
): StatusPanelData | null {
  if (database === null) return null

  const rawRows = database
    .prepare("SELECT id, session_id, time_created, data FROM session_message WHERE type = 'assistant'")
    .all()

  const stepRows: AssistantStepRow[] = []
  for (const rawRow of rawRows) {
    const rowRecord = asRecord(rawRow)
    if (rowRecord === null) continue
    const stepRow = parseAssistantStepRow(rowRecord)
    if (stepRow !== null) stepRows.push(stepRow)
  }

  const todayDateKey = toLocalDateKey(nowMs)
  const todayStepRows = stepRows.filter(
    (stepRow) => toLocalDateKey(stepRow.timeCreated) === todayDateKey,
  )

  let todayTokens = 0
  let todayCacheRead = 0
  let todayInput = 0
  for (const stepRow of todayStepRows) {
    todayTokens += totalUsageTokens(stepRow.tokens)
    todayCacheRead += stepRow.tokens.cacheRead
    todayInput += stepRow.tokens.input
  }

  const todayModelMetrics = computeModelMetrics(todayStepRows)
  return {
    todayTokens,
    todayHitRate: hitRate(todayCacheRead, todayInput),
    todayModelTopFive: todayModelMetrics
      .slice(0, STATUS_PANEL_MODEL_LIMIT)
      .map((modelMetric) => ({ modelId: modelMetric.modelId, tokens: modelMetric.tokens })),
    weekTrend: bucketDailyTrend(stepRows, STATUS_PANEL_TREND_DAYS),
  }
}

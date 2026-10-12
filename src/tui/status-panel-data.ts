/**
 * Data acquisition for the /insight-status dialog (DESIGN.md §8, task T6.2).
 *
 * The dialog talks to the query layer in-process (same approach as the
 * export command). One bounded scan of the assistant messages feeds every
 * dialog widget: today totals + hit rate, today's model TOP5 and the 7-day
 * trend. The scan goes through the exported queryAssistantStepRows, whose
 * sinceMs lower bound keeps the scan proportional to the trend window.
 *
 * (Historically written for the retired sidebar panel; the v0.16.0 dialog
 * redesign keeps the scan and its shape untouched.)
 */

import type { SqliteReadConnection } from "../db/types.ts"
import { queryAssistantStepRows } from "../db/queries.ts"
import { computeModelMetrics } from "../stats/model-metrics.ts"
import { bucketDailyTrend, toLocalDateKey, type DailyTrendPoint } from "../stats/daily-buckets.ts"
import { hitRate, totalUsageTokens } from "../stats/hit-rate.ts"

/** How many models the dialog leaderboard shows. */
export const STATUS_PANEL_MODEL_LIMIT = 5

/** How many days the dialog trend chart covers. */
export const STATUS_PANEL_TREND_DAYS = 7

/**
 * SQL lower bound for the dialog scan: the 7-day window covers the six days
 * before today plus today, so "now minus seven days" is always safely below
 * the window start while pruning everything older.
 */
const PANEL_SCAN_WINDOW_MS = STATUS_PANEL_TREND_DAYS * 24 * 60 * 60 * 1000

/** One model row of the dialog leaderboard. */
export interface TodayModelUsage {
  modelId: string
  /** Σ input+output+cache.read of this model's steps today. */
  tokens: number
}

/** Everything one dialog refresh needs, computed from a single scan. */
export interface StatusPanelData {
  todayTokens: number
  todayHitRate: number
  todayModelTopFive: TodayModelUsage[]
  weekTrend: DailyTrendPoint[]
}

/**
 * Collect the dialog data from one read-only scan of assistant messages.
 * Returns null when the database is unavailable; database read errors
 * propagate so the dialog lifecycle can show its unavailable copy.
 */
export function collectStatusPanelData(
  database: SqliteReadConnection | null,
  nowMs: number = Date.now(),
): StatusPanelData | null {
  if (database === null) return null

  const stepRows = queryAssistantStepRows(database, nowMs - PANEL_SCAN_WINDOW_MS) ?? []

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

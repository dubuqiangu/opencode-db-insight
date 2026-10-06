/**
 * Shared scan conventions for the SQL-side aggregation queries
 * (aggregate-queries.ts, behavior-queries.ts).
 *
 * Single source of truth for the assistant-step predicate and the
 * days-pushdown scan floor. Both query files must filter the exact same
 * rows and use the same window slack — cross-route conservation
 * (heatmap Σsteps === trend Σsteps for the same days) depends on it,
 * so drift here is a correctness bug, not a style issue.
 */

/** One day in milliseconds; only used for scan-window floors. */
export const DAY_MS = 24 * 60 * 60 * 1000

/**
 * Shared SQL predicate selecting exactly the rows the old JS pipeline
 * accepted as steps: assistant messages whose `data` is a valid JSON
 * object. Rows failing it were skipped by parseAssistantStepRow, so every
 * aggregate applying it stays comparable with the pre-SQL era (0.1.2
 * parity discipline).
 */
export const ASSISTANT_OBJECT_DATA_PREDICATE =
  "type = 'assistant' AND json_valid(data) AND json_type(data) = 'object'"

/**
 * SQL-side scan floor for a bounded day window (days pushdown): one
 * extra day of slack so the floor is always below the window start even
 * across DST transitions. The slack rows it lets through are dropped
 * JS-side by local-time window enforcement (the trend's date-key map,
 * the heatmap's window lower bound, compaction's recentDaily key map).
 */
export function buildScanFloorEpochMs(boundedDays: number): number {
  return Date.now() - (boundedDays + 1) * DAY_MS
}

/**
 * Local midnight of the oldest day inside a bounded day window — the
 * JS-side window lower bound, the same construction bucketDailyTrend
 * uses to generate its consecutive local date keys. Together with
 * buildScanFloorEpochMs it forms the pushdown + reclaim pair.
 */
export function buildWindowStartEpochMs(boundedDays: number): number {
  const todayLocalMidnight = new Date()
  todayLocalMidnight.setHours(0, 0, 0, 0)
  const windowStartDate = new Date(todayLocalMidnight.getTime())
  windowStartDate.setDate(windowStartDate.getDate() - (boundedDays - 1))
  return windowStartDate.getTime()
}

/**
 * Local-timezone daily bucketing for tool call errors
 * (GET /api/tool-error-trend, v0.22.0 B 档). Pure functions, zero IO.
 *
 * Same 口径 and key discipline as bucketDailyTrend
 * (src/stats/daily-buckets.ts): the SQL layer hands over one sample per
 * counted tool call part (its message's time_created plus the part's wire
 * status), and the day bucketing happens here in JS Date — never in SQL,
 * because SQLite date() has no local timezone (DESIGN.md §10).
 *
 * 口径: one sample = one tool call part of one assistant message, resolved
 * exactly like queryToolHealth (type === "tool", name wins over the legacy
 * "tool" key, an empty name drops the part, a non-string state.status maps
 * to "unknown"). Every sample counts towards toolCalls; only the wire
 * status "error" counts towards errors — so a day's errorRate is
 * errors / toolCalls, 0 when the day saw no tool calls.
 */

import { buildLocalDateKeys, toLocalDateKey } from "./daily-buckets.ts"

/** Wire status that counts as an error. */
export const TOOL_ERROR_STATUS = "error"

/** One local day of the tool-error trend series. */
export interface ToolErrorTrendPoint {
  /** Local timezone YYYY-MM-DD. */
  date: string
  /** Tool call parts observed on this local day. */
  toolCalls: number
  /** Tool call parts whose status is "error" on this local day. */
  errors: number
  /** errors / toolCalls, raw 0..1 fraction; 0 when toolCalls is 0. */
  errorRate: number
}

/**
 * One counted tool call part: the local-day timestamp of its message and
 * the part's status string (already coerced by the query layer — a
 * non-string state.status arrives as "unknown").
 */
export interface ToolErrorSample {
  timeCreated: number
  status: string
}

/**
 * Bucket tool call samples into a consecutive daily series ending today
 * (local timezone), oldest → newest, zero-filling inactive days so charts
 * get a continuous axis. Samples with invalid timestamps or outside the
 * window are excluded; days <= 0 yields an empty series; the window is
 * capped at MAX_TREND_DAYS.
 */
export function bucketDailyToolErrors(
  samples: ToolErrorSample[],
  days: number,
): ToolErrorTrendPoint[] {
  const dateKeys = buildLocalDateKeys(days)
  if (dateKeys.length === 0) return [] // non-finite/non-positive window: empty series

  const pointsByDate = new Map<string, ToolErrorTrendPoint>()
  for (const dateKey of dateKeys) {
    pointsByDate.set(dateKey, { date: dateKey, toolCalls: 0, errors: 0, errorRate: 0 })
  }

  for (const sample of samples) {
    const trendPoint = pointsByDate.get(toLocalDateKey(sample.timeCreated))
    if (trendPoint === undefined) continue // outside window or invalid timestamp
    trendPoint.toolCalls += 1
    if (sample.status === TOOL_ERROR_STATUS) trendPoint.errors += 1
  }

  const trendPoints: ToolErrorTrendPoint[] = []
  for (const dateKey of dateKeys) {
    const trendPoint = pointsByDate.get(dateKey)!
    trendPoint.errorRate = trendPoint.toolCalls > 0 ? trendPoint.errors / trendPoint.toolCalls : 0
    trendPoints.push(trendPoint)
  }
  return trendPoints
}

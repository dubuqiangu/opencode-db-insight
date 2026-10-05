/**
 * Local-timezone daily bucketing for the trend series (DESIGN.md §5 逐日趋势).
 * Pure functions, zero IO. Bucketing happens in JS Date (local timezone),
 * never in SQL — see DESIGN.md §10 "时区按运行机器本地时间分桶".
 */

import type { AssistantStepRow } from "../db/types.ts"
import { hitRate } from "./hit-rate.ts"

/** One day of the trend series returned by GET /api/trend. */
export interface DailyTrendPoint {
  /** Local timezone YYYY-MM-DD. */
  date: string
  steps: number
  input: number
  read: number
  output: number
  hitRate: number
}

/** Upper bound for the requested window, protects against absurd ?days= values. */
export const MAX_TREND_DAYS = 366

/** Format an epoch-ms timestamp as local YYYY-MM-DD. */
export function toLocalDateKey(epochMilliseconds: number): string {
  const localDate = new Date(epochMilliseconds)
  if (Number.isNaN(localDate.getTime())) return ""
  const year = localDate.getFullYear()
  const month = String(localDate.getMonth() + 1).padStart(2, "0")
  const dayOfMonth = String(localDate.getDate()).padStart(2, "0")
  return `${year}-${month}-${dayOfMonth}`
}

/**
 * Bucket assistant steps into a consecutive daily series ending today
 * (local timezone). Days without activity are zero-filled so charts get a
 * continuous axis. Samples older than the window and samples with invalid
 * timestamps are excluded; a window of days <= 0 yields an empty series.
 * Result is ordered oldest → newest.
 */
export function bucketDailyTrend(stepRows: AssistantStepRow[], days: number): DailyTrendPoint[] {
  if (!Number.isFinite(days) || days <= 0) return []
  const boundedDays = Math.min(Math.floor(days), MAX_TREND_DAYS)

  // Consecutive local date keys, oldest first, ending with today.
  const dateKeys: string[] = []
  const todayLocalMidnight = new Date()
  todayLocalMidnight.setHours(0, 0, 0, 0)
  for (let daysBack = boundedDays - 1; daysBack >= 0; daysBack -= 1) {
    const bucketDate = new Date(todayLocalMidnight.getTime())
    bucketDate.setDate(bucketDate.getDate() - daysBack)
    dateKeys.push(toLocalDateKey(bucketDate.getTime()))
  }

  const bucketsByDate = new Map<string, DailyTrendPoint>()
  for (const dateKey of dateKeys) {
    bucketsByDate.set(dateKey, { date: dateKey, steps: 0, input: 0, read: 0, output: 0, hitRate: 0 })
  }

  for (const stepRow of stepRows) {
    const bucket = bucketsByDate.get(toLocalDateKey(stepRow.timeCreated))
    if (bucket === undefined) continue // outside window or invalid timestamp
    bucket.steps += 1
    bucket.input += stepRow.tokens.input
    bucket.read += stepRow.tokens.cacheRead
    bucket.output += stepRow.tokens.output
  }

  const trendPoints: DailyTrendPoint[] = []
  for (const dateKey of dateKeys) {
    const bucket = bucketsByDate.get(dateKey)
    if (bucket === undefined) continue
    bucket.hitRate = hitRate(bucket.read, bucket.input)
    trendPoints.push(bucket)
  }
  return trendPoints
}

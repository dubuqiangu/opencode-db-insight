/**
 * Local-timezone daily bucketing for the trend series (DESIGN.md §5 逐日趋势).
 * Pure functions, zero IO. Bucketing happens in JS Date (local timezone),
 * never in SQL — see DESIGN.md §10 "时区按运行机器本地时间分桶".
 */

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
  /**
   * Per-model token buckets for THIS local day (v0.11.0): modelId → the
   * model's tokens on this day. 口径: input + read + output — the same
   * three assistant-row fields, the same JS coercions and the same
   * row-level extraction as the point totals above, NOT the session_v2
   * session-summary columns. Every model observed inside the window
   * appears in EVERY day's map, zero-filled on inactive days, so the
   * maps pivot 1:1 into the mock's `{ modelId, values[] }` series with
   * values aligned to the points (the mock is the pinned wire
   * contract, src/web/public/mock-data.js getMockTrend). Key order is
   * deterministic — see the pinned sort below.
   */
  byModel: Record<string, number>
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
 * Minimal per-step shape the daily bucketing needs. Deliberately structural:
 * the SQL-side lightweight trend rows satisfy it without carrying the full
 * AssistantStepRow, and full step rows keep satisfying it too.
 */
export interface DailyTrendSample {
  timeCreated: number
  /**
   * Model that produced the step (v0.11.0 byModel). Callers map a missing
   * or empty model id to the shared "unknown" fallback BEFORE bucketing —
   * the same mapping parseAssistantStepRow applies, so the SQL-side
   * pipeline and the full-row pipeline stay 口径-identical.
   */
  modelId: string
  tokens: { input: number; cacheRead: number; output: number }
}

/**
 * Bucket assistant steps into a consecutive daily series ending today
 * (local timezone). Days without activity are zero-filled so charts get a
 * continuous axis. Samples older than the window and samples with invalid
 * timestamps are excluded; a window of days <= 0 yields an empty series.
 * Result is ordered oldest → newest.
 *
 * v0.11.0 byModel: each point also carries per-model token buckets for
 * its day (Σ input+read+output per (day, model)). Aggregation stays in
 * JS by the existing discipline — SQLite numeric coercion would break
 * the old token 口径 (see aggregate-queries.ts) — so the per-model sums
 * reuse exactly the same coerced values the point totals are built
 * from, and Σ point.byModel === point.input + point.read + point.output
 * holds on every day by construction.
 */
export function bucketDailyTrend(sampleRows: DailyTrendSample[], days: number): DailyTrendPoint[] {
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
  const modelTokensByDate = new Map<string, Map<string, number>>()
  for (const dateKey of dateKeys) {
    bucketsByDate.set(dateKey, { date: dateKey, steps: 0, input: 0, read: 0, output: 0, hitRate: 0, byModel: {} })
    modelTokensByDate.set(dateKey, new Map())
  }

  for (const sampleRow of sampleRows) {
    const dateKey = toLocalDateKey(sampleRow.timeCreated)
    const bucket = bucketsByDate.get(dateKey)
    if (bucket === undefined) continue // outside window or invalid timestamp
    bucket.steps += 1
    bucket.input += sampleRow.tokens.input
    bucket.read += sampleRow.tokens.cacheRead
    bucket.output += sampleRow.tokens.output
    const modelTokens = modelTokensByDate.get(dateKey)!
    modelTokens.set(
      sampleRow.modelId,
      (modelTokens.get(sampleRow.modelId) ?? 0) +
        sampleRow.tokens.input +
        sampleRow.tokens.cacheRead +
        sampleRow.tokens.output,
    )
  }

  // Pinned model ordering (contract #3, v0.11.0): full-window token
  // total descending, modelId ascending lexicographic as the tie-break.
  // The frontend's stacked-layer order depends on this being a total
  // deterministic order; it is locked by test/daily-buckets.test.ts and
  // test/trend-by-model.test.ts.
  const windowTotalByModelId = new Map<string, number>()
  for (const modelTokens of modelTokensByDate.values()) {
    for (const [modelId, tokens] of modelTokens) {
      windowTotalByModelId.set(modelId, (windowTotalByModelId.get(modelId) ?? 0) + tokens)
    }
  }
  const orderedModelIds = [...windowTotalByModelId.keys()].sort(
    (leftModelId, rightModelId) => {
      const totalDifference =
        (windowTotalByModelId.get(rightModelId) ?? 0) -
        (windowTotalByModelId.get(leftModelId) ?? 0)
      if (totalDifference !== 0) return totalDifference
      return leftModelId < rightModelId ? -1 : leftModelId > rightModelId ? 1 : 0
    },
  )

  const trendPoints: DailyTrendPoint[] = []
  for (const dateKey of dateKeys) {
    const bucket = bucketsByDate.get(dateKey)
    if (bucket === undefined) continue
    // Dense per-point byModel in the pinned order: every window model on
    // every day, zero where the model had no activity that day.
    const modelTokens = modelTokensByDate.get(dateKey)!
    const denseByModel: Record<string, number> = {}
    for (const modelId of orderedModelIds) {
      denseByModel[modelId] = modelTokens.get(modelId) ?? 0
    }
    bucket.byModel = denseByModel
    bucket.hitRate = hitRate(bucket.read, bucket.input)
    trendPoints.push(bucket)
  }
  return trendPoints
}

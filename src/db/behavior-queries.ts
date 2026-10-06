/**
 * SQL-side queries for the v0.2-A behavior statistics routes:
 * hour heatmap, session survival and compaction stats.
 *
 * Same discipline as aggregate-queries.ts (P0-1): SQLite does the filtering
 * and grouping so only the lightest columns ever cross into JS — message
 * `data` bodies are never materialized except for tiny json_extract
 * scalars, and the window "days pushdown" (time_created >= ? floor
 * computed in JS) mirrors queryDailyTrend exactly, because SQLite
 * date() has no local timezone. Local-time bucketing itself stays in the
 * pure stats functions (src/stats/hour-heatmap.ts, session-survival.ts,
 * daily-buckets.ts toLocalDateKey 口径).
 */

import type { SqliteReadConnection } from "./types.ts"
import { asRecord, coerceNumber, coerceText } from "./rows.ts"
import {
  bucketStepsByHourAndWeekday,
  type HourWeekdayCell,
  type StepTimestampSample,
} from "../stats/hour-heatmap.ts"
import {
  computeSessionSurvival,
  type SessionLifetimeSample,
  type SessionSurvivalStats,
} from "../stats/session-survival.ts"
import { MAX_TREND_DAYS, toLocalDateKey } from "../stats/daily-buckets.ts"
import {
  ASSISTANT_OBJECT_DATA_PREDICATE,
  buildScanFloorEpochMs,
  buildWindowStartEpochMs,
} from "./scan-conventions.ts"

/** Bucket key for compaction rows whose data carries no usable reason. */
const UNKNOWN_COMPACTION_REASON = "unknown"

/** recentDaily window: the last 30 local days ending today. */
const COMPACTION_RECENT_DAILY_WINDOW_DAYS = 30

/** topSessions: the ten sessions with the most compaction rows. */
const COMPACTION_TOP_SESSION_LIMIT = 10

/**
 * Heatmap cells for GET /api/hour-heatmap?days=90. SQL selects only the
 * epoch-ms time_created of assistant steps above the scan floor (days
 * pushdown with the shared +1-day DST slack); the 7×24 local-time
 * bucketing itself happens in bucketStepsByHourAndWeekday, which also
 * enforces the window lower bound (local midnight of the oldest day) so
 * the slack rows above the floor but below the window never land in a
 * cell — otherwise the heatmap would silently count days+1 (P1-1).
 * days is clamped to 1..MAX_TREND_DAYS like the trend route; a window of
 * days <= 0 skips the database and yields the zero-filled 168-cell grid.
 */
export function queryHourHeatmap(
  db: SqliteReadConnection | null,
  days: number = 90,
): HourWeekdayCell[] | null {
  if (db === null) return null
  if (!Number.isFinite(days) || days <= 0) return bucketStepsByHourAndWeekday([])
  const boundedDays = Math.min(Math.floor(days), MAX_TREND_DAYS)
  const scanFloorMs = buildScanFloorEpochMs(boundedDays)
  const windowStartEpochMs = buildWindowStartEpochMs(boundedDays)

  const rawRows = db
    .prepare(
      `SELECT time_created
       FROM session_message
       WHERE ${ASSISTANT_OBJECT_DATA_PREDICATE} AND time_created >= ?`,
    )
    .all(scanFloorMs)

  const stepSamples: StepTimestampSample[] = []
  for (const rawRow of rawRows) {
    const rowRecord = asRecord(rawRow)
    if (rowRecord === null) continue
    stepSamples.push({ timeCreated: coerceNumber(rowRecord["time_created"]) })
  }
  return bucketStepsByHourAndWeekday(stepSamples, windowStartEpochMs)
}

/**
 * Survival stats for GET /api/session-survival. SQL reads exactly the
 * four session_v2 columns computeSessionSurvival needs; durations, the
 * median and the outcome bucketing stay in the pure function.
 */
export function querySessionSurvival(db: SqliteReadConnection | null): SessionSurvivalStats | null {
  if (db === null) return null

  const rawRows = db
    .prepare("SELECT id, time_created, time_updated, idle_outcome FROM session_v2")
    .all()

  const lifetimeSamples: SessionLifetimeSample[] = []
  for (const rawRow of rawRows) {
    const rowRecord = asRecord(rawRow)
    if (rowRecord === null) continue
    const rawIdleOutcome = rowRecord["idle_outcome"]
    lifetimeSamples.push({
      sessionId: coerceText(rowRecord["id"]),
      timeCreated: coerceNumber(rowRecord["time_created"]),
      timeUpdated: coerceNumber(rowRecord["time_updated"]),
      // null stays null (bucketed as "none" by the pure function); any
      // other shape degrades to text like the rest of the read layer.
      idleOutcome: rawIdleOutcome === null || rawIdleOutcome === undefined ? null : coerceText(rawIdleOutcome),
    })
  }
  return computeSessionSurvival(lifetimeSamples)
}

/** One local day of the compaction recentDaily series. */
export interface CompactionDailyCount {
  /** Local timezone YYYY-MM-DD (toLocalDateKey 口径). */
  dateKey: string
  count: number
}

/** One entry of the compaction topSessions leaderboard. */
export interface CompactionSessionCount {
  sessionId: string
  count: number
}

/** Payload for GET /api/compaction. */
export interface CompactionStats {
  total: number
  /** json_extract(data,'$.reason') → row count; missing/NULL → "unknown". */
  byReason: Record<string, number>
  /** Last 30 local days, zero-filled, oldest → newest. */
  recentDaily: CompactionDailyCount[]
  /** Top sessions by compaction row count, descending. */
  topSessions: CompactionSessionCount[]
}

/**
 * Compaction stats for GET /api/compaction, aggregated SQL-side from the
 * session_message rows with type = 'compaction' (wire data shape
 * {"status":"completed","reason":"auto","summary":"..."}):
 * - byReason: one GROUP BY pass with a json_extract on $.reason guarded
 *   by json_valid — missing/NULL reasons collapse to "unknown" inside
 *   SQL, and only (reason, count) pairs cross into JS;
 * - total: the sum of the byReason counts (no extra scan);
 * - recentDaily: the last 30 local days, zero-filled. Local-midnight
 *   keys cannot be produced by SQLite date(), so this one scan selects
 *   only time_created (with the same days-pushdown floor) and buckets
 *   in JS with toLocalDateKey — the daily-buckets 口径;
 * - topSessions: one GROUP BY session_id pass, count DESC with a
 *   session_id ASC tie-break so equal counts keep a stable order.
 */
export function queryCompactionStats(db: SqliteReadConnection | null): CompactionStats | null {
  if (db === null) return null

  const compactionPredicate = "type = 'compaction'"

  const reasonRows = db
    .prepare(
      `SELECT CASE
                WHEN json_valid(data) AND json_extract(data, '$.reason') IS NOT NULL
                  THEN json_extract(data, '$.reason')
                ELSE '${UNKNOWN_COMPACTION_REASON}'
              END AS reason_key,
              COUNT(*) AS reason_count
       FROM session_message
       WHERE ${compactionPredicate}
       GROUP BY reason_key`,
    )
    .all()

  const byReason: Record<string, number> = {}
  let total = 0
  for (const rawRow of reasonRows) {
    const rowRecord = asRecord(rawRow)
    if (rowRecord === null) continue
    const reasonKey = coerceText(rowRecord["reason_key"]) || UNKNOWN_COMPACTION_REASON
    const reasonCount = coerceNumber(rowRecord["reason_count"])
    byReason[reasonKey] = (byReason[reasonKey] ?? 0) + reasonCount
    total += reasonCount
  }

  const recentDailyFloorMs = buildScanFloorEpochMs(COMPACTION_RECENT_DAILY_WINDOW_DAYS)
  const timestampRows = db
    .prepare(
      `SELECT time_created
       FROM session_message
       WHERE ${compactionPredicate} AND time_created >= ?`,
    )
    .all(recentDailyFloorMs)

  // Consecutive local date keys, oldest first, ending with today — the
  // same key generation bucketDailyTrend uses.
  const recentDaily: CompactionDailyCount[] = []
  const countByDateKey = new Map<string, number>()
  const todayLocalMidnight = new Date()
  todayLocalMidnight.setHours(0, 0, 0, 0)
  for (let daysBack = COMPACTION_RECENT_DAILY_WINDOW_DAYS - 1; daysBack >= 0; daysBack -= 1) {
    const bucketDate = new Date(todayLocalMidnight.getTime())
    bucketDate.setDate(bucketDate.getDate() - daysBack)
    const dateKey = toLocalDateKey(bucketDate.getTime())
    recentDaily.push({ dateKey, count: 0 })
    countByDateKey.set(dateKey, 0)
  }
  for (const rawRow of timestampRows) {
    const rowRecord = asRecord(rawRow)
    if (rowRecord === null) continue
    const dateKey = toLocalDateKey(coerceNumber(rowRecord["time_created"]))
    // Keys outside the window (or from invalid timestamps → "") are dropped.
    if (!countByDateKey.has(dateKey)) continue
    countByDateKey.set(dateKey, (countByDateKey.get(dateKey) ?? 0) + 1)
  }
  for (const dailyEntry of recentDaily) {
    dailyEntry.count = countByDateKey.get(dailyEntry.dateKey) ?? 0
  }

  const topSessionRows = db
    .prepare(
      `SELECT session_id, COUNT(*) AS session_count
       FROM session_message
       WHERE ${compactionPredicate}
       GROUP BY session_id
       ORDER BY session_count DESC, session_id ASC
       LIMIT ${COMPACTION_TOP_SESSION_LIMIT}`,
    )
    .all()

  const topSessions: CompactionSessionCount[] = []
  for (const rawRow of topSessionRows) {
    const rowRecord = asRecord(rawRow)
    if (rowRecord === null) continue
    topSessions.push({
      sessionId: coerceText(rowRecord["session_id"]),
      count: coerceNumber(rowRecord["session_count"]),
    })
  }

  return { total, byReason, recentDaily, topSessions }
}

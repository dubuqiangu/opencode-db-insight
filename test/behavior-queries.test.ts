/**
 * Tests for the v0.2-A behavior-statistics queries (src/db/behavior-queries.ts)
 * against the fake insight database: hour heatmap (days clamp + 168-cell
 * zero fill), session survival (empty db, idle outcomes) and compaction
 * stats (reason missing/normal shape, recentDaily window, topSessions tie
 * stability).
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import { createRequire } from "node:module"

import {
  queryCompactionStats,
  queryHourHeatmap,
  querySessionSurvival,
} from "../src/db/behavior-queries.ts"
import { queryDailyTrend } from "../src/db/aggregate-queries.ts"
import { toLocalDateKey } from "../src/stats/daily-buckets.ts"
import type { SqliteReadConnection } from "../src/db/types.ts"
import {
  buildFakeSessionSummary,
  createFakeInsightDatabase,
  type FakeInsightDatabaseScenario,
} from "./helpers/fake-insight-db.ts"

const DAY_MS = 24 * 60 * 60 * 1000

function emptyScenario(): FakeInsightDatabaseScenario {
  return {
    sessions: [],
    messagesBySessionId: {},
    systemPromptBySessionId: {},
  }
}

/** A connection whose every statement fails; proves a code path never prepares. */
function refusingDatabase(): SqliteReadConnection {
  return {
    prepare: (sql: string): never => {
      throw new Error(`refusing database: unexpected SQL: ${sql}`)
    },
    close: () => {},
  }
}

// ---------------------------------------------------------------------------
// hour heatmap
// ---------------------------------------------------------------------------

test("queryHourHeatmap returns null when the db connection is missing", () => {
  assert.equal(queryHourHeatmap(null), null)
})

test("queryHourHeatmap returns a zero-filled 168-cell grid ordered weekday-outer, hour-inner", () => {
  const heatmapCells = queryHourHeatmap(createFakeInsightDatabase(emptyScenario()), 90)

  assert.notEqual(heatmapCells, null)
  assert.equal(heatmapCells!.length, 7 * 24)
  let expectedCellIndex = 0
  for (let weekday = 0; weekday < 7; weekday += 1) {
    for (let hour = 0; hour < 24; hour += 1) {
      const cell = heatmapCells![expectedCellIndex]
      assert.deepEqual(
        { weekday: cell.weekday, hour: cell.hour, steps: cell.steps },
        { weekday, hour, steps: 0 },
        `cell #${expectedCellIndex} must be the zero-filled ${weekday}/${hour} cell`,
      )
      expectedCellIndex += 1
    }
  }
})

test("queryHourHeatmap buckets one assistant step into its local weekday/hour cell", () => {
  // Pinned local time (no UTC components) so weekday/hour are TZ-stable:
  // 2026-10-05 15:30 local is a Monday afternoon.
  const pinnedStepTime = new Date(2026, 9, 5, 15, 30).getTime()
  const fakeDatabase = createFakeInsightDatabase({
    ...emptyScenario(),
    sessions: [buildFakeSessionSummary({ id: "ses_heatmap_step" })],
    messagesBySessionId: {
      ses_heatmap_step: [{ type: "assistant", data: { tokens: { input: 1 } }, timeCreated: pinnedStepTime }],
    },
  })

  const heatmapCells = queryHourHeatmap(fakeDatabase, 90)!

  assert.equal(heatmapCells.length, 168)
  const mondayCell = heatmapCells.find((cell) => cell.weekday === 1 && cell.hour === 15)
  assert.notEqual(mondayCell, undefined, "2026-10-05 15:30 local is Monday 15h")
  assert.equal(mondayCell!.steps, 1)
  const totalSteps = heatmapCells.reduce((sum, cell) => sum + cell.steps, 0)
  assert.equal(totalSteps, 1)
})

test("queryHourHeatmap respects the days window: old steps drop out, fresh ones stay", () => {
  const freshStepTime = Date.now() // "now" is always ≥ today's local midnight, hence inside the days=1 window
  // (a "one hour ago" anchor falls below the window start when the suite runs
  // between 00:00 and 01:00 local time and the fresh step would drop out).
  const staleStepTime = Date.now() - 10 * DAY_MS // ten days ago
  const fakeDatabase = createFakeInsightDatabase({
    ...emptyScenario(),
    sessions: [buildFakeSessionSummary({ id: "ses_heatmap_window" })],
    messagesBySessionId: {
      ses_heatmap_window: [
        { type: "assistant", data: {}, timeCreated: freshStepTime },
        { type: "assistant", data: {}, timeCreated: staleStepTime },
      ],
    },
  })

  const oneDayCells = queryHourHeatmap(fakeDatabase, 1)!
  const ninetyDayCells = queryHourHeatmap(fakeDatabase, 90)!

  assert.equal(oneDayCells.reduce((sum, cell) => sum + cell.steps, 0), 1, "days=1 keeps only the fresh step")
  assert.equal(ninetyDayCells.reduce((sum, cell) => sum + cell.steps, 0), 2, "days=90 keeps both steps")
})

test("queryHourHeatmap clamps absurd days to the 366-day trend bound without scanning everything", () => {
  const stepInsideBoundTime = Date.now() - 300 * DAY_MS // 300 days ago
  const stepBeyondAnyWindowTime = Date.now() - 400 * DAY_MS // 400 days ago
  const fakeDatabase = createFakeInsightDatabase({
    ...emptyScenario(),
    sessions: [buildFakeSessionSummary({ id: "ses_heatmap_clamp" })],
    messagesBySessionId: {
      ses_heatmap_clamp: [
        { type: "assistant", data: {}, timeCreated: stepInsideBoundTime },
        { type: "assistant", data: {}, timeCreated: stepBeyondAnyWindowTime },
      ],
    },
  })

  const clampedCells = queryHourHeatmap(fakeDatabase, 100_000)!

  // 100_000 days would include the 400-day-old step without the clamp.
  assert.equal(clampedCells.reduce((sum, cell) => sum + cell.steps, 0), 1)
})

test("queryHourHeatmap answers days <= 0 with the zero grid and never touches the db", () => {
  const heatmapCells = queryHourHeatmap(refusingDatabase(), 0)
  assert.equal(heatmapCells!.length, 168)
  assert.equal(heatmapCells!.every((cell) => cell.steps === 0), true)
})

/**
 * Cross-route conservation (审查盲区②): for the same days window the
 * heatmap's 168 cells must sum to exactly the trend's steps sum. The
 * heatmap SQL floor carries one extra day of DST slack — without a
 * JS-side window lower bound every row above the floor lands in a cell,
 * silently widening the window to days+1 (100% off at days=1).
 */
test("queryHourHeatmap step total conserves the trend step total for the same days", () => {
  const HOUR_MS = 60 * 60 * 1000
  const todayLocalMidnight = new Date()
  todayLocalMidnight.setHours(0, 0, 0, 0)

  const freshTodayTime = todayLocalMidnight.getTime() + 60_000
  // ~yesterday noon: above the days=1 SQL floor (now - 2d) but below the
  // window start (today's local midnight) — trend must drop it, so the
  // heatmap must drop it too.
  const staleOutsideWindowTime = todayLocalMidnight.getTime() - 12 * HOUR_MS
  // 80 days back: inside the 90-day window on both routes.
  const deepInsideWindowTime = todayLocalMidnight.getTime() - 80 * DAY_MS

  const fakeDatabase = createFakeInsightDatabase({
    ...emptyScenario(),
    sessions: [buildFakeSessionSummary({ id: "ses_conservation" })],
    messagesBySessionId: {
      ses_conservation: [
        { type: "assistant", data: {}, timeCreated: freshTodayTime },
        { type: "assistant", data: {}, timeCreated: staleOutsideWindowTime },
        { type: "assistant", data: {}, timeCreated: deepInsideWindowTime },
      ],
    },
  })

  const trendStepTotal = queryDailyTrend(fakeDatabase, 90)!
    .reduce((stepSum, trendPoint) => stepSum + trendPoint.steps, 0)
  const heatmapStepTotal = queryHourHeatmap(fakeDatabase, 90)!
    .reduce((stepSum, cell) => stepSum + cell.steps, 0)
  assert.equal(heatmapStepTotal, trendStepTotal, "days=90: heatmap and trend must count the same steps")

  const oneDayTrendTotal = queryDailyTrend(fakeDatabase, 1)!
    .reduce((stepSum, trendPoint) => stepSum + trendPoint.steps, 0)
  const oneDayHeatmapTotal = queryHourHeatmap(fakeDatabase, 1)!
    .reduce((stepSum, cell) => stepSum + cell.steps, 0)
  assert.equal(oneDayTrendTotal, 1, "days=1 trend window is today only (the fresh step)")
  assert.equal(oneDayHeatmapTotal, oneDayTrendTotal, "days=1: heatmap must not leak the slack-day rows")
})

// ---------------------------------------------------------------------------
// session survival
// ---------------------------------------------------------------------------

test("querySessionSurvival returns null when the db connection is missing", () => {
  assert.equal(querySessionSurvival(null), null)
})

test("querySessionSurvival reports zeroed stats for an empty session_v2", () => {
  const survivalStats = querySessionSurvival(createFakeInsightDatabase(emptyScenario()))

  assert.deepEqual(survivalStats, {
    totalSessions: 0,
    medianDurationSeconds: 0,
    shortLivedShare: 0,
    idleOutcomeCounts: {},
  })
})

test("querySessionSurvival aggregates durations, short-lived share and idle outcomes", () => {
  const minuteMs = 60_000
  const fakeDatabase = createFakeInsightDatabase({
    ...emptyScenario(),
    sessions: [
      buildFakeSessionSummary({ id: "ses_long_archived", timeCreated: 0, timeUpdated: 20 * minuteMs }),
      buildFakeSessionSummary({ id: "ses_medium_dismissed", timeCreated: 0, timeUpdated: 10 * minuteMs }),
      buildFakeSessionSummary({ id: "ses_short_null_outcome", timeCreated: 0, timeUpdated: 1 * minuteMs }),
    ],
    idleOutcomeBySessionId: {
      ses_long_archived: "archived",
      ses_medium_dismissed: "dismissed",
      ses_short_null_outcome: null,
    },
  })

  const survivalStats = querySessionSurvival(fakeDatabase)!

  assert.equal(survivalStats.totalSessions, 3)
  // Sorted durations [1, 10, 20] minutes, nearest-rank median = 10 minutes.
  assert.equal(survivalStats.medianDurationSeconds, 600)
  assert.equal(survivalStats.shortLivedShare, 1 / 3)
  assert.deepEqual(survivalStats.idleOutcomeCounts, { archived: 1, dismissed: 1, none: 1 })
})

// ---------------------------------------------------------------------------
// compaction stats
// ---------------------------------------------------------------------------

test("queryCompactionStats returns null when the db connection is missing", () => {
  assert.equal(queryCompactionStats(null), null)
})

test("queryCompactionStats counts reasons with the real wire shape and buckets missing reasons as unknown", () => {
  const fakeDatabase = createFakeInsightDatabase({
    ...emptyScenario(),
    compactionMessages: [
      {
        sessionId: "ses_compaction_auto",
        data: { status: "completed", reason: "auto", summary: "summary one" },
      },
      {
        sessionId: "ses_compaction_auto",
        data: { status: "completed", reason: "auto", summary: "summary two" },
      },
      // Real shape without a reason key → must land in "unknown".
      { sessionId: "ses_compaction_unlabeled", data: { status: "completed", summary: "no reason" } },
    ],
  })

  const compactionStats = queryCompactionStats(fakeDatabase)!

  assert.equal(compactionStats.total, 3)
  assert.deepEqual(compactionStats.byReason, { auto: 2, unknown: 1 })
})

test("queryCompactionStats recentDaily spans 30 zero-filled local days ascending and drops older rows", () => {
  const todayStepTime = Date.now()
  const outsideWindowStepTime = Date.now() - 40 * DAY_MS
  const fakeDatabase = createFakeInsightDatabase({
    ...emptyScenario(),
    compactionMessages: [
      { sessionId: "ses_compaction_today", timeCreated: todayStepTime, data: { reason: "auto" } },
      {
        sessionId: "ses_compaction_old",
        timeCreated: outsideWindowStepTime,
        data: { reason: "auto" },
      },
    ],
  })

  const compactionStats = queryCompactionStats(fakeDatabase)!

  assert.equal(compactionStats.recentDaily.length, 30)
  // Oldest → newest, consecutive local date keys ending today.
  for (let dayIndex = 0; dayIndex < compactionStats.recentDaily.length; dayIndex += 1) {
    const dailyEntry = compactionStats.recentDaily[dayIndex]
    const daysBack = compactionStats.recentDaily.length - 1 - dayIndex
    const expectedBucketDate = new Date()
    expectedBucketDate.setHours(0, 0, 0, 0)
    expectedBucketDate.setDate(expectedBucketDate.getDate() - daysBack)
    assert.equal(dailyEntry.dateKey, toLocalDateKey(expectedBucketDate.getTime()))
  }
  const todayEntry = compactionStats.recentDaily[compactionStats.recentDaily.length - 1]
  assert.equal(todayEntry.dateKey, toLocalDateKey(todayStepTime))
  assert.equal(todayEntry.count, 1, "only the row from today lands inside the 30-day window")
  const zeroedDays = compactionStats.recentDaily.filter((dailyEntry) => dailyEntry.count === 0)
  assert.equal(zeroedDays.length, 29)
  // Outside the window but still a compaction row: counted in total.
  assert.equal(compactionStats.total, 2)
})

test("queryCompactionStats ranks topSessions by count descending with a stable id tie-break", () => {
  const compactionFixtures = [
    { sessionId: "ses_c", data: { reason: "auto" } },
    { sessionId: "ses_c", data: { reason: "auto" } },
    { sessionId: "ses_c", data: { reason: "manual" } },
    { sessionId: "ses_b", data: { reason: "auto" } },
    { sessionId: "ses_b", data: { reason: "auto" } },
    { sessionId: "ses_a", data: { reason: "auto" } },
    { sessionId: "ses_a", data: { reason: "auto" } },
    { sessionId: "ses_d", data: { reason: "auto" } },
  ]
  const fakeDatabase = createFakeInsightDatabase({
    ...emptyScenario(),
    compactionMessages: compactionFixtures,
  })

  const compactionStats = queryCompactionStats(fakeDatabase)!

  // ses_a and ses_b tie at 2: the ascending session_id tie-break keeps
  // the order stable regardless of fixture order.
  assert.deepEqual(compactionStats.topSessions, [
    { sessionId: "ses_c", count: 3 },
    { sessionId: "ses_a", count: 2 },
    { sessionId: "ses_b", count: 2 },
    { sessionId: "ses_d", count: 1 },
  ])
  assert.equal(compactionStats.total, 8)
  assert.deepEqual(compactionStats.byReason, { auto: 7, manual: 1 })
})

/**
 * Weird reason shapes the wire could carry, asserted against BOTH the
 * fake database and an in-memory node:sqlite database. The expected map
 * follows real SQLite json_extract semantics (probed on the live
 * SQLite build): booleans → 0/1, numbers → numbers, objects → JSON
 * text; empty-string reason folds into "unknown" together with missing
 * reason, JSON null, non-object documents, invalid JSON and NULL data.
 */
const WEIRD_REASON_BY_REASON_EXPECTED: Record<string, number> = {
  "0": 1,
  "1": 1,
  "5": 1,
  '{"a":1}': 1,
  unknown: 3,
}

test("queryCompactionStats maps weird reason shapes the way the fake's SQLite semantics dictate", () => {
  const fakeDatabase = createFakeInsightDatabase({
    ...emptyScenario(),
    compactionMessages: [
      { sessionId: "ses_weird_reasons", data: { reason: false } },
      { sessionId: "ses_weird_reasons", data: { reason: true } },
      { sessionId: "ses_weird_reasons", data: { reason: 5 } },
      { sessionId: "ses_weird_reasons", data: { reason: "" } },
      { sessionId: "ses_weird_reasons", data: { reason: { a: 1 } } },
      { sessionId: "ses_weird_reasons", data: null },
      { sessionId: "ses_weird_reasons", data: { status: "completed", summary: "no reason key" } },
    ],
  })

  const compactionStats = queryCompactionStats(fakeDatabase)!

  assert.deepEqual(compactionStats.byReason, WEIRD_REASON_BY_REASON_EXPECTED)
  assert.equal(compactionStats.total, 7)
})

/**
 * The authoritative variant of the weird-shapes test: a real in-memory
 * SQLite database, which can also express rows the JSON.stringify-based
 * fake cannot — raw invalid JSON text and a SQL NULL data column.
 * Skipped when node:sqlite is unavailable (same fallback as the live
 * smoke tests).
 */
function createInMemoryCompactionDatabase(
  compactionRows: Array<{ sessionId: string; data: string | null }>,
): SqliteReadConnection | null {
  try {
    const requireNodeModule = createRequire(import.meta.url)
    const { DatabaseSync } = requireNodeModule("node:sqlite") as {
      DatabaseSync: new (databasePath: string) => {
        exec: (sql: string) => void
        prepare: (sql: string) => { run: (...parameters: unknown[]) => void }
        close: () => void
      }
    }
    const database = new DatabaseSync(":memory:")
    database.exec(
      "CREATE TABLE session_message (" +
        "id TEXT, session_id TEXT, type TEXT, seq INTEGER, " +
        "time_created REAL, time_updated REAL, data TEXT)",
    )
    const insertCompactionRow = database.prepare(
      "INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) " +
        "VALUES (?, ?, 'compaction', 0, 1000, 1000, ?)",
    )
    for (const [rowIndex, compactionRow] of compactionRows.entries()) {
      insertCompactionRow.run(`msg_weird_${rowIndex}`, compactionRow.sessionId, compactionRow.data)
    }
    // The connection exposes run() statements the read interface never
    // needs — the structural cast is safe because queryCompactionStats
    // only calls prepare().all() on SELECTs.
    return database as unknown as SqliteReadConnection
  } catch {
    return null
  }
}

test("queryCompactionStats follows real SQLite json_extract semantics for weird reason shapes", () => {
  const inMemoryDatabase = createInMemoryCompactionDatabase([
    { sessionId: "ses_weird_reasons", data: '{"status":"completed","reason":"auto","summary":"x"}' },
    { sessionId: "ses_weird_reasons", data: '{"reason":false}' },
    { sessionId: "ses_weird_reasons", data: '{"reason":true}' },
    { sessionId: "ses_weird_reasons", data: '{"reason":5}' },
    { sessionId: "ses_weird_reasons", data: '{"reason":""}' },
    { sessionId: "ses_weird_reasons", data: '{"reason":{"a":1}}' },
    { sessionId: "ses_weird_reasons", data: "not valid json {{" },
    { sessionId: "ses_weird_reasons", data: null },
    { sessionId: "ses_weird_reasons", data: '{"status":"completed","summary":"no reason key"}' },
  ])
  if (inMemoryDatabase === null) {
    assert.ok(true, "node:sqlite unavailable on this machine — skipping the in-memory semantics test")
    return
  }

  try {
    const compactionStats = queryCompactionStats(inMemoryDatabase)!

    // auto + the five shaped keys + four "unknown" folds
    // ("" / invalid JSON / NULL data / missing reason).
    assert.deepEqual(compactionStats.byReason, {
      auto: 1,
      ...WEIRD_REASON_BY_REASON_EXPECTED,
      unknown: WEIRD_REASON_BY_REASON_EXPECTED.unknown + 1,
    })
    assert.equal(compactionStats.total, 9)
    assert.deepEqual(compactionStats.topSessions, [
      { sessionId: "ses_weird_reasons", count: 9 },
    ])
  } finally {
    inMemoryDatabase.close()
  }
})

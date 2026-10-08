/**
 * Real-SQLite tests for the /api/trend byModel field (v0.11.0): the
 * per-day per-model token buckets on DailyTrendPoint.
 *
 * 发布清单 #2 discipline: the byModel semantics are locked against a
 * real node:sqlite :memory: fixture with hand-reconciled expectations
 * (the numbers below are unfolded by hand from the fixture constants —
 * an independent check, not a re-derivation through the code under
 * test). The SQL-extraction ↔ full-row parity is additionally locked
 * field-for-field by test/sql-aggregation-parity.test.ts, whose fixture
 * gained an out-of-window model row for the leak lock.
 *
 * Covered here:
 * 1. Multi-model, multi-day bucketing with exact per-day byModel maps
 *    (dense zero-fill, every window model on every day).
 * 2. The pinned model ordering: window token total desc, modelId asc
 *    tie-break — deterministic across runs.
 * 3. Window pruning: a model whose only activity is 30 days back
 *    appears for days=90 and never for days=7/30.
 * 4. Missing/empty model ids collapse onto the shared "unknown" bucket
 *    (same mapping as parseAssistantStepRow).
 * 5. Single-model input degenerates to one dense model layer.
 * 6. Route level: GET /api/trend?days=7 serves the thickened body.
 *
 * All fixture values are fictional placeholders (example-model-*,
 * release checklist #3). Timestamps are local noons so the tests hold
 * in any timezone. The whole file skips when node:sqlite is unavailable.
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import { createRequire } from "node:module"

import type { SqliteReadConnection } from "../src/db/types.ts"
import { queryDailyTrend } from "../src/db/queries.ts"
import { toLocalDateKey } from "../src/stats/daily-buckets.ts"
import { handleApiRequest, type ApiRequestContext } from "../src/web/api.ts"
import { matchApiRoute } from "../src/web/router.ts"
import { clearResultCache } from "../src/stats/cache.ts"

/** Structural type of a read-write node:sqlite connection for fixtures. */
interface SqliteReadWriteConnection extends SqliteReadConnection {
  exec(sql: string): void
}

type SqliteReadWriteConstructor = new (
  databasePath: string,
  options?: { readOnly?: boolean },
) => SqliteReadWriteConnection

/** Resolve DatabaseSync defensively so machines without it skip cleanly. */
function resolveReadWriteConstructor(): SqliteReadWriteConstructor | null {
  try {
    const requireNodeModule = createRequire(import.meta.url)
    const sqliteModule = requireNodeModule("node:sqlite") as {
      DatabaseSync: SqliteReadWriteConstructor
    }
    return sqliteModule.DatabaseSync
  } catch {
    return null
  }
}

const readWriteConstructor = resolveReadWriteConstructor()
const skipReason: string | false =
  readWriteConstructor === null
    ? "node:sqlite unavailable — skipping trend byModel tests"
    : false

/** Noon N days back, local time (timezone-safe fixture timestamps). */
function localNoonDaysAgo(daysBack: number): number {
  const noonDate = new Date()
  noonDate.setHours(12, 0, 0, 0)
  noonDate.setDate(noonDate.getDate() - daysBack)
  return noonDate.getTime()
}

/** One fixture message's token payload, in the wire shape. */
interface TrendFixtureMessage {
  sessionId: string
  type: "assistant" | "user"
  daysAgo: number
  /** Model id inside data.model.id; null omits the model block entirely. */
  modelId: string | null
  input: number
  output: number
  cacheRead: number
}

/**
 * The hand-reconciled fixture. Today carries two named models plus one
 * empty-id and one absent-model row (both → "unknown"); yesterday
 * carries two example-model-a steps (100 + 90 = 190) and a big
 * example-model-b step (500); a model whose ONLY activity is 30 days
 * back must never leak into shorter windows.
 */
const TREND_FIXTURE_MESSAGES: TrendFixtureMessage[] = [
  // today — example-model-a: 100+40+60 = 200
  { sessionId: "ses_trend_example_alpha", type: "assistant", daysAgo: 0, modelId: "example-model-a", input: 100, output: 40, cacheRead: 60 },
  // today — example-model-b: 10+5+5 = 20
  { sessionId: "ses_trend_example_alpha", type: "assistant", daysAgo: 0, modelId: "example-model-b", input: 10, output: 5, cacheRead: 5 },
  // today — empty model id → "unknown": 7
  { sessionId: "ses_trend_example_alpha", type: "assistant", daysAgo: 0, modelId: "", input: 7, output: 0, cacheRead: 0 },
  // today — model block absent → "unknown": 3 (unknown today total: 10)
  { sessionId: "ses_trend_example_alpha", type: "assistant", daysAgo: 0, modelId: null, input: 3, output: 0, cacheRead: 0 },
  // today — a user message that must never contribute
  { sessionId: "ses_trend_example_alpha", type: "user", daysAgo: 0, modelId: null, input: 999, output: 999, cacheRead: 999 },
  // yesterday — example-model-a: 50+0+50 = 100
  { sessionId: "ses_trend_example_alpha", type: "assistant", daysAgo: 1, modelId: "example-model-a", input: 50, output: 0, cacheRead: 50 },
  // yesterday — example-model-b: 500
  { sessionId: "ses_trend_example_alpha", type: "assistant", daysAgo: 1, modelId: "example-model-b", input: 500, output: 0, cacheRead: 0 },
  // yesterday — example-model-a again: 30+30+30 = 90 (day total 190)
  { sessionId: "ses_trend_example_alpha", type: "assistant", daysAgo: 1, modelId: "example-model-a", input: 30, output: 30, cacheRead: 30 },
  // 30 days back — the window-leak model: 1020, its only activity
  { sessionId: "ses_trend_example_alpha", type: "assistant", daysAgo: 30, modelId: "example-model-leak", input: 1000, output: 20, cacheRead: 0 },
]

/** Build the data JSON text of one fixture message (wire shape). */
function buildFixtureDataText(fixtureMessage: TrendFixtureMessage): string {
  const payload: Record<string, unknown> = {
    agent: "fixer",
    tokens: {
      input: fixtureMessage.input,
      output: fixtureMessage.output,
      reasoning: 0,
      cache: { read: fixtureMessage.cacheRead, write: 0 },
    },
    content: [],
  }
  if (fixtureMessage.modelId !== null) {
    payload["model"] = { id: fixtureMessage.modelId, providerID: "example-provider" }
  }
  return JSON.stringify(payload)
}

/** A fresh in-memory database carrying the byModel fixture. */
function createTrendByModelDatabase(): SqliteReadWriteConnection {
  const database = new readWriteConstructor!(":memory:")
  database.exec(
    "CREATE TABLE session_message (" +
      "id TEXT, session_id TEXT, type TEXT, seq INTEGER, " +
      "time_created INTEGER, time_updated INTEGER, data TEXT);",
  )
  const insertMessage = database.prepare(
    "INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?)",
  )
  TREND_FIXTURE_MESSAGES.forEach((fixtureMessage, messageIndex) => {
    const timeCreatedMs = localNoonDaysAgo(fixtureMessage.daysAgo)
    insertMessage.run(
      `msg_trend_${messageIndex}`,
      fixtureMessage.sessionId,
      fixtureMessage.type,
      messageIndex,
      timeCreatedMs,
      timeCreatedMs,
      fixtureMessage.type === "assistant"
        ? buildFixtureDataText(fixtureMessage)
        : JSON.stringify({ text: "用户消息" }),
    )
  })
  return database
}

/** Run queryDailyTrend against a fresh fixture and return its points. */
function freshTrendPoints(days: number) {
  const database = createTrendByModelDatabase()
  try {
    const trendPoints = queryDailyTrend(database as unknown as SqliteReadConnection, days)
    assert.ok(trendPoints !== null)
    return trendPoints
  } finally {
    database.close()
  }
}

test(
  "byModel buckets per day exactly, dense zero-filled, in the pinned order (hand-reconciled)",
  { skip: skipReason },
  () => {
    const trendPoints = freshTrendPoints(7)
    assert.equal(trendPoints.length, 7)
    const yesterdayPoint = trendPoints[5]
    const todayPoint = trendPoints[6]
    assert.equal(todayPoint.date, toLocalDateKey(Date.now()))
    assert.equal(yesterdayPoint.date, toLocalDateKey(localNoonDaysAgo(1)))

    // Window totals: example-model-b 20+500=520, example-model-a
    // 200+190=390, unknown 7+3=10 → pinned order: total desc.
    const expectedModelOrder = ["example-model-b", "example-model-a", "unknown"]

    // today, by hand: a 200, b 20, unknown 7+3 = 10.
    assert.deepEqual(todayPoint.byModel, {
      "example-model-b": 20,
      "example-model-a": 200,
      unknown: 10,
    })
    // yesterday, by hand: b 500, a 100+90 = 190, unknown 0.
    assert.deepEqual(yesterdayPoint.byModel, {
      "example-model-b": 500,
      "example-model-a": 190,
      unknown: 0,
    })
    // The five empty days stay dense: every window model, zero value.
    for (let emptyDayIndex = 0; emptyDayIndex < 5; emptyDayIndex += 1) {
      assert.deepEqual(trendPoints[emptyDayIndex].byModel, {
        "example-model-b": 0,
        "example-model-a": 0,
        unknown: 0,
      })
    }
    // Key order is the pinned order on every day, today and empty alike.
    for (const trendPoint of trendPoints) {
      assert.deepEqual(Object.keys(trendPoint.byModel), expectedModelOrder)
    }

    // 口径 consistency: Σ byModel === input + read + output, every day.
    // today: 120 + 65 + 45 = 230 = 20 + 200 + 10; yesterday: 690.
    for (const trendPoint of trendPoints) {
      const byModelSum = Object.values(trendPoint.byModel).reduce(
        (tokenSum, modelTokens) => tokenSum + modelTokens,
        0,
      )
      assert.equal(
        byModelSum,
        trendPoint.input + trendPoint.read + trendPoint.output,
        `day ${trendPoint.date}: byModel sums must equal the totals`,
      )
    }
    assert.equal(
      todayPoint.input + todayPoint.read + todayPoint.output,
      230,
      "today's totals by hand: (100+10+7+3) + (60+5) + (40+5)",
    )
  },
)

test(
  "the pinned model order is deterministic across runs",
  { skip: skipReason },
  () => {
    const firstRunPoints = freshTrendPoints(7)
    const secondRunPoints = freshTrendPoints(7)
    assert.deepEqual(secondRunPoints, firstRunPoints)
    assert.deepEqual(
      secondRunPoints.map((trendPoint) => Object.keys(trendPoint.byModel)),
      firstRunPoints.map((trendPoint) => Object.keys(trendPoint.byModel)),
      "identical inputs must produce identical byModel key order",
    )
  },
)

test(
  "a model whose only activity is 30 days back never leaks into 7/30-day windows but joins 90",
  { skip: skipReason },
  () => {
    for (const shortWindowDays of [7, 30]) {
      const trendPoints = freshTrendPoints(shortWindowDays)
      for (const trendPoint of trendPoints) {
        assert.ok(
          !Object.hasOwn(trendPoint.byModel, "example-model-leak"),
          `days=${shortWindowDays}: the out-of-window model must not appear on ${trendPoint.date}`,
        )
      }
    }
    // days=90: the leak model's single day (30 back) carries its 1020,
    // and it LEADS the pinned order (window total 1020 > 520 > 390 > 10).
    const longTrendPoints = freshTrendPoints(90)
    assert.equal(longTrendPoints.length, 90)
    const leakDayPoint = longTrendPoints[59] // today − 30 days, window starts at −89
    assert.equal(leakDayPoint.date, toLocalDateKey(localNoonDaysAgo(30)))
    assert.deepEqual(leakDayPoint.byModel, {
      "example-model-leak": 1020,
      "example-model-b": 0,
      "example-model-a": 0,
      unknown: 0,
    })
    assert.deepEqual(Object.keys(leakDayPoint.byModel), [
      "example-model-leak",
      "example-model-b",
      "example-model-a",
      "unknown",
    ])
    // Every other day of the 90-day window stays dense with all four models.
    assert.deepEqual(Object.keys(longTrendPoints[0].byModel), [
      "example-model-leak",
      "example-model-b",
      "example-model-a",
      "unknown",
    ])
  },
)

test(
  "a single-model database degenerates to one dense model layer",
  { skip: skipReason },
  () => {
    const database = new readWriteConstructor!(":memory:")
    try {
      database.exec(
        "CREATE TABLE session_message (" +
          "id TEXT, session_id TEXT, type TEXT, seq INTEGER, " +
          "time_created INTEGER, time_updated INTEGER, data TEXT);",
      )
      const insertMessage = database.prepare(
        "INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      const soloTimeMs = localNoonDaysAgo(0)
      insertMessage.run(
        "msg_trend_solo",
        "ses_trend_example_solo",
        "assistant",
        1,
        soloTimeMs,
        soloTimeMs,
        JSON.stringify({
          agent: "fixer",
          model: { id: "example-model-solo", providerID: "example-provider" },
          tokens: { input: 100, output: 20, reasoning: 0, cache: { read: 3, write: 0 } },
          content: [],
        }),
      )
      const trendPoints = queryDailyTrend(database as unknown as SqliteReadConnection, 2)!
      assert.deepEqual(trendPoints[1].byModel, { "example-model-solo": 123 })
      assert.deepEqual(trendPoints[0].byModel, { "example-model-solo": 0 })
    } finally {
      database.close()
    }
  },
)

test(
  "route level: GET /api/trend?days=7 serves the byModel-thickened body (cache key unchanged)",
  { skip: skipReason },
  () => {
    const database = createTrendByModelDatabase()
    try {
      const trendRoute = matchApiRoute("/api/trend")
      assert.notEqual(trendRoute, null)
      clearResultCache()
      const apiResponse = handleApiRequest({
        route: trendRoute!,
        searchParams: new URLSearchParams("days=7"),
        database: database as unknown as SqliteReadConnection,
        databasePath: "test://trend-fixture",
        serverPort: 18789,
      })
      assert.equal(apiResponse.statusCode, 200)
      const trendPoints = apiResponse.body as {
        date: string
        byModel: Record<string, number>
      }[]
      assert.equal(trendPoints.length, 7)
      assert.deepEqual(trendPoints[6].byModel, {
        "example-model-b": 20,
        "example-model-a": 200,
        unknown: 10,
      })
      assert.deepEqual(Object.keys(trendPoints[6].byModel), [
        "example-model-b",
        "example-model-a",
        "unknown",
      ])
    } finally {
      clearResultCache()
      database.close()
    }
  },
)

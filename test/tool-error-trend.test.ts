/**
 * v0.22.0 B 档 GET /api/tool-error-trend 测试：
 * - 纯函数 bucketDailyToolErrors（src/stats/tool-error-trend.ts）：连续
 *   本地日窗口、补零、按本地日归总、errorRate、MAX_TREND_DAYS 上限；
 * - 查询层（src/db/tool-error-trend-queries.ts）：真实 :memory: SQLite
 *   夹具——两层抽取（fast path ≤8 段 + json_each 回退）与 tool-health 同构，
 *   数字用独立手算对照；
 * - 空库零载荷；db 缺失 → null（API 层 503）；
 * - API 层：200 载荷形状（{days, points}）、近形路径 404、days 收窄缓存键。
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import { createRequire } from "node:module"

import type { SqliteReadConnection } from "../src/db/types.ts"
import { queryToolErrorTrend } from "../src/db/tool-error-trend-queries.ts"
import { queryToolHealth } from "../src/db/tool-health-queries.ts"
import {
  bucketDailyToolErrors,
  type ToolErrorSample,
  type ToolErrorTrendPoint,
} from "../src/stats/tool-error-trend.ts"
import { MAX_TREND_DAYS, toLocalDateKey } from "../src/stats/daily-buckets.ts"
import { handleApiRequest, type ApiRequestContext } from "../src/web/api.ts"
import { matchApiRoute } from "../src/web/router.ts"
import { clearResultCache, resultCacheSize } from "../src/stats/cache.ts"

/** Noon today / noon N days back, local time (timezone-independent). */
function localNoonDaysAgo(daysBack: number): number {
  const noonDate = new Date()
  noonDate.setHours(12, 0, 0, 0)
  noonDate.setDate(noonDate.getDate() - daysBack)
  return noonDate.getTime()
}

// ---------------------------------------------------------------------------
// Pure-function layer.

test("bucketDailyToolErrors returns an empty series for zero, negative or NaN days", () => {
  assert.deepEqual(bucketDailyToolErrors([], 0), [])
  assert.deepEqual(bucketDailyToolErrors([], -3), [])
  assert.deepEqual(bucketDailyToolErrors([], Number.NaN), [])
})

test("bucketDailyToolErrors zero-fills a continuous window ending today", () => {
  const trendPoints = bucketDailyToolErrors([], 3)
  assert.equal(trendPoints.length, 3)
  assert.equal(trendPoints[2].date, toLocalDateKey(Date.now()), "last point is today (local)")
  for (const trendPoint of trendPoints) {
    assert.deepEqual(trendPoint, {
      date: trendPoint.date,
      toolCalls: 0,
      errors: 0,
      errorRate: 0,
    })
  }
})

test("bucketDailyToolErrors accumulates toolCalls/errors per local day with the right errorRate", () => {
  const todayNoon = localNoonDaysAgo(0)
  const yesterdayNoon = localNoonDaysAgo(1)
  const samples: ToolErrorSample[] = [
    { timeCreated: todayNoon, status: "completed" },
    { timeCreated: todayNoon, status: "error" },
    { timeCreated: todayNoon, status: "error" },
    // A non-"error" status counts as a tool call but never as an error.
    { timeCreated: todayNoon, status: "unknown" },
    { timeCreated: yesterdayNoon, status: "completed" },
  ]

  const [yesterdayPoint, todayPoint] = bucketDailyToolErrors(samples, 2)
  assert.equal(todayPoint.toolCalls, 4)
  assert.equal(todayPoint.errors, 2)
  assert.equal(todayPoint.errorRate, 0.5)
  assert.equal(yesterdayPoint.toolCalls, 1)
  assert.equal(yesterdayPoint.errors, 0)
  assert.equal(yesterdayPoint.errorRate, 0, "a zero-error day stays at 0, never NaN")
})

test("bucketDailyToolErrors drops samples outside the window and with invalid timestamps", () => {
  const samples: ToolErrorSample[] = [
    { timeCreated: localNoonDaysAgo(30), status: "error" },
    { timeCreated: Number.NaN, status: "error" },
    { timeCreated: localNoonDaysAgo(0), status: "error" },
  ]
  const trendPoints = bucketDailyToolErrors(samples, 7)
  assert.equal(trendPoints.length, 7)
  const totalCalls = trendPoints.reduce((callSum, point) => callSum + point.toolCalls, 0)
  assert.equal(totalCalls, 1, "only the in-window, valid-timestamp sample survives")
})

test("bucketDailyToolErrors caps the window at MAX_TREND_DAYS", () => {
  assert.equal(bucketDailyToolErrors([], 1_000_000).length, MAX_TREND_DAYS)
})

test("bucketDailyToolErrors is deterministic for identical input", () => {
  const samples: ToolErrorSample[] = [
    { timeCreated: localNoonDaysAgo(0), status: "error" },
    { timeCreated: localNoonDaysAgo(1), status: "completed" },
  ]
  assert.deepEqual(bucketDailyToolErrors(samples, 2), bucketDailyToolErrors(samples, 2))
})

// ---------------------------------------------------------------------------
// Route matching.

test("matchApiRoute recognizes the tool-error-trend route; near-miss shapes do not match", () => {
  assert.deepEqual(matchApiRoute("/api/tool-error-trend"), { routeName: "tool-error-trend" })
  assert.deepEqual(matchApiRoute("/api/tool-error-trend/"), { routeName: "tool-error-trend" })
  assert.equal(matchApiRoute("/api/tool-error-trend/extra"), null, "no sub-path")
  assert.equal(matchApiRoute("/api/tool-error-trends"), null, "plural misspelling")
  assert.equal(matchApiRoute("/api/tool_error_trend"), null, "underscore misspelling")
})

// ---------------------------------------------------------------------------
// Query layer against real SQLite.

interface SqliteReadWriteStatement {
  all(...parameters: unknown[]): unknown[]
  get(...parameters: unknown[]): unknown
  run(...parameters: unknown[]): unknown
}

interface SqliteReadWriteConnection extends SqliteReadConnection {
  prepare(sql: string): SqliteReadWriteStatement
  exec(sql: string): void
}

type SqliteReadWriteConstructor = new (
  databasePath: string,
  options?: { readOnly?: boolean },
) => SqliteReadWriteConnection

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
    ? "node:sqlite unavailable — skipping tool-error-trend SQL tests"
    : false

test("queryToolErrorTrend returns null when the db connection is missing", () => {
  assert.equal(queryToolErrorTrend(null), null)
})

/** The one session_v2 row every anchored fixture message points at. */
const TOOL_ERROR_TREND_FIXTURE_SESSION_ID = "ses_tool_error_trend_fixture"

/** One fixture assistant message: when it happened plus its raw content. */
interface ToolErrorTrendMessageFixture {
  messageId: string
  type: string
  timeCreated: number
  data: unknown
  /** session_id of the message; defaults to the anchored fixture session. */
  sessionId?: string
}

function createToolErrorTrendFixtureDatabase(
  messageFixtures: ToolErrorTrendMessageFixture[],
): SqliteReadWriteConnection {
  const fixtureDatabase = new readWriteConstructor!(":memory:")
  fixtureDatabase.exec(
    `CREATE TABLE session_message (
       id TEXT PRIMARY KEY,
       session_id TEXT,
       type TEXT,
       seq INTEGER,
       time_created INTEGER,
       time_updated INTEGER,
       data TEXT
     )`,
  )
  // The anchored scan keeps only messages whose session_id is listed in
  // session_v2; unlisted ids model orphan (deleted-session) messages.
  fixtureDatabase.exec("CREATE TABLE session_v2 (id TEXT PRIMARY KEY)")
  fixtureDatabase.prepare("INSERT INTO session_v2 (id) VALUES (?)").run(
    TOOL_ERROR_TREND_FIXTURE_SESSION_ID,
  )
  const insertStatement = fixtureDatabase.prepare(
    "INSERT INTO session_message (id, session_id, type, seq, time_created, data) " +
      "VALUES (?, ?, ?, ?, ?, ?)",
  )
  let sequence = 0
  for (const messageFixture of messageFixtures) {
    sequence += 1
    insertStatement.run(
      messageFixture.messageId,
      messageFixture.sessionId ?? TOOL_ERROR_TREND_FIXTURE_SESSION_ID,
      messageFixture.type,
      sequence,
      messageFixture.timeCreated,
      typeof messageFixture.data === "string"
        ? messageFixture.data
        : JSON.stringify(messageFixture.data),
    )
  }
  return fixtureDatabase
}

/** Current-wire tool part ("name" key). */
function toolPart(toolName: string, status: string): Record<string, unknown> {
  return { type: "tool", name: toolName, state: { status } }
}

test("queryToolErrorTrend buckets tool calls and errors by local day over a controlled fixture", { skip: skipReason }, () => {
  const todayNoon = localNoonDaysAgo(0)
  const yesterdayNoon = localNoonDaysAgo(1)

  // 10 parts exceed the fast-path limit of 8 and force the json_each fallback.
  const longContentParts = [
    ...Array.from({ length: 6 }, () => toolPart("loop", "completed")),
    ...Array.from({ length: 3 }, () => toolPart("loop", "error")),
    toolPart("loop", "running"),
  ]
  // 8 parts sit exactly on the fast-path boundary.
  const eightContentParts = Array.from({ length: 8 }, () => toolPart("read", "completed"))

  const fixtureDatabase = createToolErrorTrendFixtureDatabase([
    {
      messageId: "msg_today_short",
      type: "assistant",
      timeCreated: todayNoon,
      data: {
        content: [
          { type: "text", text: "prose is never a tool part" },
          toolPart("bash", "completed"),
          toolPart("edit", "error"),
          toolPart("bash", "error"),
        ],
      },
    },
    { messageId: "msg_today_long", type: "assistant", timeCreated: todayNoon, data: { content: longContentParts } },
    { messageId: "msg_today_eight", type: "assistant", timeCreated: todayNoon, data: { content: eightContentParts } },
    {
      messageId: "msg_today_legacy_name",
      type: "assistant",
      timeCreated: todayNoon,
      data: { content: [{ type: "tool", tool: "grep", state: { status: "error" } }] },
    },
    {
      messageId: "msg_today_missing_state",
      type: "assistant",
      timeCreated: todayNoon,
      data: { content: [{ type: "tool", name: "webfetch", input: { url: "https://example.com" } }] },
    },
    {
      messageId: "msg_nameless_tool",
      type: "assistant",
      timeCreated: todayNoon,
      data: { content: [{ type: "tool", state: { status: "error" } }] },
    },
    {
      messageId: "msg_yesterday",
      type: "assistant",
      timeCreated: yesterdayNoon,
      data: { content: [toolPart("bash", "completed")] },
    },
    {
      messageId: "msg_outside_window",
      type: "assistant",
      timeCreated: localNoonDaysAgo(30),
      data: { content: [toolPart("bash", "error"), toolPart("bash", "error")] },
    },
    { messageId: "msg_user", type: "user", timeCreated: todayNoon, data: { content: [toolPart("bash", "error")] } },
    { messageId: "msg_non_object", type: "assistant", timeCreated: todayNoon, data: '"not an assistant object"' },
  ])

  try {
    const trend = queryToolErrorTrend(fixtureDatabase, 2)!
    assert.equal(trend.days, 2)
    assert.equal(trend.points.length, 2)
    const [yesterdayPoint, todayPoint] = trend.points

    // Hand-computed 对照: today = short(3/2) + long(10/3) + eight(8/0)
    // + legacy(1/1) + missing-state(1/0) = 23 calls, 6 errors;
    // nameless / user / non-object / outside-window contribute nothing.
    assert.equal(todayPoint.date, toLocalDateKey(todayNoon))
    assert.equal(todayPoint.toolCalls, 23)
    assert.equal(todayPoint.errors, 6)
    assert.equal(todayPoint.errorRate, 6 / 23)

    assert.equal(yesterdayPoint.date, toLocalDateKey(yesterdayNoon))
    assert.equal(yesterdayPoint.toolCalls, 1)
    assert.equal(yesterdayPoint.errors, 0)
    assert.equal(yesterdayPoint.errorRate, 0)
  } finally {
    fixtureDatabase.close()
  }
})

test("tool-health and tool-error-trend conserve the same tool-call totals on one shared fixture", { skip: skipReason }, () => {
  const todayNoon = localNoonDaysAgo(0)
  const yesterdayNoon = localNoonDaysAgo(1)
  const threeDaysAgoNoon = localNoonDaysAgo(3)

  // 12 parts exceed the fast-path limit of 8 and force the json_each fallback.
  const overFastPathLimitParts = [
    ...Array.from({ length: 7 }, () => toolPart("loop", "completed")),
    ...Array.from({ length: 4 }, () => toolPart("loop", "error")),
    toolPart("loop", "running"),
  ]
  // 8 parts sit exactly on the fast-path boundary (json_array_length <= 8).
  const atFastPathLimitParts = Array.from({ length: 8 }, () => toolPart("read", "completed"))

  const fixtureDatabase = createToolErrorTrendFixtureDatabase([
    {
      messageId: "msg_conserve_short",
      type: "assistant",
      timeCreated: todayNoon,
      data: {
        content: [
          { type: "text", text: "prose is never a tool part" },
          toolPart("bash", "completed"),
          toolPart("edit", "error"),
          toolPart("bash", "error"),
        ],
      },
    },
    {
      messageId: "msg_conserve_over_limit",
      type: "assistant",
      timeCreated: todayNoon,
      data: { content: overFastPathLimitParts },
    },
    {
      messageId: "msg_conserve_at_limit",
      type: "assistant",
      timeCreated: todayNoon,
      data: { content: atFastPathLimitParts },
    },
    {
      messageId: "msg_conserve_legacy_tool_key",
      type: "assistant",
      timeCreated: todayNoon,
      data: { content: [{ type: "tool", tool: "grep", state: { status: "error" } }] },
    },
    {
      // Non-string state.status: both endpoints must map it to "unknown"
      // — counted as a tool call, never as an error.
      messageId: "msg_conserve_non_string_status",
      type: "assistant",
      timeCreated: todayNoon,
      data: { content: [{ type: "tool", name: "webfetch", state: { status: 7 } }] },
    },
    {
      messageId: "msg_conserve_missing_status",
      type: "assistant",
      timeCreated: todayNoon,
      data: { content: [{ type: "tool", name: "webfetch" }] },
    },
    {
      // Empty name (no "name" and no legacy "tool"): dropped by both sides.
      messageId: "msg_conserve_nameless_tool",
      type: "assistant",
      timeCreated: todayNoon,
      data: { content: [{ type: "tool", state: { status: "error" } }] },
    },
    {
      messageId: "msg_conserve_yesterday",
      type: "assistant",
      timeCreated: yesterdayNoon,
      data: { content: [toolPart("bash", "completed")] },
    },
    {
      messageId: "msg_conserve_three_days_ago",
      type: "assistant",
      timeCreated: threeDaysAgoNoon,
      data: { content: [toolPart("bash", "error"), toolPart("bash", "error")] },
    },
    { messageId: "msg_conserve_user", type: "user", timeCreated: todayNoon, data: { content: [toolPart("bash", "error")] } },
    { messageId: "msg_conserve_non_object", type: "assistant", timeCreated: todayNoon, data: '"not an assistant object"' },
  ])

  try {
    // tool-error-trend is windowed (366 local days back from today), so every
    // fixture message must sit inside it for the totals to be comparable.
    const fullWindowTrend = queryToolErrorTrend(fixtureDatabase, MAX_TREND_DAYS)!
    const toolHealthStats = queryToolHealth(fixtureDatabase)!

    assert.equal(fullWindowTrend.days, MAX_TREND_DAYS)
    assert.equal(fullWindowTrend.points.length, MAX_TREND_DAYS)

    const trendToolCalls = fullWindowTrend.points.reduce(
      (callSum, point) => callSum + point.toolCalls,
      0,
    )
    const trendErrors = fullWindowTrend.points.reduce((errorSum, point) => errorSum + point.errors, 0)
    const healthTotal = toolHealthStats.reduce((totalSum, stat) => totalSum + stat.total, 0)
    const healthErrors = toolHealthStats.reduce((errorSum, stat) => errorSum + stat.error, 0)

    assert.equal(trendToolCalls, healthTotal, "Σ points.toolCalls must equal Σ tool-health.total")
    assert.equal(trendErrors, healthErrors, "Σ points.errors must equal Σ tool-health.error")

    // Hand-computed anchor: short(3/2) + over-limit(12/4) + at-limit(8/0)
    // + legacy(1/1) + non-string status(1/0) + missing status(1/0)
    // + yesterday(1/0) + three-days-ago(2/2) = 29 calls, 9 errors. Pinning it
    // keeps the conservation above from passing vacuously on two empty sides.
    assert.equal(trendToolCalls, 29)
    assert.equal(trendErrors, 9)
  } finally {
    fixtureDatabase.close()
  }
})

test("queryToolErrorTrend excludes orphan messages whose session_id is absent from session_v2", { skip: skipReason }, () => {
  const todayNoon = localNoonDaysAgo(0)
  // One anchored assistant message (its session is in session_v2) and one
  // orphan assistant message (会话已删、消息残留) also carrying tool parts.
  // The anchored scan must drop the orphan; before the anchor its two
  // error calls were counted.
  const fixtureDatabase = createToolErrorTrendFixtureDatabase([
    {
      messageId: "msg_anchored_bash",
      type: "assistant",
      timeCreated: todayNoon,
      data: { content: [toolPart("bash", "completed")] },
    },
    {
      messageId: "msg_orphan_edit",
      type: "assistant",
      timeCreated: todayNoon,
      sessionId: "ses_orphan_not_in_session_v2",
      data: { content: [toolPart("edit", "error"), toolPart("edit", "error")] },
    },
  ])
  try {
    const trend = queryToolErrorTrend(fixtureDatabase, 1)!
    const [todayPoint] = trend.points
    assert.equal(todayPoint.toolCalls, 1, "only the anchored message's call counts")
    assert.equal(todayPoint.errors, 0, "the orphan session's errors must not count")
  } finally {
    fixtureDatabase.close()
  }
})

test("queryToolErrorTrend answers a zero-filled series for an empty fixture", { skip: skipReason }, () => {
  const fixtureDatabase = createToolErrorTrendFixtureDatabase([
    { messageId: "msg_prose_only", type: "assistant", timeCreated: localNoonDaysAgo(0), data: { content: [] } },
  ])
  try {
    const trend = queryToolErrorTrend(fixtureDatabase, 3)!
    assert.equal(trend.days, 3)
    assert.equal(trend.points.length, 3)
    assert.deepEqual(
      trend.points.map((point: ToolErrorTrendPoint) => point.toolCalls),
      [0, 0, 0],
    )
    assert.equal(trend.points.reduce((callSum, point) => callSum + point.errors, 0), 0)
  } finally {
    fixtureDatabase.close()
  }
})

test("queryToolErrorTrend skips the database and yields an empty series for a non-positive days", () => {
  // No db needed: the guard returns before touching any connection.
  assert.deepEqual(queryToolErrorTrend({ prepare: () => {
    throw new Error("must not be called")
  }, close: () => {} }, 0), { days: 0, points: [] })
})

// ---------------------------------------------------------------------------
// API layer.

function apiContextFor(
  pathname: string,
  database: SqliteReadConnection,
  queryString = "",
): ApiRequestContext {
  const route = matchApiRoute(pathname)
  assert.notEqual(route, null, `route failed to match: ${pathname}`)
  return {
    route: route!,
    searchParams: new URLSearchParams(queryString),
    database,
    databasePath: "test://tool-error-trend",
    serverPort: 18789,
  }
}

test("/api/tool-error-trend answers 200 with {days, points} and ignores ?session=", { skip: skipReason }, () => {
  clearResultCache()
  try {
    const fixtureDatabase = createToolErrorTrendFixtureDatabase([
      {
        messageId: "msg_api_short",
        type: "assistant",
        timeCreated: localNoonDaysAgo(0),
        data: { content: [toolPart("bash", "error"), toolPart("bash", "completed")] },
      },
    ])
    try {
      const apiResponse = handleApiRequest(apiContextFor("/api/tool-error-trend", fixtureDatabase, "days=1"))
      assert.equal(apiResponse.statusCode, 200)
      const body = apiResponse.body as { days: number; points: ToolErrorTrendPoint[] }
      assert.equal(body.days, 1)
      assert.equal(body.points.length, 1)
      assert.equal(body.points[0].toolCalls, 2)
      assert.equal(body.points[0].errors, 1)
      assert.equal(body.points[0].errorRate, 0.5)

      // ?session= is ignored (全部会话口径) — still a 200 all-session payload.
      const sessionScopedResponse = handleApiRequest(
        apiContextFor("/api/tool-error-trend", fixtureDatabase, "days=1&session=ses_whatever"),
      )
      assert.equal(sessionScopedResponse.statusCode, 200)
    } finally {
      fixtureDatabase.close()
    }
  } finally {
    clearResultCache()
  }
})

test("/api/tool-error-trend cache key clamps days to the MAX_TREND_DAYS bound", { skip: skipReason }, () => {
  clearResultCache()
  try {
    const fixtureDatabase = createToolErrorTrendFixtureDatabase([])
    try {
      const absurdResponse = handleApiRequest(apiContextFor("/api/tool-error-trend", fixtureDatabase, "days=1000"))
      const boundedResponse = handleApiRequest(apiContextFor("/api/tool-error-trend", fixtureDatabase, "days=366"))
      assert.equal(absurdResponse.statusCode, 200)
      assert.deepEqual(boundedResponse.body, absurdResponse.body)
      assert.equal(resultCacheSize(), 1, "?days=1000 and ?days=366 share one clamped entry")

      handleApiRequest(apiContextFor("/api/tool-error-trend", fixtureDatabase, "days=30"))
      assert.equal(resultCacheSize(), 2, "a genuinely different window gets its own entry")
    } finally {
      fixtureDatabase.close()
    }
  } finally {
    clearResultCache()
  }
})

test("the tool-error-trend route answers 503 while the db is missing", () => {
  const route = matchApiRoute("/api/tool-error-trend")
  assert.notEqual(route, null)
  const apiResponse = handleApiRequest({
    route: route!,
    searchParams: new URLSearchParams(),
    database: null,
    databasePath: "test://no-database",
    serverPort: 18789,
  })
  assert.equal(apiResponse.statusCode, 503)
})

/**
 * v0.22.0 B 档 GET /api/session-outcomes 测试：
 * - 纯函数（src/stats/session-outcome.ts）：rankErrorTypes 排序（count 降序
 *   + type 升序）、interruptedShare 派生、零分母守卫；
 * - 查询层（src/db/session-outcome-queries.ts）：真实 :memory: SQLite 夹具，
 *   数字用独立手算对照——「最后一条 assistant 消息带 $.error」判定、锚定
 *   session_v2（孤儿排除）、**会话级** byErrorType（每个收尾会话只按其终局
 *   错误类型贡献一次，Σ = interruptedSessions）、recentInterrupted 按
 *   time_updated 降序排序与 limit 5；
 * - sessionsWithSteps 与 /api/step-distribution 的样本集合 parity（口径统一）；
 * - 空库零载荷；db 缺失 → null（API 层 503）；
 * - API 层：200 载荷形状、近形路径 404、?session= 被忽略。
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import { createRequire } from "node:module"

import type { SqliteReadConnection } from "../src/db/types.ts"
import { querySessionOutcome } from "../src/db/session-outcome-queries.ts"
import { queryStepDistribution } from "../src/db/session-distribution-queries.ts"
import {
  buildSessionOutcomeStats,
  rankErrorTypes,
  type RecentInterruptedSession,
} from "../src/stats/session-outcome.ts"
import { handleApiRequest, type ApiRequestContext } from "../src/web/api.ts"
import { matchApiRoute } from "../src/web/router.ts"
import { clearResultCache } from "../src/stats/cache.ts"

// ---------------------------------------------------------------------------
// Pure-function layer.

test("rankErrorTypes sorts by count descending and type ascending on ties", () => {
  const rankedErrorTypes = rankErrorTypes([
    { type: "zeta", count: 2 },
    { type: "alpha", count: 2 },
    { type: "mid", count: 5 },
    { type: "beta", count: 1 },
  ])
  assert.deepEqual(rankedErrorTypes, [
    { type: "mid", count: 5 },
    { type: "alpha", count: 2 },
    { type: "zeta", count: 2 },
    { type: "beta", count: 1 },
  ])
})

test("rankErrorTypes does not mutate its input", () => {
  const inputErrorTypes = [
    { type: "b", count: 1 },
    { type: "a", count: 3 },
  ]
  rankErrorTypes(inputErrorTypes)
  assert.deepEqual(inputErrorTypes, [
    { type: "b", count: 1 },
    { type: "a", count: 3 },
  ])
})

test("buildSessionOutcomeStats derives interruptedShare", () => {
  const recentInterrupted: RecentInterruptedSession[] = [
    { sessionId: "ses_x", title: "x", errorType: "aborted", errorMessage: "aborted", timeUpdated: 10 },
  ]
  const stats = buildSessionOutcomeStats({
    totalSessions: 10,
    sessionsWithSteps: 4,
    interruptedSessions: 2,
    errorTypeCounts: [
      { type: "aborted", count: 1 },
      { type: "provider.error", count: 3 },
    ],
    recentInterrupted,
  })
  assert.equal(stats.interruptedShare, 0.5)
  assert.deepEqual(stats.byErrorType, [
    { type: "provider.error", count: 3 },
    { type: "aborted", count: 1 },
  ])
  assert.deepEqual(stats.recentInterrupted, recentInterrupted)
})

test("buildSessionOutcomeStats guards a zero step denominator", () => {
  const emptyStats = buildSessionOutcomeStats({
    totalSessions: 0,
    sessionsWithSteps: 0,
    interruptedSessions: 0,
    errorTypeCounts: [],
    recentInterrupted: [],
  })
  assert.deepEqual(emptyStats, {
    totalSessions: 0,
    sessionsWithSteps: 0,
    interruptedSessions: 0,
    interruptedShare: 0,
    byErrorType: [],
    recentInterrupted: [],
  })

  // Defensive: an impossible interrupted > steps input still yields a
  // well-defined share (interrupted is a subset of steps by construction).
  const clampedStats = buildSessionOutcomeStats({
    totalSessions: 1,
    sessionsWithSteps: 1,
    interruptedSessions: 2,
    errorTypeCounts: [],
    recentInterrupted: [],
  })
  assert.equal(clampedStats.interruptedShare, 2)
})

// ---------------------------------------------------------------------------
// Route matching.

test("matchApiRoute recognizes the session-outcomes route; near-miss shapes do not match", () => {
  assert.deepEqual(matchApiRoute("/api/session-outcomes"), { routeName: "session-outcomes" })
  assert.deepEqual(matchApiRoute("/api/session-outcomes/"), { routeName: "session-outcomes" })
  assert.equal(matchApiRoute("/api/session-outcomes/extra"), null, "no sub-path")
  assert.equal(matchApiRoute("/api/session-outcome"), null, "singular misspelling")
  assert.equal(matchApiRoute("/api/session_outcomes"), null, "underscore misspelling")
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
    ? "node:sqlite unavailable — skipping session-outcome SQL tests"
    : false

test("querySessionOutcome returns null when the db connection is missing", () => {
  assert.equal(querySessionOutcome(null), null)
})

interface SessionFixture {
  id: string
  title: string
  timeCreated: number
  timeUpdated: number
  /** Assistant messages in seq order; null seq entries mean "no messages". */
  assistantMessages: Array<{ seq: number; data: unknown }>
}

function createSessionOutcomeFixtureDatabase(sessions: SessionFixture[]): SqliteReadWriteConnection {
  const fixtureDatabase = new readWriteConstructor!(":memory:")
  fixtureDatabase.exec(
    "CREATE TABLE session_v2 (id TEXT PRIMARY KEY, title TEXT, time_created INTEGER, time_updated INTEGER)",
  )
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
  const insertSession = fixtureDatabase.prepare(
    "INSERT INTO session_v2 (id, title, time_created, time_updated) VALUES (?, ?, ?, ?)",
  )
  const insertMessage = fixtureDatabase.prepare(
    "INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?)",
  )
  let messageCounter = 0
  for (const session of sessions) {
    insertSession.run(session.id, session.title, session.timeCreated, session.timeUpdated)
    for (const message of session.assistantMessages) {
      messageCounter += 1
      insertMessage.run(
        `msg_${messageCounter}`,
        session.id,
        "assistant",
        message.seq,
        session.timeCreated,
        session.timeUpdated,
        typeof message.data === "string" ? message.data : JSON.stringify(message.data),
      )
    }
  }
  return fixtureDatabase
}

/** Assistant message carrying a wire error ({type, message}). */
function errorMessage(errorType: string, errorMessageText: string): Record<string, unknown> {
  return { content: [], error: { type: errorType, message: errorMessageText } }
}

/** Assistant message whose terminal error carries no `type` field. */
function errorMessageWithoutType(errorMessageText: string): Record<string, unknown> {
  return { content: [], error: { message: errorMessageText } }
}

/** Assistant message without an error. */
function cleanMessage(): Record<string, unknown> {
  return { content: [] }
}

test("querySessionOutcome classifies sessions by their last assistant message (anchored to session_v2)", { skip: skipReason }, () => {
  const fixtureDatabase = createSessionOutcomeFixtureDatabase([
    { id: "ses_clean", title: "clean session", timeCreated: 1000, timeUpdated: 1100, assistantMessages: [{ seq: 1, data: cleanMessage() }] },
    {
      id: "ses_interrupted_later",
      title: "later updated error",
      // time_updated (5100) is the recentInterrupted sort key; time_created
      // (2000) deliberately contradicts it so the test proves the basis.
      timeCreated: 2000,
      timeUpdated: 5100,
      assistantMessages: [
        { seq: 1, data: cleanMessage() },
        { seq: 2, data: errorMessage("provider.error", "boom") },
      ],
    },
    {
      id: "ses_interrupted_earlier",
      title: "earlier updated error",
      timeCreated: 5000,
      timeUpdated: 2100,
      assistantMessages: [{ seq: 1, data: errorMessage("aborted", "old fail") }],
    },
    {
      id: "ses_interrupted_untyped",
      title: "untyped terminal error",
      timeCreated: 6000,
      timeUpdated: 6100,
      // Terminal error lacks `type`: still counts as interrupted, but feeds no
      // byErrorType bucket (Σ buckets < interruptedSessions).
      assistantMessages: [{ seq: 1, data: errorMessageWithoutType("no type info") }],
    },
    {
      id: "ses_recovered",
      title: "recovered",
      timeCreated: 3000,
      timeUpdated: 3100,
      // The LAST assistant message is clean → not interrupted, even though an
      // earlier one errored. Session-level byErrorType therefore does NOT
      // count the earlier `unknown` error (would have, under message-level).
      assistantMessages: [
        { seq: 1, data: errorMessage("unknown", "first attempt failed") },
        { seq: 2, data: cleanMessage() },
      ],
    },
    { id: "ses_no_steps", title: "no steps", timeCreated: 4000, timeUpdated: 4000, assistantMessages: [] },
  ])

  // Orphan message: session absent from session_v2 (a deleted session's
  // leftover row) — must not affect any counter.
  fixtureDatabase
    .prepare(
      "INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .run("msg_orphan", "ses_orphan_absent", "assistant", 1, 9000, 9000, JSON.stringify(errorMessage("provider.quota", "orphan")))

  try {
    const stats = querySessionOutcome(fixtureDatabase)!
    assert.equal(stats.totalSessions, 6, "totalSessions is every session_v2 row")
    assert.equal(stats.sessionsWithSteps, 5, "ses_no_steps has no assistant message")
    assert.equal(stats.interruptedSessions, 3)
    assert.equal(stats.interruptedShare, 0.6)

    // Session-level error types (orphan excluded; the untyped terminal error
    // contributes to no bucket): aborted×1 == provider.error×1 → type
    // ascending tie-break. Σ = 2 < interruptedSessions (3) by that one untyped
    // session.
    assert.deepEqual(stats.byErrorType, [
      { type: "aborted", count: 1 },
      { type: "provider.error", count: 1 },
    ])
    const errorTypeTotal = stats.byErrorType.reduce((total, bucket) => total + bucket.count, 0)
    assert.equal(errorTypeTotal, 2, "untyped terminal error is excluded from buckets")

    // Ordered by time_updated desc: untyped (6100), later (5100), earlier
    // (2100) — NOT by session time_created (would be untyped/earlier/later).
    assert.deepEqual(stats.recentInterrupted, [
      {
        sessionId: "ses_interrupted_untyped",
        title: "untyped terminal error",
        errorType: "",
        errorMessage: "no type info",
        timeUpdated: 6100,
      },
      {
        sessionId: "ses_interrupted_later",
        title: "later updated error",
        errorType: "provider.error",
        errorMessage: "boom",
        timeUpdated: 5100,
      },
      {
        sessionId: "ses_interrupted_earlier",
        title: "earlier updated error",
        errorType: "aborted",
        errorMessage: "old fail",
        timeUpdated: 2100,
      },
    ])
  } finally {
    fixtureDatabase.close()
  }
})

test("querySessionOutcome answers the zero payload for an empty database", { skip: skipReason }, () => {
  const fixtureDatabase = createSessionOutcomeFixtureDatabase([])
  try {
    assert.deepEqual(querySessionOutcome(fixtureDatabase), {
      totalSessions: 0,
      sessionsWithSteps: 0,
      interruptedSessions: 0,
      interruptedShare: 0,
      byErrorType: [],
      recentInterrupted: [],
    })
  } finally {
    fixtureDatabase.close()
  }
})

test("sessionsWithSteps shares the step-distribution sample set (parity, incl. non-object assistant rows)", { skip: skipReason }, () => {
  // 两张卡都叫「有步骤的会话」——同名必须同数。夹具故意含一个「有 assistant
  // 行、但只有非对象 / 非 JSON 可解析行」的会话：它在步数分布（纯行计数）里
  // 是一个样本，在 session-outcome 里也必须计入 sessionsWithSteps，却因不可
  // json_extract 而不判为收尾错误。
  const fixtureDatabase = createSessionOutcomeFixtureDatabase([
    {
      id: "ses_object_steps",
      title: "object rows",
      timeCreated: 1000,
      timeUpdated: 1100,
      assistantMessages: [{ seq: 1, data: cleanMessage() }],
    },
    {
      id: "ses_non_object_steps",
      title: "non-object rows only",
      timeCreated: 2000,
      timeUpdated: 2100,
      assistantMessages: [
        { seq: 1, data: "not-json-at-all" },
        { seq: 2, data: 123 },
        { seq: 3, data: [1, 2] },
      ],
    },
    { id: "ses_no_steps", title: "no steps", timeCreated: 3000, timeUpdated: 3000, assistantMessages: [] },
  ])
  try {
    const outcomeStats = querySessionOutcome(fixtureDatabase)!
    // NumericDistributionStats.totalSessions is the step-distribution sample
    // count (sessions with at least one assistant row).
    const stepDistribution = queryStepDistribution(fixtureDatabase)!
    assert.equal(
      outcomeStats.sessionsWithSteps,
      2,
      "both assistant-bearing sessions count; the zero-step one does not",
    )
    assert.equal(stepDistribution.totalSessions, 2, "step distribution saw the same two sessions")
    assert.equal(
      outcomeStats.sessionsWithSteps,
      stepDistribution.totalSessions,
      "the two 'sessions with steps' cards must agree on the same session set",
    )
    // A session with only non-object assistant rows is a step session, yet
    // never classifies as interrupted (no object message to json_extract).
    assert.equal(outcomeStats.interruptedSessions, 0)
    assert.equal(outcomeStats.interruptedShare, 0)
  } finally {
    fixtureDatabase.close()
  }
})

test("querySessionOutcome caps recentInterrupted at 5 ordered by time_updated desc", { skip: skipReason }, () => {
  const sessions: SessionFixture[] = []
  for (let index = 0; index < 10; index += 1) {
    // time_updated desc drives the rank; time_created asc deliberately
    // contradicts it, proving time_updated is the basis. Indices 0 and 1 share
    // time_updated 900 to exercise the session_id ascending tie-break.
    const timeUpdated = index < 2 ? 900 : (9 - index) * 100
    sessions.push({
      id: `ses_recent_${index}`,
      title: `recent ${index}`,
      timeCreated: index * 100,
      timeUpdated,
      assistantMessages: [{ seq: 1, data: errorMessage("aborted", `fail ${index}`) }],
    })
  }
  const fixtureDatabase = createSessionOutcomeFixtureDatabase(sessions)
  try {
    const stats = querySessionOutcome(fixtureDatabase)!
    assert.equal(stats.interruptedSessions, 10)
    assert.equal(stats.recentInterrupted.length, 5, "limit 5 (matches the card cap)")
    assert.deepEqual(
      stats.recentInterrupted.map((recentSession) => recentSession.sessionId),
      [
        "ses_recent_0",
        "ses_recent_1",
        "ses_recent_2",
        "ses_recent_3",
        "ses_recent_4",
      ],
    )
  } finally {
    fixtureDatabase.close()
  }
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
    databasePath: "test://session-outcome",
    serverPort: 18789,
  }
}

test("/api/session-outcomes answers 200 with the outcome payload and ignores ?session=", { skip: skipReason }, () => {
  clearResultCache()
  try {
    const fixtureDatabase = createSessionOutcomeFixtureDatabase([
      { id: "ses_api_ok", title: "api clean", timeCreated: 1000, timeUpdated: 1100, assistantMessages: [{ seq: 1, data: cleanMessage() }] },
      { id: "ses_api_fail", title: "api fail", timeCreated: 2000, timeUpdated: 2100, assistantMessages: [{ seq: 1, data: errorMessage("aborted", "nope") }] },
    ])
    try {
      const apiResponse = handleApiRequest(apiContextFor("/api/session-outcomes", fixtureDatabase))
      assert.equal(apiResponse.statusCode, 200)
      const body = apiResponse.body as {
        totalSessions: number
        sessionsWithSteps: number
        interruptedSessions: number
        interruptedShare: number
      }
      assert.equal(body.totalSessions, 2)
      assert.equal(body.sessionsWithSteps, 2)
      assert.equal(body.interruptedSessions, 1)
      assert.equal(body.interruptedShare, 0.5)

      // ?session= is ignored (全部会话口径) — still a 200 all-session payload.
      const sessionScopedResponse = handleApiRequest(
        apiContextFor("/api/session-outcomes", fixtureDatabase, "session=ses_api_ok"),
      )
      assert.equal(sessionScopedResponse.statusCode, 200)
    } finally {
      fixtureDatabase.close()
    }
  } finally {
    clearResultCache()
  }
})

test("the session-outcomes route answers 503 while the db is missing", () => {
  const route = matchApiRoute("/api/session-outcomes")
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

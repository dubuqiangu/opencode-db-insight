/**
 * Tests for the optional /api/models ?days= window:
 *
 * - query level (queryModelMetrics): days pushdown + local-midnight
 *   window reclaim, the clamp to MAX_TREND_DAYS, and the full-history
 *   fallback for illegal values — locked against a real SQLite fixture
 *   file (SQL semantics must be tested against real SQLite, not a fake
 *   JS mirror; see the 发布清单 #2 note in helpers/fake-insight-db.ts);
 * - route level (handleApiRequest): the parameter-handling trio of the
 *   trend route (parse / clamp / key) — garbage ?days= shares the
 *   full-history cache entry, and ?days=1000 shares the 366 entry.
 */

import { after, test } from "node:test"
import assert from "node:assert/strict"
import { createRequire } from "node:module"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { queryModelMetrics, queryModelMetricsComparison } from "../src/db/aggregate-queries.ts"
import type { SqliteReadConnection } from "../src/db/types.ts"
import { handleApiRequest, type ApiRequestContext } from "../src/web/api.ts"
import { matchApiRoute } from "../src/web/router.ts"
import { clearResultCache, resultCacheSize } from "../src/stats/cache.ts"
import {
  createFakeInsightDatabase,
  type FakeInsightDatabaseScenario,
} from "./helpers/fake-insight-db.ts"

const DAY_MS = 24 * 60 * 60 * 1000

// ---------------------------------------------------------------------------
// Real-SQLite fixture (query level)
// ---------------------------------------------------------------------------

/** Local structural type for the write-capable statements the fixture needs. */
interface SqliteRunStatement {
  run(...parameters: unknown[]): unknown
}

type SqliteReadWriteConnection = SqliteReadConnection & {
  prepare(sql: string): SqliteRunStatement
}

type SqliteReadWriteConstructor = new (databasePath: string) => SqliteReadWriteConnection

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
    ? "node:sqlite unavailable — skipping model-metrics days-window SQL tests"
    : false

/** Local noon keeps "N days ago" fixtures timezone-safe across the suite's run time. */
function localNoonMs(daysAgo: number): number {
  const nowDate = new Date()
  const noonDate = new Date(nowDate.getFullYear(), nowDate.getMonth(), nowDate.getDate(), 12, 0)
  return noonDate.getTime() - daysAgo * DAY_MS
}

/**
 * Fixture: five assistant steps across four models at controlled local
 * noons, plus one user message that must never contribute —
 * - model/current: today and 3 days ago (inside days=7)
 * - model/older:   20 days ago (inside days=30, outside days=7)
 * - model/edge:   300 days ago (inside the 366-day clamp bound)
 * - model/ancient: 400 days ago (outside every legal window)
 */
async function createModelsWindowFixture(): Promise<SqliteReadWriteConnection> {
  const fixtureDir = await mkdtemp(join(tmpdir(), "models-days-window-"))
  const database = new readWriteConstructor!(join(fixtureDir, "fixture.db"))
  database
    .prepare(
      `CREATE TABLE session_message (
         id TEXT, session_id TEXT, type TEXT, seq INTEGER,
         time_created INTEGER, time_updated INTEGER, data TEXT)`,
    )
    .run()

  const insertMessage = database.prepare(
    "INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?, ?)",
  )
  let messageSeq = 0
  const addAssistantStep = (modelId: string, daysAgo: number): void => {
    messageSeq += 1
    insertMessage.run(
      `msg_${messageSeq}`,
      "ses_models_window",
      "assistant",
      messageSeq,
      localNoonMs(daysAgo),
      localNoonMs(daysAgo),
      JSON.stringify({
        model: { id: modelId, providerID: "provider-fixture" },
        tokens: { input: 100, output: 40, reasoning: 10, cache: { read: 60, write: 5 } },
        content: [],
      }),
    )
  }

  addAssistantStep("model/current", 0)
  addAssistantStep("model/current", 3)
  addAssistantStep("model/older", 20)
  addAssistantStep("model/edge", 300)
  addAssistantStep("model/ancient", 400)
  messageSeq += 1
  insertMessage.run(
    `msg_${messageSeq}`,
    "ses_models_window",
    "user",
    messageSeq,
    localNoonMs(0),
    localNoonMs(0),
    JSON.stringify({ text: "user message must never contribute" }),
  )

  after(async () => {
    database.close()
    await rm(fixtureDir, { recursive: true, force: true })
  })
  return database
}

/**
 * Fixture for the 环比 comparison (B-part-2): one model spanning the current
 * window AND the previous equal-length window, one current-only model, and
 * one previous-only model — each step totals 200 tokens (100+40+60).
 */
async function createModelComparisonFixture(): Promise<SqliteReadWriteConnection> {
  const fixtureDir = await mkdtemp(join(tmpdir(), "models-comparison-"))
  const database = new readWriteConstructor!(join(fixtureDir, "fixture.db"))
  database
    .prepare(
      `CREATE TABLE session_message (
         id TEXT, session_id TEXT, type TEXT, seq INTEGER,
         time_created INTEGER, time_updated INTEGER, data TEXT)`,
    )
    .run()

  const insertMessage = database.prepare(
    "INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?, ?)",
  )
  let messageSeq = 0
  const addAssistantStep = (modelId: string, daysAgo: number): void => {
    messageSeq += 1
    insertMessage.run(
      `msg_${messageSeq}`,
      "ses_models_comparison",
      "assistant",
      messageSeq,
      localNoonMs(daysAgo),
      localNoonMs(daysAgo),
      JSON.stringify({
        model: { id: modelId, providerID: "provider-fixture" },
        tokens: { input: 100, output: 40, reasoning: 10, cache: { read: 60, write: 5 } },
        content: [],
      }),
    )
  }

  // days=7: current window = local [today-6 .. today]; the previous
  // equal-length window = local [today-13 .. today-7]. daysAgo 6 is the
  // current window's first day, daysAgo 7 the previous window's last day —
  // the boundary pair must never land in both windows (no double count).
  addAssistantStep("model/boundary", 6) // current first day
  addAssistantStep("model/boundary", 7) // previous last day
  addAssistantStep("model/steady", 2) // current
  addAssistantStep("model/steady", 9) // previous
  addAssistantStep("model/fresh", 1) // current only
  addAssistantStep("model/gone", 10) // previous only

  after(async () => {
    database.close()
    await rm(fixtureDir, { recursive: true, force: true })
  })
  return database
}

/** Model ids present in a metrics list, as a sorted set for easy comparison. */
function modelIdsOf(modelMetrics: NonNullable<ReturnType<typeof queryModelMetrics>>): string[] {
  return modelMetrics.map((modelMetric) => modelMetric.modelId).sort()
}

function stepsOf(
  modelMetrics: NonNullable<ReturnType<typeof queryModelMetrics>>,
  modelId: string,
): number {
  const modelMetric = modelMetrics.find((candidate) => candidate.modelId === modelId)
  assert.notEqual(modelMetric, undefined, `expected a row for ${modelId}`)
  return modelMetric!.steps
}

test("queryModelMetrics without days scans the full history (back-compat default)", { skip: skipReason || undefined }, async () => {
  const database = await createModelsWindowFixture()
  const modelMetrics = queryModelMetrics(database)!

  assert.deepEqual(modelIdsOf(modelMetrics), [
    "model/ancient",
    "model/current",
    "model/edge",
    "model/older",
  ])
  assert.equal(stepsOf(modelMetrics, "model/current"), 2, "both current-model steps count")
})

test("queryModelMetrics with days=7 keeps only the window's steps and reclaims the DST slack", { skip: skipReason || undefined }, async () => {
  const database = await createModelsWindowFixture()
  const modelMetrics = queryModelMetrics(database, 7)!

  assert.deepEqual(modelIdsOf(modelMetrics), ["model/current"], "only the in-window model survives")
  assert.equal(stepsOf(modelMetrics, "model/current"), 2, "today's and the 3-day-ago step are both inside days=7")

  const currentModelMetric = modelMetrics[0]
  assert.equal(currentModelMetric.lastSeen, localNoonMs(0))
  assert.equal(currentModelMetric.firstSeen, localNoonMs(3), "firstSeen/lastSeen reflect the window, not the full history")
})

test("queryModelMetrics with days=30 widens the window to the 20-day step but not beyond", { skip: skipReason || undefined }, async () => {
  const database = await createModelsWindowFixture()
  const modelMetrics = queryModelMetrics(database, 30)!

  assert.deepEqual(modelIdsOf(modelMetrics), ["model/current", "model/older"])
})

test("queryModelMetrics clamps absurd days to the 366-day bound (days=1000 ≡ days=366)", { skip: skipReason || undefined }, async () => {
  const database = await createModelsWindowFixture()
  const clampedMetrics = queryModelMetrics(database, 1000)!

  // 1000 days would include the 400-day-old step without the clamp.
  assert.ok(!modelIdsOf(clampedMetrics).includes("model/ancient"), "the 400-day step is outside the clamped window")
  assert.ok(modelIdsOf(clampedMetrics).includes("model/edge"), "the 300-day step is inside the clamped window")
  assert.deepEqual(clampedMetrics, queryModelMetrics(database, 366)!, "clamped days and the bound itself agree exactly")
})

test("queryModelMetrics treats days=1 as local midnight of today: only today's step stays", { skip: skipReason || undefined }, async () => {
  const database = await createModelsWindowFixture()
  const modelMetrics = queryModelMetrics(database, 1)!

  assert.deepEqual(modelIdsOf(modelMetrics), ["model/current"])
  assert.equal(stepsOf(modelMetrics, "model/current"), 1, "the 3-day-ago step is outside days=1")
})

test("queryModelMetrics falls back to the full history for illegal days values (0, negative, NaN)", { skip: skipReason || undefined }, async () => {
  const database = await createModelsWindowFixture()
  const fullHistoryMetrics = queryModelMetrics(database)!

  assert.deepEqual(queryModelMetrics(database, 0)!, fullHistoryMetrics, "days=0 means full history, not an empty leaderboard")
  assert.deepEqual(queryModelMetrics(database, -5)!, fullHistoryMetrics)
  assert.deepEqual(queryModelMetrics(database, Number.NaN)!, fullHistoryMetrics)
})

test("queryModelMetrics returns null without a db connection regardless of days", () => {
  assert.equal(queryModelMetrics(null), null)
  assert.equal(queryModelMetrics(null, 7), null)
})

// ---------------------------------------------------------------------------
// 环比 comparison (queryModelMetricsComparison, B-part-2)
// ---------------------------------------------------------------------------

test("queryModelMetricsComparison carries the previous equal-length window's token total per composite key", { skip: skipReason || undefined }, async () => {
  const database = await createModelComparisonFixture()
  const comparison = queryModelMetricsComparison(database, 7)!
  const rowByModelId = new Map(comparison.map((row) => [row.modelId, row]))

  assert.deepEqual(
    [...rowByModelId.keys()].sort(),
    ["model/boundary", "model/fresh", "model/steady"],
    "only current-window models form rows (the previous-only model disappears)",
  )
  assert.equal(rowByModelId.get("model/steady")!.tokens, 200)
  assert.equal(
    rowByModelId.get("model/steady")!.previousTokens,
    200,
    "the 9-days-ago step lands in the previous equal-length window",
  )
  assert.equal(
    rowByModelId.get("model/boundary")!.tokens,
    200,
    "the current first day counts in the current window only",
  )
  assert.equal(
    rowByModelId.get("model/boundary")!.previousTokens,
    200,
    "the previous last day counts in the previous window only — no double count",
  )
  assert.equal(
    rowByModelId.get("model/fresh")!.previousTokens,
    0,
    "a model present only in the current window gets 0",
  )
})

test("queryModelMetricsComparison keeps offset-0 parity with queryModelMetrics", { skip: skipReason || undefined }, async () => {
  const database = await createModelComparisonFixture()
  const comparison = queryModelMetricsComparison(database, 7)!
  const withoutPrevious = comparison.map(({ previousTokens: _previousTokens, ...metric }) => metric)
  assert.deepEqual(
    withoutPrevious,
    queryModelMetrics(database, 7)!,
    "the current-window rows are byte-identical once previousTokens is stripped",
  )
})

test("queryModelMetricsComparison degrades full history to previousTokens 0", { skip: skipReason || undefined }, async () => {
  const database = await createModelComparisonFixture()
  const comparison = queryModelMetricsComparison(database, undefined)!
  assert.ok(comparison.length > 0)
  for (const row of comparison) {
    assert.equal(row.previousTokens, 0, "full history has no previous equal-length window")
  }
  const withoutPrevious = comparison.map(({ previousTokens: _previousTokens, ...metric }) => metric)
  assert.deepEqual(withoutPrevious, queryModelMetrics(database)!)
})

test("queryModelMetricsComparison returns null without a db connection", () => {
  assert.equal(queryModelMetricsComparison(null, 7), null)
  assert.equal(queryModelMetricsComparison(null, undefined), null)
})

// ---------------------------------------------------------------------------
// Route level (parameter trio: parse / clamp / key)
// ---------------------------------------------------------------------------

function modelsRouteContextWithQuery(
  query: string,
  database: SqliteReadConnection,
): ApiRequestContext {
  const route = matchApiRoute("/api/models")
  assert.notEqual(route, null, "/api/models must match a route")
  return {
    route: route!,
    searchParams: new URLSearchParams(query),
    database,
    databasePath: "test://models-days-window",
    serverPort: 18789,
  }
}

function fakeModelsWindowDatabase(): SqliteReadConnection {
  const scenario: FakeInsightDatabaseScenario = {
    sessions: [],
    messagesBySessionId: {
      ses_models_window_route: [
        { type: "assistant", data: { tokens: { input: 1 } }, timeCreated: Date.now() },
        { type: "assistant", data: { tokens: { input: 1 } }, timeCreated: Date.now() - 10 * DAY_MS },
      ],
    },
    systemPromptBySessionId: {},
  }
  return createFakeInsightDatabase(scenario)
}

test("/api/models keeps answering the full-history leaderboard when days is missing or garbage", () => {
  clearResultCache()
  try {
    const fakeDatabase = fakeModelsWindowDatabase()
    const fullHistoryResponse = handleApiRequest(
      modelsRouteContextWithQuery("", fakeDatabase),
    )
    assert.equal(fullHistoryResponse.statusCode, 200)
    const fullHistoryMetrics = fullHistoryResponse.body as Array<{ steps: number }>
    assert.equal(fullHistoryMetrics.length, 1, "both fixture steps fold into the single unknown-model row")
    assert.equal(fullHistoryMetrics[0].steps, 2, "no window → the 10-day-old step still counts")

    for (const garbageQuery of ["days=not-a-number", "days=0", "days=-5", "days="]) {
      const garbageResponse = handleApiRequest(
        modelsRouteContextWithQuery(garbageQuery, fakeDatabase),
      )
      assert.equal(garbageResponse.statusCode, 200)
      const garbageMetrics = garbageResponse.body as Array<{ steps: number }>
      assert.equal(garbageMetrics[0].steps, 2, `?${garbageQuery} means full history`)
    }
    assert.equal(resultCacheSize(), 1, "garbage and missing days all share the full-history cache entry")
  } finally {
    clearResultCache()
  }
})

test("/api/models?days=7 answers the windowed leaderboard", () => {
  clearResultCache()
  try {
    const fakeDatabase = fakeModelsWindowDatabase()
    const windowedResponse = handleApiRequest(
      modelsRouteContextWithQuery("days=7", fakeDatabase),
    )
    assert.equal(windowedResponse.statusCode, 200)
    const windowedMetrics = windowedResponse.body as Array<{ steps: number }>
    assert.equal(windowedMetrics[0].steps, 1, "the 10-day-old step is outside the 7-day window")
  } finally {
    clearResultCache()
  }
})

test("/api/models?days= returns rows carrying the previous-window token base (previousTokens)", () => {
  clearResultCache()
  try {
    const fakeDatabase = fakeModelsWindowDatabase()
    const windowedResponse = handleApiRequest(
      modelsRouteContextWithQuery("days=7", fakeDatabase),
    )
    assert.equal(windowedResponse.statusCode, 200)
    const windowedMetrics = windowedResponse.body as Array<{
      tokens: number
      previousTokens: number
    }>
    assert.equal(windowedMetrics.length, 1)
    assert.ok(
      "previousTokens" in windowedMetrics[0],
      "the route response now carries the comparison field",
    )
    assert.ok(
      Number.isFinite(windowedMetrics[0].previousTokens),
      "every route row carries a finite previousTokens",
    )
    assert.ok(windowedMetrics[0].previousTokens >= 0)
  } finally {
    clearResultCache()
  }
})

test("/api/models clamp-before-key: ?days=1000 shares the 366 entry, garbage shares the no-window entry", () => {
  clearResultCache()
  try {
    const fakeDatabase = fakeModelsWindowDatabase()
    handleApiRequest(modelsRouteContextWithQuery("", fakeDatabase))
    assert.equal(resultCacheSize(), 1, "the full-history call owns one entry")

    handleApiRequest(modelsRouteContextWithQuery("days=7", fakeDatabase))
    assert.equal(resultCacheSize(), 2, "the 7-day window is its own entry")

    handleApiRequest(modelsRouteContextWithQuery("days=1000", fakeDatabase))
    handleApiRequest(modelsRouteContextWithQuery("days=366", fakeDatabase))
    assert.equal(resultCacheSize(), 3, "clamped days and the bound itself share one entry (P2-6)")

    handleApiRequest(modelsRouteContextWithQuery("days=7", fakeDatabase))
    assert.equal(resultCacheSize(), 3, "a repeat window call hits the existing entry")
  } finally {
    clearResultCache()
  }
})

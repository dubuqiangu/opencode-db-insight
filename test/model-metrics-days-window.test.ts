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

import { queryModelMetrics } from "../src/db/aggregate-queries.ts"
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

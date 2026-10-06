/**
 * Tests for the API dispatch contract (src/web/api.ts) with a null database:
 * 503 for data routes, always-200 health with dbStatus (DESIGN.md §9).
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import { mock } from "node:test"

import {
  DATABASE_UNAVAILABLE_MESSAGE,
  handleApiRequest,
  INSIGHT_VERSION,
  INTERNAL_ERROR_MESSAGE,
  SESSION_EMPTY_MESSAGE,
  SESSION_NOT_FOUND_MESSAGE,
  type ApiRequestContext,
} from "../src/web/api.ts"
import type { SqliteReadConnection } from "../src/db/types.ts"
import { matchApiRoute } from "../src/web/router.ts"
import { clearResultCache, resultCacheSize } from "../src/stats/cache.ts"
import {
  buildFakeSessionSummary,
  createFakeInsightDatabase,
} from "./helpers/fake-insight-db.ts"

function requestContextFor(pathname: string): ApiRequestContext | null {
  const route = matchApiRoute(pathname)
  if (route === null) return null
  return {
    route,
    searchParams: new URLSearchParams(),
    database: null,
    databasePath: "test://no-database",
    serverPort: 18789,
  }
}

test("every data route answers 503 with the unavailable error when the db is missing", () => {
  const dataRoutePathnames = [
    "/api/overview",
    "/api/trend",
    "/api/models",
    "/api/agents",
    "/api/sessions",
    "/api/todo",
    "/api/hour-heatmap",
    "/api/session-survival",
    "/api/compaction",
    "/api/directories",
    "/api/session/ses_example/messages",
    "/api/session/ses_example/system-prompt",
  ]
  for (const pathname of dataRoutePathnames) {
    const requestContext = requestContextFor(pathname)
    assert.notEqual(requestContext, null, `route failed to match: ${pathname}`)
    const apiResponse = handleApiRequest(requestContext!)
    assert.equal(
      apiResponse.statusCode,
      503,
      `${pathname} must answer 503 while the db is unavailable`,
    )
    assert.deepEqual(apiResponse.body, { error: DATABASE_UNAVAILABLE_MESSAGE })
  }
})

test("health answers 200 with dbStatus unavailable and the bound port while the db is missing", () => {
  const requestContext = requestContextFor("/api/health")
  assert.notEqual(requestContext, null)
  const apiResponse = handleApiRequest(requestContext!)
  assert.equal(apiResponse.statusCode, 200)
  assert.deepEqual(apiResponse.body, {
    status: "ok",
    version: INSIGHT_VERSION,
    port: 18789,
    dbStatus: "unavailable",
    dbPath: "test://no-database",
  })
})

test("trend keeps the 30-day default when the days parameter is garbage", () => {
  const route = matchApiRoute("/api/trend")
  assert.notEqual(route, null)
  const apiResponse = handleApiRequest({
    route: route!,
    searchParams: new URLSearchParams("days=not-a-number"),
    database: null,
    databasePath: "test://no-database",
    serverPort: 18789,
  })
  // db unavailable short-circuits before parsing — the point here is that
  // bad parameters never throw on the way to the 503.
  assert.equal(apiResponse.statusCode, 503)
})

function apiContextFor(
  pathname: string,
  database: SqliteReadConnection,
): ApiRequestContext {
  const route = matchApiRoute(pathname)
  assert.notEqual(route, null, `route failed to match: ${pathname}`)
  return {
    route: route!,
    searchParams: new URLSearchParams(),
    database,
    databasePath: "test://wired-database",
    serverPort: 18789,
  }
}

test("health reports dbStatus ok when the live SELECT 1 probe succeeds (P1-4)", () => {
  const liveDatabase = createFakeInsightDatabase({
    sessions: [],
    messagesBySessionId: {},
    systemPromptBySessionId: {},
  })

  const apiResponse = handleApiRequest(apiContextFor("/api/health", liveDatabase))

  assert.equal(apiResponse.statusCode, 200)
  assert.deepEqual(apiResponse.body, {
    status: "ok",
    version: INSIGHT_VERSION,
    port: 18789,
    dbStatus: "ok",
    dbPath: "test://wired-database",
  })
})

test("health stays 200 but reports dbStatus unavailable when the probe fails (P1-4)", () => {
  // A non-null connection whose statements all fail — e.g. the db file was
  // deleted or corrupted after the server started.
  const deadDatabase: SqliteReadConnection = {
    prepare: () => {
      throw new Error("database is not open")
    },
    close: () => {},
  }

  const apiResponse = handleApiRequest(apiContextFor("/api/health", deadDatabase))

  assert.equal(apiResponse.statusCode, 200)
  assert.deepEqual(apiResponse.body, {
    status: "ok",
    version: INSIGHT_VERSION,
    port: 18789,
    dbStatus: "unavailable",
    dbPath: "test://wired-database",
  })
})

test("sessionMessages distinguishes empty sessions from unknown ids (P2-7)", () => {
  clearResultCache()
  try {
    const fakeDatabase = createFakeInsightDatabase({
      sessions: [buildFakeSessionSummary({ id: "ses_exists_but_empty" })],
      messagesBySessionId: {},
      systemPromptBySessionId: {},
    })

    // Session row exists in session_v2, yet carries zero messages.
    const emptySessionResponse = handleApiRequest(
      apiContextFor("/api/session/ses_exists_but_empty/messages", fakeDatabase),
    )
    assert.equal(emptySessionResponse.statusCode, 404)
    assert.deepEqual(emptySessionResponse.body, { error: SESSION_EMPTY_MESSAGE })

    // Unknown id: neither a session row nor messages.
    const unknownSessionResponse = handleApiRequest(
      apiContextFor("/api/session/ses_never_heard_of/messages", fakeDatabase),
    )
    assert.equal(unknownSessionResponse.statusCode, 404)
    assert.deepEqual(unknownSessionResponse.body, { error: SESSION_NOT_FOUND_MESSAGE })
  } finally {
    clearResultCache()
  }
})

test("unexpected query errors answer an opaque 500 and only log the cause (P2-11)", () => {
  clearResultCache()
  const consoleErrorMock = mock.method(console, "error", () => {})
  try {
    const failingDatabase: SqliteReadConnection = {
      prepare: (sql: string) => {
        if (sql.includes("FROM session_message")) {
          throw new Error("fake db: corrupt b-tree page in session_message")
        }
        throw new Error(`fake db: unexpected SQL: ${sql}`)
      },
      close: () => {},
    }

    const apiResponse = handleApiRequest(
      apiContextFor("/api/session/ses_probe/messages", failingDatabase),
    )

    assert.equal(apiResponse.statusCode, 500)
    assert.deepEqual(apiResponse.body, { error: INTERNAL_ERROR_MESSAGE })
    assert.ok(consoleErrorMock.mock.calls.length >= 1, "the real cause must be logged")
    assert.match(
      String(consoleErrorMock.mock.calls[0].arguments[0]),
      /api query failed/,
    )
  } finally {
    consoleErrorMock.mock.restore()
    clearResultCache()
  }
})

test("v0.2-A behavior routes are registered and answer 200 with a live database", () => {
  clearResultCache()
  try {
    const fakeDatabase = createFakeInsightDatabase({
      sessions: [
        buildFakeSessionSummary({ id: "ses_behavior_route", timeCreated: 0, timeUpdated: 10 * 60_000 }),
      ],
      messagesBySessionId: {
        ses_behavior_route: [{ type: "assistant", data: {}, timeCreated: Date.now() - 60_000 }],
      },
      systemPromptBySessionId: {},
      idleOutcomeBySessionId: { ses_behavior_route: "archived" },
      compactionMessages: [
        { sessionId: "ses_behavior_route", data: { status: "completed", reason: "auto", summary: "x" } },
      ],
    })

    // /api/hour-heatmap → bare 168-cell array body.
    const heatmapResponse = handleApiRequest(apiContextFor("/api/hour-heatmap", fakeDatabase))
    assert.equal(heatmapResponse.statusCode, 200)
    assert.ok(Array.isArray(heatmapResponse.body), "heatmap body is a bare array")
    assert.equal((heatmapResponse.body as unknown[]).length, 168)

    // /api/hour-heatmap?days=<garbage> keeps the 90-day default and still
    // answers a bare 200 body.
    const heatmapRoute = matchApiRoute("/api/hour-heatmap")
    assert.notEqual(heatmapRoute, null)
    const heatmapDefaultDaysResponse = handleApiRequest({
      route: heatmapRoute!,
      searchParams: new URLSearchParams("days=not-a-number"),
      database: fakeDatabase,
      databasePath: "test://wired-database",
      serverPort: 18789,
    })
    assert.equal(heatmapDefaultDaysResponse.statusCode, 200)
    assert.equal((heatmapDefaultDaysResponse.body as unknown[]).length, 168)

    // /api/session-survival → bare survival object body.
    const survivalResponse = handleApiRequest(apiContextFor("/api/session-survival", fakeDatabase))
    assert.equal(survivalResponse.statusCode, 200)
    assert.deepEqual(survivalResponse.body, {
      totalSessions: 1,
      medianDurationSeconds: 600,
      shortLivedShare: 0,
      idleOutcomeCounts: { archived: 1 },
    })

    // /api/compaction → bare compaction object body.
    const compactionResponse = handleApiRequest(apiContextFor("/api/compaction", fakeDatabase))
    assert.equal(compactionResponse.statusCode, 200)
    const compactionBody = compactionResponse.body as Record<string, unknown>
    assert.equal(compactionBody["total"], 1)
    assert.deepEqual(compactionBody["byReason"], { auto: 1 })
    assert.equal(
      (compactionBody["recentDaily"] as unknown[]).length,
      30,
    )
    assert.deepEqual(compactionBody["topSessions"], [
      { sessionId: "ses_behavior_route", count: 1 },
    ])
  } finally {
    clearResultCache()
  }
})

test("trend and hour-heatmap cache keys clamp days to the 366-day bound (P2-6)", () => {
  clearResultCache()
  try {
    const fakeDatabase = createFakeInsightDatabase({
      sessions: [buildFakeSessionSummary({ id: "ses_cache_clamp" })],
      messagesBySessionId: {
        ses_cache_clamp: [{ type: "assistant", data: {}, timeCreated: Date.now() - 60_000 }],
      },
      systemPromptBySessionId: {},
    })

    const trendRoute = matchApiRoute("/api/trend")!
    const heatmapRoute = matchApiRoute("/api/hour-heatmap")!
    const contextWithDays = (route: typeof trendRoute, days: string): ApiRequestContext => ({
      route,
      searchParams: new URLSearchParams(`days=${days}`),
      database: fakeDatabase,
      databasePath: "test://wired-database",
      serverPort: 18789,
    })

    // Warm the entry with the absurd value, then hit it with the clamp
    // bound: identical clamped key → still exactly one cache entry per
    // route, and the responses agree (same underlying window).
    const absurdTrendResponse = handleApiRequest(contextWithDays(trendRoute, "1000"))
    const boundedTrendResponse = handleApiRequest(contextWithDays(trendRoute, "366"))
    assert.equal(absurdTrendResponse.statusCode, 200)
    assert.equal(boundedTrendResponse.statusCode, 200)
    assert.deepEqual(boundedTrendResponse.body, absurdTrendResponse.body)

    const absurdHeatmapResponse = handleApiRequest(contextWithDays(heatmapRoute, "1000"))
    const boundedHeatmapResponse = handleApiRequest(contextWithDays(heatmapRoute, "366"))
    assert.equal(absurdHeatmapResponse.statusCode, 200)
    assert.equal(boundedHeatmapResponse.statusCode, 200)
    assert.deepEqual(boundedHeatmapResponse.body, absurdHeatmapResponse.body)

    // 2 routes × 1 clamped entry each — days=1000 did NOT spray a
    // near-duplicate entry next to the days=366 one.
    assert.equal(resultCacheSize(), 2)

    // A genuinely different window still gets its own entry.
    handleApiRequest(contextWithDays(heatmapRoute, "90"))
    assert.equal(resultCacheSize(), 3)
  } finally {
    clearResultCache()
  }
})

test("v0.3-A directories route is registered and answers 200 with the contract body", () => {
  clearResultCache()
  try {
    const fakeDatabase = createFakeInsightDatabase({
      sessions: [
        buildFakeSessionSummary({
          id: "ses_directory_route",
          directory: "D:/projects/example-alpha",
          timeCreated: 1000,
          timeUpdated: 2000,
        }),
        // NULL directory: excluded from the list and both totals.
        buildFakeSessionSummary({
          id: "ses_directory_route_null",
          directory: "D:/overridden",
          timeCreated: 1000,
          timeUpdated: 2000,
        }),
      ],
      messagesBySessionId: {
        ses_directory_route: [
          { type: "assistant", data: {}, timeCreated: Date.now() - 60_000 },
          { type: "assistant", data: {}, timeCreated: Date.now() - 30_000 },
        ],
        ses_directory_route_null: [
          { type: "assistant", data: {}, timeCreated: Date.now() - 60_000 },
        ],
      },
      systemPromptBySessionId: {},
      directoryColumnBySessionId: { ses_directory_route_null: null },
    })

    const directoriesResponse = handleApiRequest(apiContextFor("/api/directories", fakeDatabase))
    assert.equal(directoriesResponse.statusCode, 200)
    assert.deepEqual(directoriesResponse.body, {
      totalDirectories: 1,
      totalSessions: 1,
      directories: [
        {
          directory: "D:/projects/example-alpha",
          name: "example-alpha",
          sessions: 1,
          steps: 2,
          lastActiveMs: 2000,
        },
      ],
    })

    // ?limit=<garbage> keeps the default 10; ?limit=1 truncates the list
    // while the totals stay full (they are never clamped).
    const directoriesRoute = matchApiRoute("/api/directories")!
    const garbageLimitResponse = handleApiRequest({
      route: directoriesRoute,
      searchParams: new URLSearchParams("limit=not-a-number"),
      database: fakeDatabase,
      databasePath: "test://wired-database",
      serverPort: 18789,
    })
    assert.equal(garbageLimitResponse.statusCode, 200)
    assert.equal(
      ((garbageLimitResponse.body as Record<string, unknown>)["directories"] as unknown[]).length,
      1,
    )

    const singleLimitResponse = handleApiRequest({
      route: directoriesRoute,
      searchParams: new URLSearchParams("limit=1"),
      database: fakeDatabase,
      databasePath: "test://wired-database",
      serverPort: 18789,
    })
    assert.equal(singleLimitResponse.statusCode, 200)
    const singleLimitBody = singleLimitResponse.body as Record<string, unknown>
    assert.equal((singleLimitBody["directories"] as unknown[]).length, 1)
    assert.equal(singleLimitBody["totalDirectories"], 1)
    assert.equal(singleLimitBody["totalSessions"], 1)
  } finally {
    clearResultCache()
  }
})

test("directories cache keys clamp limit to the 50-row bound (P2-6 discipline)", () => {
  clearResultCache()
  try {
    const fakeDatabase = createFakeInsightDatabase({
      sessions: [
        buildFakeSessionSummary({ id: "ses_directory_cache", directory: "D:/cache-clamp" }),
      ],
      messagesBySessionId: {
        ses_directory_cache: [{ type: "assistant", data: {}, timeCreated: Date.now() - 60_000 }],
      },
      systemPromptBySessionId: {},
    })

    const directoriesRoute = matchApiRoute("/api/directories")!
    const contextWithLimit = (limit: string): ApiRequestContext => ({
      route: directoriesRoute,
      searchParams: new URLSearchParams(`limit=${limit}`),
      database: fakeDatabase,
      databasePath: "test://wired-database",
      serverPort: 18789,
    })

    // Warm with the absurd value, then hit the clamp bound: the key must
    // collide (one entry), and the responses agree.
    const absurdLimitResponse = handleApiRequest(contextWithLimit("999"))
    const boundedLimitResponse = handleApiRequest(contextWithLimit("50"))
    assert.equal(absurdLimitResponse.statusCode, 200)
    assert.equal(boundedLimitResponse.statusCode, 200)
    assert.deepEqual(boundedLimitResponse.body, absurdLimitResponse.body)
    assert.equal(resultCacheSize(), 1, "?limit=999 and ?limit=50 share one clamped entry")

    // A genuinely different limit gets its own entry.
    handleApiRequest(contextWithLimit("10"))
    assert.equal(resultCacheSize(), 2)
  } finally {
    clearResultCache()
  }
})

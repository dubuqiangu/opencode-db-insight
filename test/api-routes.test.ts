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
  INVALID_RANGE_MESSAGE,
  SESSION_EMPTY_MESSAGE,
  SESSION_NOT_FOUND_MESSAGE,
  type ApiRequestContext,
} from "../src/web/api.ts"
import type { SqliteReadConnection } from "../src/db/types.ts"
import { matchApiRoute } from "../src/web/router.ts"
import { clearResultCache, resultCacheSize } from "../src/stats/cache.ts"
import {
  SESSION_SUMMARY_CSV_CONTENT_TYPE,
  SESSION_SUMMARY_CSV_FILENAME,
  SESSION_SUMMARY_CSV_HEADER,
} from "../src/web/session-summary-csv.ts"
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
    "/api/export/sessions.csv",
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
          // v0.15.0 token sums: the builder default components
          // (100000/20000/3456), once per session — the 2 steps must
          // NOT multiply them.
          tokensInput: 100000,
          tokensOutput: 20000,
          tokensCacheRead: 3456,
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

test("sessions with sort/order parameters still answers 503 while the db is missing", () => {
  const sessionsRoute = matchApiRoute("/api/sessions")
  assert.notEqual(sessionsRoute, null)
  const apiResponse = handleApiRequest({
    route: sessionsRoute!,
    searchParams: new URLSearchParams("sort=%3B%20DROP%20TABLE&order=garbage"),
    database: null,
    databasePath: "test://no-database",
    serverPort: 18789,
  })
  // The db-unavailable short-circuit happens before any parameter
  // parsing — hostile sort/order text must never even reach the resolvers
  // on the way to the 503.
  assert.equal(apiResponse.statusCode, 503)
  assert.deepEqual(apiResponse.body, { error: DATABASE_UNAVAILABLE_MESSAGE })
})

test("sessions cache keys carry resolved sort/order: distinct combos get entries, garbage shares the default (v0.2-B)", () => {
  clearResultCache()
  try {
    const fakeDatabase = createFakeInsightDatabase({
      sessions: [
        buildFakeSessionSummary({ id: "ses_sort_cache_1", timeCreated: 1000, timeUpdated: 2000 }),
        buildFakeSessionSummary({ id: "ses_sort_cache_2", timeCreated: 3000, timeUpdated: 4000 }),
      ],
      messagesBySessionId: {},
      systemPromptBySessionId: {},
    })

    const sessionsRoute = matchApiRoute("/api/sessions")!
    const contextWithQuery = (queryString: string): ApiRequestContext => ({
      route: sessionsRoute,
      searchParams: new URLSearchParams(queryString),
      database: fakeDatabase,
      databasePath: "test://wired-database",
      serverPort: 18789,
    })

    // The default entry (limit 50, offset 0, time_updated desc).
    handleApiRequest(contextWithQuery(""))
    assert.equal(resultCacheSize(), 1)

    // Each distinct whitelisted combination gets its own entry.
    handleApiRequest(contextWithQuery("sort=cost"))
    assert.equal(resultCacheSize(), 2, "sort=cost is its own cache entry")
    handleApiRequest(contextWithQuery("order=asc"))
    assert.equal(resultCacheSize(), 3, "order=asc is its own cache entry")
    handleApiRequest(contextWithQuery("sort=cost&order=asc"))
    assert.equal(resultCacheSize(), 4, "the cost/asc combination is its own entry")
    handleApiRequest(contextWithQuery("sort=tokens&order=asc"))
    assert.equal(resultCacheSize(), 5)

    // Explicit defaults and every garbage variant resolve onto the very
    // same key as the no-parameter call — illegal input never sprays
    // near-duplicate entries.
    handleApiRequest(contextWithQuery("sort=time_updated&order=desc"))
    handleApiRequest(contextWithQuery("sort=%3B%20DROP%20TABLE%20session_v2%20--"))
    handleApiRequest(contextWithQuery("order=DESC%3B%20DROP%20TABLE%20session_v2"))
    handleApiRequest(contextWithQuery("sort=unknown_sort_key&order=garbage"))
    assert.equal(resultCacheSize(), 5, "defaults and garbage share the default key")
  } finally {
    clearResultCache()
  }
})

test("/api/refresh clears the process-local cache and reports the evicted count (v0.14.0)", () => {
  clearResultCache()
  try {
    const fakeDatabase = createFakeInsightDatabase({
      sessions: [buildFakeSessionSummary({ id: "ses_refresh_route" })],
      messagesBySessionId: {},
      systemPromptBySessionId: {},
    })
    // Warm three distinct cache entries through three distinct routes.
    handleApiRequest(apiContextFor("/api/overview", fakeDatabase))
    handleApiRequest(apiContextFor("/api/models", fakeDatabase))
    handleApiRequest(apiContextFor("/api/agents", fakeDatabase))
    const warmCacheSize = resultCacheSize()
    assert.ok(warmCacheSize >= 3, "the warming requests actually cached something")

    const refreshResponse = handleApiRequest(apiContextFor("/api/refresh", fakeDatabase))
    assert.equal(refreshResponse.statusCode, 200)
    assert.deepEqual(refreshResponse.body, { status: "ok", cleared: warmCacheSize })
    assert.equal(resultCacheSize(), 0, "every cached entry is gone")
    // The refresh route itself must not consume a cache slot.
    assert.equal(resultCacheSize(), 0, "handling the refresh created no new cache entry")
  } finally {
    clearResultCache()
  }
})

test("/api/refresh answers 200 even while the db is missing (cache control needs no db)", () => {
  clearResultCache()
  try {
    // Warm one entry through a wired fake db first, so the count is
    // observable and non-zero.
    const warmDatabase = createFakeInsightDatabase({
      sessions: [buildFakeSessionSummary({ id: "ses_refresh_no_db" })],
      messagesBySessionId: {},
      systemPromptBySessionId: {},
    })
    handleApiRequest(apiContextFor("/api/overview", warmDatabase))
    const warmCacheSize = resultCacheSize()
    assert.ok(warmCacheSize >= 1)

    // db null: the refresh route must NOT take the 503 short-circuit —
    // clearing the cache never needed a database.
    const refreshResponse = handleApiRequest(requestContextFor("/api/refresh")!)
    assert.notEqual(refreshResponse, null)
    assert.equal(refreshResponse.statusCode, 200)
    assert.deepEqual(refreshResponse.body, { status: "ok", cleared: warmCacheSize })
    assert.equal(resultCacheSize(), 0)
  } finally {
    clearResultCache()
  }
})

test("after a refresh the cached routes immediately reflect new data (v0.14.0 behavior lock)", () => {
  clearResultCache()
  try {
    const beforeRefreshDatabase = createFakeInsightDatabase({
      sessions: [buildFakeSessionSummary({ id: "ses_refresh_before" })],
      messagesBySessionId: {},
      systemPromptBySessionId: {},
    })
    const afterRefreshDatabase = createFakeInsightDatabase({
      sessions: [buildFakeSessionSummary({ id: "ses_refresh_after" })],
      messagesBySessionId: {},
      systemPromptBySessionId: {},
    })

    const firstResponse = handleApiRequest(apiContextFor("/api/sessions", beforeRefreshDatabase))
    assert.equal(firstResponse.statusCode, 200)

    // Same cache key, different (fresher) database: the 60s TTL still
    // serves the stale page — this is the exact symptom /insight-refresh
    // exists to fix.
    const staleResponse = handleApiRequest(apiContextFor("/api/sessions", afterRefreshDatabase))
    assert.deepEqual(staleResponse.body, firstResponse.body, "TTL window serves the cached page")

    // One refresh later, the very same request sees the new data.
    const refreshResponse = handleApiRequest(apiContextFor("/api/refresh", afterRefreshDatabase))
    assert.equal(refreshResponse.statusCode, 200)
    assert.equal(
      (refreshResponse.body as { cleared: number }).cleared,
      1,
      "exactly the one warmed entry was evicted",
    )
    const freshResponse = handleApiRequest(apiContextFor("/api/sessions", afterRefreshDatabase))
    assert.deepEqual(
      (freshResponse.body as { id: string }[]).map((sessionSummary) => sessionSummary.id),
      ["ses_refresh_after"],
      "cleared cache means immediately visible new data",
    )
  } finally {
    clearResultCache()
  }
})

test("sessions with a directory parameter still answers 503 while the db is missing", () => {
  const sessionsRoute = matchApiRoute("/api/sessions")
  assert.notEqual(sessionsRoute, null)
  const apiResponse = handleApiRequest({
    route: sessionsRoute!,
    searchParams: new URLSearchParams("directory=%27%20OR%20%271%27%3D%271"),
    database: null,
    databasePath: "test://no-database",
    serverPort: 18789,
  })
  // The db-unavailable short-circuit happens before any parameter
  // parsing — hostile directory text must never even reach the query
  // layer on the way to the 503.
  assert.equal(apiResponse.statusCode, 503)
  assert.deepEqual(apiResponse.body, { error: DATABASE_UNAVAILABLE_MESSAGE })
})

test("sessions route serves directory-filtered requests with 200 and the exact-match subset (v0.7.0)", () => {
  clearResultCache()
  try {
    const fakeDatabase = createFakeInsightDatabase({
      sessions: [
        buildFakeSessionSummary({
          id: "ses_directory_drill_alpha",
          directory: "D:/projects/example-alpha",
          timeCreated: 1000,
          timeUpdated: 2000,
        }),
        buildFakeSessionSummary({
          id: "ses_directory_drill_beta",
          directory: "D:/projects/example-beta",
          timeCreated: 3000,
          timeUpdated: 4000,
        }),
      ],
      messagesBySessionId: {},
      systemPromptBySessionId: {},
    })
    const sessionsRoute = matchApiRoute("/api/sessions")!
    const contextWithQuery = (queryString: string): ApiRequestContext => ({
      route: sessionsRoute,
      searchParams: new URLSearchParams(queryString),
      database: fakeDatabase,
      databasePath: "test://wired-database",
      serverPort: 18789,
    })

    const filteredResponse = handleApiRequest(
      contextWithQuery("directory=D%3A%2Fprojects%2Fexample-beta"),
    )
    assert.equal(filteredResponse.statusCode, 200)
    assert.deepEqual(
      (filteredResponse.body as { id: string }[]).map((sessionSummary) => sessionSummary.id),
      ["ses_directory_drill_beta"],
      "the drill-down returns only the exact-match row",
    )
  } finally {
    clearResultCache()
  }
})

test("sessions route passes the session_v2 token components through per-field, folding `tokens` unchanged (v0.13.0)", () => {
  clearResultCache()
  try {
    // Two deliberately different component distributions: alpha is
    // cache-read-heavy, bravo is input-heavy, and both differ from the
    // fake's defaults. Any passthrough mistake (folding all three into
    // tokens_input, or swapping two columns) breaks a per-field
    // assertion here instead of hiding inside the folded total.
    const alphaSummary = buildFakeSessionSummary({
      id: "ses_tokens_route_alpha",
      tokensInput: 100,
      tokensOutput: 300,
      tokensCacheRead: 500,
      tokens: 900,
    })
    const bravoSummary = buildFakeSessionSummary({
      id: "ses_tokens_route_bravo",
      tokensInput: 900,
      tokensOutput: 90,
      tokensCacheRead: 9,
      tokens: 999,
    })
    const fakeDatabase = createFakeInsightDatabase({
      sessions: [alphaSummary, bravoSummary],
      messagesBySessionId: {},
      systemPromptBySessionId: {},
    })

    const apiResponse = handleApiRequest(apiContextFor("/api/sessions", fakeDatabase))
    assert.equal(apiResponse.statusCode, 200)

    const servedSummaries = apiResponse.body as {
      id: string
      tokens: number
      tokensInput: number
      tokensOutput: number
      tokensCacheRead: number
    }[]
    assert.deepEqual(
      servedSummaries.map((servedSummary) => servedSummary.id),
      ["ses_tokens_route_alpha", "ses_tokens_route_bravo"],
    )

    for (const expectedSummary of [alphaSummary, bravoSummary]) {
      const servedSummary = servedSummaries.find(
        (candidate) => candidate.id === expectedSummary.id,
      )
      assert.notEqual(servedSummary, undefined)
      // Per-field passthrough of the session_v2 summary columns.
      assert.equal(servedSummary!.tokensInput, expectedSummary.tokensInput)
      assert.equal(servedSummary!.tokensOutput, expectedSummary.tokensOutput)
      assert.equal(servedSummary!.tokensCacheRead, expectedSummary.tokensCacheRead)
      // The folded `tokens` keeps its original computation: the sum of
      // the same three coerced columns, value-for-value.
      assert.equal(servedSummary!.tokens, expectedSummary.tokens)
      assert.equal(
        servedSummary!.tokens,
        servedSummary!.tokensInput + servedSummary!.tokensOutput + servedSummary!.tokensCacheRead,
      )
    }
  } finally {
    clearResultCache()
  }
})

test("sessions cache keys carry the directory dimension: distinct values get entries, empty string shares the default key (v0.7.0)", () => {
  clearResultCache()
  try {
    const fakeDatabase = createFakeInsightDatabase({
      sessions: [
        buildFakeSessionSummary({
          id: "ses_directory_cache",
          directory: "D:/projects/example-alpha",
          timeCreated: 1000,
          timeUpdated: 2000,
        }),
      ],
      messagesBySessionId: {},
      systemPromptBySessionId: {},
    })
    const sessionsRoute = matchApiRoute("/api/sessions")!
    const contextWithQuery = (queryString: string): ApiRequestContext => ({
      route: sessionsRoute,
      searchParams: new URLSearchParams(queryString),
      database: fakeDatabase,
      databasePath: "test://wired-database",
      serverPort: 18789,
    })

    // The default entry (directory "" — the no-filter request).
    handleApiRequest(contextWithQuery(""))
    assert.equal(resultCacheSize(), 1)

    // Each distinct directory value gets its own entry.
    handleApiRequest(contextWithQuery("directory=D%3A%2Fprojects%2Fexample-alpha"))
    assert.equal(resultCacheSize(), 2, "one entry per directory value")
    handleApiRequest(contextWithQuery("directory=D%3A%2Fprojects%2Fexample-beta"))
    assert.equal(resultCacheSize(), 3, "a second directory value is its own entry")

    // Combinations with other dimensions stay distinct entries too.
    handleApiRequest(contextWithQuery("directory=D%3A%2Fprojects%2Fexample-alpha&sort=cost"))
    assert.equal(resultCacheSize(), 4, "directory + sort is its own entry")

    // An empty ?directory= shares the "no filter" key with no parameter
    // at all — never a near-duplicate entry (contract #4).
    handleApiRequest(contextWithQuery("directory="))
    assert.equal(resultCacheSize(), 4, "empty directory shares the default key")
  } finally {
    clearResultCache()
  }
})

test("router matches /api/export/sessions.csv and rejects the near-miss spellings (v0.8.0)", () => {
  assert.deepEqual(matchApiRoute("/api/export/sessions.csv"), {
    routeName: "sessionSummaryExport",
  })
  // Typos and shape violations must fall through to the server's 404.
  assert.equal(matchApiRoute("/api/export/sessions-csv"), null, "hyphen is not a dot")
  assert.equal(matchApiRoute("/api/export/sessions"), null, "missing the .csv suffix")
  assert.equal(matchApiRoute("/api/export/sessions.csv/extra"), null, "no trailing segment allowed")
  assert.equal(matchApiRoute("/api/export/session.csv"), null, "singular session is the .md shape only")
  assert.equal(matchApiRoute("/api/export/sessions.csv.md"), null, "no double suffix")
  // The legacy per-session .md shape still matches — zero change to it.
  assert.deepEqual(matchApiRoute("/api/export/session/ses_example.md"), {
    routeName: "sessionExport",
    sessionId: "ses_example",
  })
})

test("the sessions.csv export short-circuits to 503 before parsing any parameter while the db is missing (v0.8.0)", () => {
  const exportCsvRoute = matchApiRoute("/api/export/sessions.csv")
  assert.notEqual(exportCsvRoute, null)
  const apiResponse = handleApiRequest({
    route: exportCsvRoute!,
    searchParams: new URLSearchParams("directory=%27%20OR%20%271%27%3D%271"),
    database: null,
    databasePath: "test://no-database",
    serverPort: 18789,
  })
  // Same discipline as the sessions route: the db-unavailable
  // short-circuit fires before any parameter parsing — hostile
  // directory text never reaches the query layer on the way to the 503.
  assert.equal(apiResponse.statusCode, 503)
  assert.deepEqual(apiResponse.body, { error: DATABASE_UNAVAILABLE_MESSAGE })
})

test("the sessions.csv export answers 200 with the CSV headers, the BOM document, and no cache entries (v0.8.0)", () => {
  clearResultCache()
  try {
    const fakeDatabase = createFakeInsightDatabase({
      sessions: [
        buildFakeSessionSummary({
          id: "ses_csv_route_alpha",
          title: "alpha 标题, with comma",
          directory: "D:/projects/example-alpha",
        }),
        buildFakeSessionSummary({
          id: "ses_csv_route_beta",
          directory: "D:/projects/example-beta",
        }),
      ],
      messagesBySessionId: {},
      systemPromptBySessionId: {},
    })
    const exportCsvRoute = matchApiRoute("/api/export/sessions.csv")!
    const contextWithQuery = (queryString: string): ApiRequestContext => ({
      route: exportCsvRoute,
      searchParams: new URLSearchParams(queryString),
      database: fakeDatabase,
      databasePath: "test://wired-database",
      serverPort: 18789,
    })

    const exportResponse = handleApiRequest(contextWithQuery(""))
    assert.equal(exportResponse.statusCode, 200)
    assert.equal(exportResponse.rawText!.contentType, SESSION_SUMMARY_CSV_CONTENT_TYPE)
    assert.equal(
      exportResponse.rawText!.headers["Content-Disposition"],
      `attachment; filename="${SESSION_SUMMARY_CSV_FILENAME}"`,
    )
    const exportText = exportResponse.rawText!.text
    assert.ok(exportText.startsWith("\uFEFF"), "BOM prefixes the export document")
    assert.ok(
      exportText.includes("ses_csv_route_alpha"),
      "the export carries every session row, torture title included",
    )
    assert.ok(
      exportText.includes('"alpha 标题, with comma"'),
      "the comma title arrives RFC 4180-escaped",
    )
    assert.ok(exportText.endsWith("\r\n"), "the document is CRLF-terminated")

    // A directory miss is filter semantics, not fallback: a
    // header-only CSV with 200.
    const missResponse = handleApiRequest(
      contextWithQuery("directory=D%3A%2Fprojects%2Fexample-nowhere"),
    )
    assert.equal(missResponse.statusCode, 200)
    assert.equal(
      missResponse.rawText!.text,
      "\uFEFF" + SESSION_SUMMARY_CSV_HEADER + "\r\n",
      "miss yields the header-only document",
    )

    // An empty ?directory= is the same "no filter" export as no
    // parameter at all.
    const emptyFilterResponse = handleApiRequest(contextWithQuery("directory="))
    assert.equal(emptyFilterResponse.rawText!.text, exportText)

    // One-shot click export, deliberately uncached: the requests above
    // must not have left a single TTL entry behind.
    assert.equal(resultCacheSize(), 0, "the export never touches the result cache")
  } finally {
    clearResultCache()
  }
})

test("sessions and the CSV export with a range parameter still answer 503 while the db is missing (v0.9.0)", () => {
  const sessionsRoute = matchApiRoute("/api/sessions")
  const exportCsvRoute = matchApiRoute("/api/export/sessions.csv")
  assert.notEqual(sessionsRoute, null)
  assert.notEqual(exportCsvRoute, null)
  for (const route of [sessionsRoute!, exportCsvRoute!]) {
    const apiResponse = handleApiRequest({
      route,
      // A range word that would be a 400 with a live db must never even
      // reach parameter parsing on the way to the 503 — the db
      // short-circuit fires first (same discipline as ?directory=).
      searchParams: new URLSearchParams("range=week"),
      database: null,
      databasePath: "test://no-database",
      serverPort: 18789,
    })
    assert.equal(apiResponse.statusCode, 503)
    assert.deepEqual(apiResponse.body, { error: DATABASE_UNAVAILABLE_MESSAGE })
  }
})

test("sessions cache keys carry the range dimension: words get entries, empty shares the default, invalid adds none (v0.9.0)", () => {
  clearResultCache()
  try {
    const nowMs = Date.now()
    const dayMs = 86_400_000
    const fakeDatabase = createFakeInsightDatabase({
      sessions: [
        buildFakeSessionSummary({
          id: "ses_range_cache_fresh",
          timeCreated: nowMs - 1 * dayMs,
          timeUpdated: nowMs - 1 * dayMs,
        }),
        buildFakeSessionSummary({
          id: "ses_range_cache_stale",
          timeCreated: nowMs - 91 * dayMs,
          timeUpdated: nowMs - 91 * dayMs,
        }),
      ],
      messagesBySessionId: {},
      systemPromptBySessionId: {},
    })
    const sessionsRoute = matchApiRoute("/api/sessions")!
    const contextWithQuery = (queryString: string): ApiRequestContext => ({
      route: sessionsRoute,
      searchParams: new URLSearchParams(queryString),
      database: fakeDatabase,
      databasePath: "test://wired-database",
      serverPort: 18789,
    })

    // The default entry (no range parameter).
    handleApiRequest(contextWithQuery(""))
    assert.equal(resultCacheSize(), 1)

    // The raw word is the cache dimension — never the Date.now()-based
    // threshold, which moves every millisecond and would spray
    // near-duplicate entries (contract #4).
    handleApiRequest(contextWithQuery("range=7d"))
    assert.equal(resultCacheSize(), 2, "7d is its own entry")
    handleApiRequest(contextWithQuery("range=30d"))
    assert.equal(resultCacheSize(), 3, "30d is its own entry")

    // An empty ?range= shares the "no filter" key with no parameter at
    // all — the same equivalence as ?directory=.
    handleApiRequest(contextWithQuery("range="))
    assert.equal(resultCacheSize(), 3, "empty range shares the default key")

    // An invalid word is rejected with a loud 400 BEFORE any cache
    // write — no near-duplicate garbage entries.
    const invalidResponse = handleApiRequest(contextWithQuery("range=week"))
    assert.equal(invalidResponse.statusCode, 400)
    assert.deepEqual(invalidResponse.body, { error: INVALID_RANGE_MESSAGE })
    assert.equal(resultCacheSize(), 3, "the 400 wrote no cache entry")
  } finally {
    clearResultCache()
  }
})

test("the sessions route rejects unknown range words with a loud 400 and filters real windows otherwise (v0.9.0)", () => {
  clearResultCache()
  try {
    const nowMs = Date.now()
    const dayMs = 86_400_000
    const fakeDatabase = createFakeInsightDatabase({
      sessions: [
        buildFakeSessionSummary({
          id: "ses_range_route_fresh",
          timeCreated: nowMs - 1 * dayMs,
          timeUpdated: nowMs - 1 * dayMs,
        }),
        buildFakeSessionSummary({
          id: "ses_range_route_stale",
          timeCreated: nowMs - 91 * dayMs,
          timeUpdated: nowMs - 91 * dayMs,
        }),
      ],
      messagesBySessionId: {},
      systemPromptBySessionId: {},
    })
    const sessionsRoute = matchApiRoute("/api/sessions")!
    const contextWithQuery = (queryString: string): ApiRequestContext => ({
      route: sessionsRoute,
      searchParams: new URLSearchParams(queryString),
      database: fakeDatabase,
      databasePath: "test://wired-database",
      serverPort: 18789,
    })
    const bodyIds = (apiResponse: { body: unknown }): string[] =>
      (apiResponse.body as { id: string }[]).map((sessionSummary) => sessionSummary.id)

    // The whole typo family answers the same loud 400 — a silent
    // full-list fallback would read as "filtered" to the caller.
    for (const invalidRangeWord of ["7days", "24h", "week", "7D", "__proto__"]) {
      const invalidResponse = handleApiRequest(
        contextWithQuery(`range=${encodeURIComponent(invalidRangeWord)}`),
      )
      assert.equal(invalidResponse.statusCode, 400, `"${invalidRangeWord}" must 400`)
      assert.deepEqual(invalidResponse.body, { error: INVALID_RANGE_MESSAGE })
    }

    // A legal window really filters (and exercises the fake's minimal
    // range mirror — bind slots stay right, limit is not consumed).
    const filteredResponse = handleApiRequest(contextWithQuery("range=30d"))
    assert.equal(filteredResponse.statusCode, 200)
    assert.deepEqual(bodyIds(filteredResponse), ["ses_range_route_fresh"])

    // Without a window the stale row is back.
    const defaultResponse = handleApiRequest(contextWithQuery(""))
    assert.equal(defaultResponse.statusCode, 200)
    assert.deepEqual(bodyIds(defaultResponse), [
      "ses_range_route_fresh",
      "ses_range_route_stale",
    ])
  } finally {
    clearResultCache()
  }
})

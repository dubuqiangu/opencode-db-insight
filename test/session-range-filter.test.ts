/**
 * Tests for the ?range= time-window filter (v0.9.0) on the session
 * list — and, through the shared resolver, on the CSV export:
 *
 * 1. Pure resolver vocabulary: tri-state resolution (none / window /
 *    invalid), exact threshold arithmetic under frozen timers, and the
 *    P1-1 Object.hasOwn discipline (prototype-chain keys are invalid,
 *    never accepted).
 * 2. Real node:sqlite :memory: fixtures (发布清单 #2 — SQL semantics
 *    are locked against real SQLite, never a fake JS mirror): window
 *    membership across the 7d/30d/90d presets with day-scale gaps,
 *    the EXACT >= threshold boundary (rows exactly on the threshold
 *    stay in, rows 1 ms below stay out), and the directory+range
 *    intersection.
 * 3. SQL capture: byte-level shapes for all four WHERE combinations,
 *    the fixed bind order (directory, range threshold, limit, offset),
 *    and the no-filter SQL staying byte-identical to pre-0.9.0.
 * 4. API level: unknown non-empty range words answer a loud 400 (never
 *    a silent full-list fallback), missing/empty mean no filter.
 *
 * The db-unavailable 503 short-circuit and the cache-key range
 * dimension live in test/api-routes.test.ts; the export-side
 * composition (every pagination page carries the window, no cache
 * entries) lives in test/session-summary-csv.test.ts.
 *
 * All fixture paths are fictional placeholders (example-alpha series,
 * release checklist #3). The fixture parts skip when node:sqlite is
 * unavailable; the pure parts run everywhere.
 */

import { test, mock } from "node:test"
import assert from "node:assert/strict"
import { createRequire } from "node:module"

import type {
  SessionSummary,
  SqliteReadConnection,
} from "../src/db/types.ts"
import {
  querySessionList,
  resolveSessionRange,
  SESSION_RANGE_WINDOW_DAYS_BY_RANGE_KEY,
  SESSION_RANGE_WINDOW_MS_PER_DAY,
} from "../src/db/queries.ts"
import {
  handleApiRequest,
  INVALID_RANGE_MESSAGE,
  type ApiRequestContext,
} from "../src/web/api.ts"
import { matchApiRoute } from "../src/web/router.ts"
import { clearResultCache } from "../src/stats/cache.ts"

// ---------------------------------------------------------------------------
// 1. Pure resolver vocabulary

test("resolveSessionRange tri-states the ?range= vocabulary with exact threshold arithmetic", () => {
  // Missing, null and empty string all mean NO window.
  assert.deepEqual(resolveSessionRange(null), { rangeKind: "none" })
  assert.deepEqual(resolveSessionRange(undefined), { rangeKind: "none" })
  assert.deepEqual(resolveSessionRange(""), { rangeKind: "none" })

  // Frozen clocks pin the threshold arithmetic exactly: the window
  // start is now − N × 86_400_000 ms, computed at request time.
  const frozenNowMs = Date.UTC(2026, 9, 7, 12, 0, 0)
  mock.timers.enable({ now: frozenNowMs })
  try {
    assert.deepEqual(resolveSessionRange("7d"), {
      rangeKind: "window",
      rangeStartMs: frozenNowMs - 7 * SESSION_RANGE_WINDOW_MS_PER_DAY,
    })
    assert.deepEqual(resolveSessionRange("30d"), {
      rangeKind: "window",
      rangeStartMs: frozenNowMs - 30 * SESSION_RANGE_WINDOW_MS_PER_DAY,
    })
    assert.deepEqual(resolveSessionRange("90d"), {
      rangeKind: "window",
      rangeStartMs: frozenNowMs - 90 * SESSION_RANGE_WINDOW_MS_PER_DAY,
    })
  } finally {
    mock.timers.reset()
  }

  // Unknown non-empty words are INVALID — a loud 400 upstream, never a
  // silent full-list fallback (the "自以为筛了" trap). Case matters:
  // "7D" is not in the vocabulary.
  const invalidRangeWords = [
    "7days",
    "24h",
    "week",
    "7D",
    "0d",
    "365d",
    "-7d",
    " 7d",
    "7d ",
  ]
  for (const invalidRangeWord of invalidRangeWords) {
    assert.deepEqual(
      resolveSessionRange(invalidRangeWord),
      { rangeKind: "invalid" },
      `"${invalidRangeWord}" must resolve to invalid`,
    )
  }

  // P1-1 discipline (v0.4.1): prototype-chain keys pass `in` but must
  // fail the own-property check — "invalid" here, 400 upstream.
  for (const hostileRangeWord of ["toString", "__proto__", "constructor"]) {
    assert.deepEqual(
      resolveSessionRange(hostileRangeWord),
      { rangeKind: "invalid" },
      `prototype-chain key "${hostileRangeWord}" must resolve to invalid`,
    )
  }

  // The vocabulary itself is exactly the three pinned presets.
  assert.deepEqual(Object.keys(SESSION_RANGE_WINDOW_DAYS_BY_RANGE_KEY), ["7d", "30d", "90d"])
})

// ---------------------------------------------------------------------------
// Real-SQLite fixture plumbing (same shape as the directory-filter file)

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
    ? "node:sqlite unavailable — skipping session range-filter tests"
    : false

/** Wire-shaped model column for the fixture (parsed by parseSessionModelColumn). */
const MODEL_COLUMN_TEXT = '{"id":"glm-5.3","providerID":"futureppo"}'

/** One session_v2 fixture row, before column mapping. */
interface SessionRangeFixtureRow {
  id: string
  directory: string
  timeUpdated: number
}

/** A fresh in-memory database carrying the given fixture rows. */
function createRangeFixtureDatabase(
  fixtureRows: SessionRangeFixtureRow[],
): SqliteReadWriteConnection {
  const database = new readWriteConstructor!(":memory:")
  database.exec(
    "CREATE TABLE session_v2 (" +
      "id TEXT, title TEXT, model TEXT, agent TEXT, directory TEXT, " +
      "time_created INTEGER, time_updated INTEGER, " +
      "tokens_input REAL, tokens_output REAL, tokens_cache_read REAL, cost REAL);",
  )
  const insertSession = database.prepare(
    "INSERT INTO session_v2 (id, title, model, agent, directory, time_created, time_updated, " +
      "tokens_input, tokens_output, tokens_cache_read, cost) " +
      "VALUES (?, 'fixture title', ?, 'fixer', ?, 1000, ?, 100, 20, 30, 0.5)",
  )
  for (const fixtureRow of fixtureRows) {
    insertSession.run(fixtureRow.id, MODEL_COLUMN_TEXT, fixtureRow.directory, fixtureRow.timeUpdated)
  }
  return database
}

/** A fixed moment for the frozen-clock boundary test. */
const FROZEN_NOW_MS = Date.UTC(2026, 9, 7, 12, 0, 0)

/** Rows straddling every preset boundary, computed from a fixed moment. */
function thresholdEdgeFixtureRows(): SessionRangeFixtureRow[] {
  const dayMs = SESSION_RANGE_WINDOW_MS_PER_DAY
  return [
    { id: "ses_range_edge_7d", directory: "D:/projects/example-alpha", timeUpdated: FROZEN_NOW_MS - 7 * dayMs },
    { id: "ses_range_edge_7d_minus_1ms", directory: "D:/projects/example-alpha", timeUpdated: FROZEN_NOW_MS - 7 * dayMs - 1 },
    { id: "ses_range_edge_30d", directory: "D:/projects/example-beta", timeUpdated: FROZEN_NOW_MS - 30 * dayMs },
    { id: "ses_range_edge_30d_minus_1ms", directory: "D:/projects/example-beta", timeUpdated: FROZEN_NOW_MS - 30 * dayMs - 1 },
    { id: "ses_range_edge_90d", directory: "D:/projects/example-gamma", timeUpdated: FROZEN_NOW_MS - 90 * dayMs },
    { id: "ses_range_edge_90d_minus_1ms", directory: "D:/projects/example-gamma", timeUpdated: FROZEN_NOW_MS - 90 * dayMs - 1 },
  ]
}

/** Rows spread across the windows with day-scale slack (drift-proof). */
function windowDistributionFixtureRows(): SessionRangeFixtureRow[] {
  const nowMs = Date.now()
  const dayMs = SESSION_RANGE_WINDOW_MS_PER_DAY
  const ageInDaysById: [string, number][] = [
    ["ses_range_age_1d", 1],
    ["ses_range_age_6d", 6],
    ["ses_range_age_8d", 8],
    ["ses_range_age_29d", 29],
    ["ses_range_age_31d", 31],
    ["ses_range_age_89d", 89],
    ["ses_range_age_91d", 91],
  ]
  return ageInDaysById.map(([rowId, ageInDays], rowIndex) => ({
    id: rowId,
    directory: rowIndex % 2 === 0 ? "D:/projects/example-alpha" : "D:/projects/example-beta",
    timeUpdated: nowMs - ageInDays * dayMs,
  }))
}

// ---------------------------------------------------------------------------
// 2. Real-SQL window semantics

test(
  "real-SQL: each preset window returns exactly its members, default order kept",
  { skip: skipReason },
  () => {
    const database = createRangeFixtureDatabase(windowDistributionFixtureRows())
    try {
      const idsForWindow = (windowDays: number | null): string[] => {
        const nowMs = Date.now()
        const rangeStartMs =
          windowDays === null ? null : nowMs - windowDays * SESSION_RANGE_WINDOW_MS_PER_DAY
        const sessionPage = querySessionList(
          database as unknown as SqliteReadConnection,
          500,
          0,
          undefined,
          undefined,
          null,
          rangeStartMs,
        )
        assert.ok(sessionPage !== null)
        return sessionPage.map((sessionSummary) => sessionSummary.id)
      }

      // 7d: strictly newer than a week.
      assert.deepEqual(idsForWindow(7), ["ses_range_age_1d", "ses_range_age_6d"])

      // 30d: the 8d and 29d rows join; the 31d row does not.
      assert.deepEqual(idsForWindow(30), [
        "ses_range_age_1d",
        "ses_range_age_6d",
        "ses_range_age_8d",
        "ses_range_age_29d",
      ])

      // 90d: everything except the 91d row.
      assert.deepEqual(idsForWindow(90), [
        "ses_range_age_1d",
        "ses_range_age_6d",
        "ses_range_age_8d",
        "ses_range_age_29d",
        "ses_range_age_31d",
        "ses_range_age_89d",
      ])

      // No window at all: the full seven rows, 91d included.
      assert.deepEqual(idsForWindow(null), [
        "ses_range_age_1d",
        "ses_range_age_6d",
        "ses_range_age_8d",
        "ses_range_age_29d",
        "ses_range_age_31d",
        "ses_range_age_89d",
        "ses_range_age_91d",
      ])
    } finally {
      database.close()
    }
  },
)

test(
  "real-SQL + frozen clock: rows exactly ON the threshold stay in, rows 1 ms below stay out (>= pinned)",
  { skip: skipReason },
  () => {
    // The handler computes the threshold from Date.now() at request
    // time, so the clock is frozen to the same moment the fixture rows
    // were computed from — byte-exact boundary arithmetic, no drift.
    const sessionsRoute = matchApiRoute("/api/sessions")
    assert.notEqual(sessionsRoute, null)
    const database = createRangeFixtureDatabase(thresholdEdgeFixtureRows())
    mock.timers.enable({ now: FROZEN_NOW_MS })
    try {
      const idsForRange = (queryString: string): string[] => {
        clearResultCache()
        const apiResponse = handleApiRequest({
          route: sessionsRoute!,
          searchParams: new URLSearchParams(queryString),
          database: database as unknown as SqliteReadConnection,
          databasePath: "test://range-fixture",
          serverPort: 18789,
        })
        assert.equal(apiResponse.statusCode, 200)
        return (apiResponse.body as SessionSummary[]).map(
          (sessionSummary) => sessionSummary.id,
        )
      }

      // >= pinned: the row exactly at now − 7d is IN the 7d window.
      assert.deepEqual(idsForRange("range=7d"), ["ses_range_edge_7d"])

      // The 1-ms-below row joins only from the 30d window on.
      assert.deepEqual(idsForRange("range=30d"), [
        "ses_range_edge_7d",
        "ses_range_edge_7d_minus_1ms",
        "ses_range_edge_30d",
      ])

      // And symmetrically for the 30d/90d edges.
      assert.deepEqual(idsForRange("range=90d"), [
        "ses_range_edge_7d",
        "ses_range_edge_7d_minus_1ms",
        "ses_range_edge_30d",
        "ses_range_edge_30d_minus_1ms",
        "ses_range_edge_90d",
      ])

      // No range: every row, including all three minus-1ms stragglers.
      assert.deepEqual(idsForRange(""), [
        "ses_range_edge_7d",
        "ses_range_edge_7d_minus_1ms",
        "ses_range_edge_30d",
        "ses_range_edge_30d_minus_1ms",
        "ses_range_edge_90d",
        "ses_range_edge_90d_minus_1ms",
      ])
    } finally {
      mock.timers.reset()
      clearResultCache()
      database.close()
    }
  },
)

test(
  "real-SQL: the range window composes with the directory drill-down (intersection)",
  { skip: skipReason },
  () => {
    const nowMs = Date.now()
    const dayMs = SESSION_RANGE_WINDOW_MS_PER_DAY
    const database = createRangeFixtureDatabase([
      { id: "ses_range_stack_alpha_fresh", directory: "D:/projects/example-alpha", timeUpdated: nowMs - 1 * dayMs },
      { id: "ses_range_stack_alpha_stale", directory: "D:/projects/example-alpha", timeUpdated: nowMs - 31 * dayMs },
      { id: "ses_range_stack_beta_fresh", directory: "D:/projects/example-beta", timeUpdated: nowMs - 6 * dayMs },
      { id: "ses_range_stack_beta_stale", directory: "D:/projects/example-beta", timeUpdated: nowMs - 91 * dayMs },
    ])
    try {
      const sessionsRoute = matchApiRoute("/api/sessions")!
      const idsForQuery = (queryString: string): string[] => {
        clearResultCache()
        const apiResponse = handleApiRequest({
          route: sessionsRoute,
          searchParams: new URLSearchParams(queryString),
          database: database as unknown as SqliteReadConnection,
          databasePath: "test://range-fixture",
          serverPort: 18789,
        })
        assert.equal(apiResponse.statusCode, 200)
        return (apiResponse.body as SessionSummary[]).map(
          (sessionSummary) => sessionSummary.id,
        )
      }

      // Intersection: only the fresh alpha row survives both filters —
      // the stale alpha row (−31d) is out of the 30d window even
      // though the directory matches, and the fresh beta row is out
      // because the directory does not.
      assert.deepEqual(
        idsForQuery(
          "directory=D%3A%2Fprojects%2Fexample-alpha&range=30d",
        ),
        ["ses_range_stack_alpha_fresh"],
        "directory + range is the intersection, never a union",
      )

      // The other quadrant proves both dimensions filter independently.
      assert.deepEqual(
        idsForQuery("directory=D%3A%2Fprojects%2Fexample-beta&range=7d"),
        ["ses_range_stack_beta_fresh"],
      )

      // Directory alone keeps both of its rows.
      assert.deepEqual(
        idsForQuery("directory=D%3A%2Fprojects%2Fexample-alpha"),
        ["ses_range_stack_alpha_fresh", "ses_range_stack_alpha_stale"],
      )

      // Range alone keeps every fresh row regardless of directory.
      assert.deepEqual(
        idsForQuery("range=90d"),
        [
          "ses_range_stack_alpha_fresh",
          "ses_range_stack_beta_fresh",
          "ses_range_stack_alpha_stale",
        ],
      )
    } finally {
      clearResultCache()
      database.close()
    }
  },
)

// ---------------------------------------------------------------------------
// 3. SQL capture: shapes, bind order, byte-identity

test("the four WHERE shapes stay byte-exact and the bind order is directory, range, limit, offset", () => {
  const capturedSqlStatements: string[] = []
  const capturedParameterLists: unknown[][] = []
  const capturingConnection: SqliteReadConnection = {
    prepare: (sqlText: string) => {
      capturedSqlStatements.push(sqlText)
      return {
        all: (...parameters: unknown[]) => {
          capturedParameterLists.push(parameters)
          return []
        },
        get: () => undefined,
      }
    },
    close: () => {},
  }

  const selectAndFromSql =
    `SELECT id, title, model, agent, directory, time_created, time_updated,
              tokens_input, tokens_output, tokens_cache_read, cost
       FROM session_v2`
  const orderAndPageSql =
    `ORDER BY time_updated DESC, id ASC
       LIMIT ? OFFSET ?`

  // No filter: byte-identical to the pre-0.7.0 statement (unchanged by
  // v0.9.0's composition — regression lock).
  querySessionList(capturingConnection, 50, 0)
  assert.equal(capturedSqlStatements[0], `${selectAndFromSql}\n       ${orderAndPageSql}`)
  assert.deepEqual(capturedParameterLists[0], [50, 0])

  // Range only: WHERE time_updated >= ?, threshold bound first.
  querySessionList(
    capturingConnection,
    50,
    0,
    undefined,
    undefined,
    null,
    1_700_000_000_000,
  )
  assert.equal(
    capturedSqlStatements[1],
    `${selectAndFromSql}
       WHERE time_updated >= ?
       ${orderAndPageSql}`,
  )
  assert.deepEqual(capturedParameterLists[1], [1_700_000_000_000, 50, 0])

  // Directory only: unchanged by v0.9.0.
  querySessionList(
    capturingConnection,
    50,
    0,
    undefined,
    undefined,
    "D:/projects/example-alpha",
  )
  assert.equal(
    capturedSqlStatements[2],
    `${selectAndFromSql}
       WHERE directory = ?
       ${orderAndPageSql}`,
  )
  assert.deepEqual(capturedParameterLists[2], ["D:/projects/example-alpha", 50, 0])

  // Both: one WHERE, AND-composed, bind order directory → range
  // threshold → limit → offset (contract #5, the lock this test owns).
  querySessionList(
    capturingConnection,
    50,
    0,
    undefined,
    undefined,
    "D:/projects/example-alpha",
    1_700_000_000_000,
  )
  assert.equal(
    capturedSqlStatements[3],
    `${selectAndFromSql}
       WHERE directory = ? AND time_updated >= ?
       ${orderAndPageSql}`,
  )
  assert.deepEqual(capturedParameterLists[3], [
    "D:/projects/example-alpha",
    1_700_000_000_000,
    50,
    0,
  ])
  assert.ok(
    !capturedSqlStatements[3].includes("1700000000000"),
    "the threshold rides the bind parameter, never the SQL text",
  )
})

// ---------------------------------------------------------------------------
// 4. API level: vocabulary, 400s, no-filter equivalence

test(
  "API level: unknown range words answer 400; missing and empty mean no filter",
  { skip: skipReason },
  () => {
    const sessionsRoute = matchApiRoute("/api/sessions")
    assert.notEqual(sessionsRoute, null)
    const nowMs = Date.now()
    const dayMs = SESSION_RANGE_WINDOW_MS_PER_DAY
    const database = createRangeFixtureDatabase([
      { id: "ses_range_api_fresh", directory: "D:/projects/example-alpha", timeUpdated: nowMs - 1 * dayMs },
      { id: "ses_range_api_stale", directory: "D:/projects/example-alpha", timeUpdated: nowMs - 31 * dayMs },
    ])
    try {
      const contextWithQuery = (queryString: string): ApiRequestContext => ({
        route: sessionsRoute!,
        searchParams: new URLSearchParams(queryString),
        database: database as unknown as SqliteReadConnection,
        databasePath: "test://range-fixture",
        serverPort: 18789,
      })

      // A typo'd range is a LOUD 400 — never a silent full list that
      // the caller would mistake for a filtered result.
      for (const invalidRangeWord of ["7days", "24h", "week", "7D", "__proto__", "toString"]) {
        clearResultCache()
        const invalidResponse = handleApiRequest(
          contextWithQuery(`range=${encodeURIComponent(invalidRangeWord)}`),
        )
        assert.equal(invalidResponse.statusCode, 400, `"${invalidRangeWord}" must 400`)
        assert.deepEqual(invalidResponse.body, { error: INVALID_RANGE_MESSAGE })
      }

      // A legal window filters for real.
      clearResultCache()
      const filteredResponse = handleApiRequest(contextWithQuery("range=30d"))
      assert.equal(filteredResponse.statusCode, 200)
      assert.deepEqual(
        (filteredResponse.body as SessionSummary[]).map((s) => s.id),
        ["ses_range_api_fresh"],
      )

      // Missing and empty ?range= are both the no-filter request —
      // byte-equal bodies (fresh cache reads each time).
      clearResultCache()
      const defaultBody = handleApiRequest(contextWithQuery("")).body
      clearResultCache()
      const emptyRangeResponse = handleApiRequest(contextWithQuery("range="))
      assert.equal(emptyRangeResponse.statusCode, 200)
      assert.deepEqual(emptyRangeResponse.body, defaultBody)
    } finally {
      clearResultCache()
      database.close()
    }
  },
)

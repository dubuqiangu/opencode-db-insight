/**
 * Real-SQL tests for the /api/sessions directory drill-down (v0.7.0):
 * ?directory=<path> exact-match filtering. Per the release checklist
 * (tasks.md 发布清单 #2) the new WHERE semantics are locked against a
 * real node:sqlite :memory: controlled fixture, not a fake JS mirror
 * (the fake only carries a minimal exact-match mirror so route tests
 * see meaningful rows — this file is the semantic authority).
 *
 * Faces locked here, one per group:
 * - exact-match subset selection, including special-character directory
 *   values (space / CJK / single quote);
 * - filter semantics deliberately differ from fallback semantics: a
 *   directory matching nothing is a legitimate EMPTY 200 result, while
 *   missing/empty-string means NO filter at all;
 * - filtering composes with sort/order and keeps the `id ASC`
 *   tie-break, and paginates over the filtered set;
 * - the no-filter SQL is byte-identical to the pre-0.7.0 statement
 *   (captured-SQL assertion), and the directory value only ever reaches
 *   SQLite as a bind parameter — never as SQL text (injection face);
 * - end-to-end through handleApiRequest: URLSearchParams decodes spaces,
 *   CJK and quotes; a hostile value leaks no rows.
 *
 * The fixture part skips when node:sqlite is unavailable (same
 * fallback as session-list-sorting.test.ts); the SQL-capture tests run
 * everywhere because they only record SQL text and bind parameters.
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import { createRequire } from "node:module"

import type {
  SessionSummary,
  SqliteReadConnection,
} from "../src/db/types.ts"
import { querySessionList } from "../src/db/queries.ts"
import {
  handleApiRequest,
  type ApiRequestContext,
} from "../src/web/api.ts"
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
    ? "node:sqlite unavailable — skipping session directory-filter tests"
    : false

/** Wire-shaped model column for the fixture (parsed by parseSessionModelColumn). */
const MODEL_COLUMN_TEXT = '{"id":"glm-5.3","providerID":"futureppo"}'

/** One session_v2 fixture row, before column mapping. */
interface SessionDirectoryFixtureRow {
  id: string
  directory: string | null
  timeCreated: number
  timeUpdated: number
  tokensInput: number
  tokensOutput: number
  tokensCacheRead: number
  cost: number
}

/**
 * The controlled fixture, multi-directory by design (all fictional
 * placeholder paths, release checklist #3):
 * - example-alpha: two sessions, distinct tokens (300 vs 1500);
 * - example-beta: two sessions, time_updated 7000 tie AND tokens 600
 *   tie — the id ASC secondary key must stay in force on the filtered
 *   subset;
 * - "example 中文 spaced": space + CJK code points;
 * - "example-o'quote": a single quote, the classic SQL-text face;
 * - "": an empty-string directory row (only visible unfiltered);
 * - NULL directory row (only visible unfiltered).
 */
const SESSION_DIRECTORY_FIXTURE_ROWS: SessionDirectoryFixtureRow[] = [
  { id: "ses_dir_alpha", directory: "D:/projects/example-alpha", timeCreated: 1000, timeUpdated: 5000, tokensInput: 1000, tokensOutput: 300, tokensCacheRead: 200, cost: 1.0 },
  { id: "ses_dir_bravo", directory: "D:/projects/example-alpha", timeCreated: 2000, timeUpdated: 9000, tokensInput: 100, tokensOutput: 100, tokensCacheRead: 100, cost: 2.5 },
  { id: "ses_dir_charlie", directory: "D:/projects/example-beta", timeCreated: 3000, timeUpdated: 7000, tokensInput: 200, tokensOutput: 100, tokensCacheRead: 300, cost: 1.5 },
  { id: "ses_dir_delta", directory: "D:/projects/example-beta", timeCreated: 4000, timeUpdated: 7000, tokensInput: 300, tokensOutput: 100, tokensCacheRead: 200, cost: 2.0 },
  { id: "ses_dir_echo", directory: "D:/projects/example 中文 spaced", timeCreated: 5000, timeUpdated: 6000, tokensInput: 10, tokensOutput: 0, tokensCacheRead: 0, cost: 0.5 },
  { id: "ses_dir_foxtrot", directory: "D:/projects/example-o'quote", timeCreated: 5500, timeUpdated: 8000, tokensInput: 5, tokensOutput: 5, tokensCacheRead: 5, cost: 0.25 },
  { id: "ses_dir_golf", directory: "", timeCreated: 6000, timeUpdated: 9500, tokensInput: 1, tokensOutput: 1, tokensCacheRead: 1, cost: 0.1 },
  { id: "ses_dir_hotel", directory: null, timeCreated: 7000, timeUpdated: 9900, tokensInput: 2, tokensOutput: 2, tokensCacheRead: 2, cost: 0.2 },
]

/** A fresh in-memory database carrying the multi-directory fixture. */
function createDirectoryFixtureDatabase(): SqliteReadWriteConnection {
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
      "VALUES (?, 'fixture title', ?, 'fixer', ?, ?, ?, ?, ?, ?, ?)",
  )
  for (const fixtureRow of SESSION_DIRECTORY_FIXTURE_ROWS) {
    insertSession.run(
      fixtureRow.id,
      MODEL_COLUMN_TEXT,
      fixtureRow.directory,
      fixtureRow.timeCreated,
      fixtureRow.timeUpdated,
      fixtureRow.tokensInput,
      fixtureRow.tokensOutput,
      fixtureRow.tokensCacheRead,
      fixtureRow.cost,
    )
  }
  return database
}

/** Run querySessionList against a fresh fixture db and map to ids. */
function sessionIdsFromFreshFixture(
  limit: number,
  offset: number,
  sortKeyValue?: string | null,
  sortOrderValue?: string | null,
  directoryValue?: string | null,
): string[] {
  const database = createDirectoryFixtureDatabase()
  try {
    const sessionPage = querySessionList(
      database as unknown as SqliteReadConnection,
      limit,
      offset,
      sortKeyValue,
      sortOrderValue,
      directoryValue,
    )
    assert.ok(sessionPage !== null)
    return sessionPage.map((sessionSummary) => sessionSummary.id)
  } finally {
    database.close()
  }
}

test(
  "real-SQL: the directory drill-down returns the exact-match subset, empty 200 for no match",
  { skip: skipReason },
  () => {
    // Exact subset, default ordering (time_updated desc).
    assert.deepEqual(
      sessionIdsFromFreshFixture(500, 0, undefined, undefined, "D:/projects/example-alpha"),
      ["ses_dir_bravo", "ses_dir_alpha"],
      "example-alpha: bravo (9000) before alpha (5000)",
    )
    // The beta pair ties at time_updated 7000 — id ASC decides on the
    // filtered subset exactly like it does unfiltered.
    assert.deepEqual(
      sessionIdsFromFreshFixture(500, 0, undefined, undefined, "D:/projects/example-beta"),
      ["ses_dir_charlie", "ses_dir_delta"],
      "example-beta: the 7000 tie must resolve by id ASC",
    )

    // Special-character directory values exact-match their own row and
    // never anything else (space / CJK / single quote).
    assert.deepEqual(
      sessionIdsFromFreshFixture(500, 0, undefined, undefined, "D:/projects/example 中文 spaced"),
      ["ses_dir_echo"],
    )
    assert.deepEqual(
      sessionIdsFromFreshFixture(500, 0, undefined, undefined, "D:/projects/example-o'quote"),
      ["ses_dir_foxtrot"],
    )

    // Filter semantics ≠ fallback semantics (contract #3): a directory
    // matching nothing is a legitimate EMPTY result, never a fallback
    // to the unfiltered list.
    assert.deepEqual(
      sessionIdsFromFreshFixture(500, 0, undefined, undefined, "D:/projects/example-nowhere"),
      [],
      "an unknown directory must yield an empty page, not the default list",
    )

    // Missing, null and empty-string all mean NO filter — the
    // empty-string-directory row (golf) and the NULL-directory row
    // (hotel) stay visible, in the full default order.
    const fullDefaultOrderIds = [
      "ses_dir_hotel", // 9900
      "ses_dir_golf", // 9500
      "ses_dir_bravo", // 9000
      "ses_dir_foxtrot", // 8000
      "ses_dir_charlie", // 7000 tie → id ASC
      "ses_dir_delta",
      "ses_dir_echo", // 6000
      "ses_dir_alpha", // 5000
    ]
    assert.deepEqual(sessionIdsFromFreshFixture(500, 0), fullDefaultOrderIds)
    assert.deepEqual(
      sessionIdsFromFreshFixture(500, 0, undefined, undefined, null),
      fullDefaultOrderIds,
      "null directory means no filter",
    )
    assert.deepEqual(
      sessionIdsFromFreshFixture(500, 0, undefined, undefined, ""),
      fullDefaultOrderIds,
      "empty-string directory means no filter",
    )
  },
)

test(
  "real-SQL: the drill-down composes with sort/order, tie-break and pagination",
  { skip: skipReason },
  () => {
    // Filter + tokens asc / desc on example-alpha (distinct sums).
    assert.deepEqual(
      sessionIdsFromFreshFixture(500, 0, "tokens", "asc", "D:/projects/example-alpha"),
      ["ses_dir_bravo", "ses_dir_alpha"], // 300 before 1500
    )
    assert.deepEqual(
      sessionIdsFromFreshFixture(500, 0, "tokens", "desc", "D:/projects/example-alpha"),
      ["ses_dir_alpha", "ses_dir_bravo"],
    )
    // Filter + tokens desc on example-beta: the 600 tie must still
    // resolve by id ASC — the secondary key survives the filter.
    assert.deepEqual(
      sessionIdsFromFreshFixture(500, 0, "tokens", "desc", "D:/projects/example-beta"),
      ["ses_dir_charlie", "ses_dir_delta"],
      "the 600-token tie must resolve by id ASC even filtered and desc",
    )
    // Filter + cost desc on example-beta (distinct costs: 2.0 vs 1.5).
    assert.deepEqual(
      sessionIdsFromFreshFixture(500, 0, "cost", "desc", "D:/projects/example-beta"),
      ["ses_dir_delta", "ses_dir_charlie"],
    )
    // Pagination over the filtered subset: page 2 of example-beta.
    assert.deepEqual(
      sessionIdsFromFreshFixture(1, 1, undefined, undefined, "D:/projects/example-beta"),
      ["ses_dir_delta"],
      "limit/offset page inside the filtered subset",
    )
  },
)

test(
  "real-SQL: the no-filter SQL stays byte-identical to pre-0.7.0; the directory value only binds",
  () => {
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

    // The exact pre-0.7.0 statement — the default call must keep
    // producing this string byte for byte (default-path regression
    // lock, contract #2).
    const expectedDefaultSql =
      `SELECT id, title, model, agent, directory, time_created, time_updated,
              tokens_input, tokens_output, tokens_cache_read, cost
       FROM session_v2
       ORDER BY time_updated DESC, id ASC
       LIMIT ? OFFSET ?`
    querySessionList(capturingConnection, 50, 0)
    assert.equal(capturedSqlStatements[0], expectedDefaultSql)
    assert.ok(!capturedSqlStatements[0].includes("WHERE"), "no filter → no WHERE clause")
    assert.deepEqual(capturedParameterLists[0], [50, 0])

    // An explicit empty-string directory is the same no-filter request:
    // same SQL bytes, same bind list.
    querySessionList(capturingConnection, 50, 0, undefined, undefined, "")
    assert.equal(capturedSqlStatements[1], expectedDefaultSql)
    assert.deepEqual(capturedParameterLists[1], [50, 0])

    // The filtered shape: WHERE directory = ? is a bind parameter slot,
    // and the value leads the parameter list (directory, limit, offset).
    const expectedFilteredSql =
      `SELECT id, title, model, agent, directory, time_created, time_updated,
              tokens_input, tokens_output, tokens_cache_read, cost
       FROM session_v2
       WHERE directory = ?
       ORDER BY time_updated DESC, id ASC
       LIMIT ? OFFSET ?`
    querySessionList(
      capturingConnection,
      50,
      0,
      undefined,
      undefined,
      "D:/projects/example-o'quote",
    )
    assert.equal(capturedSqlStatements[2], expectedFilteredSql)
    assert.deepEqual(capturedParameterLists[2], ["D:/projects/example-o'quote", 50, 0])

    // Injection face: hostile directory values never appear in any SQL
    // text and always collapse onto the byte-identical filtered shape —
    // the value rides the bind parameter, every other token is a
    // compile-time literal (contract #7).
    const hostileDirectoryValues = [
      "' OR '1'='1",
      "x' UNION SELECT id, title FROM session_v2 --",
      "D:/projects/example-nowhere; DROP TABLE session_v2",
      "D:/projects/example%20'--",
      "' OR directory IS NOT NULL --",
    ]
    for (const hostileDirectoryValue of hostileDirectoryValues) {
      querySessionList(capturingConnection, 50, 0, undefined, undefined, hostileDirectoryValue)
    }
    for (
      let hostileValueIndex = 0;
      hostileValueIndex < hostileDirectoryValues.length;
      hostileValueIndex += 1
    ) {
      const capturedSqlIndex = 3 + hostileValueIndex
      assert.equal(capturedSqlStatements[capturedSqlIndex], expectedFilteredSql)
      assert.deepEqual(capturedParameterLists[capturedSqlIndex], [
        hostileDirectoryValues[hostileValueIndex],
        50,
        0,
      ])
    }
    for (const hostileValue of hostileDirectoryValues) {
      for (const capturedSql of capturedSqlStatements) {
        assert.ok(
          !capturedSql.includes(hostileValue),
          `hostile directory value must never appear in the SQL text: ${hostileValue}`,
        )
      }
    }
  },
)

test(
  "API level: ?directory= filters end to end — decoding, empty 200, no row leaks",
  { skip: skipReason },
  () => {
    const sessionsRoute = matchApiRoute("/api/sessions")
    assert.notEqual(sessionsRoute, null)
    const database = createDirectoryFixtureDatabase()
    try {
      const contextWithQuery = (queryString: string): ApiRequestContext => ({
        route: sessionsRoute!,
        searchParams: new URLSearchParams(queryString),
        database: database as unknown as SqliteReadConnection,
        databasePath: "test://directory-fixture",
        serverPort: 18789,
      })
      const bodyIds = (apiResponse: { body: unknown }) =>
        (apiResponse.body as SessionSummary[]).map((sessionSummary) => sessionSummary.id)

      // URLSearchParams decodes %XX escapes (contract #5) — the query
      // string carries the encoded path, the SQL binds the decoded one.
      const alphaFilterResponse = handleApiRequest(
        contextWithQuery("directory=D%3A%2Fprojects%2Fexample-alpha"),
      )
      assert.equal(alphaFilterResponse.statusCode, 200)
      assert.deepEqual(bodyIds(alphaFilterResponse), ["ses_dir_bravo", "ses_dir_alpha"])

      // Space + CJK decode through the query parameter too.
      const cjkFilterResponse = handleApiRequest(
        contextWithQuery("directory=D%3A%2Fprojects%2Fexample%20%E4%B8%AD%E6%96%87%20spaced"),
      )
      assert.equal(cjkFilterResponse.statusCode, 200)
      assert.deepEqual(bodyIds(cjkFilterResponse), ["ses_dir_echo"])

      // So does a single quote — decoded, then bound, never interpolated.
      const quoteFilterResponse = handleApiRequest(
        contextWithQuery("directory=D%3A%2Fprojects%2Fexample-o%27quote"),
      )
      assert.equal(quoteFilterResponse.statusCode, 200)
      assert.deepEqual(bodyIds(quoteFilterResponse), ["ses_dir_foxtrot"])

      // Empty 200 for an unknown directory — not a fallback, not an error.
      clearResultCache()
      const nowhereFilterResponse = handleApiRequest(
        contextWithQuery("directory=D%3A%2Fprojects%2Fexample-nowhere"),
      )
      assert.equal(nowhereFilterResponse.statusCode, 200)
      assert.deepEqual(nowhereFilterResponse.body, [])

      // A hostile value leaks no rows and errors nowhere: it simply
      // matches nothing, like any other exact-match miss.
      clearResultCache()
      const hostileFilterResponse = handleApiRequest(
        contextWithQuery("directory=%27%20OR%20%271%27%3D%271"),
      )
      assert.equal(hostileFilterResponse.statusCode, 200)
      assert.deepEqual(hostileFilterResponse.body, [])

      // An empty ?directory= is the same "no filter" request as no
      // parameter at all (contract #4, cache-key equivalence).
      clearResultCache()
      const defaultResponse = handleApiRequest(contextWithQuery(""))
      clearResultCache()
      const emptyDirectoryResponse = handleApiRequest(contextWithQuery("directory="))
      assert.equal(emptyDirectoryResponse.statusCode, 200)
      assert.deepEqual(emptyDirectoryResponse.body, defaultResponse.body)

      // Filter + sort compose end to end.
      clearResultCache()
      const composedResponse = handleApiRequest(
        contextWithQuery("directory=D%3A%2Fprojects%2Fexample-alpha&sort=tokens&order=desc"),
      )
      assert.equal(composedResponse.statusCode, 200)
      assert.deepEqual(bodyIds(composedResponse), ["ses_dir_alpha", "ses_dir_bravo"])
    } finally {
      clearResultCache()
      database.close()
    }
  },
)

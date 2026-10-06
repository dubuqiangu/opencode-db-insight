/**
 * Real-SQL tests for the /api/sessions server-side sorting (v0.2-B,
 * released as 0.4.0). Per the release checklist (tasks.md 发布清单 #2),
 * a new SQL ordering must be locked against a real node:sqlite
 * :memory: controlled fixture — the fake database deliberately does not
 * mirror sort/order semantics (see the comment in its session-list
 * branch), so these tests are the only ordering authority.
 *
 * Faces locked here, one per group:
 * - every whitelisted sort/order pair orders by its mapped SQL fragment
 *   with the mandatory `id ASC` tie-break;
 * - sort=tokens asc agrees value-by-value with a JS re-sort of a full
 *   fetch (parity against the three-column token sum);
 * - pagination across primary-key ties is deterministic: no duplicate,
 *   no gap, stable order over consecutive pages;
 * - garbage sort/order values degrade to the default wire order (no
 *   400s), both at the query layer and end-to-end through
 *   handleApiRequest, while a genuinely whitelisted combination does
 *   change the response;
 * - hostile values never reach the SQL text (whitelist-map structure is
 *   the injection defense; the test pins it).
 *
 * The whole fixture part skips when node:sqlite is unavailable (same
 * fallback as directory-stats-sql-parity.test.ts); the injection-face
 * test runs everywhere because it only captures SQL text.
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
    ? "node:sqlite unavailable — skipping session-list sorting tests"
    : false

/** Wire-shaped model column for the fixture (parsed by parseSessionModelColumn). */
const MODEL_COLUMN_TEXT = '{"id":"glm-5.3","providerID":"futureppo"}'

/** One session_v2 fixture row, before column mapping. */
interface SessionSortFixtureRow {
  id: string
  title: string
  timeCreated: number
  timeUpdated: number
  tokensInput: number
  tokensOutput: number
  tokensCacheRead: number
  cost: number
}

/**
 * The controlled fixture, planted with deliberate ties on every sort key:
 * - tokens total 600 tie: bravo / charlie / foxtrot (spans page cuts);
 * - time_updated 5000 tie: alpha / bravo; 7000 tie: delta / echo;
 * - cost 2.5 tie: bravo / delta;
 * - title "banana" tie: bravo / delta / foxtrot;
 * - time_created is fully distinct (the insertion order).
 * Fixture paths use fictional placeholders per the release checklist #3.
 */
const SESSION_SORT_FIXTURE_ROWS: SessionSortFixtureRow[] = [
  { id: "ses_sort_alpha", title: "cherry", timeCreated: 1000, timeUpdated: 5000, tokensInput: 1000, tokensOutput: 300, tokensCacheRead: 200, cost: 1.0 },
  { id: "ses_sort_bravo", title: "banana", timeCreated: 2000, timeUpdated: 5000, tokensInput: 300, tokensOutput: 100, tokensCacheRead: 200, cost: 2.5 },
  { id: "ses_sort_charlie", title: "apple", timeCreated: 3000, timeUpdated: 9000, tokensInput: 200, tokensOutput: 100, tokensCacheRead: 300, cost: 4.5 },
  { id: "ses_sort_delta", title: "banana", timeCreated: 4000, timeUpdated: 7000, tokensInput: 100, tokensOutput: 100, tokensCacheRead: 100, cost: 2.5 },
  { id: "ses_sort_echo", title: "date", timeCreated: 5000, timeUpdated: 7000, tokensInput: 600, tokensOutput: 100, tokensCacheRead: 200, cost: 0.5 },
  { id: "ses_sort_foxtrot", title: "banana", timeCreated: 6000, timeUpdated: 3000, tokensInput: 400, tokensOutput: 100, tokensCacheRead: 100, cost: 6.0 },
]

/** A fresh in-memory database carrying the tie-planted fixture. */
function createSortingFixtureDatabase(): SqliteReadWriteConnection {
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
      "VALUES (?, ?, ?, 'fixer', 'D:/projects/example-sort', ?, ?, ?, ?, ?, ?)",
  )
  for (const fixtureRow of SESSION_SORT_FIXTURE_ROWS) {
    insertSession.run(
      fixtureRow.id,
      fixtureRow.title,
      MODEL_COLUMN_TEXT,
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
): string[] {
  const database = createSortingFixtureDatabase()
  try {
    const sessionPage = querySessionList(
      database as unknown as SqliteReadConnection,
      limit,
      offset,
      sortKeyValue,
      sortOrderValue,
    )
    assert.ok(sessionPage !== null)
    return sessionPage.map((sessionSummary) => sessionSummary.id)
  } finally {
    database.close()
  }
}

test(
  "real-SQL: every whitelisted sort/order pair orders by its mapped fragment, ties broken by id ASC",
  { skip: skipReason },
  () => {
    const expectedIdsBySortKeyAndOrder: Record<string, string[]> = {
      // Default wire order — must stay byte-identical to pre-0.4.0.
      "time_updated desc": [
        "ses_sort_charlie", // 9000
        "ses_sort_delta", // 7000 tie → id ASC
        "ses_sort_echo",
        "ses_sort_alpha", // 5000 tie → id ASC
        "ses_sort_bravo",
        "ses_sort_foxtrot", // 3000
      ],
      "time_updated asc": [
        "ses_sort_foxtrot", // 3000
        "ses_sort_alpha", // 5000 tie → id ASC
        "ses_sort_bravo",
        "ses_sort_delta", // 7000 tie → id ASC
        "ses_sort_echo",
        "ses_sort_charlie", // 9000
      ],
      "time_created asc": [
        "ses_sort_alpha",
        "ses_sort_bravo",
        "ses_sort_charlie",
        "ses_sort_delta",
        "ses_sort_echo",
        "ses_sort_foxtrot",
      ],
      "time_created desc": [
        "ses_sort_foxtrot",
        "ses_sort_echo",
        "ses_sort_delta",
        "ses_sort_charlie",
        "ses_sort_bravo",
        "ses_sort_alpha",
      ],
      // The three-column token sum, not a single column: 300 / 600×3 / 900 / 1500.
      "tokens asc": [
        "ses_sort_delta", // 300
        "ses_sort_bravo", // 600 tie → id ASC
        "ses_sort_charlie",
        "ses_sort_foxtrot",
        "ses_sort_echo", // 900
        "ses_sort_alpha", // 1500
      ],
      "tokens desc": [
        "ses_sort_alpha", // 1500
        "ses_sort_echo", // 900
        "ses_sort_bravo", // 600 tie → id ASC
        "ses_sort_charlie",
        "ses_sort_foxtrot",
        "ses_sort_delta", // 300
      ],
      "cost asc": [
        "ses_sort_echo", // 0.5
        "ses_sort_alpha", // 1.0
        "ses_sort_bravo", // 2.5 tie → id ASC
        "ses_sort_delta",
        "ses_sort_charlie", // 4.5
        "ses_sort_foxtrot", // 6.0
      ],
      "cost desc": [
        "ses_sort_foxtrot", // 6.0
        "ses_sort_charlie", // 4.5
        "ses_sort_bravo", // 2.5 tie → id ASC
        "ses_sort_delta",
        "ses_sort_alpha", // 1.0
        "ses_sort_echo", // 0.5
      ],
      // TEXT ordering under SQLite BINARY collation.
      "title asc": [
        "ses_sort_charlie", // apple
        "ses_sort_bravo", // banana tie → id ASC
        "ses_sort_delta",
        "ses_sort_foxtrot",
        "ses_sort_alpha", // cherry
        "ses_sort_echo", // date
      ],
      "title desc": [
        "ses_sort_echo", // date
        "ses_sort_alpha", // cherry
        "ses_sort_bravo", // banana tie → id ASC
        "ses_sort_delta",
        "ses_sort_foxtrot",
        "ses_sort_charlie", // apple
      ],
    }

    for (const [sortKeyAndOrder, expectedIds] of Object.entries(expectedIdsBySortKeyAndOrder)) {
      const [sortKeyValue, sortOrderValue] = sortKeyAndOrder.split(" ")
      assert.deepEqual(
        sessionIdsFromFreshFixture(500, 0, sortKeyValue, sortOrderValue),
        expectedIds,
        `${sortKeyAndOrder} must follow the mapped SQL fragment order`,
      )
    }
  },
)

test(
  "real-SQL: sort=tokens asc agrees value-by-value with a JS re-sort of the full fetch",
  { skip: skipReason },
  () => {
    const database = createSortingFixtureDatabase()
    try {
      const readOnlyConnection = database as unknown as SqliteReadConnection
      // Full fetch under an unrelated complete ordering (time_created asc).
      const fetchedSummaries = querySessionList(readOnlyConnection, 500, 0, "time_created", "asc")!
      assert.equal(fetchedSummaries.length, SESSION_SORT_FIXTURE_ROWS.length)

      const jsResortedSummaries = [...fetchedSummaries].sort(
        (leftSummary, rightSummary) =>
          leftSummary.tokens - rightSummary.tokens ||
          (leftSummary.id < rightSummary.id ? -1 : leftSummary.id > rightSummary.id ? 1 : 0),
      )
      const sqlSortedSummaries = querySessionList(readOnlyConnection, 500, 0, "tokens", "asc")!
      assert.deepEqual(sqlSortedSummaries, jsResortedSummaries)
    } finally {
      database.close()
    }
  },
)

test(
  "real-SQL: ties paginate deterministically — limit=2 over three pages, no duplicate, no gap",
  { skip: skipReason },
  () => {
    // tokens asc puts the 600-tie group (bravo/charlie/foxtrot) across
    // the page cuts at offsets 2 and 4 — exactly where a missing
    // secondary key would duplicate or skip rows.
    const fullSortedIds = sessionIdsFromFreshFixture(500, 0, "tokens", "asc")
    const pagedIds: string[] = []
    for (const pageOffset of [0, 2, 4]) {
      pagedIds.push(...sessionIdsFromFreshFixture(2, pageOffset, "tokens", "asc"))
    }
    assert.equal(new Set(pagedIds).size, SESSION_SORT_FIXTURE_ROWS.length, "no row served twice")
    assert.deepEqual(pagedIds, fullSortedIds, "pages concatenate into the full sorted order")
  },
)

test(
  "real-SQL: garbage sort/order values degrade to the default wire order",
  { skip: skipReason },
  () => {
    const defaultOrderIds = sessionIdsFromFreshFixture(500, 0)
    assert.deepEqual(
      sessionIdsFromFreshFixture(500, 0, "; DROP TABLE session_v2 --", "DESC; DROP TABLE session_v2"),
      defaultOrderIds,
      "injection-shaped values must fall back to the default order",
    )
    assert.deepEqual(
      sessionIdsFromFreshFixture(500, 0, "unknown_sort_key", "upside-down"),
      defaultOrderIds,
      "unknown values must fall back to the default order",
    )
  },
)

test(
  "API level: garbage sort/order keep the default response, whitelisted values change it",
  { skip: skipReason },
  () => {
    const sessionsRoute = matchApiRoute("/api/sessions")
    assert.notEqual(sessionsRoute, null)
    const database = createSortingFixtureDatabase()
    try {
      const contextWithQuery = (queryString: string): ApiRequestContext => ({
        route: sessionsRoute!,
        searchParams: new URLSearchParams(queryString),
        database: database as unknown as SqliteReadConnection,
        databasePath: "test://sorting-fixture",
        serverPort: 18789,
      })

      clearResultCache()
      const defaultResponse = handleApiRequest(contextWithQuery(""))
      assert.equal(defaultResponse.statusCode, 200)

      const garbageQueryStrings = [
        "sort=%3B%20DROP%20TABLE%20session_v2%20--",
        "sort=unknown_sort_key",
        "order=%3B%20DROP%20TABLE%20session_v2",
        "order=garbage",
        "sort=unknown_sort_key&order=garbage",
      ]
      for (const garbageQueryString of garbageQueryStrings) {
        // Clear the cache so each call computes independently — a leaked
        // hostile value would throw in SQLite and surface as a 500 here.
        clearResultCache()
        const garbageResponse = handleApiRequest(contextWithQuery(garbageQueryString))
        assert.equal(garbageResponse.statusCode, 200, `${garbageQueryString} must not error`)
        assert.deepEqual(
          garbageResponse.body,
          defaultResponse.body,
          `${garbageQueryString} must fall back to the default response`,
        )
      }

      // A genuinely whitelisted combination changes the response — the
      // params are live end to end, not swallowed by the fallback.
      clearResultCache()
      const createdAscResponse = handleApiRequest(
        contextWithQuery("sort=time_created&order=asc"),
      )
      assert.equal(createdAscResponse.statusCode, 200)
      assert.notDeepEqual(createdAscResponse.body, defaultResponse.body)
      assert.deepEqual(
        (createdAscResponse.body as SessionSummary[]).map(
          (sessionSummary) => sessionSummary.id,
        ),
        [
          "ses_sort_alpha",
          "ses_sort_bravo",
          "ses_sort_charlie",
          "ses_sort_delta",
          "ses_sort_echo",
          "ses_sort_foxtrot",
        ],
      )
    } finally {
      clearResultCache()
      database.close()
    }
  },
)

test("injection face: hostile sort/order values never reach the SQL text", () => {
  const capturedSqlStatements: string[] = []
  const capturingConnection: SqliteReadConnection = {
    prepare: (sqlText: string) => {
      capturedSqlStatements.push(sqlText)
      return { all: () => [], get: () => undefined }
    },
    close: () => {},
  }

  const hostileSortValues = [
    "; DROP TABLE session_v2 --",
    "time_updated; DROP TABLE session_v2",
    "tokens_input + tokens_output + tokens_cache_read) ASC, (SELECT 1) --",
    "' OR '1'='1",
    "unknown_sort_key",
  ]
  const hostileOrderValues = [
    "DESC; DROP TABLE session_v2",
    "ASC, (SELECT 1) --",
    "' OR '1'='1",
    "sideways",
  ]
  for (const hostileSortValue of hostileSortValues) {
    querySessionList(capturingConnection, 50, 0, hostileSortValue, "desc")
  }
  for (const hostileOrderValue of hostileOrderValues) {
    querySessionList(capturingConnection, 50, 0, "cost", hostileOrderValue)
  }
  // Baselines for the byte-identity lock below: the two default shapes
  // the hostile inputs must collapse onto.
  querySessionList(capturingConnection, 50, 0)
  querySessionList(capturingConnection, 50, 0, "cost", "desc")
  const defaultSortSql =
    capturedSqlStatements[hostileSortValues.length + hostileOrderValues.length]
  const costDescSql =
    capturedSqlStatements[hostileSortValues.length + hostileOrderValues.length + 1]

  // Every produced SQL ends in a whitelisted ORDER BY fragment plus the
  // fixed `, id ASC` tie-break and the parameterized LIMIT/OFFSET.
  const whitelistOrderByPattern =
    /ORDER BY (time_updated|time_created|tokens_input \+ tokens_output \+ tokens_cache_read|cost|title) (ASC|DESC), id ASC\s+LIMIT \? OFFSET \?$/
  for (const capturedSql of capturedSqlStatements) {
    assert.match(capturedSql, whitelistOrderByPattern)
  }

  // And no hostile value ever appears inside any SQL text.
  for (const hostileValue of [...hostileSortValues, ...hostileOrderValues]) {
    for (const capturedSql of capturedSqlStatements) {
      assert.ok(
        !capturedSql.includes(hostileValue),
        `hostile value must never appear in the SQL text: ${hostileValue}`,
      )
    }
  }

  // Illegal values resolve to byte-identical SQL as the defaults —
  // "illegal input never enters the SQL text" as an equivalence, not
  // just a substring guess.
  for (let sortValueIndex = 0; sortValueIndex < hostileSortValues.length; sortValueIndex += 1) {
    assert.equal(capturedSqlStatements[sortValueIndex], defaultSortSql)
  }
  for (let orderValueIndex = 0; orderValueIndex < hostileOrderValues.length; orderValueIndex += 1) {
    assert.equal(
      capturedSqlStatements[hostileSortValues.length + orderValueIndex],
      costDescSql,
    )
  }
})

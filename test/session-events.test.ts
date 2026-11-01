/**
 * Tests for GET /api/session/:id/events (A2/A3 会话事件): the 4-segment route,
 * the compaction / model-switched / system extraction (real node:sqlite
 * :memory: fixture — the fake insight database does not mirror json_extract
 * semantics), and the API-layer 404 / empty-events contract.
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import { createRequire } from "node:module"

import type { SqliteReadConnection } from "../src/db/types.ts"
import { querySessionEvents } from "../src/db/session-event-queries.ts"
import { matchApiRoute } from "../src/web/router.ts"
import {
  handleApiRequest,
  SESSION_NOT_FOUND_MESSAGE,
  type ApiRequestContext,
} from "../src/web/api.ts"
import { clearResultCache } from "../src/stats/cache.ts"
import {
  buildFakeSessionSummary,
  createFakeInsightDatabase,
} from "./helpers/fake-insight-db.ts"

// ---------------------------------------------------------------------------
// route matching
// ---------------------------------------------------------------------------

test("matchApiRoute recognizes the session events sub-route; near misses do not", () => {
  assert.deepEqual(matchApiRoute("/api/session/ses_abc123/events"), {
    routeName: "sessionEvents",
    sessionId: "ses_abc123",
  })
  assert.deepEqual(matchApiRoute("/api/session/ses%20with%20space/events"), {
    routeName: "sessionEvents",
    sessionId: "ses with space",
  })
  assert.deepEqual(matchApiRoute("/api/session/ses_abc/events/"), {
    routeName: "sessionEvents",
    sessionId: "ses_abc",
  })
  assert.equal(matchApiRoute("/api/session/ses_abc/event"), null, "singular misspelling")
  assert.equal(matchApiRoute("/api/session/ses_abc/events/extra"), null, "no sub-path")
  assert.equal(matchApiRoute("/api/session//events"), null, "empty id")
})

// ---------------------------------------------------------------------------
// querySessionEvents — db-null contract + real node:sqlite fixture
// ---------------------------------------------------------------------------

test("querySessionEvents returns null when the db connection is missing", () => {
  assert.equal(querySessionEvents(null, "ses_any"), null)
})

/** Structural type of a read-write node:sqlite connection for fixtures. */
interface SqliteReadWriteConnection extends SqliteReadConnection {
  exec(sql: string): void
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
    ? "node:sqlite unavailable — skipping session-events query fixture tests"
    : false

/** One fixture session_message row, before it is turned into a wire row. */
interface SessionEventMessageFixture {
  sessionId: string
  type: string
  seq: number
  timeCreated: number
  data: unknown
}

/** The one session_v2 row the anchored event messages point at. */
const EVENT_SESSION_ID = "ses_events_fixture"

/** 300-code-point text ending on an emoji, to pin surrogate-safe truncation. */
const LONG_SYSTEM_TEXT = "a".repeat(199) + "😀" + "b".repeat(100)

/** Plant the fixture into a real :memory: SQLite with the wire shapes. */
function createSessionEventFixtureDatabase(
  messageFixtures: SessionEventMessageFixture[],
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
  fixtureDatabase.exec("CREATE TABLE session_v2 (id TEXT PRIMARY KEY)")
  fixtureDatabase.prepare("INSERT INTO session_v2 (id) VALUES (?)").run(EVENT_SESSION_ID)
  const insertStatement = fixtureDatabase.prepare(
    "INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?)",
  )
  messageFixtures.forEach((messageFixture, messageIndex) => {
    insertStatement.run(
      `msg_${messageIndex}`,
      messageFixture.sessionId,
      messageFixture.type,
      messageFixture.seq,
      messageFixture.timeCreated,
      messageFixture.timeCreated,
      JSON.stringify(messageFixture.data),
    )
  })
  return fixtureDatabase
}

test("querySessionEvents extracts compaction / model-switched / system rows in seq order", { skip: skipReason }, () => {
  const fixtureDatabase = createSessionEventFixtureDatabase([
    {
      sessionId: EVENT_SESSION_ID,
      type: "compaction",
      seq: 1,
      timeCreated: 1000,
      data: { status: "completed", reason: "auto", summary: "x" },
    },
    // Assistant / user rows are never events.
    { sessionId: EVENT_SESSION_ID, type: "assistant", seq: 2, timeCreated: 2000, data: { tokens: {} } },
    {
      sessionId: EVENT_SESSION_ID,
      type: "system",
      seq: 3,
      timeCreated: 3000,
      data: { text: LONG_SYSTEM_TEXT },
    },
    {
      sessionId: EVENT_SESSION_ID,
      type: "model-switched",
      seq: 4,
      timeCreated: 4000,
      data: { model: { id: "glm-5.3" }, previous: { id: "claude-opus-5" } },
    },
    // Missing reason → "unknown".
    { sessionId: EVENT_SESSION_ID, type: "compaction", seq: 5, timeCreated: 5000, data: {} },
    { sessionId: EVENT_SESSION_ID, type: "system", seq: 6, timeCreated: 6000, data: { text: "short" } },
    { sessionId: EVENT_SESSION_ID, type: "user", seq: 7, timeCreated: 7000, data: { text: "hi" } },
    // Missing previous → "unknown → m2".
    {
      sessionId: EVENT_SESSION_ID,
      type: "model-switched",
      seq: 8,
      timeCreated: 8000,
      data: { model: { id: "m2" } },
    },
    // Orphan event: session id absent from session_v2 → excluded by the anchor.
    {
      sessionId: "ses_orphan_not_in_session_v2",
      type: "compaction",
      seq: 1,
      timeCreated: 9000,
      data: { reason: "manual" },
    },
  ])

  try {
    const events = querySessionEvents(fixtureDatabase, EVENT_SESSION_ID)!
    assert.notEqual(events, null)
    assert.deepEqual(
      events.map((event) => event.seq),
      [1, 3, 4, 5, 6, 8],
      "events come back in seq order; orphan and non-event rows are dropped",
    )
    assert.deepEqual(events.map((event) => event.type), [
      "compaction",
      "system",
      "model-switched",
      "compaction",
      "system",
      "model-switched",
    ])
    assert.deepEqual(events.map((event) => event.timeCreated), [
      1000, 3000, 4000, 5000, 6000, 8000,
    ])
    assert.equal(events[0].detail, "auto")
    assert.equal(events[3].detail, "unknown", "missing compaction reason → unknown")
    assert.equal(events[2].detail, "claude-opus-5 → glm-5.3")
    assert.equal(events[5].detail, "unknown → m2")
    assert.equal(events[4].detail, "short")
    // Long system text truncates to 200 code points WITHOUT splitting the emoji.
    const truncatedDetail = events[1].detail
    assert.equal([...truncatedDetail].length, 200)
    assert.ok(truncatedDetail.endsWith("😀"), "surrogate pair survives truncation")
  } finally {
    fixtureDatabase.close()
  }
})

test("querySessionEvents returns an empty array for a known session with no events", { skip: skipReason }, () => {
  const fixtureDatabase = createSessionEventFixtureDatabase([
    { sessionId: EVENT_SESSION_ID, type: "assistant", seq: 1, timeCreated: 1000, data: { tokens: {} } },
  ])
  try {
    assert.deepEqual(querySessionEvents(fixtureDatabase, EVENT_SESSION_ID), [])
  } finally {
    fixtureDatabase.close()
  }
})

// ---------------------------------------------------------------------------
// API layer: 404 only for absent sessions, empty events stay 200
// ---------------------------------------------------------------------------

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

test("the events route answers 200 with events for a live session (fake db)", () => {
  clearResultCache()
  try {
    const fakeDatabase = createFakeInsightDatabase({
      sessions: [buildFakeSessionSummary({ id: "ses_events_live" })],
      messagesBySessionId: {
        ses_events_live: [
          { type: "compaction", seq: 1, timeCreated: 1000, data: { status: "completed", reason: "auto", summary: "x" } },
          { type: "model-switched", seq: 2, timeCreated: 2000, data: { model: { id: "b" }, previous: { id: "a" } } },
          { type: "system", seq: 3, timeCreated: 3000, data: { text: "system notice" } },
          { type: "assistant", seq: 4, timeCreated: 4000, data: {} },
        ],
      },
      systemPromptBySessionId: {},
    })

    const apiResponse = handleApiRequest(
      apiContextFor("/api/session/ses_events_live/events", fakeDatabase),
    )
    assert.equal(apiResponse.statusCode, 200)
    assert.deepEqual(apiResponse.body, {
      events: [
        { seq: 1, timeCreated: 1000, type: "compaction", detail: "auto" },
        { seq: 2, timeCreated: 2000, type: "model-switched", detail: "a → b" },
        { seq: 3, timeCreated: 3000, type: "system", detail: "system notice" },
      ],
    })
  } finally {
    clearResultCache()
  }
})

test("the events route distinguishes an event-less session (200) from an unknown id (404)", () => {
  clearResultCache()
  try {
    const fakeDatabase = createFakeInsightDatabase({
      sessions: [buildFakeSessionSummary({ id: "ses_events_quiet" })],
      messagesBySessionId: {
        ses_events_quiet: [{ type: "assistant", seq: 1, data: {} }],
      },
      systemPromptBySessionId: {},
    })

    // Session row exists in session_v2 but carries no events → 200 {events: []}.
    const emptyResponse = handleApiRequest(
      apiContextFor("/api/session/ses_events_quiet/events", fakeDatabase),
    )
    assert.equal(emptyResponse.statusCode, 200)
    assert.deepEqual(emptyResponse.body, { events: [] })

    // Unknown session id → 404 with the shared body.
    const unknownResponse = handleApiRequest(
      apiContextFor("/api/session/ses_never_heard_of/events", fakeDatabase),
    )
    assert.equal(unknownResponse.statusCode, 404)
    assert.deepEqual(unknownResponse.body, { error: SESSION_NOT_FOUND_MESSAGE })
  } finally {
    clearResultCache()
  }
})

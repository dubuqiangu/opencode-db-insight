/**
 * Tests for GET /api/tool-health: the pure computeToolHealth
 * aggregation (src/stats/tool-health.ts) runs everywhere; the
 * query-layer faces are locked against a real node:sqlite :memory:
 * controlled fixture (same discipline as session-list-sorting.test.ts
 * — the fake insight database does not mirror json_extract/json_each
 * semantics, so the two-tier extraction must be tested against real
 * SQLite) and skip cleanly when node:sqlite is unavailable.
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import { createRequire } from "node:module"

import type { SqliteReadConnection } from "../src/db/types.ts"
import { queryToolHealth } from "../src/db/tool-health-queries.ts"
import {
  computeToolHealth,
  type ToolHealthSample,
} from "../src/stats/tool-health.ts"
import { matchApiRoute } from "../src/web/router.ts"

// ---------------------------------------------------------------------------
// computeToolHealth — pure function, zero IO
// ---------------------------------------------------------------------------

test("computeToolHealth returns an empty list for empty sample input", () => {
  assert.deepEqual(computeToolHealth([]), [])
})

test("computeToolHealth aggregates buckets and errorRate per tool", () => {
  // Interleave the two tools' samples so grouping, not insertion
  // order, owns the rows.
  const interleavedSamples: ToolHealthSample[] = [
    { tool: "bash", status: "completed" },
    { tool: "edit", status: "completed" },
    { tool: "bash", status: "completed" },
    { tool: "edit", status: "completed" },
    { tool: "bash", status: "completed" },
    { tool: "bash", status: "error" },
  ]

  const toolHealthStats = computeToolHealth(interleavedSamples)

  assert.deepEqual(toolHealthStats, [
    {
      tool: "bash",
      completed: 3,
      error: 1,
      running: 0,
      total: 4,
      errorRate: 0.25,
    },
    {
      tool: "edit",
      completed: 2,
      error: 0,
      running: 0,
      total: 2,
      errorRate: 0,
    },
  ])
})

test("computeToolHealth counts unknown statuses in total but in no bucket", () => {
  const toolHealthStats = computeToolHealth([
    { tool: "webfetch", status: "unknown" },
    { tool: "webfetch", status: "pending" },
    { tool: "webfetch", status: "error" },
  ])

  assert.deepEqual(toolHealthStats, [
    {
      tool: "webfetch",
      completed: 0,
      error: 1,
      running: 0,
      total: 3,
      // Only the "error" sample lands in a bucket numerator; the two
      // unknown/pending samples stay denominator-only.
      errorRate: 1 / 3,
    },
  ])
})

test("computeToolHealth sorts by total descending and tool name ascending on ties", () => {
  const toolHealthStats = computeToolHealth([
    { tool: "zed", status: "completed" },
    { tool: "alpha", status: "completed" },
    { tool: "mid", status: "error" },
    { tool: "mid", status: "completed" },
  ])

  assert.deepEqual(
    toolHealthStats.map((stat) => stat.tool),
    ["mid", "alpha", "zed"],
  )
  // mid (total 2) leads; alpha and zed tie at total 1 and must be
  // name-ascending regardless of their sample insertion order.
  assert.equal(toolHealthStats[1].total, 1)
  assert.equal(toolHealthStats[2].total, 1)
})

test("computeToolHealth never emits a row with total 0 (errorRate stays defined)", () => {
  // Every sample increments its tool's total, so no emitted row can
  // carry total 0; the guard inside errorRate only matters for the
  // empty input, which emits no rows at all.
  const toolHealthStats = computeToolHealth([
    { tool: "bash", status: "completed" },
    { tool: "bash", status: "error" },
    { tool: "bash", status: "running" },
  ])
  assert.equal(toolHealthStats[0].total, 3)
  assert.equal(toolHealthStats[0].errorRate, 1 / 3)
  assert.ok(Number.isFinite(toolHealthStats[0].errorRate))
})

// ---------------------------------------------------------------------------
// route matching
// ---------------------------------------------------------------------------

test("matchApiRoute recognizes the tool-health route", () => {
  assert.deepEqual(matchApiRoute("/api/tool-health"), { routeName: "tool-health" })
  assert.deepEqual(matchApiRoute("/api/tool-health/"), { routeName: "tool-health" })
  assert.equal(matchApiRoute("/api/tool-health/extra"), null, "tool-health takes no sub-path")
})

// ---------------------------------------------------------------------------
// queryToolHealth — db-null contract + real node:sqlite fixture
// ---------------------------------------------------------------------------

test("queryToolHealth returns null when the db connection is missing", () => {
  assert.equal(queryToolHealth(null), null)
})

/** Structural type of a read-write node:sqlite connection for fixtures. */
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
    ? "node:sqlite unavailable — skipping tool-health query fixture tests"
    : false

/** The one session_v2 row every anchored fixture message points at. */
const TOOL_HEALTH_FIXTURE_SESSION_ID = "ses_tool_health_fixture"

/**
 * Session ids present in session_v2 for the fixture. The anchored scan
 * (session_id IN (SELECT id FROM session_v2)) keeps only messages whose
 * session_id is listed here — an unlisted id models an orphan message.
 */
const TOOL_HEALTH_FIXTURE_SESSION_IDS = [TOOL_HEALTH_FIXTURE_SESSION_ID]

/** One fixture session_message row, before it is turned into a wire row. */
interface ToolHealthMessageFixture {
  messageId: string
  type: string
  data: unknown
  /** session_id of the message; defaults to the anchored fixture session. */
  sessionId?: string
}

/**
 * Plant the fixture into a real :memory: SQLite with the wire
 * session_message shape (only the columns the tool-health scan reads:
 * type and data; the rest exist so future query changes fail loudly
 * instead of silently binding to a narrower table). session_v2 carries
 * the anchored sessions so the scan's session_id sub-select matches.
 */
function createToolHealthFixtureDatabase(
  messageFixtures: ToolHealthMessageFixture[],
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
  // Only the anchoring column the scan sub-selects; extra columns are
  // unwanted here (unlike session_message, this scan never reads them).
  fixtureDatabase.exec("CREATE TABLE session_v2 (id TEXT PRIMARY KEY)")
  const insertSessionStatement = fixtureDatabase.prepare("INSERT INTO session_v2 (id) VALUES (?)")
  for (const sessionId of TOOL_HEALTH_FIXTURE_SESSION_IDS) {
    insertSessionStatement.run(sessionId)
  }
  const insertStatement = fixtureDatabase.prepare(
    "INSERT INTO session_message (id, session_id, type, data) VALUES (?, ?, ?, ?)",
  )
  for (const messageFixture of messageFixtures) {
    insertStatement.run(
      messageFixture.messageId,
      messageFixture.sessionId ?? TOOL_HEALTH_FIXTURE_SESSION_ID,
      messageFixture.type,
      typeof messageFixture.data === "string"
        ? messageFixture.data
        : JSON.stringify(messageFixture.data),
    )
  }
  return fixtureDatabase
}

/** Wire-shaped tool part with the current "name" key. */
function toolPart(toolName: string, status: string): Record<string, unknown> {
  return { type: "tool", name: toolName, state: { status } }
}

test("queryToolHealth aggregates statuses over a controlled assistant fixture", { skip: skipReason }, () => {
  // msg_short: the fast-path branch (json_array_length <= 8) — two bash
  // calls in different statuses, one edit call, plus a text part that
  // must be ignored.
  // msg_legacy_name: the historical wire shape carries the tool name in
  // "tool" with no "name" key.
  // msg_missing_state: a tool part without state.status maps to the
  // "unknown" status (total only, no bucket).
  // msg_long_content: 10 tool parts exceed the fast-path limit of 8 and
  // force the json_each fallback, which must see every part.
  // msg_user and msg_non_object_data: excluded by the shared assistant
  // predicate (non-assistant type; valid JSON but not an object).
  const longContentLoopParts = [
    ...Array.from({ length: 6 }, () => toolPart("loop", "completed")),
    ...Array.from({ length: 3 }, () => toolPart("loop", "error")),
    toolPart("loop", "running"),
  ]
  const fixtureDatabase = createToolHealthFixtureDatabase([
    {
      messageId: "msg_short",
      type: "assistant",
      data: {
        content: [
          { type: "text", text: "surrounding prose is never a tool part" },
          toolPart("bash", "completed"),
          toolPart("edit", "completed"),
          toolPart("bash", "error"),
        ],
      },
    },
    {
      messageId: "msg_legacy_name",
      type: "assistant",
      data: { content: [{ type: "tool", tool: "grep", state: { status: "completed" } }] },
    },
    {
      messageId: "msg_missing_state",
      type: "assistant",
      data: { content: [{ type: "tool", name: "webfetch", input: { url: "https://example.com" } }] },
    },
    {
      messageId: "msg_long_content",
      type: "assistant",
      data: { content: longContentLoopParts },
    },
    {
      messageId: "msg_user",
      type: "user",
      data: { content: [toolPart("bash", "completed")] },
    },
    {
      messageId: "msg_non_object_data",
      type: "assistant",
      data: '"a valid JSON string is not an assistant object row"',
    },
  ])

  try {
    const toolHealthStats = queryToolHealth(fixtureDatabase)
    assert.notEqual(toolHealthStats, null)
    assert.deepEqual(toolHealthStats, [
      // loop: 10 parts via the json_each fallback (6 completed,
      // 3 error, 1 running).
      { tool: "loop", completed: 6, error: 3, running: 1, total: 10, errorRate: 0.3 },
      // bash: one completed + one error, both from the fast-path message.
      { tool: "bash", completed: 1, error: 1, running: 0, total: 2, errorRate: 0.5 },
      // total-1 ties sort by tool name ascending.
      { tool: "edit", completed: 1, error: 0, running: 0, total: 1, errorRate: 0 },
      // grep came from the legacy "tool" key.
      { tool: "grep", completed: 1, error: 0, running: 0, total: 1, errorRate: 0 },
      // webfetch had no state.status: "unknown" — total, no bucket.
      { tool: "webfetch", completed: 0, error: 0, running: 0, total: 1, errorRate: 0 },
    ])
  } finally {
    fixtureDatabase.close()
  }
})

test("queryToolHealth returns an empty list for an assistant-only empty fixture", { skip: skipReason }, () => {
  const fixtureDatabase = createToolHealthFixtureDatabase([
    { messageId: "msg_prose_only", type: "assistant", data: { content: [] } },
  ])
  try {
    assert.deepEqual(queryToolHealth(fixtureDatabase), [])
  } finally {
    fixtureDatabase.close()
  }
})

test("queryToolHealth drops tool parts whose name resolves to nothing", { skip: skipReason }, () => {
  // A tool part with neither "name" nor "tool" is not attributable to
  // any tool and must vanish from every counter.
  const fixtureDatabase = createToolHealthFixtureDatabase([
    {
      messageId: "msg_nameless_tool",
      type: "assistant",
      data: {
        content: [
          { type: "tool", state: { status: "completed" } },
          toolPart("bash", "completed"),
        ],
      },
    },
  ])
  try {
    const toolHealthStats = queryToolHealth(fixtureDatabase)
    assert.deepEqual(toolHealthStats, [
      { tool: "bash", completed: 1, error: 0, running: 0, total: 1, errorRate: 0 },
    ])
  } finally {
    fixtureDatabase.close()
  }
})

test("queryToolHealth excludes orphan messages whose session_id is absent from session_v2", { skip: skipReason }, () => {
  // An assistant message carrying a tool part but whose session_id was
  // never registered in session_v2 (会话已删、消息残留). The anchored scan
  // must not count it; before the session_v2 anchor it did.
  const fixtureDatabase = createToolHealthFixtureDatabase([
    {
      messageId: "msg_anchored_bash",
      type: "assistant",
      data: { content: [toolPart("bash", "completed")] },
    },
    {
      messageId: "msg_orphan_edit",
      type: "assistant",
      sessionId: "ses_orphan_not_in_session_v2",
      data: { content: [toolPart("edit", "error")] },
    },
  ])
  try {
    const toolHealthStats = queryToolHealth(fixtureDatabase)
    assert.deepEqual(
      toolHealthStats!.map((stat) => stat.tool),
      ["bash"],
      "the orphan session's edit call must not appear",
    )
    assert.deepEqual(toolHealthStats, [
      { tool: "bash", completed: 1, error: 0, running: 0, total: 1, errorRate: 0 },
    ])
  } finally {
    fixtureDatabase.close()
  }
})

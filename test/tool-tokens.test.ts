/**
 * Tests for GET /api/tool-tokens: the pure computeToolTokens
 * aggregation (src/stats/tool-tokens.ts) runs everywhere; the query
 * layer faces are locked against a real node:sqlite :memory: fixture
 * (the fake insight database does not mirror json_extract/json_each
 * semantics, so the byte-length extraction must be tested against real
 * SQLite) and skip cleanly when node:sqlite is unavailable.
 *
 * 关键不变量：整数守恒（Σ 行 tokens === Σ 步 token，精确相等）——
 * 这是「字节比例归因但总量不减」的契约核心，单独锁定。
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import { createRequire } from "node:module"

import type { SqliteReadConnection } from "../src/db/types.ts"
import { queryToolTokens } from "../src/db/tool-token-queries.ts"
import {
  computeToolTokens,
  type ToolTokenSample,
} from "../src/stats/tool-tokens.ts"
import { makeTokenUsage } from "./helpers/step-factories.ts"
import { matchApiRoute } from "../src/web/router.ts"

// ---------------------------------------------------------------------------
// computeToolTokens — pure function, zero IO
// ---------------------------------------------------------------------------

test("computeToolTokens returns an empty list for empty sample input", () => {
  assert.deepEqual(computeToolTokens([]), [])
})

test("computeToolTokens gives a single-tool step its whole token total", () => {
  const toolTokenStats = computeToolTokens([
    { tokens: makeTokenUsage({ input: 100 }), tools: [{ name: "read", bytes: 7 }] },
  ])
  assert.deepEqual(toolTokenStats, [{ tool: "read", tokens: 100, share: 1, steps: 1 }])
})

test("computeToolTokens splits a two-tool step by byte weight (largest-remainder)", () => {
  // stepTokens = 100; read 10B / edit 20B → raw 33.33 / 66.67 → floors
  // 33 + 66 = 99, 1 deficit goes to the larger remainder (edit) → 33/67.
  const toolTokenStats = computeToolTokens([
    {
      tokens: makeTokenUsage({ input: 100 }),
      tools: [
        { name: "read", bytes: 10 },
        { name: "edit", bytes: 20 },
      ],
    },
  ])
  assert.deepEqual(toolTokenStats, [
    { tool: "edit", tokens: 67, share: 67 / 100, steps: 1 },
    { tool: "read", tokens: 33, share: 33 / 100, steps: 1 },
  ])
  assert.equal(
    toolTokenStats.reduce((sum, stat) => sum + stat.tokens, 0),
    100,
    "integer conservation: Σ rows === step tokens",
  )
})

test("computeToolTokens merges the same tool's bytes within one step", () => {
  // bash appears twice in one step (4B + 8B = 12B, the only tool) → the
  // whole step total lands on bash, counted as one step.
  const toolTokenStats = computeToolTokens([
    {
      tokens: makeTokenUsage({ output: 12 }),
      tools: [
        { name: "bash", bytes: 4 },
        { name: "bash", bytes: 8 },
      ],
    },
  ])
  assert.deepEqual(toolTokenStats, [{ tool: "bash", tokens: 12, share: 1, steps: 1 }])
})

test("computeToolTokens puts a zero-tool step's tokens in the empty-name bucket", () => {
  const toolTokenStats = computeToolTokens([
    { tokens: makeTokenUsage({ input: 50 }), tools: [] },
  ])
  assert.deepEqual(toolTokenStats, [{ tool: "", tokens: 50, share: 1, steps: 1 }])
})

test("computeToolTokens splits equally when every tool's byte weight is zero", () => {
  const toolTokenStats = computeToolTokens([
    {
      tokens: makeTokenUsage({ cacheRead: 10 }),
      tools: [
        { name: "read", bytes: 0 },
        { name: "grep", bytes: 0 },
      ],
    },
  ])
  assert.deepEqual(toolTokenStats, [
    { tool: "grep", tokens: 5, share: 0.5, steps: 1 },
    { tool: "read", tokens: 5, share: 0.5, steps: 1 },
  ])
})

test("computeToolTokens conserves the grand token total exactly across mixed steps", () => {
  // A deliberately lumpy mix (odd divisions, a zero-tool step, an
  // all-empty-byte step and a single-tool step) whose per-step tokens
  // do not divide evenly — Σ rows must still equal Σ step tokens.
  const samples: ToolTokenSample[] = [
    { tokens: makeTokenUsage({ input: 7, output: 3, cacheRead: 1 }), tools: [{ name: "a", bytes: 1 }, { name: "b", bytes: 2 }, { name: "c", bytes: 3 }] },
    { tokens: makeTokenUsage({ output: 5 }), tools: [] },
    { tokens: makeTokenUsage({ input: 9 }), tools: [{ name: "d", bytes: 0 }, { name: "e", bytes: 0 }] },
    { tokens: makeTokenUsage({ input: 11 }), tools: [{ name: "a", bytes: 5 }] },
  ]
  const stepTokensTotal = samples.reduce((sum, sample) => sum + sample.tokens.input + sample.tokens.output + sample.tokens.cacheRead, 0)
  const toolTokenStats = computeToolTokens(samples)
  assert.equal(
    toolTokenStats.reduce((sum, stat) => sum + stat.tokens, 0),
    stepTokensTotal,
  )
  // share is the exact fraction of the grand total per row.
  const shareSum = toolTokenStats.reduce((sum, stat) => sum + stat.share, 0)
  assert.ok(Math.abs(shareSum - 1) < 1e-9, `shares must sum to 1, got ${shareSum}`)
})

test("computeToolTokens sorts by tokens descending with the tool name ascending on ties", () => {
  const toolTokenStats = computeToolTokens([
    { tokens: makeTokenUsage({ input: 4 }), tools: [{ name: "zeta", bytes: 1 }] },
    { tokens: makeTokenUsage({ input: 4 }), tools: [{ name: "alpha", bytes: 1 }] },
    { tokens: makeTokenUsage({ input: 9 }), tools: [{ name: "mid", bytes: 1 }] },
  ])
  assert.deepEqual(
    toolTokenStats.map((stat) => stat.tool),
    ["mid", "alpha", "zeta"],
  )
})

// ---------------------------------------------------------------------------
// route matching
// ---------------------------------------------------------------------------

test("matchApiRoute recognizes the tool-tokens route; near-miss shapes do not match", () => {
  assert.deepEqual(matchApiRoute("/api/tool-tokens"), { routeName: "tool-tokens" })
  assert.deepEqual(matchApiRoute("/api/tool-tokens/"), { routeName: "tool-tokens" })
  assert.equal(matchApiRoute("/api/tool-tokens/extra"), null, "no sub-path")
  assert.equal(matchApiRoute("/api/tool-token"), null, "singular misspelling")
})

// ---------------------------------------------------------------------------
// queryToolTokens — db-null contract + real node:sqlite fixture
// ---------------------------------------------------------------------------

test("queryToolTokens returns null when the db connection is missing", () => {
  assert.equal(queryToolTokens(null), null)
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
    ? "node:sqlite unavailable — skipping tool-tokens query fixture tests"
    : false

/** The one session_v2 row every anchored fixture message points at. */
const TOOL_TOKEN_FIXTURE_SESSION_ID = "ses_tool_token_fixture"
const TOOL_TOKEN_FIXTURE_SESSION_IDS = [TOOL_TOKEN_FIXTURE_SESSION_ID]

/** One fixture session_message row, before it is turned into a wire row. */
interface ToolTokenMessageFixture {
  messageId: string
  type: string
  data: unknown
  /** session_id of the message; defaults to the anchored fixture session. */
  sessionId?: string
}

/**
 * Plant the fixture into a real :memory: SQLite with the wire
 * session_message shape. session_v2 carries the anchored session so the
 * scan's session_id sub-select matches; an unlisted session_id models an
 * orphan message.
 */
function createToolTokenFixtureDatabase(
  messageFixtures: ToolTokenMessageFixture[],
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
  const insertSessionStatement = fixtureDatabase.prepare("INSERT INTO session_v2 (id) VALUES (?)")
  for (const sessionId of TOOL_TOKEN_FIXTURE_SESSION_IDS) {
    insertSessionStatement.run(sessionId)
  }
  const insertStatement = fixtureDatabase.prepare(
    "INSERT INTO session_message (id, session_id, type, data) VALUES (?, ?, ?, ?)",
  )
  for (const messageFixture of messageFixtures) {
    insertStatement.run(
      messageFixture.messageId,
      messageFixture.sessionId ?? TOOL_TOKEN_FIXTURE_SESSION_ID,
      messageFixture.type,
      JSON.stringify(messageFixture.data),
    )
  }
  return fixtureDatabase
}

test("queryToolTokens attributes byte-proportionally over a controlled fixture", { skip: skipReason }, () => {
  // msg_ratio: text part ignored; read 10B vs edit 20B → 33/67 of 100.
  // msg_same_tool_twice: bash twice → 4B + 8B merged, whole 12 to bash.
  // msg_zero_tool: prose only → "" bucket gets 50.
  // msg_empty_bytes: both tools weightless (no state) → equal 5/5 of 10.
  // msg_legacy_tool: name absent, legacy "tool" key + 4B → whole 7.
  // msg_user / msg_orphan: excluded (non-assistant type; unanchored session).
  const fixtureDatabase = createToolTokenFixtureDatabase([
    {
      messageId: "msg_ratio",
      type: "assistant",
      data: {
        tokens: { input: 100, output: 0, cache: { read: 0 } },
        content: [
          { type: "text", text: "prose is not a tool part" },
          { type: "tool", name: "read", state: { output: "aaaaaaaaaa" } },
          { type: "tool", name: "edit", state: { output: "bbbbbbbbbbbbbbbbbbbb" } },
        ],
      },
    },
    {
      messageId: "msg_same_tool_twice",
      type: "assistant",
      data: {
        tokens: { input: 0, output: 12, cache: { read: 0 } },
        content: [
          { type: "tool", name: "bash", state: { output: "aaaa" } },
          { type: "tool", name: "bash", state: { output: "bbbbbbbb" } },
        ],
      },
    },
    {
      messageId: "msg_zero_tool",
      type: "assistant",
      data: {
        tokens: { input: 50, output: 0, cache: { read: 0 } },
        content: [{ type: "text", text: "no tools here" }],
      },
    },
    {
      messageId: "msg_empty_bytes",
      type: "assistant",
      data: {
        tokens: { input: 0, output: 0, cache: { read: 10 } },
        content: [
          { type: "tool", name: "read", state: { status: "completed" } },
          { type: "tool", name: "grep", state: { status: "completed" } },
        ],
      },
    },
    {
      messageId: "msg_legacy_tool",
      type: "assistant",
      data: {
        tokens: { input: 7, output: 0, cache: { read: 0 } },
        content: [{ type: "tool", tool: "webfetch", state: { output: "AAAA" } }],
      },
    },
    {
      messageId: "msg_user",
      type: "user",
      data: { tokens: { input: 999 }, content: [{ type: "tool", name: "bash", state: { output: "x" } }] },
    },
    {
      messageId: "msg_orphan",
      type: "assistant",
      sessionId: "ses_orphan_not_in_session_v2",
      data: { tokens: { input: 999 }, content: [{ type: "tool", name: "bash", state: { output: "x" } }] },
    },
  ])

  try {
    const toolTokenStats = queryToolTokens(fixtureDatabase)
    assert.notEqual(toolTokenStats, null)
    // grand = 100 + 12 + 50 + 10 + 7 = 179.
    assert.deepEqual(toolTokenStats, [
      { tool: "edit", tokens: 67, share: 67 / 179, steps: 1 },
      { tool: "", tokens: 50, share: 50 / 179, steps: 1 },
      { tool: "read", tokens: 38, share: 38 / 179, steps: 2 },
      { tool: "bash", tokens: 12, share: 12 / 179, steps: 1 },
      { tool: "webfetch", tokens: 7, share: 7 / 179, steps: 1 },
      { tool: "grep", tokens: 5, share: 5 / 179, steps: 1 },
    ])
    assert.equal(
      toolTokenStats!.reduce((sum, stat) => sum + stat.tokens, 0),
      179,
      "integer conservation holds through the real SQLite byte extraction",
    )
  } finally {
    fixtureDatabase.close()
  }
})

test("queryToolTokens returns an empty list when no assistant step qualifies", { skip: skipReason }, () => {
  // Only a non-assistant row: the shared assistant predicate excludes
  // it, so the leaderboard has no rows at all.
  const fixtureDatabase = createToolTokenFixtureDatabase([
    { messageId: "msg_user_only", type: "user", data: { content: [] } },
  ])
  try {
    assert.deepEqual(queryToolTokens(fixtureDatabase), [])
  } finally {
    fixtureDatabase.close()
  }
})

test("queryToolTokens counts a zero-token, zero-tool step in the empty-name bucket", { skip: skipReason }, () => {
  // content: [] → no tool parts; tokens 0 → the "" bucket still records
  // the step (tokens 0, share 0) — steps is meaningful even at 0 tokens.
  const fixtureDatabase = createToolTokenFixtureDatabase([
    { messageId: "msg_empty", type: "assistant", data: { tokens: { input: 0 }, content: [] } },
  ])
  try {
    assert.deepEqual(queryToolTokens(fixtureDatabase), [{ tool: "", tokens: 0, share: 0, steps: 1 }])
  } finally {
    fixtureDatabase.close()
  }
})

test("queryToolTokens scopes to a single session when sessionFilterId is passed", { skip: skipReason }, () => {
  // Two anchored sessions: the filter must narrow the scan to one of them
  // (the shared ?session= fragment), leaving the other out entirely.
  const fixtureDatabase = new readWriteConstructor!(":memory:")
  fixtureDatabase.exec(
    `CREATE TABLE session_message (
       id TEXT PRIMARY KEY, session_id TEXT, type TEXT, seq INTEGER,
       time_created INTEGER, time_updated INTEGER, data TEXT
     )`,
  )
  fixtureDatabase.exec("CREATE TABLE session_v2 (id TEXT PRIMARY KEY)")
  const insertSessionStatement = fixtureDatabase.prepare("INSERT INTO session_v2 (id) VALUES (?)")
  insertSessionStatement.run("ses_alpha")
  insertSessionStatement.run("ses_beta")
  const insertStatement = fixtureDatabase.prepare(
    "INSERT INTO session_message (id, session_id, type, data) VALUES (?, ?, ?, ?)",
  )
  insertStatement.run(
    "msg_alpha",
    "ses_alpha",
    "assistant",
    JSON.stringify({
      tokens: { input: 30, output: 0, cache: { read: 0 } },
      content: [{ type: "tool", name: "alpha_tool", state: { output: "aaa" } }],
    }),
  )
  insertStatement.run(
    "msg_beta",
    "ses_beta",
    "assistant",
    JSON.stringify({
      tokens: { input: 70, output: 0, cache: { read: 0 } },
      content: [{ type: "tool", name: "beta_tool", state: { output: "bbb" } }],
    }),
  )
  try {
    assert.deepEqual(queryToolTokens(fixtureDatabase, "ses_alpha"), [
      { tool: "alpha_tool", tokens: 30, share: 1, steps: 1 },
    ])
    assert.deepEqual(queryToolTokens(fixtureDatabase, "ses_beta"), [
      { tool: "beta_tool", tokens: 70, share: 1, steps: 1 },
    ])
    // No filter → both sessions, grand 100.
    assert.deepEqual(
      queryToolTokens(fixtureDatabase)!.map((stat) => stat.tool),
      ["beta_tool", "alpha_tool"],
    )
  } finally {
    fixtureDatabase.close()
  }
})

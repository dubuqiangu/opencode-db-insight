/**
 * Tests for GET /api/tool-tokens: the pure computeToolTokens
 * aggregation (src/stats/tool-tokens.ts) runs everywhere; the query
 * layer faces are locked against a real node:sqlite :memory: fixture
 * (the fake insight database does not mirror json_extract/json_each
 * semantics, so the character/byte-length extraction must be tested
 * against real SQLite) and skip cleanly when node:sqlite is unavailable.
 *
 * 关键不变量：整数守恒（Σ 行 tokens === Σ 步 token，精确相等）——
 * 这是「分词估算归因但总量不减」的契约核心，单独锁定。
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import { createRequire } from "node:module"

import type { SqliteReadConnection } from "../src/db/types.ts"
import { queryToolTokens } from "../src/db/tool-token-queries.ts"
import {
  computeToolTokens,
  estimateTokensFromLengths,
  type ToolTokenSample,
} from "../src/stats/tool-tokens.ts"
import { makeTokenUsage } from "./helpers/step-factories.ts"
import { matchApiRoute } from "../src/web/router.ts"

// ---------------------------------------------------------------------------
// estimateTokensFromLengths — self-contained token estimate
// ---------------------------------------------------------------------------

test("estimateTokensFromLengths treats ASCII as ~1 token per 4 chars", () => {
  assert.equal(estimateTokensFromLengths(0, 0), 0)
  assert.equal(estimateTokensFromLengths(4, 4), 1)
  assert.equal(estimateTokensFromLengths(40, 40), 10)
})

test("estimateTokensFromLengths treats 3-byte CJK as ~1 token per char", () => {
  // "你好世界": 4 chars, 12 UTF-8 bytes → 4 tokens (not 3, as raw bytes would say).
  assert.equal(estimateTokensFromLengths(4, 12), 4)
})

test("estimateTokensFromLengths is linear in (charCount, byteCount)", () => {
  // Same result whether lengths are summed first or estimates are summed.
  const ascii = { charCount: 8, byteCount: 8 }
  const cjk = { charCount: 4, byteCount: 12 }
  const summed = estimateTokensFromLengths(
    ascii.charCount + cjk.charCount,
    ascii.byteCount + cjk.byteCount,
  )
  const perPart =
    estimateTokensFromLengths(ascii.charCount, ascii.byteCount) +
    estimateTokensFromLengths(cjk.charCount, cjk.byteCount)
  assert.equal(summed, perPart)
})

test("estimateTokensFromLengths clamps non-positive and non-finite inputs to zero", () => {
  assert.equal(estimateTokensFromLengths(-5, -5), 0)
  assert.equal(estimateTokensFromLengths(Number.NaN, Number.NaN), 0)
  assert.equal(estimateTokensFromLengths(10, 2), estimateTokensFromLengths(10, 10))
})

// ---------------------------------------------------------------------------
// computeToolTokens — pure function, zero IO
// ---------------------------------------------------------------------------

test("computeToolTokens returns an empty list for empty sample input", () => {
  assert.deepEqual(computeToolTokens([]), [])
})

test("computeToolTokens gives a single-tool step its whole token total", () => {
  const toolTokenStats = computeToolTokens([
    { tokens: makeTokenUsage({ input: 100 }), tools: [{ name: "read", charCount: 7, byteCount: 7 }] },
  ])
  assert.deepEqual(toolTokenStats, [{ tool: "read", tokens: 100, share: 1, steps: 1 }])
})

test("computeToolTokens splits a two-tool step by estimate weight (largest-remainder)", () => {
  // ASCII lengths: estimate 10/4 = 2.5 vs 20/4 = 5 → ratio 1:2 →
  // raw 33.33 / 66.67 → floors 33 + 66 = 99, 1 deficit to the larger
  // remainder (edit) → 33/67.
  const toolTokenStats = computeToolTokens([
    {
      tokens: makeTokenUsage({ input: 100 }),
      tools: [
        { name: "read", charCount: 10, byteCount: 10 },
        { name: "edit", charCount: 20, byteCount: 20 },
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

test("computeToolTokens reweights CJK against ASCII away from raw bytes", () => {
  // cjk "你好世界" = 4 chars / 12 bytes; ascii "abcdabcd" = 8 chars / 8 bytes.
  // Raw-byte weights would be 12:8 = 60/40; the token estimate (4 vs 2)
  // gives 4:2 → 67/33 — closer to a real BPE split.
  const toolTokenStats = computeToolTokens([
    {
      tokens: makeTokenUsage({ output: 100 }),
      tools: [
        { name: "cjk", charCount: 4, byteCount: 12 },
        { name: "ascii", charCount: 8, byteCount: 8 },
      ],
    },
  ])
  assert.deepEqual(toolTokenStats, [
    { tool: "cjk", tokens: 67, share: 67 / 100, steps: 1 },
    { tool: "ascii", tokens: 33, share: 33 / 100, steps: 1 },
  ])
})

test("computeToolTokens merges the same tool's sizes within one step", () => {
  // bash appears twice in one step (4 + 8 chars, the only tool) → the
  // whole step total lands on bash, counted as one step.
  const toolTokenStats = computeToolTokens([
    {
      tokens: makeTokenUsage({ output: 12 }),
      tools: [
        { name: "bash", charCount: 4, byteCount: 4 },
        { name: "bash", charCount: 8, byteCount: 8 },
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

test("computeToolTokens splits equally when every tool's estimate weight is zero", () => {
  const toolTokenStats = computeToolTokens([
    {
      tokens: makeTokenUsage({ cacheRead: 10 }),
      tools: [
        { name: "read", charCount: 0, byteCount: 0 },
        { name: "grep", charCount: 0, byteCount: 0 },
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
  // all-zero-weight step and a single-tool step) whose per-step tokens
  // do not divide evenly — Σ rows must still equal Σ step tokens.
  const samples: ToolTokenSample[] = [
    { tokens: makeTokenUsage({ input: 7, output: 3, cacheRead: 1 }), tools: [{ name: "a", charCount: 1, byteCount: 1 }, { name: "b", charCount: 2, byteCount: 2 }, { name: "c", charCount: 3, byteCount: 3 }] },
    { tokens: makeTokenUsage({ output: 5 }), tools: [] },
    { tokens: makeTokenUsage({ input: 9 }), tools: [{ name: "d", charCount: 0, byteCount: 0 }, { name: "e", charCount: 0, byteCount: 0 }] },
    { tokens: makeTokenUsage({ input: 11 }), tools: [{ name: "a", charCount: 5, byteCount: 5 }] },
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
    { tokens: makeTokenUsage({ input: 4 }), tools: [{ name: "zeta", charCount: 1, byteCount: 1 }] },
    { tokens: makeTokenUsage({ input: 4 }), tools: [{ name: "alpha", charCount: 1, byteCount: 1 }] },
    { tokens: makeTokenUsage({ input: 9 }), tools: [{ name: "mid", charCount: 1, byteCount: 1 }] },
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

test("queryToolTokens attributes by estimate weight over a controlled fixture", { skip: skipReason }, () => {
  // msg_ratio: text part ignored; read 10 chars vs edit 20 chars (ASCII,
  //   so 1:2 in both bytes and estimate) → 33/67 of 100.
  // msg_same_tool_twice: bash twice → 4 + 8 merged, whole 12 to bash.
  // msg_zero_tool: prose only → "" bucket gets 50.
  // msg_empty_weight: both tools weightless (no state) → equal 5/5 of 10.
  // msg_legacy_tool: name absent, legacy "tool" key + 4 chars → whole 7.
  // msg_user / msg_orphan: excluded (non-assistant type; unanchored session).
  const fixtureDatabase = createToolTokenFixtureDatabase([
    {
      messageId: "msg_ratio",
      type: "assistant",
      data: {
        tokens: { input: 100, output: 0, cache: { read: 0 } },
        content: [
          { type: "text", text: "prose is not a tool part" },
          // read takes the state.content[] fallback path; edit takes the
          // state.metadata.output path — both real tool-part shapes.
          { type: "tool", name: "read", state: { content: [{ type: "text", text: "aaaaaaaaaa" }] } },
          { type: "tool", name: "edit", state: { metadata: { output: "bbbbbbbbbbbbbbbbbbbb" } } },
        ],
      },
    },
    {
      messageId: "msg_same_tool_twice",
      type: "assistant",
      data: {
        tokens: { input: 0, output: 12, cache: { read: 0 } },
        content: [
          { type: "tool", name: "bash", state: { metadata: { output: "aaaa" } } },
          { type: "tool", name: "bash", state: { content: [{ type: "text", text: "bbbbbbbb" }] } },
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
        content: [{ type: "tool", tool: "webfetch", state: { metadata: { output: "AAAA" } } }],
      },
    },
    {
      messageId: "msg_user",
      type: "user",
      data: { tokens: { input: 999 }, content: [{ type: "tool", name: "bash", state: { metadata: { output: "x" } } }] },
    },
    {
      messageId: "msg_orphan",
      type: "assistant",
      sessionId: "ses_orphan_not_in_session_v2",
      data: { tokens: { input: 999 }, content: [{ type: "tool", name: "bash", state: { metadata: { output: "x" } } }] },
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

test("queryToolTokens reweights CJK vs ASCII using real SQLite length() semantics", { skip: skipReason }, () => {
  // msg_cjk: cjk output "你好世界" (4 chars / 12 bytes) vs ascii output
  //   "abcdabcd" (8 chars / 8 bytes). Raw bytes would split 60/40
  //   (12:8); the estimate (4 vs 2 tokens) splits 67/33. This pins that
  //   length() returns chars (not bytes) through json_extract.
  const fixtureDatabase = createToolTokenFixtureDatabase([
    {
      messageId: "msg_cjk",
      type: "assistant",
      data: {
        tokens: { input: 0, output: 100, cache: { read: 0 } },
        content: [
          { type: "tool", name: "cjk", state: { metadata: { output: "你好世界" } } },
          { type: "tool", name: "ascii", state: { content: [{ type: "text", text: "abcdabcd" }] } },
        ],
      },
    },
  ])
  try {
    assert.deepEqual(queryToolTokens(fixtureDatabase), [
      { tool: "cjk", tokens: 67, share: 67 / 100, steps: 1 },
      { tool: "ascii", tokens: 33, share: 33 / 100, steps: 1 },
    ])
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
      content: [{ type: "tool", name: "alpha_tool", state: { metadata: { output: "aaa" } } }],
    }),
  )
  insertStatement.run(
    "msg_beta",
    "ses_beta",
    "assistant",
    JSON.stringify({
      tokens: { input: 70, output: 0, cache: { read: 0 } },
      content: [{ type: "tool", name: "beta_tool", state: { content: [{ type: "text", text: "bbb" }] } }],
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

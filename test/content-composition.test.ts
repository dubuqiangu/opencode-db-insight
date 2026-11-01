/**
 * Tests for GET /api/content-composition (A4 会话内容构成): the pure
 * computeContentComposition aggregation (src/stats/content-composition.ts)
 * runs everywhere; the query layer's two-branch UNION ALL / json_each walk
 * is locked against a real node:sqlite :memory: fixture and skips cleanly
 * when node:sqlite is unavailable.
 *
 * The fixture also pins the sub-query isolation fix: json_each exposes its
 * own `type` column, so the assistant scan MUST wrap session_message in a
 * subquery — the bare join fails with "ambiguous column name: type".
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import { createRequire } from "node:module"

import type { SqliteReadConnection } from "../src/db/types.ts"
import { queryContentComposition } from "../src/db/content-composition-queries.ts"
import {
  computeContentComposition,
  CONTENT_COMPOSITION_CATEGORY_KEYS,
  type ContentCompositionSample,
} from "../src/stats/content-composition.ts"
import { estimateTokensFromLengths } from "../src/stats/tool-tokens.ts"
import { matchApiRoute } from "../src/web/router.ts"
import { handleApiRequest } from "../src/web/api.ts"
import { clearResultCache } from "../src/stats/cache.ts"

/** A sample with every field defaulted; override the ones a case cares about. */
function makeContentCompositionSample(
  overrides: Partial<ContentCompositionSample> = {},
): ContentCompositionSample {
  return {
    sessionId: "ses_sample",
    assistantTextChars: 0,
    reasoningChars: 0,
    toolInputChars: 0,
    toolOutputChars: 0,
    toolInputBytes: 0,
    toolOutputBytes: 0,
    otherChars: 0,
    nonAssistantTextChars: 0,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// computeContentComposition — pure function, zero IO
// ---------------------------------------------------------------------------

test("computeContentComposition returns six zero categories for empty input", () => {
  const stats = computeContentComposition([])
  assert.equal(stats.totalChars, 0)
  assert.equal(stats.sessions, 0)
  assert.equal(stats.toolEstimatedTokens, 0)
  assert.deepEqual(
    stats.categories.map((category) => category.key).sort(),
    [...CONTENT_COMPOSITION_CATEGORY_KEYS].sort(),
    "the six-key whitelist is always present",
  )
  assert.ok(stats.categories.every((category) => category.chars === 0 && category.share === 0))
})

test("computeContentComposition folds samples into totalChars, shares and a chars-desc ordering", () => {
  const stats = computeContentComposition([
    makeContentCompositionSample({
      sessionId: "ses_a",
      assistantTextChars: 30,
      reasoningChars: 10,
      toolInputChars: 50,
      toolOutputChars: 5,
      toolInputBytes: 50,
      toolOutputBytes: 5,
      nonAssistantTextChars: 5,
    }),
    makeContentCompositionSample({ sessionId: "ses_b", assistantTextChars: 20, otherChars: 1 }),
  ])

  // 50 assistantText + 10 reasoning + 50 toolInput + 5 toolOutput + 1 other + 5 userText = 121.
  assert.equal(stats.totalChars, 121)
  assert.equal(stats.sessions, 2)

  // chars desc, ties broken by key asc (assistantText before toolInput).
  assert.deepEqual(
    stats.categories.map((category) => [category.key, category.chars]),
    [
      ["assistantText", 50],
      ["toolInput", 50],
      ["reasoning", 10],
      ["toolOutput", 5],
      ["userText", 5],
      ["other", 1],
    ],
  )
  const shareByKey = new Map(stats.categories.map((category) => [category.key, category.share]))
  assert.equal(shareByKey.get("assistantText"), 50 / 121)
  assert.equal(shareByKey.get("other"), 1 / 121)
})

test("computeContentComposition derives toolEstimatedTokens from tool chars + bytes only", () => {
  const stats = computeContentComposition([
    makeContentCompositionSample({
      sessionId: "ses_a",
      assistantTextChars: 9999,
      reasoningChars: 9999,
      toolInputChars: 40,
      toolOutputChars: 10,
      toolInputBytes: 42,
      toolOutputBytes: 12,
      nonAssistantTextChars: 9999,
    }),
  ])
  // Text categories never feed the estimate — only tool input+output.
  assert.equal(stats.toolEstimatedTokens, estimateTokensFromLengths(50, 54))
})

test("computeContentComposition counts each session once across the two scan halves", () => {
  const stats = computeContentComposition([
    makeContentCompositionSample({ sessionId: "ses_a", assistantTextChars: 1 }),
    makeContentCompositionSample({ sessionId: "ses_a", nonAssistantTextChars: 1 }),
    makeContentCompositionSample({ sessionId: "ses_b", assistantTextChars: 1 }),
    // An empty session id never counts.
    makeContentCompositionSample({ sessionId: "", assistantTextChars: 1 }),
  ])
  assert.equal(stats.sessions, 2)
})

// ---------------------------------------------------------------------------
// route matching
// ---------------------------------------------------------------------------

test("matchApiRoute recognizes the content-composition route; near-miss shapes do not match", () => {
  assert.deepEqual(matchApiRoute("/api/content-composition"), { routeName: "content-composition" })
  assert.deepEqual(matchApiRoute("/api/content-composition/"), { routeName: "content-composition" })
  assert.equal(matchApiRoute("/api/content-composition/extra"), null, "no sub-path")
  assert.equal(matchApiRoute("/api/content-compositions"), null, "plural misspelling")
})

// ---------------------------------------------------------------------------
// queryContentComposition — db-null contract + real node:sqlite fixture
// ---------------------------------------------------------------------------

test("queryContentComposition returns null when the db connection is missing", () => {
  assert.equal(queryContentComposition(null), null)
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
    ? "node:sqlite unavailable — skipping content-composition query fixture tests"
    : false

/** One fixture session_message row, before it is turned into a wire row. */
interface ContentCompositionMessageFixture {
  sessionId: string
  type: string
  data: unknown
}

/** Plant the fixture into a real :memory: SQLite with the wire shapes. */
function createContentCompositionFixtureDatabase(
  sessionIds: string[],
  messageFixtures: ContentCompositionMessageFixture[],
): SqliteReadWriteConnection {
  const fixtureDatabase = new readWriteConstructor!(":memory:")
  fixtureDatabase.exec("CREATE TABLE session_v2 (id TEXT PRIMARY KEY)")
  fixtureDatabase.exec(
    `CREATE TABLE session_message (
       id TEXT PRIMARY KEY,
       session_id TEXT,
       type TEXT,
       time_created INTEGER,
       data TEXT
     )`,
  )
  const insertSessionStatement = fixtureDatabase.prepare("INSERT INTO session_v2 (id) VALUES (?)")
  for (const sessionId of sessionIds) insertSessionStatement.run(sessionId)

  const insertMessageStatement = fixtureDatabase.prepare(
    "INSERT INTO session_message (id, session_id, type, time_created, data) VALUES (?, ?, ?, ?, ?)",
  )
  messageFixtures.forEach((messageFixture, messageIndex) => {
    insertMessageStatement.run(
      `msg_${messageIndex}`,
      messageFixture.sessionId,
      messageFixture.type,
      messageIndex,
      JSON.stringify(messageFixture.data),
    )
  })
  return fixtureDatabase
}

const RICH_ASSISTANT_DATA = {
  content: [
    { type: "text", text: "hello" },
    { type: "reasoning", text: "why" },
    {
      type: "tool",
      name: "read",
      state: { input: { path: "/a/b.ts" }, metadata: { output: "out" } },
    },
  ],
}

test("queryContentComposition walks assistant parts and non-assistant text per session", { skip: skipReason }, () => {
  const fixtureDatabase = createContentCompositionFixtureDatabase(
    ["ses_a", "ses_b"],
    [
      { sessionId: "ses_a", type: "assistant", data: RICH_ASSISTANT_DATA },
      // Non-assistant side: $.text wins.
      { sessionId: "ses_a", type: "user", data: { text: "hi there" } },
      { sessionId: "ses_b", type: "assistant", data: { content: [{ type: "text", text: "world" }] } },
      // Orphan message: session_id absent from session_v2 → excluded by the anchor.
      { sessionId: "ses_orphan", type: "assistant", data: { content: [{ type: "text", text: "zzz" }] } },
    ],
  )
  try {
    // A bare `session_message m, json_each(...)` join throws
    // "ambiguous column name: type"; reaching the assertions proves the
    // sub-query isolation holds.
    const samples = queryContentComposition(fixtureDatabase)!
    assert.notEqual(samples, null)
    // ses_a → one assistant row + one non-assistant row; ses_b → one assistant row.
    assert.equal(samples.length, 3, "orphan dropped, session halves stay separate rows")

    const assistantSamples = samples.filter((sample) => sample.assistantTextChars > 0)
    const assistantSampleBySessionId = new Map(
      assistantSamples.map((sample) => [sample.sessionId, sample]),
    )
    assert.deepEqual(assistantSampleBySessionId.get("ses_a"), {
      sessionId: "ses_a",
      assistantTextChars: 5, // "hello"
      reasoningChars: 3, // "why"
      toolInputChars: 18, // {"path":"/a/b.ts"}
      toolOutputChars: 3, // "out"
      toolInputBytes: 18,
      toolOutputBytes: 3,
      otherChars: 0,
      nonAssistantTextChars: 0,
    })
    assert.equal(assistantSampleBySessionId.get("ses_b")!.assistantTextChars, 5) // "world"

    const nonAssistantSample = samples.find((sample) => sample.nonAssistantTextChars > 0)!
    assert.equal(nonAssistantSample.sessionId, "ses_a")
    assert.equal(nonAssistantSample.nonAssistantTextChars, 8) // "hi there"
  } finally {
    fixtureDatabase.close()
  }
})

test("queryContentComposition scopes to a single session when sessionFilterId is passed", { skip: skipReason }, () => {
  const fixtureDatabase = createContentCompositionFixtureDatabase(
    ["ses_alpha", "ses_beta"],
    [
      { sessionId: "ses_alpha", type: "assistant", data: { content: [{ type: "text", text: "alpha" }] } },
      { sessionId: "ses_alpha", type: "user", data: { text: "hi" } },
      { sessionId: "ses_beta", type: "assistant", data: { content: [{ type: "text", text: "beta" }] } },
    ],
  )
  try {
    const alphaSamples = queryContentComposition(fixtureDatabase, "ses_alpha")!
    assert.ok(alphaSamples.length > 0)
    assert.ok(alphaSamples.every((sample) => sample.sessionId === "ses_alpha"))

    // Empty string = the no-filter default (both sessions).
    const defaultSessionIds = new Set(
      queryContentComposition(fixtureDatabase, "")!.map((sample) => sample.sessionId),
    )
    assert.deepEqual([...defaultSessionIds].sort(), ["ses_alpha", "ses_beta"])
  } finally {
    fixtureDatabase.close()
  }
})

// ---------------------------------------------------------------------------
// endpoint shape — GET /api/content-composition
// ---------------------------------------------------------------------------

test(
  "the content-composition route serves the aggregated { totalChars, categories, toolEstimatedTokens, sessions } body",
  { skip: skipReason },
  () => {
    const fixtureDatabase = createContentCompositionFixtureDatabase(
      ["ses_a", "ses_b"],
      [
        { sessionId: "ses_a", type: "assistant", data: RICH_ASSISTANT_DATA },
        { sessionId: "ses_a", type: "user", data: { text: "hi there" } },
        { sessionId: "ses_b", type: "assistant", data: { content: [{ type: "text", text: "world" }] } },
      ],
    )
    clearResultCache()
    try {
      const response = handleApiRequest({
        route: matchApiRoute("/api/content-composition")!,
        searchParams: new URLSearchParams(),
        database: fixtureDatabase,
        databasePath: ":memory:",
        serverPort: 18791,
      })
      assert.equal(response.statusCode, 200)
      const body = response.body as {
        totalChars: number
        categories: Array<{ key: string; chars: number; share: number }>
        toolEstimatedTokens: number
        sessions: number
      }
      assert.deepEqual(Object.keys(body).sort(), [
        "categories",
        "sessions",
        "toolEstimatedTokens",
        "totalChars",
      ])
      // same characters as the sample test: 10 + 3 + 18 + 3 + 8 = 42.
      assert.equal(body.totalChars, 42)
      assert.equal(body.sessions, 2)
      assert.equal(body.categories.length, 6)
      assert.equal(body.toolEstimatedTokens, estimateTokensFromLengths(21, 21))
    } finally {
      clearResultCache()
      fixtureDatabase.close()
    }
  },
)

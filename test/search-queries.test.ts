/**
 * Tests for the cross-session full-text search (v0.24.0, GET /api/search).
 *
 * The query runs against the real node:sqlite :memory: fixture (发布清单
 * #2 — SQL semantics locked against real SQLite, never a fake JS mirror).
 * The searchable text itself comes from message-text-extract.ts, whose
 * semantic parity with the frontend replay-message-text.js is the lock
 * the search feature depends on.
 *
 * Covered:
 * - substring finds a tool input command (the tool-input search surface
 *   that the convergence probe added);
 * - regex finds a pattern, case-insensitively;
 * - a plain user-text match;
 * - invalid regex degrades to { hits:[], total:0, error:"invalid regex" }
 *   (a 200 payload, not a throw);
 * - the hit cap (200) returns the first 200 while total stays the full
 *   match count;
 * - db = null returns null (caller answers 503).
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import { createRequire } from "node:module"

import type { SqliteReadConnection } from "../src/db/types.ts"
import { queryCrossSessionSearch } from "../src/db/search-queries.ts"

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
    ? "node:sqlite unavailable — skipping cross-session search tests"
    : false

/** A fresh in-memory db carrying session_v2 and session_message fixtures. */
function createSearchFixtureDatabase(): SqliteReadWriteConnection {
  const database = new readWriteConstructor!(":memory:")
  database.exec(
    "CREATE TABLE session_v2 (" +
      "id TEXT, title TEXT, model TEXT, agent TEXT, directory TEXT, " +
      "time_created INTEGER, time_updated INTEGER, " +
      "tokens_input REAL, tokens_output REAL, tokens_cache_read REAL, cost REAL);" +
      "CREATE TABLE session_message (" +
      "id TEXT, session_id TEXT, type TEXT, seq INTEGER, " +
      "time_created INTEGER, time_updated INTEGER, data TEXT);",
  )
  const insertSession = database.prepare(
    "INSERT INTO session_v2 (id, title, model, agent, directory, time_created, time_updated, " +
      "tokens_input, tokens_output, tokens_cache_read, cost) " +
      "VALUES (?, 'fixture title', '{}', 'fixer', '', 1000, 2000, 0, 0, 0, 0)",
  )
  insertSession.run("ses_search_alpha")
  insertSession.run("ses_search_beta")

  const insertMessage = database.prepare(
    "INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) " +
      "VALUES (?, ?, ?, ?, 1000, 2000, ?)",
  )
  insertMessage.run(
    "msg_tool_input",
    "ses_search_alpha",
    "assistant",
    1,
    JSON.stringify({
      text: "开始处理",
      content: [
        {
          type: "tool",
          name: "shell",
          state: {
            input: { command: "ls -la /tmp/xanadu-marker" },
            metadata: { output: "done" },
          },
        },
      ],
    }),
  )
  insertMessage.run(
    "msg_user_text",
    "ses_search_alpha",
    "user",
    0,
    JSON.stringify({ text: "请把这段 proto 配置修一下" }),
  )
  // Escapable char ("&") before the match — snippet <mark> must land on the
  // real match, not on an entity expansion of an earlier character.
  insertMessage.run(
    "msg_ampersand",
    "ses_search_alpha",
    "user",
    0,
    JSON.stringify({ text: "AT&T bar" }),
  )
  // Case-folding point: 'İ' (U+0130) lowercases to two code units ("i" + a
  // combining dot), so a naive toLowerCase-index search would misplace the
  // <mark> on the original text. The match index must come from the original.
  insertMessage.run(
    "msg_casefold",
    "ses_search_alpha",
    "user",
    0,
    JSON.stringify({ text: "İstanbul foo" }),
  )
  // Orphan: session_id is never registered in session_v2 (会话已删、消息残留).
  insertMessage.run(
    "msg_orphan",
    "ses_search_orphan",
    "assistant",
    0,
    JSON.stringify({ text: "orphanmarker should not be searched" }),
  )
  insertMessage.run(
    "msg_regex_target",
    "ses_search_beta",
    "assistant",
    0,
    JSON.stringify({ text: "Pattern PROBE-42 appears in the log." }),
  )
  insertMessage.run(
    "msg_other_type",
    "ses_search_beta",
    "system",
    0,
    JSON.stringify({ text: "system 不在搜索范围" }),
  )
  return database
}

test("null db degrades to null (caller answers 503)", () => {
  const result = queryCrossSessionSearch(null, "anything", "substring")
  assert.equal(result, null)
})

test(
  "substring finds a tool input command and reports the session title",
  { skip: skipReason },
  () => {
    const database = createSearchFixtureDatabase()
    try {
      const result = queryCrossSessionSearch(
        database as unknown as SqliteReadConnection,
        "xanadu-marker",
        "substring",
      )
      assert.notEqual(result, null)
      assert.equal(result!.mode, "substring")
      assert.equal(result!.total, 1)
      assert.equal(result!.hits.length, 1)
      const hit = result!.hits[0]
      assert.equal(hit.messageId, "msg_tool_input")
      assert.equal(hit.sessionId, "ses_search_alpha")
      assert.equal(hit.sessionTitle, "fixture title")
      assert.equal(hit.messageType, "assistant")
      assert.ok(hit.snippet.includes("xanadu-marker"), "snippet centers on the tool input command")
    } finally {
      database.close()
    }
  },
)

test(
  "user-text matches and empty q returns an empty payload",
  { skip: skipReason },
  () => {
    const database = createSearchFixtureDatabase()
    try {
      const result = queryCrossSessionSearch(
        database as unknown as SqliteReadConnection,
        "proto 配置",
        "substring",
      )
      assert.notEqual(result, null)
      assert.equal(result!.total, 1)
      assert.equal(result!.hits[0].messageId, "msg_user_text")

      const emptyResult = queryCrossSessionSearch(
        database as unknown as SqliteReadConnection,
        "",
        "substring",
      )
      assert.deepEqual(emptyResult, { query: "", mode: "substring", hits: [], total: 0 })
    } finally {
      database.close()
    }
  },
)

test(
  "regex finds a pattern case-insensitively",
  { skip: skipReason },
  () => {
    const database = createSearchFixtureDatabase()
    try {
      const result = queryCrossSessionSearch(
        database as unknown as SqliteReadConnection,
        "probe-\\d+",
        "regex",
      )
      assert.notEqual(result, null)
      assert.equal(result!.mode, "regex")
      assert.equal(result!.total, 1)
      assert.equal(result!.hits[0].messageId, "msg_regex_target")
      assert.ok(result!.hits[0].snippet.includes("PROBE-42"))
    } finally {
      database.close()
    }
  },
)

test(
  "invalid regex degrades to empty hits with an error field (200 payload, not a throw)",
  { skip: skipReason },
  () => {
    const database = createSearchFixtureDatabase()
    try {
      const result = queryCrossSessionSearch(
        database as unknown as SqliteReadConnection,
        "([unclosed",
        "regex",
      )
      assert.notEqual(result, null)
      assert.deepEqual(result, {
        query: "([unclosed",
        mode: "regex",
        hits: [],
        total: 0,
        error: "invalid regex",
      })
    } finally {
      database.close()
    }
  },
)

test(
  "snippet <mark> lands on the real match when an escapable char precedes it",
  { skip: skipReason },
  () => {
    const database = createSearchFixtureDatabase()
    try {
      const result = queryCrossSessionSearch(
        database as unknown as SqliteReadConnection,
        "bar",
        "substring",
      )
      assert.notEqual(result, null)
      assert.equal(result!.total, 1)
      const hit = result!.hits[0]
      assert.equal(hit.messageId, "msg_ampersand")
      // "AT&T" must be escaped but the mark must wrap only "bar": the old
      // (unescaped-window index math) version produced "AT&am<mark>p;T</mark>".
      assert.equal(hit.snippet, "AT&amp;T <mark>bar</mark>")
      assert.ok(!hit.snippet.includes("<mark>amp"), "the mark must not swallow the &amp; entity")
      assert.ok(!hit.snippet.includes("<mark>p"), "the mark must not land on the escaped '&' remainder")
    } finally {
      database.close()
    }
  },
)

test(
  "search ignores orphan messages whose session_id is absent from session_v2",
  { skip: skipReason },
  () => {
    const database = createSearchFixtureDatabase()
    try {
      const result = queryCrossSessionSearch(
        database as unknown as SqliteReadConnection,
        "orphanmarker",
        "substring",
      )
      assert.notEqual(result, null)
      assert.equal(result!.total, 0, "the orphan session's message must not appear in results")
      assert.deepEqual(result!.hits, [])
    } finally {
      database.close()
    }
  },
)

test(
  "match index comes from the original text, not a lowercased copy (İ case-folding)",
  { skip: skipReason },
  () => {
    const database = createSearchFixtureDatabase()
    try {
      const result = queryCrossSessionSearch(
        database as unknown as SqliteReadConnection,
        "foo",
        "substring",
      )
      assert.notEqual(result, null)
      assert.equal(result!.total, 1)
      const hit = result!.hits[0]
      assert.equal(hit.messageId, "msg_casefold")
      // 'İstanbul foo': 'İ' lowercases to two code units, so a lowered-index
      // search would slice the original one code unit early and mark "oo".
      assert.equal(hit.snippet, "İstanbul <mark>foo</mark>")
    } finally {
      database.close()
    }
  },
)

test(
  "equal timestamps fall back to a deterministic id DESC tie-break",
  { skip: skipReason },
  () => {
    const database = new readWriteConstructor!(":memory:")
    try {
      database.exec(
        "CREATE TABLE session_v2 (" +
          "id TEXT, title TEXT, model TEXT, agent TEXT, directory TEXT, " +
          "time_created INTEGER, time_updated INTEGER, " +
          "tokens_input REAL, tokens_output REAL, tokens_cache_read REAL, cost REAL);" +
          "CREATE TABLE session_message (" +
          "id TEXT, session_id TEXT, type TEXT, seq INTEGER, " +
          "time_created INTEGER, time_updated INTEGER, data TEXT);",
      )
      database
        .prepare(
          "INSERT INTO session_v2 (id, title, model, agent, directory, time_created, time_updated, " +
            "tokens_input, tokens_output, tokens_cache_read, cost) " +
            "VALUES ('ses_search_tie', 'tie title', '{}', 'fixer', '', 1000, 2000, 0, 0, 0, 0)",
        )
        .run()
      const insertMessage = database.prepare(
        "INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) " +
          "VALUES (?, 'ses_search_tie', 'user', ?, 1000, 2000, ?)",
      )
      // Same time_created; only the ids differ → id DESC decides.
      insertMessage.run("msg_tie_alpha", 0, JSON.stringify({ text: "tieword alpha" }))
      insertMessage.run("msg_tie_beta", 1, JSON.stringify({ text: "tieword beta" }))
      const result = queryCrossSessionSearch(
        database as unknown as SqliteReadConnection,
        "tieword",
        "substring",
      )
      assert.notEqual(result, null)
      assert.deepEqual(
        result!.hits.map((hit) => hit.messageId),
        ["msg_tie_beta", "msg_tie_alpha"],
      )
    } finally {
      database.close()
    }
  },
)

test(
  "hits are capped at 200 while total reflects the full match count",
  { skip: skipReason },
  () => {
    const database = new readWriteConstructor!(":memory:")
    try {
      database.exec(
        "CREATE TABLE session_v2 (" +
          "id TEXT, title TEXT, model TEXT, agent TEXT, directory TEXT, " +
          "time_created INTEGER, time_updated INTEGER, " +
          "tokens_input REAL, tokens_output REAL, tokens_cache_read REAL, cost REAL);" +
          "CREATE TABLE session_message (" +
          "id TEXT, session_id TEXT, type TEXT, seq INTEGER, " +
          "time_created INTEGER, time_updated INTEGER, data TEXT);",
      )
      const insertSession = database.prepare(
        "INSERT INTO session_v2 (id, title, model, agent, directory, time_created, time_updated, " +
          "tokens_input, tokens_output, tokens_cache_read, cost) " +
          "VALUES (?, 'title', '{}', 'fixer', '', 1000, 2000, 0, 0, 0, 0)",
      )
      insertSession.run("ses_search_bulk")
      const insertMessage = database.prepare(
        "INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) " +
          "VALUES (?, 'ses_search_bulk', 'user', ?, ?, 2000, ?)",
      )
      // 250 条 user 消息都含 "commonword"——匹配数超 200 上限。
      // time_created 递增（= messageIndex），配合 ORDER BY time_created DESC,
      // id DESC：命中顺序确定且最新优先，前 200 条即 msg_bulk_50 .. msg_bulk_249。
      for (let messageIndex = 0; messageIndex < 250; messageIndex += 1) {
        insertMessage.run(
          `msg_bulk_${messageIndex}`,
          messageIndex,
          messageIndex,
          JSON.stringify({ text: `message ${messageIndex} with commonword` }),
        )
      }
      const result = queryCrossSessionSearch(
        database as unknown as SqliteReadConnection,
        "commonword",
        "substring",
      )
      assert.notEqual(result, null)
      assert.equal(result!.total, 250, "total is the true full match count")
      assert.equal(result!.hits.length, 200, "hits are capped at the newest 200")
      assert.equal(result!.hits[0].messageId, "msg_bulk_249", "newest match leads")
      assert.equal(result!.hits[199].messageId, "msg_bulk_50", "the cap cuts at the 200th newest")
    } finally {
      database.close()
    }
  },
)
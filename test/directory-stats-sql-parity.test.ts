/**
 * Real-SQL structural tests for queryDirectoryStats (v0.3.1 P1-3): the
 * fake-database conservation locks dispatch on SQL strings and re-write
 * the semantics in JS, so a structural regression of the production SQL
 * (LEFT JOIN degrading to INNER, the assistant predicate moving out of
 * the subquery, the WHERE exclusion weakening) would leave them green.
 *
 * These tests plant a controlled fixture into a real node:sqlite
 * DatabaseSync(":memory:") and assert the faces such regressions break,
 * one face per test: the zero-step directory must stay listed and
 * counted, the NULL/empty-directory sessions must stay excluded,
 * Σ steps / Σ sessions must conserve, and the three-key ordering must
 * hold. The whole file skips when node:sqlite is unavailable (same
 * fallback as sql-aggregation-parity.test.ts and the live smoke tests).
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import { createRequire } from "node:module"

import type { SqliteReadConnection } from "../src/db/types.ts"
import { queryDirectoryStats } from "../src/db/directory-queries.ts"

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
    ? "node:sqlite unavailable — skipping directory-stats SQL parity tests"
    : false

/** One assistant step row's wire shape inside session_message. */
const ASSISTANT_OBJECT_DATA_TEXT = "{}"

/**
 * A fresh in-memory database carrying the full controlled fixture:
 * - example-beta (backslash path): two sessions, 2 steps each.
 * - example-gamma: 4 steps, one session — a steps tie with example-beta.
 * - example-alpha / example-delta: steps AND sessions both tied.
 * - example-junk: three assistant rows, only the JSON-object one is a step.
 * - example-quiet: zero assistant steps, NULL time_updated.
 * - NULL-directory and empty-string-directory sessions carrying steps.
 *
 * Token columns (v0.15.0) are non-zero and distinct per session, so the
 * per-directory sums have a non-trivial expected value and a step-count
 * multiplication is detectable (see the fan-out test).
 */
function createDirectoryFixtureDatabase(): SqliteReadWriteConnection {
  const database = new readWriteConstructor!(":memory:")
  database.exec(
    "CREATE TABLE session_message (" +
      "id TEXT, session_id TEXT, type TEXT, seq INTEGER, " +
      "time_created INTEGER, time_updated INTEGER, data TEXT);" +
      "CREATE TABLE session_v2 (" +
      "id TEXT, title TEXT, model TEXT, agent TEXT, directory TEXT, " +
      "time_created INTEGER, time_updated INTEGER, " +
      "tokens_input REAL, tokens_output REAL, tokens_cache_read REAL, cost REAL);",
  )

  const insertSession = database.prepare(
    "INSERT INTO session_v2 (id, title, model, agent, directory, time_created, time_updated, " +
      "tokens_input, tokens_output, tokens_cache_read, cost) VALUES (?, 't', '{}', 'a', ?, ?, ?, ?, ?, ?, 0)",
  )
  const insertMessage = database.prepare(
    "INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) " +
      "VALUES (?, ?, ?, ?, 1000, 1000, ?)",
  )
  const addSession = (
    sessionId: string,
    directoryColumn: string | null,
    timeUpdated: number | null,
    tokensInput: number,
    tokensOutput: number,
    tokensCacheRead: number,
  ) => {
    insertSession.run(sessionId, directoryColumn, 1000, timeUpdated, tokensInput, tokensOutput, tokensCacheRead)
  }
  const addAssistantObjectStep = (sessionId: string, stepIndex: number) => {
    insertMessage.run(`msg_${sessionId}_${stepIndex}`, sessionId, "assistant", stepIndex, ASSISTANT_OBJECT_DATA_TEXT)
  }

  // example-beta: two sessions, 2 steps each → steps 4, sessions 2.
  addSession("ses_beta_1", "D:\\projects\\example-beta", 1000, 300, 30, 3)
  addSession("ses_beta_2", "D:\\projects\\example-beta", 2000, 600, 60, 6)
  addAssistantObjectStep("ses_beta_1", 1)
  addAssistantObjectStep("ses_beta_1", 2)
  addAssistantObjectStep("ses_beta_2", 1)
  addAssistantObjectStep("ses_beta_2", 2)

  // example-gamma: steps tie with example-beta (4), fewer sessions.
  addSession("ses_gamma", "D:/projects/example-gamma", 3000, 4000, 400, 40)
  for (let stepIndex = 1; stepIndex <= 4; stepIndex += 1) {
    addAssistantObjectStep("ses_gamma", stepIndex)
  }

  // example-alpha / example-delta: steps AND sessions both tied →
  // directory asc decides ("...alpha" < "...delta").
  addSession("ses_alpha", "D:/projects/example-alpha", 4000, 100, 10, 1)
  addAssistantObjectStep("ses_alpha", 1)
  addSession("ses_delta", "D:/projects/example-delta", 5000, 200, 20, 2)
  addAssistantObjectStep("ses_delta", 1)

  // example-junk: three assistant rows, only the JSON-object one is
  // a step — the predicate must reject non-object and invalid data.
  addSession("ses_junk", "D:/projects/example-junk", 6000, 500, 50, 5)
  addAssistantObjectStep("ses_junk", 1)
  insertMessage.run("msg_junk_text", "ses_junk", "assistant", 2, '"just a json string"')
  insertMessage.run("msg_junk_invalid", "ses_junk", "assistant", 3, "not valid json {{")

  // example-quiet: a session with a user row but zero assistant steps,
  // and a NULL time_updated → steps 0, lastActiveMs null. Its tokens
  // must still sum in exactly once (LEFT JOIN NULL row).
  addSession("ses_quiet", "D:/projects/example-quiet", null, 700, 70, 7)
  insertMessage.run("msg_quiet_user", "ses_quiet", "user", 1, '{"text":"no assistant reply"}')

  // Excluded sessions: SQL NULL and empty-string directories, both
  // carrying assistant-object steps and DISTINCT token values that
  // must not reach any bucket or sum.
  addSession("ses_null_directory", null, 7000, 9999, 999, 99)
  addAssistantObjectStep("ses_null_directory", 1)
  addAssistantObjectStep("ses_null_directory", 2)
  addSession("ses_empty_directory", "", 8000, 8888, 888, 88)
  addAssistantObjectStep("ses_empty_directory", 1)

  return database
}

/** Run the query against a fresh fixture db, closing it afterwards. */
function statsFromFreshFixture() {
  const database = createDirectoryFixtureDatabase()
  try {
    return {
      directoryStats: queryDirectoryStats(database as unknown as SqliteReadConnection, 50)!,
    }
  } finally {
    database.close()
  }
}

test(
  "real-SQL: the zero-step directory stays listed and counted (LEFT JOIN regression face)",
  { skip: skipReason },
  () => {
    const { directoryStats } = statsFromFreshFixture()
    const quietRow = directoryStats.directories.find(
      (directoryRow) => directoryRow.directory === "D:/projects/example-quiet",
    )
    assert.ok(quietRow !== undefined, "the zero-step directory must stay listed")
    assert.equal(quietRow!.steps, 0)
    assert.equal(quietRow!.sessions, 1)
    assert.equal(quietRow!.lastActiveMs, null, "all-NULL time_updated must coerce to null")
    assert.equal(directoryStats.totalSessions, 7, "its session counts toward the total")
  },
)

test(
  "real-SQL: non-object and invalid-JSON assistant rows are not steps",
  { skip: skipReason },
  () => {
    const { directoryStats } = statsFromFreshFixture()
    const junkRow = directoryStats.directories.find(
      (directoryRow) => directoryRow.directory === "D:/projects/example-junk",
    )
    assert.ok(junkRow !== undefined)
    assert.equal(junkRow!.steps, 1, "only the JSON-object row counted as a step")
  },
)

test(
  "real-SQL: NULL and empty-string directories never reach the list or the totals",
  { skip: skipReason },
  () => {
    const { directoryStats } = statsFromFreshFixture()
    assert.equal(directoryStats.totalDirectories, 6)
    for (const directoryRow of directoryStats.directories) {
      assert.ok(directoryRow.directory !== "")
      assert.ok(directoryRow.directory !== null)
      assert.ok(directoryRow.name !== "")
    }
  },
)

test(
  "real-SQL: the listing conserves totalSessions and the listed step rows",
  { skip: skipReason },
  () => {
    const { directoryStats } = statsFromFreshFixture()
    const listedSessionSum = directoryStats.directories.reduce(
      (sessionAccumulator, directoryRow) => sessionAccumulator + directoryRow.sessions,
      0,
    )
    const listedStepSum = directoryStats.directories.reduce(
      (stepAccumulator, directoryRow) => stepAccumulator + directoryRow.steps,
      0,
    )
    assert.equal(listedSessionSum, directoryStats.totalSessions)
    // 4+4+1+1+1+0: the three excluded steps (2 NULL-dir + 1 empty-dir)
    // must not leak into any bucket.
    assert.equal(listedStepSum, 11)
  },
)

test(
  "real-SQL: a session's tokens are never multiplied by its step count (v0.15.0 fan-out face)",
  { skip: skipReason },
  () => {
    const { directoryStats } = statsFromFreshFixture()

    // example-gamma: ONE session carrying 4 assistant steps. Under the
    // old per-step-row join shape, SUM(s.tokens_input) would see the
    // session row four times and answer 16000; the pre-aggregated
    // subquery must keep the row-level value.
    const gammaRow = directoryStats.directories.find(
      (directoryRow) => directoryRow.directory === "D:/projects/example-gamma",
    )
    assert.ok(gammaRow !== undefined)
    assert.equal(gammaRow!.steps, 4)
    assert.deepEqual(
      [gammaRow!.tokensInput, gammaRow!.tokensOutput, gammaRow!.tokensCacheRead],
      [4000, 400, 40],
      "4 steps join as ONE pre-aggregated row, not four",
    )

    // example-beta: two 2-step sessions — the sum is the two sessions'
    // row-level values (300+600), never (300+600)×2.
    const betaRow = directoryStats.directories.find(
      (directoryRow) => directoryRow.directory === "D:\\projects\\example-beta",
    )
    assert.ok(betaRow !== undefined)
    assert.deepEqual(
      [betaRow!.tokensInput, betaRow!.tokensOutput, betaRow!.tokensCacheRead],
      [900, 90, 9],
    )

    // example-quiet: zero steps → LEFT JOIN emits the NULL subquery row,
    // and the session's tokens still count exactly once.
    const quietRow = directoryStats.directories.find(
      (directoryRow) => directoryRow.directory === "D:/projects/example-quiet",
    )
    assert.ok(quietRow !== undefined)
    assert.deepEqual(
      [quietRow!.tokensInput, quietRow!.tokensOutput, quietRow!.tokensCacheRead],
      [700, 70, 7],
      "a zero-step session contributes its tokens once",
    )
  },
)

test(
  "real-SQL: the three token sums conserve the listed sessions' v2 columns",
  { skip: skipReason },
  () => {
    const { directoryStats } = statsFromFreshFixture()
    // Hand-derived from the fixture: the seven listed sessions' token
    // columns, once each. The excluded sessions carry DISTINCT values
    // (9999/999/99 and 8888/888/88) — any leak breaks the equality.
    const listedTokensInputSum = directoryStats.directories.reduce(
      (tokensInputAccumulator, directoryRow) => tokensInputAccumulator + directoryRow.tokensInput,
      0,
    )
    const listedTokensOutputSum = directoryStats.directories.reduce(
      (tokensOutputAccumulator, directoryRow) => tokensOutputAccumulator + directoryRow.tokensOutput,
      0,
    )
    const listedTokensCacheReadSum = directoryStats.directories.reduce(
      (tokensCacheReadAccumulator, directoryRow) =>
        tokensCacheReadAccumulator + directoryRow.tokensCacheRead,
      0,
    )
    assert.equal(listedTokensInputSum, 6400, "Σ tokensInput: 300+600+4000+100+200+500+700")
    assert.equal(listedTokensOutputSum, 640, "Σ tokensOutput: 30+60+400+10+20+50+70")
    assert.equal(listedTokensCacheReadSum, 64, "Σ tokensCacheRead: 3+6+40+1+2+5+7")
  },
)

test(
  "real-SQL: rows follow the steps/sessions/directory order and MAX(time_updated)",
  { skip: skipReason },
  () => {
    const { directoryStats } = statsFromFreshFixture()
    assert.deepEqual(
      directoryStats.directories.map((directoryRow) => directoryRow.name),
      [
        "example-beta", // steps 4, sessions 2 — wins the steps tie on sessions
        "example-gamma", // steps 4, sessions 1
        "example-alpha", // steps 1, sessions 1 — directory asc from here
        "example-delta",
        "example-junk",
        "example-quiet", // steps 0 last
      ],
    )
    assert.deepEqual(
      directoryStats.directories.map((directoryRow) => [directoryRow.steps, directoryRow.sessions]),
      [
        [4, 2],
        [4, 1],
        [1, 1],
        [1, 1],
        [1, 1],
        [0, 1],
      ],
    )
    // lastActiveMs per directory is MAX(time_updated) — example-beta's
    // two sessions take the newer timestamp.
    const betaRow = directoryStats.directories.find(
      (directoryRow) => directoryRow.directory === "D:\\projects\\example-beta",
    )
    assert.equal(betaRow!.lastActiveMs, 2000)
  },
)

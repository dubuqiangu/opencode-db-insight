/**
 * Parity tests for the SQL-side aggregations (P0-1): every route's new
 * pipeline (src/db/aggregate-queries.ts) must be field-for-field identical
 * to the previous JS aggregation over queryAssistantStepRows.
 *
 * Two对照 scenarios:
 * 1. A fixture database — a real temporary SQLite file with fake data
 *    covering the wire shapes: multi-model/multi-agent sessions, missing
 *    token blocks, text/boolean/null token values, text-stored
 *    timestamps, legacy "tool"-keyed tool names, empty-string names,
 *    non-object data JSON, and sessions without session_v2 rows.
 * 2. The machine's real opencode.db when present (skipped otherwise).
 *
 * The whole file skips when node:sqlite is unavailable.
 */

import { after, test } from "node:test"
import assert from "node:assert/strict"
import { createRequire } from "node:module"
import { existsSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type {
  OverviewStats,
  SqliteReadConnection,
} from "../src/db/types.ts"
import {
  queryAgentStats,
  queryAssistantStepRows,
  queryDailyTrend,
  queryModelMetrics,
  queryOverview,
  querySessionList,
  querySessionSummaryById,
  resolveOpencodeDbPath,
} from "../src/db/queries.ts"
import { readAgentName, coerceText } from "../src/db/rows.ts"
import { bucketDailyTrend, toLocalDateKey } from "../src/stats/daily-buckets.ts"
import { hitRate } from "../src/stats/hit-rate.ts"
import { computeModelMetrics } from "../src/stats/model-metrics.ts"
import { computeAgentStats, type AgentSessionMembershipSample } from "../src/stats/agent-fingerprint.ts"

/** Structural type of a read-write node:sqlite connection for fixtures. */
interface SqliteReadWriteConnection extends SqliteReadConnection {
  /** Raw SQL execution — used only for BEGIN/ROLLBACK snapshot control. */
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
  readWriteConstructor === null ? "node:sqlite unavailable — skipping aggregation parity tests" : false

// ---------------------------------------------------------------------------
// Old-pipeline reference aggregations (the pre-P0-1 JS 口径).

/** Old overview aggregation, verbatim from the pre-P0-1 queries.ts. */
function computeOldOverview(
  stepRows: NonNullable<ReturnType<typeof queryAssistantStepRows>>,
  sessionCount: number,
  totalCost: number,
): OverviewStats {
  const todayDateKey = toLocalDateKey(Date.now())
  let todayTokens = 0
  let totalTokens = 0
  let todayCacheRead = 0
  let todayInput = 0

  for (const stepRow of stepRows) {
    const stepTokens = stepRow.tokens.input + stepRow.tokens.output + stepRow.tokens.cacheRead
    totalTokens += stepTokens
    if (toLocalDateKey(stepRow.timeCreated) === todayDateKey) {
      todayTokens += stepTokens
      todayCacheRead += stepRow.tokens.cacheRead
      todayInput += stepRow.tokens.input
    }
  }

  return {
    todayTokens,
    totalTokens,
    todayHitRate: hitRate(todayCacheRead, todayInput),
    sessionCount,
    stepCount: stepRows.length,
    totalCost,
  }
}

/** Old membership scan of session_v2, verbatim from the pre-P0-1 queryAgentStats. */
function computeOldMemberships(
  database: SqliteReadConnection,
): AgentSessionMembershipSample[] {
  const rawSessionRows = database.prepare("SELECT id, agent FROM session_v2").all()
  const memberships: AgentSessionMembershipSample[] = []
  for (const rawRow of rawSessionRows) {
    if (typeof rawRow !== "object" || rawRow === null) continue
    const rowRecord = rawRow as Record<string, unknown>
    memberships.push({ agent: readAgentName(rowRecord["agent"]), sessionId: coerceText(rowRecord["id"]) })
  }
  return memberships
}

function readSessionCounts(database: SqliteReadConnection): { sessionCount: number; totalCost: number } {
  const countRow = database.prepare("SELECT COUNT(*) AS sessionCount FROM session_v2").get() as
    | Record<string, unknown>
    | null
  const costRow = database.prepare("SELECT SUM(cost) AS totalCost FROM session_v2").get() as
    | Record<string, unknown>
    | null
  return {
    sessionCount: Number(countRow?.["sessionCount"] ?? 0) || 0,
    totalCost: Number(costRow?.["totalCost"] ?? 0) || 0,
  }
}

/** Assert the four routes agree between the new SQL and old JS pipelines. */
function assertRouteParity(database: SqliteReadConnection): void {
  const stepRows = queryAssistantStepRows(database) ?? []
  const memberships = computeOldMemberships(database)
  const { sessionCount, totalCost } = readSessionCounts(database)

  assert.deepEqual(queryOverview(database), computeOldOverview(stepRows, sessionCount, totalCost))
  assert.deepEqual(queryModelMetrics(database), computeModelMetrics(stepRows))
  assert.deepEqual(queryAgentStats(database), computeAgentStats(memberships, stepRows))

  for (const trendDays of [7, 30, 90]) {
    assert.deepEqual(
      queryDailyTrend(database, trendDays),
      bucketDailyTrend(stepRows, trendDays),
      `trend parity broke for days=${trendDays}`,
    )
  }
  assert.deepEqual(queryDailyTrend(database, 0), [], "days<=0 stays an empty series")
}

// ---------------------------------------------------------------------------
// Fixture database (fake data in a real SQLite file).

/** Local noon timestamps keep "today" bucketing timezone-safe in fixtures. */
function localNoonMs(daysAgo: number): number {
  const nowDate = new Date()
  const noonDate = new Date(nowDate.getFullYear(), nowDate.getMonth(), nowDate.getDate(), 12, 0)
  return noonDate.getTime() - daysAgo * 24 * 60 * 60 * 1000
}

function createFixtureDatabase(databasePath: string): SqliteReadWriteConnection {
  const database = new readWriteConstructor!(databasePath)
  database
    .prepare(
      `CREATE TABLE session_message (
         id TEXT, session_id TEXT, type TEXT, seq INTEGER,
         time_created INTEGER, time_updated INTEGER, data TEXT)`,
    )
    .run()
  database
    .prepare(
      `CREATE TABLE session_v2 (
         id TEXT, title TEXT, model TEXT, agent TEXT, directory TEXT,
         time_created INTEGER, time_updated INTEGER,
         tokens_input REAL, tokens_output REAL, tokens_cache_read REAL, cost REAL)`,
    )
    .run()

  const insertMessage = database.prepare(
    "INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?, ?)",
  )
  const insertSession = database.prepare(
    "INSERT INTO session_v2 (id, title, model, agent, directory, time_created, time_updated, tokens_input, tokens_output, tokens_cache_read, cost) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  )

  let messageSeq = 0
  const addMessage = (
    sessionId: string,
    type: string,
    // string covers text-stored timestamps (SQLite keeps non-numeric text
    // in the INTEGER column), which must coerce to 0 like coerceNumber.
    timeCreated: number | string,
    data: string | null,
  ): void => {
    messageSeq += 1
    insertMessage.run(`msg_${messageSeq}`, sessionId, type, messageSeq, timeCreated, timeCreated, data)
  }

  // Session rows: ses_build (has assistant steps), ses_review (no steps —
  // sessions must still count via membership), ses_orphan absent on
  // purpose (steps attribute defensively).
  insertSession.run("ses_build", "构建会话", '{"id":"glm-5.3","providerID":"futureppo"}', "build", "",
    localNoonMs(5), localNoonMs(0), 900, 400, 5000, 1.5)
  insertSession.run("ses_review", "审查会话", '{"id":"claude-opus-5","providerID":"anthropic"}', "review", "",
    localNoonMs(4), localNoonMs(3), 100, 50, 0, 0.25)

  const assistantPayload = (overrides: Record<string, unknown>): string =>
    JSON.stringify({
      agent: "build",
      model: { id: "glm-5.3", providerID: "futureppo" },
      tokens: { input: 100, output: 40, reasoning: 10, cache: { read: 60, write: 5 } },
      content: [],
      ...overrides,
    })

  // Today's steps across two models and two sessions.
  addMessage("ses_build", "assistant", localNoonMs(0), assistantPayload({}))
  addMessage("ses_build", "assistant", localNoonMs(0),
    assistantPayload({ model: { id: "claude-opus-5" }, tokens: { input: 300, output: 0, reasoning: 0, cache: { read: 100, write: 20 } } }))
  // The user message must never contribute.
  addMessage("ses_build", "user", localNoonMs(0), JSON.stringify({ text: "你好" }))

  // Yesterday and older steps (trend windows of 7/30/90 must all agree).
  addMessage("ses_build", "assistant", localNoonMs(1), assistantPayload({ tokens: { input: 500, output: 50, cache: { read: 0, write: 0 } } }))
  addMessage("ses_orphan", "assistant", localNoonMs(3),
    assistantPayload({
      agent: "review",
      model: { id: "", providerID: "" }, // empty model id → "unknown"
      content: [
        { type: "text", text: "部分正文" },
        { type: "tool", name: "read", state: { status: "completed" } },
        { type: "tool", name: "", tool: "legacy_edit", state: {} }, // legacy key fallback
        { type: "tool", name: 5, state: {} }, // non-string name coerces to "5"
        { type: "tool", state: {} }, // nameless tool: contributes nothing
        { type: "reasoning", text: "推理片段" },
      ],
    }))
  addMessage("ses_orphan", "assistant", localNoonMs(9), assistantPayload({ agent: undefined, tokens: undefined }))

  // Tool-name fast-path boundary (P0-1 perf follow-up): a content array of
  // exactly TOOL_NAME_FAST_PATH_PART_LIMIT parts, with the tool at the last
  // fast-path index, must extract identically from both pipelines.
  addMessage("ses_orphan", "assistant", localNoonMs(2),
    assistantPayload({
      content: [
        { type: "text", text: "填充1" },
        { type: "text", text: "填充2" },
        { type: "text", text: "填充3" },
        { type: "text", text: "填充4" },
        { type: "text", text: "填充5" },
        { type: "text", text: "填充6" },
        { type: "text", text: "填充7" },
        { type: "tool", name: "boundary_tool", state: {} }, // index 7
      ],
    }))
  // A longer array exercises the json_each fallback: the tool sits beyond
  // the fast-path indices and must still be counted.
  addMessage("ses_orphan", "assistant", localNoonMs(2),
    assistantPayload({
      content: [
        { type: "text", text: "长数组1" },
        { type: "text", text: "长数组2" },
        { type: "text", text: "长数组3" },
        { type: "text", text: "长数组4" },
        { type: "text", text: "长数组5" },
        { type: "text", text: "长数组6" },
        { type: "text", text: "长数组7" },
        { type: "text", text: "长数组8" },
        { type: "text", text: "长数组9" },
        { type: "tool", name: "deep_tool", state: {} }, // index 9 → fallback branch
      ],
    }))
  // Content that is not an array contributes no tool names in either pipeline.
  addMessage("ses_orphan", "assistant", localNoonMs(2), assistantPayload({ content: "not an array" }))
  // A boolean tool name coerces like the old parser (true → "true").
  addMessage("ses_orphan", "assistant", localNoonMs(2),
    assistantPayload({ content: [{ type: "tool", name: true, state: {} }] }))

  // v0.11.0 byModel window shape: this model's ONLY activity is 30 days
  // back — inside the 90-day trend window, outside the 7/30-day ones —
  // so the trend byModel maps must list it for days=90 and never for
  // days=7/30 (window-pruning leak lock, both pipelines agree via the
  // shared bucket-prune).
  addMessage("ses_orphan", "assistant", localNoonMs(30),
    assistantPayload({
      model: { id: "example-model-leak", providerID: "example-provider" },
      tokens: { input: 1000, output: 20, cacheRead: 0, write: 0 },
    }))

  // P1-1 parity shapes: token values as text (prefix-numeric and pure
  // text), booleans and null must all count as zero tokens exactly like
  // the old coerceNumber — SQLite's own numeric coercion would
  // prefix-parse "12abc" into 12 and turn true into 1, which is why the
  // overview route must not sum tokens inside SQL. One row lands today so
  // the today-sums are exercised too.
  addMessage("ses_orphan", "assistant", localNoonMs(0),
    assistantPayload({ tokens: { input: "12abc", output: "纯文本token", cache: { read: true, write: null } } }))
  addMessage("ses_orphan", "assistant", localNoonMs(1),
    assistantPayload({ tokens: { input: true, output: null, cache: { read: "7z压缩", write: 5 } } }))
  // A text-stored timestamp must coerce to 0 in JS (epoch 1970 → never
  // "today"), never prefix-parse to 12 ms via CAST — its tokens are real
  // so totalTokens parity would break on any SQLite-side arithmetic.
  addMessage("ses_orphan", "assistant", "12abc",
    assistantPayload({ tokens: { input: 70, output: 7, cache: { read: 7, write: 0 } } }))

  // Rows the old parser skipped must stay excluded by the SQL predicate.
  addMessage("ses_build", "assistant", localNoonMs(0), "[]") // valid JSON, not an object
  addMessage("ses_build", "assistant", localNoonMs(0), '"a bare string"')
  addMessage("ses_build", "assistant", localNoonMs(0), null) // NULL data column
  addMessage("ses_build", "assistant", localNoonMs(0), "not json at all")

  return database
}

// ---------------------------------------------------------------------------
// Fixture parity (fake data) + live-db parity (real data, when present).

const fixtureDirectory = readWriteConstructor === null ? null : await mkdtemp(join(tmpdir(), "insight-parity-"))
const fixtureDatabase =
  fixtureDirectory === null
    ? null
    : createFixtureDatabase(join(fixtureDirectory, "fixture.db"))

after(async () => {
  fixtureDatabase?.close()
  if (fixtureDirectory !== null) await rm(fixtureDirectory, { recursive: true, force: true })
})

test("fixture sessions round-trip through the list and by-id queries", { skip: skipReason }, () => {
  // Guards the shared parseSessionSummaryRow refactor (P2-2): the by-id
  // lookup must return exactly the list-row shape for the same session.
  assert.notEqual(fixtureDatabase, null)
  const database = fixtureDatabase!
  const sessionPage = querySessionList(database, 10, 0)!
  assert.equal(sessionPage.length, 2)

  const listedSession = sessionPage[0]
  const byIdSession = querySessionSummaryById(database, listedSession.id)
  assert.deepEqual(byIdSession, listedSession)
  assert.equal(querySessionSummaryById(database, "ses_absent_everywhere"), null)

  // v0.13.0 列形状锁: the three session_v2 token columns pass through
  // per-field (coerced value-by-value), while `tokens` stays the fold
  // of exactly those three columns. ses_build = 900/400/5000,
  // ses_review = 100/50/0 — the distinct REAL SQLite values, not a fake
  // JS mirror, so a column swap or fold-into-input bug fails here.
  const expectedComponentsBySessionId: Record<string, [number, number, number]> = {
    ses_build: [900, 400, 5000],
    ses_review: [100, 50, 0],
  }
  for (const summary of sessionPage) {
    const [expectedInput, expectedOutput, expectedCacheRead] =
      expectedComponentsBySessionId[summary.id]
    assert.equal(summary.tokensInput, expectedInput)
    assert.equal(summary.tokensOutput, expectedOutput)
    assert.equal(summary.tokensCacheRead, expectedCacheRead)
    assert.equal(summary.tokens, expectedInput + expectedOutput + expectedCacheRead)
  }
})

test("fixture database: SQL aggregation matches the old JS aggregation on every route", { skip: skipReason }, () => {
  // The deterministic edge-shape gate for P0-1: multi-model/multi-agent
  // rows, missing token blocks, legacy "tool"-keyed names, empty-string
  // model ids, non-object data JSON and orphan sessions must all come out
  // identical from both pipelines.
  assert.notEqual(fixtureDatabase, null)
  assertRouteParity(fixtureDatabase!)
})

const liveDatabasePath = resolveOpencodeDbPath()
const liveSnapshotDatabase =
  readWriteConstructor === null || !existsSync(liveDatabasePath)
    ? null
    : (() => {
        try {
          return new readWriteConstructor(liveDatabasePath, { readOnly: true })
        } catch {
          return null
        }
      })()
const liveSkipReason: string | false =
  liveSnapshotDatabase === null
    ? "opencode.db not found on this machine — skipping live aggregation parity tests"
    : false

after(() => {
  liveSnapshotDatabase?.close()
})

test("live opencode.db: SQL aggregation matches the old JS aggregation on every route", { skip: liveSkipReason }, () => {
  const database = liveSnapshotDatabase!
  // opencode keeps writing this database while the suite runs (the very
  // session executing these tests lands in it), and in-flight assistant
  // rows get their `data` rewritten as streaming completes — so two
  // independent scans can disagree on token sums even with identical row
  // counts (observed: equal stepCount, ±drift in totalTokens/todayTokens).
  // One read transaction pins a single WAL snapshot so both pipelines
  // aggregate the exact same rows and stay strictly comparable.
  database.exec("BEGIN")
  try {
    assertRouteParity(database)
  } finally {
    database.exec("ROLLBACK")
  }
})

/**
 * Smoke tests for the db read layer against the real opencode.db.
 * Every query runs once when ~/.local/share/opencode/opencode.db exists;
 * otherwise the whole file skips (CI/other machines).
 */

import { after, test } from "node:test"
import assert from "node:assert/strict"
import { homedir } from "node:os"
import { join } from "node:path"

import {
  openOpencodeDb,
  queryAgentStats,
  queryDailyTrend,
  queryModelMetrics,
  queryOverview,
  querySessionList,
  querySessionMessages,
  querySessionSystemPrompt,
  queryTodoStats,
  resolveOpencodeDbPath,
} from "../src/db/queries.ts"

const liveDatabase = openOpencodeDb()
const skipReason: string | false =
  liveDatabase === null ? "opencode.db not found on this machine — skipping live smoke tests" : false

after(() => {
  liveDatabase?.close()
})

test("resolveOpencodeDbPath points at opencode.db inside the user home share directory", () => {
  const resolvedPath = resolveOpencodeDbPath()
  assert.ok(resolvedPath.endsWith(join(".local", "share", "opencode", "opencode.db")))
  // must be derived from the environment, never a hardcoded absolute path
  const homeDirectory = homedir()
  assert.ok(resolvedPath.startsWith(homeDirectory))
})

test("openOpencodeDb returns null for a nonexistent database path", () => {
  const missingPath = join(homedir(), ".local", "share", "opencode", "no-such-database.sqlite")
  assert.equal(openOpencodeDb(missingPath), null)
})

test("every query answers null when no database connection is available", () => {
  assert.equal(queryOverview(null), null)
  assert.equal(queryDailyTrend(null, 7), null)
  assert.equal(queryModelMetrics(null), null)
  assert.equal(queryAgentStats(null), null)
  assert.equal(querySessionList(null, 10, 0), null)
  assert.equal(querySessionMessages(null, "ses_x"), null)
  assert.equal(queryTodoStats(null), null)
  assert.equal(querySessionSystemPrompt(null, "ses_x"), null)
})

test("queryOverview returns non-negative KPIs and a hit rate within [0, 1]", { skip: skipReason }, () => {
  const overview = queryOverview(liveDatabase)
  assert.notEqual(overview, null)
  assert.ok(overview!.todayTokens >= 0)
  assert.ok(overview!.totalTokens >= overview!.todayTokens)
  assert.ok(overview!.todayHitRate >= 0 && overview!.todayHitRate <= 1)
  assert.ok(overview!.sessionCount >= 0)
  assert.ok(overview!.stepCount >= 0)
  assert.ok(overview!.totalCost >= 0)
})

test("queryDailyTrend returns a seven point zero-filled series with valid local dates", { skip: skipReason }, () => {
  const trendPoints = queryDailyTrend(liveDatabase, 7)
  assert.equal(trendPoints?.length, 7)
  for (const trendPoint of trendPoints!) {
    assert.match(trendPoint.date, /^\d{4}-\d{2}-\d{2}$/)
    assert.ok(trendPoint.steps >= 0)
    assert.ok(trendPoint.input >= 0)
    assert.ok(trendPoint.read >= 0)
    assert.ok(trendPoint.output >= 0)
    assert.ok(trendPoint.hitRate >= 0 && trendPoint.hitRate <= 1)
  }
})

test("queryDailyTrend returns an empty series for a non-positive day count", { skip: skipReason }, () => {
  assert.deepEqual(queryDailyTrend(liveDatabase, 0), [])
})

test("queryModelMetrics returns leaderboard rows sorted by tokens with consistent activity range", {
  skip: skipReason,
}, () => {
  const modelMetrics = queryModelMetrics(liveDatabase)
  assert.ok(Array.isArray(modelMetrics))
  for (const modelMetric of modelMetrics!) {
    assert.ok(modelMetric.steps >= 1)
    assert.ok(modelMetric.tokens >= 0)
    assert.ok(modelMetric.hitRate >= 0 && modelMetric.hitRate <= 1)
    assert.ok(modelMetric.outputPerStep >= 0)
    assert.ok(modelMetric.firstSeen <= modelMetric.lastSeen)
  }
  for (let index = 1; index < modelMetrics!.length; index += 1) {
    assert.ok(modelMetrics![index - 1].tokens >= modelMetrics![index].tokens)
  }
})

test("queryAgentStats returns one row per agent with session counts and fingerprints", {
  skip: skipReason,
}, () => {
  const agentStats = queryAgentStats(liveDatabase)
  assert.ok(Array.isArray(agentStats))
  for (const agentStat of agentStats!) {
    assert.ok(agentStat.agent !== "")
    assert.ok(agentStat.sessions >= 0)
    assert.ok(agentStat.tokens >= 0)
    for (const toolCallCount of Object.values(agentStat.toolFingerprint)) {
      assert.ok(toolCallCount >= 1)
    }
  }
})

test("querySessionList returns at most the requested page, most recently updated first", {
  skip: skipReason,
}, () => {
  const sessionPage = querySessionList(liveDatabase, 5, 0)
  assert.ok(sessionPage !== null)
  assert.ok(sessionPage!.length <= 5)
  for (let index = 1; index < sessionPage!.length; index += 1) {
    assert.ok(sessionPage![index - 1].timeUpdated >= sessionPage![index].timeUpdated)
  }
})

test("querySessionList clamps absurd pagination parameters instead of failing", { skip: skipReason }, () => {
  const clampedPage = querySessionList(liveDatabase, -5, -10)
  assert.ok(clampedPage !== null)
  assert.ok(clampedPage!.length <= 1) // limit clamps up to 1
})

test("querySessionMessages returns seq-ordered messages of the newest session", { skip: skipReason }, () => {
  const newestSession = querySessionList(liveDatabase, 1, 0)?.[0]
  if (newestSession === undefined) return // empty database
  const messageRecords = querySessionMessages(liveDatabase, newestSession.id)
  assert.ok(messageRecords !== null)
  for (let index = 1; index < messageRecords!.length; index += 1) {
    assert.ok(messageRecords![index - 1].seq <= messageRecords![index].seq)
    assert.equal(messageRecords![index].sessionId, newestSession.id)
  }
})

test("querySessionMessages returns an empty array for an unknown session id", { skip: skipReason }, () => {
  assert.deepEqual(querySessionMessages(liveDatabase, "ses_does_not_exist_anywhere"), [])
})

test("queryTodoStats totals cover the known status buckets", { skip: skipReason }, () => {
  const todoStats = queryTodoStats(liveDatabase)
  assert.ok(todoStats !== null)
  assert.ok(todoStats!.total >= 0)
  assert.ok(
    todoStats!.total >= todoStats!.completed + todoStats!.pending + todoStats!.inProgress,
  )
})

test("querySessionSystemPrompt returns null or string-valued instruction entries for the newest session", {
  skip: skipReason,
}, () => {
  const newestSession = querySessionList(liveDatabase, 1, 0)?.[0]
  if (newestSession === undefined) return
  const systemPrompt = querySessionSystemPrompt(liveDatabase, newestSession.id)
  if (systemPrompt === null) return // session predates instruction_state
  for (const instructionContent of Object.values(systemPrompt)) {
    assert.equal(typeof instructionContent, "string")
    assert.ok(instructionContent.length > 0)
  }
})

test("querySessionSystemPrompt returns null for an unknown session id", { skip: skipReason }, () => {
  assert.equal(querySessionSystemPrompt(liveDatabase, "ses_does_not_exist_anywhere"), null)
})

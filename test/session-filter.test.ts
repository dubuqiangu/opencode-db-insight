/**
 * v0.20.0 ?session= 会话过滤的真实 SQL 语义测试（:memory: node:sqlite）。
 *
 * 为什么是真库而不是 fake：过滤片段（scan-conventions
 * buildSessionFilterSqlFragments）拼进各端点的 SQL 后，绑定参数位置、
 * WHERE 前置/追加形状、子查询别名解析这些语义只有真实 SQLite 才能
 * 锁住——fake db 对聚合扫描不做过滤（语义权威在这里，见
 * fake-insight-db.ts 文件头）。夹具三个会话 + 跨会话的 step /
 * compaction / todo 数据，逐消费端点断言「过滤后只剩目标会话」与
 * 「缺省 = 现行全量口径」。API 层契约（404 统一 body、空串按缺省、
 * 缓存键 session 维度、非消费路由忽略该参数）同文件覆盖。
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import { createRequire } from "node:module"

import type { SqliteReadConnection } from "../src/db/types.ts"
import { queryTodoStats, sessionExistsInSessionV2 } from "../src/db/queries.ts"
import {
  queryAgentStats,
  queryDailyTrend,
  queryModelMetrics,
  queryOverview,
} from "../src/db/aggregate-queries.ts"
import {
  queryCompactionStats,
  queryHourHeatmap,
  querySessionSurvival,
} from "../src/db/behavior-queries.ts"
import { queryToolHealth } from "../src/db/tool-health-queries.ts"
import { queryDirectoryStats } from "../src/db/directory-queries.ts"
import {
  handleApiRequest,
  SESSION_FILTER_NOT_FOUND_MESSAGE,
  type ApiRequestContext,
} from "../src/web/api.ts"
import { matchApiRoute } from "../src/web/router.ts"
import { clearResultCache, resultCacheSize } from "../src/stats/cache.ts"

// ---------------------------------------------------------------------------
// Fixture: three sessions with cross-session step / compaction / todo data.

/** Structural shape of a read-write node:sqlite connection for fixtures. */
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
  readWriteConstructor === null ? "node:sqlite unavailable — skipping session filter tests" : false

/** 过滤目标会话：两条 assistant step（各 200 tokens）+ 一条 user 消息。 */
const ALPHA_SESSION_ID = "ses_alpha_build"
/** 对照会话：一条别的模型的 step + 两条 compaction。 */
const BETA_SESSION_ID = "ses_beta_review"
/** 存在于 session_v2 但零消息零 tokens 的安静会话。 */
const QUIET_SESSION_ID = "ses_quiet_no_steps"
/** 不存在于 session_v2 的 id：404 循环与存在性探针用它。 */
const MISSING_SESSION_ID = "ses_missing_identity"

/** Local noon keeps "today" bucketing timezone-safe in fixtures. */
function localNoonMs(daysAgo: number): number {
  const nowDate = new Date()
  const noonDate = new Date(nowDate.getFullYear(), nowDate.getMonth(), nowDate.getDate(), 12, 0)
  return noonDate.getTime() - daysAgo * 24 * 60 * 60 * 1000
}

/** Wire shape of one assistant step's data column. */
function assistantStepPayload(
  agentName: string,
  modelId: string,
  providerId: string,
  tokens: Record<string, unknown>,
  content: unknown[],
): string {
  return JSON.stringify({
    // agent 必须与 session_v2 的会话 agent 一致：agent 统计把 step
    // 用量归到 step 数据的 agent 名下（computeAgentStats 口径）。
    agent: agentName,
    model: { id: modelId, providerID: providerId },
    tokens,
    content,
  })
}

/**
 * Build the three-session fixture. Session columns deliberately carry
 * distinct per-session values so a filter leak (beta steps counting into
 * alpha's aggregates) breaks a numeric assertion instead of cancelling out.
 */
function createSessionFilterFixtureDatabase(): SqliteReadConnection {
  const database = new readWriteConstructor!(":memory:")
  database.exec(
    "CREATE TABLE session_v2 (" +
      "id TEXT, title TEXT, model TEXT, agent TEXT, directory TEXT, " +
      "time_created REAL, time_updated REAL, " +
      "tokens_input REAL, tokens_output REAL, tokens_cache_read REAL, cost REAL, " +
      "tokens_reasoning REAL, tokens_cache_write REAL, parent_id TEXT, idle_outcome TEXT)",
  )
  database.exec(
    "CREATE TABLE session_message (" +
      "id TEXT, session_id TEXT, type TEXT, seq INTEGER, " +
      "time_created REAL, time_updated REAL, data TEXT)",
  )
  // 活库 todo 表带 session_id 列（v0.20.0 探针）；查询按该列过滤。
  database.exec("CREATE TABLE todo (session_id TEXT, status TEXT)")

  const insertSession = database.prepare(
    "INSERT INTO session_v2 (id, title, model, agent, directory, time_created, time_updated, " +
      "tokens_input, tokens_output, tokens_cache_read, cost, tokens_reasoning, tokens_cache_write, parent_id, idle_outcome) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  )
  insertSession.run(
    ALPHA_SESSION_ID, "构建会话", '{"id":"glm-5.3","providerID":"futureppo"}', "build",
    "D:/projects/alpha", 0, 20 * 60_000, 1000, 200, 5000, 1.25, 77, 88, null, "archived",
  )
  insertSession.run(
    BETA_SESSION_ID, "审查会话", '{"id":"claude-opus-5","providerID":"anthropic"}', "review",
    "D:/projects/beta", 0, 10 * 60_000, 200, 40, 600, 0.5, 11, 22, null, "dismissed",
  )
  insertSession.run(
    QUIET_SESSION_ID, "安静会话", '{"id":"glm-5.3","providerID":"futureppo"}', "plan",
    "D:/projects/gamma", 0, 60_000, 0, 0, 0, 0, null, null, null, null,
  )

  let messageSeq = 0
  const insertMessage = database.prepare(
    "INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?)",
  )
  const addMessage = (sessionId: string, type: string, timeCreated: number, data: string | null): void => {
    messageSeq += 1
    insertMessage.run(`msg_${messageSeq}`, sessionId, type, messageSeq, timeCreated, timeCreated, data)
  }

  // Alpha 的两条 assistant step：各 input 100 / output 40 / cache read 60
  //（步 tokens 200），带互异的工具调用部件喂 tool-health / agents。
  const alphaStepTokens = { input: 100, output: 40, reasoning: 10, cache: { read: 60, write: 5 } }
  addMessage(ALPHA_SESSION_ID, "assistant", localNoonMs(0), assistantStepPayload(
    "build", "glm-5.3", "futureppo", alphaStepTokens,
    [{ type: "tool", name: "read", state: { status: "completed" } }],
  ))
  addMessage(ALPHA_SESSION_ID, "assistant", localNoonMs(0), assistantStepPayload(
    "build", "glm-5.3", "futureppo", alphaStepTokens,
    [{ type: "tool", name: "edit", state: { status: "error" } }],
  ))
  // user 消息永远不计入任何 step 聚合。
  addMessage(ALPHA_SESSION_ID, "user", localNoonMs(0), JSON.stringify({ text: "你好" }))
  // Beta 的一条 step：模型与 tokens 都与 alpha 互异，泄漏即可见。
  addMessage(BETA_SESSION_ID, "assistant", localNoonMs(0), assistantStepPayload(
    "review", "claude-opus-5", "anthropic", { input: 900, output: 90, cache: { read: 9 } },
    [{ type: "tool", name: "read", state: { status: "error" } }],
  ))
  // compaction 行：alpha 一条 manual，beta 两条 auto（时间在 today 窗口内）。
  addMessage(ALPHA_SESSION_ID, "compaction", Date.now(),
    JSON.stringify({ status: "completed", reason: "manual", summary: "alpha 摘要" }))
  addMessage(BETA_SESSION_ID, "compaction", Date.now(),
    JSON.stringify({ status: "completed", reason: "auto", summary: "beta 摘要一" }))
  addMessage(BETA_SESSION_ID, "compaction", Date.now(),
    JSON.stringify({ status: "completed", reason: "auto", summary: "beta 摘要二" }))

  const insertTodo = database.prepare("INSERT INTO todo (session_id, status) VALUES (?, ?)")
  insertTodo.run(ALPHA_SESSION_ID, "completed")
  insertTodo.run(ALPHA_SESSION_ID, "pending")
  insertTodo.run(BETA_SESSION_ID, "completed")
  insertTodo.run(BETA_SESSION_ID, "in_progress")

  // prepare().run 只在夹具构建期使用；查询层只调 prepare().all()/get()。
  return database as unknown as SqliteReadConnection
}

/** Convenience: fixture db that must be closed by the caller. */
function withFixtureDatabase(testBody: (database: SqliteReadConnection) => void): void {
  const database = createSessionFilterFixtureDatabase()
  try {
    testBody(database)
  } finally {
    ;(database as SqliteReadWriteConnection).close()
  }
}

// ---------------------------------------------------------------------------
// Query-level filtering (real SQLite semantics per consuming endpoint).

test("queryOverview narrows steps and session rows to the filtered session", { skip: skipReason }, () => {
  withFixtureDatabase((database) => {
    const overview = queryOverview(database, ALPHA_SESSION_ID)!
    assert.deepEqual(overview, {
      todayTokens: 400, // 两条 step × (100 + 40 + 60)
      totalTokens: 400,
      todayHitRate: 120 / (120 + 200), // 两条 step 的 cache read 120 / (120 + input 200)
      sessionCount: 1,
      stepCount: 2,
      totalCost: 1.25,
    })

    // 缺省（null）与空串是同一口径：都统计全部会话（3 会话、3 step、
    // cost 1.75），与过滤值互异——证明过滤真的收窄了。
    const defaultOverview = queryOverview(database)!
    const emptyStringOverview = queryOverview(database, "")!
    assert.deepEqual(emptyStringOverview, defaultOverview)
    assert.deepEqual(defaultOverview, {
      todayTokens: 400 + 999,
      totalTokens: 400 + 999,
      todayHitRate: (120 + 9) / (120 + 9 + 200 + 900),
      sessionCount: 3,
      stepCount: 3,
      totalCost: 1.75,
    })
  })
})

test("queryDailyTrend filters to the target session's steps only", { skip: skipReason }, () => {
  withFixtureDatabase((database) => {
    const trendPoints = queryDailyTrend(database, 7, ALPHA_SESSION_ID)!
    assert.equal(trendPoints.length, 7)
    const todayPoint = trendPoints[trendPoints.length - 1]
    assert.equal(todayPoint.steps, 2)
    assert.equal(todayPoint.input, 200)
    assert.equal(todayPoint.read, 120)
    assert.equal(todayPoint.output, 80)
    assert.deepEqual(todayPoint.byModel, { "glm-5.3": 400 }, "beta 的模型不得出现在过滤视图")

    const defaultPoints = queryDailyTrend(database, 7)!
    const defaultTodayPoint = defaultPoints[defaultPoints.length - 1]
    assert.equal(defaultTodayPoint.steps, 3, "缺省口径三条 step（alpha 2 + beta 1）")
  })
})

test("queryModelMetrics keeps only the filtered session's model rows", { skip: skipReason }, () => {
  withFixtureDatabase((database) => {
    const filteredMetrics = queryModelMetrics(database, undefined, ALPHA_SESSION_ID)!
    assert.equal(filteredMetrics.length, 1)
    assert.equal(filteredMetrics[0].modelId, "glm-5.3")
    assert.equal(filteredMetrics[0].steps, 2)
    assert.equal(filteredMetrics[0].tokens, 400)

    const defaultMetrics = queryModelMetrics(database)!
    assert.deepEqual(
      defaultMetrics.map((metricRow) => metricRow.modelId).sort(),
      ["claude-opus-5", "glm-5.3"],
    )
  })
})

test("queryToolHealth counts only the filtered session's tool calls", { skip: skipReason }, () => {
  withFixtureDatabase((database) => {
    const filteredStats = queryToolHealth(database, ALPHA_SESSION_ID)!
    const statsByToolName = new Map(filteredStats.map((toolStat) => [toolStat.tool, toolStat]))
    assert.equal(statsByToolName.size, 2)
    assert.deepEqual(
      {
        completed: statsByToolName.get("read")!.completed,
        error: statsByToolName.get("read")!.error,
        total: statsByToolName.get("read")!.total,
      },
      { completed: 1, error: 0, total: 1 },
      "beta 的 read error 不得泄入 alpha 视图",
    )
    assert.deepEqual(
      {
        error: statsByToolName.get("edit")!.error,
        total: statsByToolName.get("edit")!.total,
      },
      { error: 1, total: 1 },
    )

    const defaultStats = queryToolHealth(database)!
    const defaultReadStat = defaultStats.find((toolStat) => toolStat.tool === "read")!
    assert.equal(defaultReadStat.total, 2, "缺省口径聚合两个会话的 read 调用")
    assert.equal(defaultReadStat.error, 1)
  })
})

test("queryAgentStats narrows memberships and step usage to the filtered session", { skip: skipReason }, () => {
  withFixtureDatabase((database) => {
    const filteredStats = queryAgentStats(database, ALPHA_SESSION_ID)!
    assert.equal(filteredStats.length, 1)
    assert.equal(filteredStats[0].agent, "build")
    assert.equal(filteredStats[0].sessions, 1)
    assert.equal(filteredStats[0].tokens, 400)
    assert.deepEqual(filteredStats[0].toolFingerprint, { read: 1, edit: 1 })

    const defaultStats = queryAgentStats(database)!
    assert.deepEqual(
      defaultStats.map((agentStat) => agentStat.agent).sort(),
      ["build", "plan", "review"],
      "缺省口径三个 agent（quiet 无 step 但 membership 计入）",
    )
  })
})

test("queryTodoStats filters on the todo table's session_id column", { skip: skipReason }, () => {
  withFixtureDatabase((database) => {
    assert.deepEqual(queryTodoStats(database, ALPHA_SESSION_ID), {
      total: 2,
      completed: 1,
      pending: 1,
      inProgress: 0,
    })
    assert.deepEqual(queryTodoStats(database, BETA_SESSION_ID), {
      total: 2,
      completed: 1,
      pending: 0,
      inProgress: 1,
    })
    // 空串按缺省：全库 4 条 todo。
    assert.deepEqual(queryTodoStats(database, ""), queryTodoStats(database))
    assert.deepEqual(queryTodoStats(database), {
      total: 4,
      completed: 2,
      pending: 1,
      inProgress: 1,
    })
  })
})

test("queryHourHeatmap keeps only the filtered session's steps", { skip: skipReason }, () => {
  withFixtureDatabase((database) => {
    const filteredTotal = queryHourHeatmap(database, 90, ALPHA_SESSION_ID)!
      .reduce((stepSum, cell) => stepSum + cell.steps, 0)
    assert.equal(filteredTotal, 2)
    const defaultTotal = queryHourHeatmap(database, 90)!
      .reduce((stepSum, cell) => stepSum + cell.steps, 0)
    assert.equal(defaultTotal, 3)
  })
})

test("querySessionSurvival degrades to the single filtered session", { skip: skipReason }, () => {
  withFixtureDatabase((database) => {
    assert.deepEqual(querySessionSurvival(database, ALPHA_SESSION_ID), {
      totalSessions: 1,
      medianDurationSeconds: 1200, // 20 分钟
      shortLivedShare: 0,
      idleOutcomeCounts: { archived: 1 },
    })
    const defaultSurvival = querySessionSurvival(database)!
    assert.equal(defaultSurvival.totalSessions, 3)
    assert.deepEqual(defaultSurvival.idleOutcomeCounts, { archived: 1, dismissed: 1, none: 1 })
  })
})

test("queryCompactionStats filters all three scans by session_id", { skip: skipReason }, () => {
  withFixtureDatabase((database) => {
    const filteredStats = queryCompactionStats(database, ALPHA_SESSION_ID)!
    assert.equal(filteredStats.total, 1)
    assert.deepEqual(filteredStats.byReason, { manual: 1 })
    assert.deepEqual(filteredStats.topSessions, [{ sessionId: ALPHA_SESSION_ID, count: 1 }])
    assert.equal(filteredStats.recentDaily[filteredStats.recentDaily.length - 1].count, 1)

    const betaStats = queryCompactionStats(database, BETA_SESSION_ID)!
    assert.equal(betaStats.total, 2)
    assert.deepEqual(betaStats.byReason, { auto: 2 })

    const defaultStats = queryCompactionStats(database)!
    assert.equal(defaultStats.total, 3)
    assert.deepEqual(defaultStats.byReason, { auto: 2, manual: 1 })
  })
})

test("queryDirectoryStats narrows the outer scan to the filtered session", { skip: skipReason }, () => {
  withFixtureDatabase((database) => {
    const filteredStats = queryDirectoryStats(database, 50, ALPHA_SESSION_ID)!
    assert.equal(filteredStats.totalDirectories, 1)
    assert.equal(filteredStats.totalSessions, 1)
    assert.equal(filteredStats.directories.length, 1)
    assert.deepEqual(filteredStats.directories[0], {
      directory: "D:/projects/alpha",
      name: "alpha",
      sessions: 1,
      steps: 2,
      tokensInput: 1000,
      tokensOutput: 200,
      tokensCacheRead: 5000,
      lastActiveMs: 20 * 60_000,
    })

    const defaultStats = queryDirectoryStats(database, 50)!
    assert.equal(defaultStats.totalDirectories, 3)
    assert.equal(defaultStats.totalSessions, 3)
  })
})

test("sessionExistsInSessionV2 probes session_v2 by id", { skip: skipReason }, () => {
  withFixtureDatabase((database) => {
    assert.equal(sessionExistsInSessionV2(database, ALPHA_SESSION_ID), true)
    assert.equal(sessionExistsInSessionV2(database, QUIET_SESSION_ID), true)
    assert.equal(sessionExistsInSessionV2(database, MISSING_SESSION_ID), false)
    assert.equal(sessionExistsInSessionV2(null, ALPHA_SESSION_ID), false)
  })
})

// ---------------------------------------------------------------------------
// API-layer contract: 404 body, empty-string default, cache dimension,
// and the routes that deliberately ignore ?session=.

function apiContextFor(
  pathname: string,
  queryString: string,
  database: SqliteReadConnection,
): ApiRequestContext {
  const route = matchApiRoute(pathname)
  assert.notEqual(route, null, `route failed to match: ${pathname}`)
  return {
    route: route!,
    searchParams: new URLSearchParams(queryString),
    database,
    databasePath: "test://session-filter",
    serverPort: 18789,
  }
}

/** 全部消费 ?session= 的聚合路由（与 api.ts 的清单一致）。 */
const SESSION_FILTER_CONSUMING_PATHNAMES = [
  "/api/overview",
  "/api/trend",
  "/api/models",
  "/api/tool-health",
  "/api/tool-tokens",
  "/api/agents",
  "/api/todo",
  "/api/hour-heatmap",
  "/api/session-survival",
  "/api/compaction",
  "/api/directories",
]

test("every consuming route answers the unified 404 for an unknown ?session= id", { skip: skipReason }, () => {
  clearResultCache()
  try {
    withFixtureDatabase((database) => {
      for (const pathname of SESSION_FILTER_CONSUMING_PATHNAMES) {
        const apiResponse = handleApiRequest(
          apiContextFor(pathname, `session=${MISSING_SESSION_ID}`, database),
        )
        assert.equal(
          apiResponse.statusCode,
          404,
          `${pathname} must 404 for an unknown ?session= id`,
        )
        assert.deepEqual(
          apiResponse.body,
          { error: SESSION_FILTER_NOT_FOUND_MESSAGE },
          `${pathname} shares the unified 404 body`,
        )
      }
      // 404 在校验块统一短路：没有任何缓存条目被写入。
      assert.equal(resultCacheSize(), 0)
    })
  } finally {
    clearResultCache()
  }
})

test("?session= with an empty string behaves as the no-filter default", { skip: skipReason }, () => {
  clearResultCache()
  try {
    withFixtureDatabase((database) => {
      const defaultResponse = handleApiRequest(apiContextFor("/api/overview", "", database))
      const emptySessionResponse = handleApiRequest(
        apiContextFor("/api/overview", "session=", database),
      )
      assert.equal(defaultResponse.statusCode, 200)
      assert.equal(emptySessionResponse.statusCode, 200)
      assert.deepEqual(emptySessionResponse.body, defaultResponse.body)
    })
  } finally {
    clearResultCache()
  }
})

test("a valid ?session= filters through the API layer and gets its own cache dimension", { skip: skipReason }, () => {
  clearResultCache()
  try {
    withFixtureDatabase((database) => {
      const defaultResponse = handleApiRequest(apiContextFor("/api/overview", "", database))
      assert.equal(defaultResponse.statusCode, 200)
      assert.equal((defaultResponse.body as { sessionCount: number }).sessionCount, 3)

      const filteredResponse = handleApiRequest(
        apiContextFor("/api/overview", `session=${ALPHA_SESSION_ID}`, database),
      )
      assert.equal(filteredResponse.statusCode, 200)
      assert.deepEqual(filteredResponse.body, {
        todayTokens: 400,
        totalTokens: 400,
        todayHitRate: 120 / (120 + 200),
        sessionCount: 1,
        stepCount: 2,
        totalCost: 1.25,
      })

      // 缓存键带 session 维度：缺省与过滤各一条，重复请求共享不新增。
      assert.equal(resultCacheSize(), 2, "default and filtered are distinct cache entries")
      handleApiRequest(apiContextFor("/api/overview", "", database))
      handleApiRequest(apiContextFor("/api/overview", `session=${ALPHA_SESSION_ID}`, database))
      assert.equal(resultCacheSize(), 2, "repeats share their entries")
    })
  } finally {
    clearResultCache()
  }
})

test("sessions, session-distribution and the CSV export ignore ?session= instead of validating it", { skip: skipReason }, () => {
  clearResultCache()
  try {
    withFixtureDatabase((database) => {
      // 列表路由有自己的过滤维度（directory/range），?session= 传入即
      // 忽略：未知 id 不是 404，而是完整列表。
      const sessionsResponse = handleApiRequest(
        apiContextFor("/api/sessions", `session=${MISSING_SESSION_ID}`, database),
      )
      assert.equal(sessionsResponse.statusCode, 200)
      assert.equal((sessionsResponse.body as unknown[]).length, 3)

      // 分布端点是「全部会话」口径，同样忽略该参数（quiet 会话 tokens
      // 全 0 被分布口径排除，进分布的是 alpha + beta 两条）。
      const distributionResponse = handleApiRequest(
        apiContextFor("/api/session-distribution", `session=${MISSING_SESSION_ID}`, database),
      )
      assert.equal(distributionResponse.statusCode, 200)
      assert.equal((distributionResponse.body as { totalSessions: number }).totalSessions, 2)

      // 导出路由也不吃该参数（一次点击导出，语义上就是全量快照）。
      const exportResponse = handleApiRequest(
        apiContextFor("/api/export/sessions.csv", `session=${MISSING_SESSION_ID}`, database),
      )
      assert.equal(exportResponse.statusCode, 200)
      assert.ok(exportResponse.rawText!.text.includes(ALPHA_SESSION_ID))
    })
  } finally {
    clearResultCache()
  }
})

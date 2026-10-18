/**
 * v0.21.0 三个「全部会话」分布端点 + 子会话占比端点测试：
 * - 查询层（src/db/session-distribution-queries.ts）：真实 :memory:
 *   SQLite 夹具，数字正确性——用独立的 SQL/JS 对照算均值 / 分位 / 桶 /
 *   childShare / topChildTrees，再断言端点输出相等；
 * - 空库零载荷（totalSessions 0，非 null）；
 * - db 缺失 → null（API 层答 503）；
 * - API 层：路由形状与 200 载荷、近形路径 404。
 *
 * 步数 / 时长分布复用 computeNumericDistribution（其分位 / 桶数学已在
 * session-distribution.test.ts 的纯函数层锁过），这里只锁 SQL 侧口径与
 * 载荷装配。
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import { createRequire } from "node:module"

import type { SqliteReadConnection } from "../src/db/types.ts"
import {
  queryChildShare,
  queryDurationDistribution,
  queryStepDistribution,
} from "../src/db/session-distribution-queries.ts"
import { handleApiRequest, type ApiRequestContext } from "../src/web/api.ts"
import { matchApiRoute } from "../src/web/router.ts"
import { clearResultCache } from "../src/stats/cache.ts"

// ---------------------------------------------------------------------------
// Real SQLite plumbing (same pattern as session-distribution.test.ts).

interface SqliteReadWriteConnection extends SqliteReadConnection {
  exec(sql: string): void
  close(): void
}

type SqliteReadWriteConstructor = new (databasePath: string) => SqliteReadWriteConnection

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
    ? "node:sqlite unavailable — skipping step/duration/child-share SQL tests"
    : false

/** 独立于端点实现的参照计算（模拟 SQL 的 COUNT/GROUP BY/SUM 折叠）。 */
function referenceNumericDistribution(sortedAscending: number[]): {
  totalSessions: number
  mean: number
  max: number
  p50: number
  p90: number
  p99: number
} {
  if (sortedAscending.length === 0) {
    return { totalSessions: 0, mean: 0, max: 0, p50: 0, p90: 0, p99: 0 }
  }
  const percentileByFraction = (fraction: number) => {
    const rank = Math.ceil(fraction * sortedAscending.length)
    const clampedRank = Math.min(Math.max(rank, 1), sortedAscending.length)
    return sortedAscending[clampedRank - 1]
  }
  const sum = sortedAscending.reduce((left, right) => left + right, 0)
  return {
    totalSessions: sortedAscending.length,
    mean: sum / sortedAscending.length,
    max: sortedAscending[sortedAscending.length - 1],
    p50: percentileByFraction(0.5),
    p90: percentileByFraction(0.9),
    p99: percentileByFraction(0.99),
  }
}

// ---------------------------------------------------------------------------
// queryStepDistribution.

test("queryStepDistribution reports the per-session assistant-message distribution", { skip: skipReason }, () => {
  const database = new readWriteConstructor!(":memory:")
  try {
    database.exec("CREATE TABLE session_message (session_id TEXT, type TEXT)")
    database.exec("CREATE TABLE session_v2 (id TEXT PRIMARY KEY)")
    const insertMessage = database.prepare(
      "INSERT INTO session_message (session_id, type) VALUES (?, ?)",
    )
    const insertSession = database.prepare("INSERT INTO session_v2 (id) VALUES (?)")
    // 每个 (会话, 类型) 各一行，便于按行计数推步数。
    const assistantRows: Record<string, number> = { ses_step_1: 1, ses_step_3: 3, ses_step_2: 2 }
    for (const [sessionId, assistantCount] of Object.entries(assistantRows)) {
      insertSession.run(sessionId)
      for (let rowIndex = 0; rowIndex < assistantCount; rowIndex += 1) {
        insertMessage.run(sessionId, "assistant")
      }
    }
    // 只有 user 消息的会话：GROUP BY 不出行，不进分布。
    insertSession.run("ses_step_zero")
    insertMessage.run("ses_step_zero", "user")
    // 孤儿消息（会话不在 session_v2）：即便有 assistant 行也必须被排除，
    // 与 token / 时长分布同锚（真库孤儿为 0，这里锁住未来不漂移）。
    for (let rowIndex = 0; rowIndex < 9; rowIndex += 1) {
      insertMessage.run("ses_step_orphan", "assistant")
    }

    const distribution = queryStepDistribution(database)!
    // 参照：values = [1, 2, 3]（按 COUNT(*) 升序后），合计 3 会话。
    const reference = referenceNumericDistribution([1, 2, 3])
    assert.equal(distribution.totalSessions, reference.totalSessions, "零步会话不进分布")
    assert.equal(distribution.totalSessions, 3)
    assert.equal(distribution.mean, reference.mean)
    assert.equal(distribution.max, reference.max)
    assert.deepEqual(distribution.percentiles, {
      p50: reference.p50,
      p90: reference.p90,
      p99: reference.p99,
    })
    // 桶计数守恒：Σ桶 = totalSessions。
    assert.equal(
      distribution.buckets.reduce((countSum, bucket) => countSum + bucket.count, 0),
      distribution.totalSessions,
    )
  } finally {
    database.close()
  }
})

test("queryStepDistribution answers the zero payload for a database with no assistant rows", { skip: skipReason }, () => {
  const database = new readWriteConstructor!(":memory:")
  try {
    database.exec("CREATE TABLE session_message (session_id TEXT, type TEXT)")
    database.exec("CREATE TABLE session_v2 (id TEXT PRIMARY KEY)")
    const insertMessage = database.prepare(
      "INSERT INTO session_message (session_id, type) VALUES (?, ?)",
    )
    insertMessage.run("ses_step_user_only", "user")

    const distribution = queryStepDistribution(database)!
    assert.deepEqual(distribution, {
      totalSessions: 0,
      buckets: [],
      percentiles: { p50: 0, p90: 0, p99: 0 },
      mean: 0,
      max: 0,
    })
  } finally {
    database.close()
  }
})

test("queryStepDistribution returns null only for a missing db connection", () => {
  assert.equal(queryStepDistribution(null), null)
})

// ---------------------------------------------------------------------------
// queryDurationDistribution.

test("queryDurationDistribution reports positive wall-clock durations in milliseconds", { skip: skipReason }, () => {
  const database = new readWriteConstructor!(":memory:")
  try {
    database.exec(
      "CREATE TABLE session_v2 (id TEXT, time_created INTEGER, time_updated INTEGER)",
    )
    const insertSession = database.prepare(
      "INSERT INTO session_v2 (id, time_created, time_updated) VALUES (?, ?, ?)",
    )
    insertSession.run("ses_dur_1s", 1000, 2000) // 1000ms
    insertSession.run("ses_dur_3s", 1000, 4000) // 3000ms
    insertSession.run("ses_dur_zero", 5000, 5000) // 0 → 排除
    insertSession.run("ses_dur_backwards", 6000, 5000) // 负数 → 排除
    insertSession.run("ses_dur_null_updated", 1000, null) // NULL → 排除

    const distribution = queryDurationDistribution(database)!
    // 参照：values = [1000, 3000]（毫秒原始值，前端负责人类可读）。
    const reference = referenceNumericDistribution([1000, 3000])
    assert.equal(distribution.totalSessions, 2, "非正值 / NULL 时长会话不进分布")
    assert.equal(distribution.mean, reference.mean)
    assert.equal(distribution.max, reference.max)
    assert.deepEqual(distribution.percentiles, {
      p50: reference.p50,
      p90: reference.p90,
      p99: reference.p99,
    })
  } finally {
    database.close()
  }
})

test("queryDurationDistribution answers the zero payload for a database with no positive durations", { skip: skipReason }, () => {
  const database = new readWriteConstructor!(":memory:")
  try {
    database.exec(
      "CREATE TABLE session_v2 (id TEXT, time_created INTEGER, time_updated INTEGER)",
    )
    const insertSession = database.prepare(
      "INSERT INTO session_v2 (id, time_created, time_updated) VALUES (?, ?, ?)",
    )
    insertSession.run("ses_dur_equal", 1000, 1000)

    const distribution = queryDurationDistribution(database)!
    assert.deepEqual(distribution, {
      totalSessions: 0,
      buckets: [],
      percentiles: { p50: 0, p90: 0, p99: 0 },
      mean: 0,
      max: 0,
    })
  } finally {
    database.close()
  }
})

test("queryDurationDistribution returns null only for a missing db connection", () => {
  assert.equal(queryDurationDistribution(null), null)
})

// ---------------------------------------------------------------------------
// queryChildShare.

/** 独立参照：从夹具行直接算 childShare / topChildTrees（模拟 SQL）。 */
function referenceChildShare(
  rows: Array<{
    id: string
    parentId: string | null
    title: string
    agent: string
    tokens: number
  }>,
): {
  totalSessions: number
  childSessionCount: number
  rootSessionCount: number
  childTokens: number
  rootTokens: number
  totalTokens: number
  childShare: number
  topChildTrees: Array<{
    sessionId: string
    title: string
    agent: string
    tokens: number
    childSessionCount: number
  }>
} {
  let totalSessions = 0
  let childSessionCount = 0
  let rootSessionCount = 0
  let childTokens = 0
  let totalTokens = 0
  const childTokensByParentId = new Map<string, { count: number; tokens: number }>()
  for (const row of rows) {
    totalSessions += 1
    totalTokens += row.tokens
    if (row.parentId === null) {
      rootSessionCount += 1
    } else {
      childSessionCount += 1
      childTokens += row.tokens
      const aggregate = childTokensByParentId.get(row.parentId) ?? { count: 0, tokens: 0 }
      aggregate.count += 1
      aggregate.tokens += row.tokens
      childTokensByParentId.set(row.parentId, aggregate)
    }
  }
  const rootTokens = totalTokens - childTokens
  const rankedParents = [...childTokensByParentId.entries()]
    .map(([parentId, aggregate]) => ({
      sessionId: parentId,
      tokens: aggregate.tokens,
      childSessionCount: aggregate.count,
    }))
    .sort(
      (leftRow, rightRow) =>
        rightRow.tokens - leftRow.tokens ||
        (leftRow.sessionId < rightRow.sessionId ? -1 : 1),
    )
    .slice(0, 5)
  const parentInfoById = new Map(rows.map((row) => [row.id, row]))
  const topChildTrees = rankedParents.map((rankedParent) => {
    const parentInfo = parentInfoById.get(rankedParent.sessionId)!
    return {
      sessionId: rankedParent.sessionId,
      title: parentInfo.title,
      agent: parentInfo.agent,
      tokens: rankedParent.tokens,
      childSessionCount: rankedParent.childSessionCount,
    }
  })
  return {
    totalSessions,
    childSessionCount,
    rootSessionCount,
    childTokens,
    rootTokens,
    totalTokens,
    childShare: totalTokens === 0 ? 0 : childTokens / totalTokens,
    topChildTrees,
  }
}

test("queryChildShare reports child/root split and ranks top child trees by direct-child tokens", { skip: skipReason }, () => {
  const database = new readWriteConstructor!(":memory:")
  try {
    database.exec(
      "CREATE TABLE session_v2 (id TEXT, parent_id TEXT, title TEXT, agent TEXT, " +
        "tokens_input REAL, tokens_output REAL, tokens_cache_read REAL)",
    )
    const insertSession = database.prepare(
      "INSERT INTO session_v2 (id, parent_id, title, agent, tokens_input, tokens_output, tokens_cache_read) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    // 三层结构：root → child_a/b/c；child_a → grandchild。
    insertSession.run("ses_root", null, "root", "orchestrator", 1000, 0, 0) // tokens 1000
    insertSession.run("ses_child_a", "ses_root", "child a", "fixer", 500, 0, 0) // 500
    insertSession.run("ses_child_b", "ses_root", "child b", "explorer", 300, 0, 0) // 300
    insertSession.run("ses_child_c", "ses_root", "child c", "general", 100, 0, 0) // 100
    insertSession.run("ses_orphan", null, "orphan", "librarian", 200, 0, 0) // 200
    insertSession.run("ses_grandchild", "ses_child_a", "grandchild", "fixer", 50, 0, 0) // 50

    const reference = referenceChildShare([
      { id: "ses_root", parentId: null, title: "root", agent: "orchestrator", tokens: 1000 },
      { id: "ses_child_a", parentId: "ses_root", title: "child a", agent: "fixer", tokens: 500 },
      { id: "ses_child_b", parentId: "ses_root", title: "child b", agent: "explorer", tokens: 300 },
      { id: "ses_child_c", parentId: "ses_root", title: "child c", agent: "general", tokens: 100 },
      { id: "ses_orphan", parentId: null, title: "orphan", agent: "librarian", tokens: 200 },
      { id: "ses_grandchild", parentId: "ses_child_a", title: "grandchild", agent: "fixer", tokens: 50 },
    ])

    const childShare = queryChildShare(database)!
    assert.equal(childShare.totalSessions, reference.totalSessions)
    assert.equal(childShare.childSessionCount, reference.childSessionCount)
    assert.equal(childShare.rootSessionCount, reference.rootSessionCount)
    assert.equal(childShare.childTokens, reference.childTokens)
    assert.equal(childShare.rootTokens, reference.rootTokens)
    assert.equal(childShare.totalTokens, reference.totalTokens)
    assert.equal(childShare.childShare, reference.childShare)
    // top 排序：root（直接子代 900，3 个）在 child_a（50，1 个）之前。
    assert.deepEqual(childShare.topChildTrees, reference.topChildTrees)
    assert.deepEqual(childShare.topChildTrees, [
      {
        sessionId: "ses_root",
        title: "root",
        agent: "orchestrator",
        tokens: 900,
        childSessionCount: 3,
      },
      {
        sessionId: "ses_child_a",
        title: "child a",
        agent: "fixer",
        tokens: 50,
        childSessionCount: 1,
      },
    ])
  } finally {
    database.close()
  }
})

test("queryChildShare answers a zero-ratio payload for an empty database", { skip: skipReason }, () => {
  const database = new readWriteConstructor!(":memory:")
  try {
    database.exec(
      "CREATE TABLE session_v2 (id TEXT, parent_id TEXT, title TEXT, agent TEXT, " +
        "tokens_input REAL, tokens_output REAL, tokens_cache_read REAL)",
    )
    const childShare = queryChildShare(database)!
    assert.deepEqual(childShare, {
      totalSessions: 0,
      childSessionCount: 0,
      rootSessionCount: 0,
      childTokens: 0,
      rootTokens: 0,
      totalTokens: 0,
      childShare: 0,
      topChildTrees: [],
    })
  } finally {
    database.close()
  }
})

test("queryChildShare returns null only for a missing db connection", () => {
  assert.equal(queryChildShare(null), null)
})

// ---------------------------------------------------------------------------
// API layer.

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
    databasePath: "test://step-duration-child-share",
    serverPort: 18789,
  }
}

function createStepDistributionFixtureDatabase(): SqliteReadWriteConnection {
  const database = new readWriteConstructor!(":memory:")
  database.exec("CREATE TABLE session_message (session_id TEXT, type TEXT)")
  database.exec("CREATE TABLE session_v2 (id TEXT PRIMARY KEY)")
  const insertMessage = database.prepare(
    "INSERT INTO session_message (session_id, type) VALUES (?, ?)",
  )
  const insertSession = database.prepare("INSERT INTO session_v2 (id) VALUES (?)")
  for (const sessionId of ["ses_step_a", "ses_step_b", "ses_step_c"]) {
    insertSession.run(sessionId)
  }
  insertMessage.run("ses_step_a", "assistant")
  insertMessage.run("ses_step_b", "assistant")
  insertMessage.run("ses_step_b", "assistant")
  insertMessage.run("ses_step_b", "assistant")
  insertMessage.run("ses_step_c", "assistant")
  insertMessage.run("ses_step_c", "assistant")
  insertMessage.run("ses_step_c", "user")
  return database
}

test("/api/step-distribution answers 200 with the distribution payload; near-miss paths do not match", { skip: skipReason }, () => {
  clearResultCache()
  try {
    const database = createStepDistributionFixtureDatabase()
    try {
      const apiResponse = handleApiRequest(apiContextFor("/api/step-distribution", database))
      assert.equal(apiResponse.statusCode, 200)
      const distribution = apiResponse.body as { totalSessions: number; max: number }
      assert.equal(distribution.totalSessions, 3)
      assert.equal(distribution.max, 3)
      assert.equal(matchApiRoute("/api/step-distributions"), null)
      assert.equal(matchApiRoute("/api/step_distribution"), null)
    } finally {
      database.close()
    }
  } finally {
    clearResultCache()
  }
})

test("/api/duration-distribution answers 200 with the distribution payload", { skip: skipReason }, () => {
  clearResultCache()
  try {
    const database = new readWriteConstructor!(":memory:")
    try {
      database.exec(
        "CREATE TABLE session_v2 (id TEXT, time_created INTEGER, time_updated INTEGER)",
      )
      const insertSession = database.prepare(
        "INSERT INTO session_v2 (id, time_created, time_updated) VALUES (?, ?, ?)",
      )
      insertSession.run("ses_dur_1", 1000, 5000)
      insertSession.run("ses_dur_2", 1000, 2000)
      insertSession.run("ses_dur_skip", 7000, 7000)

      const apiResponse = handleApiRequest(
        apiContextFor("/api/duration-distribution", database),
      )
      assert.equal(apiResponse.statusCode, 200)
      const distribution = apiResponse.body as { totalSessions: number; mean: number; max: number }
      assert.equal(distribution.totalSessions, 2, "非正时长会话不进分布")
      assert.equal(distribution.mean, (4000 + 1000) / 2)
      assert.equal(distribution.max, 4000)
      assert.equal(matchApiRoute("/api/duration-distributions"), null)
    } finally {
      database.close()
    }
  } finally {
    clearResultCache()
  }
})

test("/api/child-share answers 200 with the split payload; near-miss paths do not match", { skip: skipReason }, () => {
  clearResultCache()
  try {
    const database = new readWriteConstructor!(":memory:")
    try {
      database.exec(
        "CREATE TABLE session_v2 (id TEXT, parent_id TEXT, title TEXT, agent TEXT, " +
          "tokens_input REAL, tokens_output REAL, tokens_cache_read REAL)",
      )
      const insertSession = database.prepare(
        "INSERT INTO session_v2 (id, parent_id, title, agent, tokens_input, tokens_output, tokens_cache_read) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      insertSession.run("ses_root", null, "root", "orchestrator", 100, 0, 0)
      insertSession.run("ses_child", "ses_root", "child", "fixer", 25, 0, 0)

      const apiResponse = handleApiRequest(apiContextFor("/api/child-share", database))
      assert.equal(apiResponse.statusCode, 200)
      const body = apiResponse.body as { totalSessions: number; childShare: number }
      assert.equal(body.totalSessions, 2)
      assert.equal(body.childShare, 25 / 125)
      assert.equal(matchApiRoute("/api/child_shares"), null)
    } finally {
      database.close()
    }
  } finally {
    clearResultCache()
  }
})

test("the three new endpoints answer 503 while the db is missing", () => {
  const routeNames = ["/api/step-distribution", "/api/duration-distribution", "/api/child-share"]
  for (const pathname of routeNames) {
    const route = matchApiRoute(pathname)
    assert.notEqual(route, null, `route failed to match: ${pathname}`)
    const apiResponse = handleApiRequest({
      route: route!,
      searchParams: new URLSearchParams(),
      database: null,
      databasePath: "test://no-database",
      serverPort: 18789,
    })
    assert.equal(apiResponse.statusCode, 503, `${pathname} must answer 503 while the db is unavailable`)
  }
})

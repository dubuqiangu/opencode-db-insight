/**
 * GET /api/session-distribution（v0.20.0 会话 tokens 总量分布）测试：
 * - 纯计算层（src/stats/session-distribution.ts）：对数半档桶边界
 *   （10^(k/2) 圆整 3 位有效数字）、逐值归桶、nearestRank 分位、
 *   空输入 / 非正值输入的零载荷；
 * - 查询层（src/db/session-distribution-queries.ts）：真实 :memory:
 *   SQLite 的三列 COALESCE 合计 + > 0 排除（全 0 / NULL 列会话不进入
 *   分布）；
 * - API 层：路由形状与 200 载荷、近形路径 404。
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import { createRequire } from "node:module"

import type { SqliteReadConnection } from "../src/db/types.ts"
import { computeSessionTokenDistribution } from "../src/stats/session-distribution.ts"
import { querySessionTokenDistribution } from "../src/db/session-distribution-queries.ts"
import { handleApiRequest, type ApiRequestContext } from "../src/web/api.ts"
import { matchApiRoute } from "../src/web/router.ts"
import { clearResultCache } from "../src/stats/cache.ts"

// ---------------------------------------------------------------------------
// Pure-function layer.

test("log half-decade bucket edges round to three significant digits (10^(k/2))", () => {
  // max = 1e6 → D = 6 → 边 2D+2 = 14 条：1, 3.16, 10, …, 1e6, 3.16e6。
  // 圆整值与十进制字面量严格相等（已实测验证），deepEqual 即逐位锁。
  const distribution = computeSessionTokenDistribution([1_000_000])
  const bucketBoundaries = distribution.buckets.map((bucket) => [bucket.start, bucket.end])
  assert.deepEqual(bucketBoundaries, [
    [0, 1],
    [1, 3.16],
    [3.16, 10],
    [10, 31.6],
    [31.6, 100],
    [100, 316],
    [316, 1000],
    [1000, 3160],
    [3160, 10000],
    [10000, 31600],
    [31600, 100000],
    [100000, 316000],
    [316000, 1000000],
    [1000000, 3160000],
  ])
  // max 恰为 10 的整数次幂时落在末桶下界上，必须归末桶而不是消失。
  assert.equal(distribution.buckets[distribution.buckets.length - 1].count, 1)
})

test("values land in buckets by comparison against the rounded edges", () => {
  const sampleTotals = [0.5, 1, 2, 3.2, 10, 100, 1_000_000]
  const distribution = computeSessionTokenDistribution(sampleTotals)

  assert.equal(distribution.totalSessions, sampleTotals.length)
  // 0.5→首桶[0,1)；1、2→[1,3.16)；3.2→[3.16,10)；10→[10,31.6)；
  // 100→[100,316)（左闭右开：[31.6,100) 不含上界 100）；1e6→末桶（含下界）。
  assert.deepEqual(
    distribution.buckets.map((bucket) => bucket.count),
    [1, 2, 1, 1, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1],
  )
  assert.equal(distribution.max, 1_000_000)
  const expectedSum = sampleTotals.reduce((left, right) => left + right, 0)
  assert.equal(distribution.mean, expectedSum / sampleTotals.length)
  // nearest-rank 分位：升序 [0.5,1,2,3.2,10,100,1e6]，p50 第 4 秩 = 3.2，
  // p90 第 7 秩 = 1e6，p99 秩 ceil(6.93)=7 → 1e6。
  assert.deepEqual(distribution.percentiles, { p50: 3.2, p90: 1_000_000, p99: 1_000_000 })
})

test("percentiles and mean follow the nearest-rank contract on a clean sequence", () => {
  const ascendingTotals = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
  const distribution = computeSessionTokenDistribution(ascendingTotals)
  assert.deepEqual(distribution.percentiles, { p50: 5, p90: 9, p99: 10 })
  assert.equal(distribution.mean, 5.5)
  assert.equal(distribution.max, 10)
  // max=10 → D=1 → 4 桶：1→[1,3.16)；2、3 同桶；4..9→[3.16,10)；10→末桶。
  assert.deepEqual(
    distribution.buckets.map((bucket) => bucket.count),
    [0, 3, 6, 1],
  )
})

test("empty and all-non-positive inputs answer the honest zero payload", () => {
  const zeroPayload = {
    totalSessions: 0,
    buckets: [],
    percentiles: { p50: 0, p90: 0, p99: 0 },
    mean: 0,
    max: 0,
  }
  assert.deepEqual(computeSessionTokenDistribution([]), zeroPayload)
  // SQL 侧已用 WHERE > 0 排除；纯函数层对 0 / 负值 / 非有限值同样
  // 过滤，防御「查询层口径变化后伪造桶」。
  assert.deepEqual(computeSessionTokenDistribution([0, -100, Number.NaN]), zeroPayload)
})

// ---------------------------------------------------------------------------
// Query layer against real SQLite.

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
    ? "node:sqlite unavailable — skipping session distribution SQL tests"
    : false

/** 五个会话：三个正值（125 / 1250 / 123000）、一个全 0、一个全 NULL 列。 */
function createDistributionFixtureDatabase(): SqliteReadWriteConnection {
  const database = new readWriteConstructor!(":memory:")
  database.exec(
    "CREATE TABLE session_v2 (" +
      "id TEXT, tokens_input REAL, tokens_output REAL, tokens_cache_read REAL)",
  )
  const insertSession = database.prepare(
    "INSERT INTO session_v2 (id, tokens_input, tokens_output, tokens_cache_read) VALUES (?, ?, ?, ?)",
  )
  insertSession.run("ses_dist_small", 100, 20, 5) // 合计 125
  insertSession.run("ses_dist_mid", 1000, 200, 50) // 合计 1250
  insertSession.run("ses_dist_large", 100000, 20000, 3000) // 合计 123000
  insertSession.run("ses_dist_all_zero", 0, 0, 0) // 契约排除
  insertSession.run("ses_dist_all_null", null, null, null) // COALESCE 兜 0 → 同样排除
  return database
}

test("querySessionTokenDistribution excludes zero-token sessions and reports the three-value distribution", { skip: skipReason }, () => {
  const database = createDistributionFixtureDatabase()
  try {
    const distribution = querySessionTokenDistribution(database)!
    assert.equal(distribution.totalSessions, 3, "全 0 与全 NULL 会话不进入分布")
    // 桶计数守恒：Σ桶 = totalSessions。
    assert.equal(
      distribution.buckets.reduce((countSum, bucket) => countSum + bucket.count, 0),
      distribution.totalSessions,
    )
    // max = 123000 → D = ceil(log10(123000)) = 6 → 14 桶；
    // 125→[100,316)；1250→[1000,3160)；123000→[100000,316000)。
    const occupiedBuckets = distribution.buckets.filter((bucket) => bucket.count > 0)
    assert.deepEqual(
      occupiedBuckets.map((bucket) => [bucket.start, bucket.end, bucket.count]),
      [
        [100, 316, 1],
        [1000, 3160, 1],
        [100000, 316000, 1],
      ],
    )
    assert.equal(distribution.max, 123000)
    assert.equal(distribution.mean, (125 + 1250 + 123000) / 3)
    // nearest-rank：升序 [125, 1250, 123000]，p50 第 2 秩 = 1250；
    // p90/p99 第 3 秩 = 123000。
    assert.deepEqual(distribution.percentiles, { p50: 1250, p90: 123000, p99: 123000 })
  } finally {
    database.close()
  }
})

test("a database whose sessions are all zero-token answers the zero payload, not null", { skip: skipReason }, () => {
  const database = new readWriteConstructor!(":memory:")
  try {
    database.exec(
      "CREATE TABLE session_v2 (" +
        "id TEXT, tokens_input REAL, tokens_output REAL, tokens_cache_read REAL)",
    )
    const insertSession = database.prepare(
      "INSERT INTO session_v2 (id, tokens_input, tokens_output, tokens_cache_read) VALUES (?, ?, ?, ?)",
    )
    insertSession.run("ses_dist_zero_only", 0, 0, 0)

    const distribution = querySessionTokenDistribution(database)!
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

test("querySessionTokenDistribution returns null only for a missing db connection", () => {
  assert.equal(querySessionTokenDistribution(null), null)
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
    databasePath: "test://session-distribution",
    serverPort: 18789,
  }
}

test("/api/session-distribution answers 200 with the distribution payload; near-miss paths do not match", { skip: skipReason }, () => {
  clearResultCache()
  try {
    const database = createDistributionFixtureDatabase()
    try {
      const apiResponse = handleApiRequest(apiContextFor("/api/session-distribution", database))
      assert.equal(apiResponse.statusCode, 200)
      const distribution = apiResponse.body as { totalSessions: number; max: number }
      assert.equal(distribution.totalSessions, 3)
      assert.equal(distribution.max, 123000)

      // 近形路径全部落到 404（路由层不匹配）。
      assert.equal(matchApiRoute("/api/session-distributions"), null, "复数拼写不匹配")
      assert.equal(matchApiRoute("/api/session-distribution/extra"), null, "不接受子路径")
      assert.equal(matchApiRoute("/api/session_distribution"), null, "下划线拼写不匹配")
    } finally {
      database.close()
    }
  } finally {
    clearResultCache()
  }
})

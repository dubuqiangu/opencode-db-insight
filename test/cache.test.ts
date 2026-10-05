/**
 * Tests for the 60s TTL process-local result cache (tasks.md T1.4).
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import { setTimeout as sleep } from "node:timers/promises"

import {
  buildCacheKey,
  cachedResult,
  clearResultCache,
  DEFAULT_CACHE_TTL_MS,
  resultCacheSize,
} from "../src/stats/cache.ts"

test("cachedResult computes on the first call and reuses the stored value on the second call", () => {
  clearResultCache()
  let computeCallCount = 0
  const computeOverview = (): { totalTokens: number } => {
    computeCallCount += 1
    return { totalTokens: 42 }
  }

  const cacheKey = buildCacheKey("queryOverview", [])
  const firstResult = cachedResult(cacheKey, computeOverview)
  const secondResult = cachedResult(cacheKey, computeOverview)

  assert.deepEqual(firstResult, { totalTokens: 42 })
  assert.deepEqual(secondResult, { totalTokens: 42 })
  assert.equal(computeCallCount, 1)
})

test("cachedResult recomputes once the TTL has expired", async () => {
  clearResultCache()
  let computeCallCount = 0
  const cacheKey = buildCacheKey("queryDailyTrend", [7])

  const firstResult = cachedResult(
    cacheKey,
    () => {
      computeCallCount += 1
      return "fresh"
    },
    5,
  )
  await sleep(15)
  const secondResult = cachedResult(
    cacheKey,
    () => {
      computeCallCount += 1
      return "refreshed"
    },
    5,
  )

  assert.equal(firstResult, "fresh")
  assert.equal(secondResult, "refreshed")
  assert.equal(computeCallCount, 2)
})

test("cachedResult keeps results of different cache keys independent", () => {
  clearResultCache()
  const overviewResult = cachedResult(buildCacheKey("queryOverview", []), () => "overview-value")
  const trendResult = cachedResult(buildCacheKey("queryDailyTrend", [30]), () => "trend-value")
  assert.equal(overviewResult, "overview-value")
  assert.equal(trendResult, "trend-value")
  assert.equal(resultCacheSize(), 2)
})

test("buildCacheKey separates function names and parameters, and is stable for equal inputs", () => {
  const firstKey = buildCacheKey("queryDailyTrend", [7])
  assert.equal(firstKey, buildCacheKey("queryDailyTrend", [7]))
  assert.notEqual(firstKey, buildCacheKey("queryDailyTrend", [30]))
  assert.notEqual(buildCacheKey("queryOverview", []), buildCacheKey("querySessionList", [50, 0]))
  assert.ok(firstKey.startsWith("queryDailyTrend:"))
})

test("clearResultCache empties every stored entry so the next call recomputes", () => {
  clearResultCache()
  let computeCallCount = 0
  const cacheKey = buildCacheKey("queryOverview", [])
  cachedResult(cacheKey, () => {
    computeCallCount += 1
    return 1
  })
  assert.ok(resultCacheSize() > 0)

  clearResultCache()
  assert.equal(resultCacheSize(), 0)

  const recomputedValue = cachedResult(cacheKey, () => {
    computeCallCount += 1
    return 2
  })
  assert.equal(recomputedValue, 2)
  assert.equal(computeCallCount, 2)
})

test("the default TTL is 60 seconds as specified in DESIGN.md §10", () => {
  assert.equal(DEFAULT_CACHE_TTL_MS, 60_000)
})

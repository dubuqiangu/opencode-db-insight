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
  MAX_CACHE_ENTRIES,
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

test("the cache evicts the oldest entry once the entry cap is reached (P1-6)", () => {
  clearResultCache()
  const computeCallCountByIndex = new Map<number, number>()

  const fillCache = (cacheEntryIndex: number, expectedSize: number): void => {
    cachedResult(buildCacheKey("querySessionList", [cacheEntryIndex]), () => {
      computeCallCountByIndex.set(cacheEntryIndex, (computeCallCountByIndex.get(cacheEntryIndex) ?? 0) + 1)
      return cacheEntryIndex
    })
    assert.equal(resultCacheSize(), expectedSize)
  }

  for (let cacheEntryIndex = 0; cacheEntryIndex < MAX_CACHE_ENTRIES; cacheEntryIndex += 1) {
    fillCache(cacheEntryIndex, cacheEntryIndex + 1)
  }
  // One more entry evicts the oldest (insertion order), not the newest.
  fillCache(MAX_CACHE_ENTRIES, MAX_CACHE_ENTRIES)

  // The oldest entry recomputes (it was evicted); the newest is still cached.
  const evictedValue = cachedResult(
    buildCacheKey("querySessionList", [0]),
    () => {
      computeCallCountByIndex.set(0, (computeCallCountByIndex.get(0) ?? 0) + 1)
      return "recomputed-after-eviction"
    },
  )
  assert.equal(evictedValue, "recomputed-after-eviction")
  assert.equal(computeCallCountByIndex.get(0), 2, "the evicted entry must recompute")

  const newestValue = cachedResult(
    buildCacheKey("querySessionList", [MAX_CACHE_ENTRIES]),
    () => {
      throw new Error("the newest entry must still be cached")
    },
  )
  assert.equal(newestValue, MAX_CACHE_ENTRIES)
})

test("refreshing an expired key at the cap updates the value without evicting anything (P1-6)", async () => {
  clearResultCache()
  // Key 0 is stored first with a tiny TTL so it expires while the other
  // entries stay fresh: a read-through cache only recomputes ("refreshes")
  // a key once its previous entry has expired — a still-fresh entry must
  // be reused, not recomputed.
  cachedResult(buildCacheKey("queryOverview", [0]), () => 0, 5)
  for (let cacheEntryIndex = 1; cacheEntryIndex < MAX_CACHE_ENTRIES; cacheEntryIndex += 1) {
    cachedResult(buildCacheKey("queryOverview", [cacheEntryIndex]), () => cacheEntryIndex)
  }
  assert.equal(resultCacheSize(), MAX_CACHE_ENTRIES)
  await sleep(10)

  // Refreshing the expired key overwrites it in place — size must not grow
  // and no other key may be evicted for it.
  const refreshedValue = cachedResult(buildCacheKey("queryOverview", [0]), () => "refreshed")
  assert.equal(refreshedValue, "refreshed")
  assert.equal(resultCacheSize(), MAX_CACHE_ENTRIES)

  const cachedRefreshedValue = cachedResult(buildCacheKey("queryOverview", [0]), () => {
    throw new Error("the refreshed entry must be cached")
  })
  assert.equal(cachedRefreshedValue, "refreshed")
  const untouchedValue = cachedResult(buildCacheKey("queryOverview", [MAX_CACHE_ENTRIES - 1]), () => {
    throw new Error("the last-filled entry must still be cached")
  })
  assert.equal(untouchedValue, MAX_CACHE_ENTRIES - 1)
})

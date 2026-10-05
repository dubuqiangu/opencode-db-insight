/**
 * Tests for the token accounting and cache hit-rate formulas (DESIGN.md §5).
 */

import { test } from "node:test"
import assert from "node:assert/strict"

import { hitRate, strictHitRate, totalUsageTokens } from "../src/stats/hit-rate.ts"

test("hitRate returns the cacheRead share of cacheRead+input for normal values", () => {
  assert.equal(hitRate(900, 100), 0.9)
})

test("hitRate returns 0 when cacheRead and input are both zero", () => {
  assert.equal(hitRate(0, 0), 0)
})

test("hitRate returns 0 when only fresh input was billed and nothing came from cache", () => {
  assert.equal(hitRate(0, 100), 0)
})

test("hitRate returns 1 when the whole context came from cache and input is zero", () => {
  assert.equal(hitRate(500, 0), 1)
})

test("strictHitRate divides cacheRead by cacheRead+input+cacheWrite", () => {
  assert.equal(strictHitRate(800, 100, 100), 0.8)
})

test("strictHitRate returns 0 when the strict denominator is zero", () => {
  assert.equal(strictHitRate(0, 0, 0), 0)
})

test("strictHitRate is never larger than the loose hitRate", () => {
  const cacheRead = 700
  const input = 300
  const cacheWrite = 200
  assert.ok(strictHitRate(cacheRead, input, cacheWrite) <= hitRate(cacheRead, input))
})

test("totalUsageTokens sums input+output+cacheRead and excludes cacheWrite and reasoning", () => {
  const tokens = { input: 10, output: 20, reasoning: 5, cacheRead: 70, cacheWrite: 99 }
  assert.equal(totalUsageTokens(tokens), 100)
})

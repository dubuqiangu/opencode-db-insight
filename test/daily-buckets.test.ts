/**
 * Tests for local-timezone daily bucketing (DESIGN.md §5 逐日趋势).
 * All timestamps are constructed with local-time Date constructors so the
 * tests hold in any timezone.
 */

import { test } from "node:test"
import assert from "node:assert/strict"

import {
  bucketDailyTrend,
  MAX_TREND_DAYS,
  toLocalDateKey,
} from "../src/stats/daily-buckets.ts"
import { makeAssistantStepRow, makeTokenUsage } from "./helpers/step-factories.ts"

/** Noon today / noon N days back, local time. */
function localNoonDaysAgo(daysBack: number): Date {
  const noonDate = new Date()
  noonDate.setHours(12, 0, 0, 0)
  noonDate.setDate(noonDate.getDate() - daysBack)
  return noonDate
}

test("toLocalDateKey formats a timestamp as local YYYY-MM-DD", () => {
  const localNoon = new Date(2026, 9, 5, 12, 0, 0)
  assert.equal(toLocalDateKey(localNoon.getTime()), "2026-10-05")
})

test("toLocalDateKey keeps local midnight and the day's last millisecond on the same date", () => {
  const localMidnight = new Date(2026, 9, 5, 0, 0, 0, 0)
  const lastMillisecondOfDay = new Date(2026, 9, 5, 23, 59, 59, 999)
  assert.equal(toLocalDateKey(localMidnight.getTime()), "2026-10-05")
  assert.equal(toLocalDateKey(lastMillisecondOfDay.getTime()), "2026-10-05")
})

test("toLocalDateKey returns an empty string for an invalid timestamp", () => {
  assert.equal(toLocalDateKey(Number.NaN), "")
})

test("bucketDailyTrend returns an empty series for zero or negative days", () => {
  assert.deepEqual(bucketDailyTrend([], 0), [])
  assert.deepEqual(bucketDailyTrend([], -3), [])
  assert.deepEqual(bucketDailyTrend([], Number.NaN), [])
})

test("bucketDailyTrend zero-fills a continuous window ending today", () => {
  const trendPoints = bucketDailyTrend([], 3)
  assert.equal(trendPoints.length, 3)
  assert.equal(trendPoints[2].date, toLocalDateKey(Date.now()))
  for (const trendPoint of trendPoints) {
    assert.deepEqual(trendPoint, {
      date: trendPoint.date,
      steps: 0,
      input: 0,
      read: 0,
      output: 0,
      hitRate: 0,
    })
  }
})

test("bucketDailyTrend accumulates steps and token parts into the matching local day", () => {
  const todayNoon = localNoonDaysAgo(0).getTime()
  const yesterdayNoon = localNoonDaysAgo(1).getTime()
  const stepRows = [
    makeAssistantStepRow({
      timeCreated: todayNoon,
      tokens: makeTokenUsage({ input: 100, output: 50, cacheRead: 300 }),
    }),
    makeAssistantStepRow({
      timeCreated: todayNoon,
      tokens: makeTokenUsage({ input: 100, output: 50, cacheRead: 100 }),
    }),
    makeAssistantStepRow({
      timeCreated: yesterdayNoon,
      tokens: makeTokenUsage({ input: 0, output: 10, cacheRead: 0 }),
    }),
  ]

  const trendPoints = bucketDailyTrend(stepRows, 2)
  assert.equal(trendPoints.length, 2)
  const [yesterdayPoint, todayPoint] = trendPoints

  assert.equal(todayPoint.steps, 2)
  assert.equal(todayPoint.input, 200)
  assert.equal(todayPoint.read, 400)
  assert.equal(todayPoint.output, 100)
  assert.equal(todayPoint.hitRate, 400 / 600) // read=400, input=200 → 2/3

  assert.equal(yesterdayPoint.steps, 1)
  assert.equal(yesterdayPoint.hitRate, 0) // zero denominator stays at 0, never NaN
})

test("bucketDailyTrend excludes samples older than the requested window", () => {
  const oldNoon = localNoonDaysAgo(30).getTime()
  const stepRows = [
    makeAssistantStepRow({ timeCreated: oldNoon, tokens: makeTokenUsage({ input: 5 }) }),
  ]
  const trendPoints = bucketDailyTrend(stepRows, 7)
  assert.equal(trendPoints.length, 7)
  const totalSteps = trendPoints.reduce((stepSum, point) => stepSum + point.steps, 0)
  assert.equal(totalSteps, 0)
})

test("bucketDailyTrend caps the window at MAX_TREND_DAYS", () => {
  assert.equal(bucketDailyTrend([], 1_000_000).length, MAX_TREND_DAYS)
})

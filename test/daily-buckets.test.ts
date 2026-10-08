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
      // No models observed → empty dense map on every day.
      byModel: {},
    })
  }
})

test("bucketDailyTrend buckets byModel per day, dense zero-filled, in the pinned model order (v0.11.0)", () => {
  const todayNoon = localNoonDaysAgo(0).getTime()
  const yesterdayNoon = localNoonDaysAgo(1).getTime()
  const stepRows = [
    // today: example-model-a 250+50+100 = 400, example-model-b 300.
    makeAssistantStepRow({
      timeCreated: todayNoon,
      modelId: "example-model-a",
      tokens: makeTokenUsage({ input: 250, output: 50, cacheRead: 100 }),
    }),
    makeAssistantStepRow({
      timeCreated: todayNoon,
      modelId: "example-model-b",
      tokens: makeTokenUsage({ input: 300, output: 0, cacheRead: 0 }),
    }),
    // yesterday: example-model-a 100 + 90 = 190, example-model-c 300.
    makeAssistantStepRow({
      timeCreated: yesterdayNoon,
      modelId: "example-model-a",
      tokens: makeTokenUsage({ input: 100, output: 0, cacheRead: 0 }),
    }),
    makeAssistantStepRow({
      timeCreated: yesterdayNoon,
      modelId: "example-model-a",
      tokens: makeTokenUsage({ input: 30, output: 30, cacheRead: 30 }),
    }),
    makeAssistantStepRow({
      timeCreated: yesterdayNoon,
      modelId: "example-model-c",
      tokens: makeTokenUsage({ input: 300, output: 0, cacheRead: 0 }),
    }),
  ]

  const trendPoints = bucketDailyTrend(stepRows, 2)
  assert.equal(trendPoints.length, 2)
  const [yesterdayPoint, todayPoint] = trendPoints

  // Window totals: example-model-a 400+190=590, example-model-b 300,
  // example-model-c 300 → pinned order: total desc (a first), then the
  // 300-tie resolved by modelId ascending (b before c).
  const expectedModelOrder = ["example-model-a", "example-model-b", "example-model-c"]
  assert.deepEqual(Object.keys(todayPoint.byModel), expectedModelOrder)
  assert.deepEqual(Object.keys(yesterdayPoint.byModel), expectedModelOrder)
  assert.deepEqual(todayPoint.byModel, {
    "example-model-a": 400,
    "example-model-b": 300,
    "example-model-c": 0,
  })
  assert.deepEqual(yesterdayPoint.byModel, {
    "example-model-a": 190,
    "example-model-b": 0,
    "example-model-c": 300,
  })

  // 口径 consistency lock: Σ byModel === input + read + output, every day.
  for (const trendPoint of trendPoints) {
    const byModelSum = Object.values(trendPoint.byModel).reduce(
      (tokenSum, modelTokens) => tokenSum + modelTokens,
      0,
    )
    assert.equal(byModelSum, trendPoint.input + trendPoint.read + trendPoint.output)
  }
})

test("bucketDailyTrend sorts by window-total desc with modelId asc as the tie-break (v0.11.0)", () => {
  const todayNoon = localNoonDaysAgo(0).getTime()
  const stepRows = [
    makeAssistantStepRow({ timeCreated: todayNoon, modelId: "example-model-a", tokens: makeTokenUsage({ input: 100 }) }),
    makeAssistantStepRow({ timeCreated: todayNoon, modelId: "example-model-b", tokens: makeTokenUsage({ input: 500 }) }),
    makeAssistantStepRow({ timeCreated: todayNoon, modelId: "example-model-d", tokens: makeTokenUsage({ input: 200 }) }),
    makeAssistantStepRow({ timeCreated: todayNoon, modelId: "example-model-c", tokens: makeTokenUsage({ input: 200 }) }),
  ]
  const [todayPoint] = bucketDailyTrend(stepRows, 1)
  // b(500) leads on total; the 200-tie between c and d resolves by id
  // ascending; a(100) closes. A lexicographic-only or total-only sort
  // would both fail this lock.
  assert.deepEqual(Object.keys(todayPoint.byModel), [
    "example-model-b",
    "example-model-c",
    "example-model-d",
    "example-model-a",
  ])
})

test("bucketDailyTrend produces byte-identical byModel for identical inputs (determinism lock, v0.11.0)", () => {
  const todayNoon = localNoonDaysAgo(0).getTime()
  const yesterdayNoon = localNoonDaysAgo(1).getTime()
  const buildStepRows = () => [
    makeAssistantStepRow({ timeCreated: todayNoon, modelId: "example-model-b", tokens: makeTokenUsage({ input: 300 }) }),
    makeAssistantStepRow({ timeCreated: yesterdayNoon, modelId: "example-model-a", tokens: makeTokenUsage({ input: 100 }) }),
    makeAssistantStepRow({ timeCreated: yesterdayNoon, modelId: "example-model-c", tokens: makeTokenUsage({ input: 100 }) }),
  ]
  const firstRunPoints = bucketDailyTrend(buildStepRows(), 2)
  const secondRunPoints = bucketDailyTrend(buildStepRows(), 2)
  assert.deepEqual(secondRunPoints, firstRunPoints, "same input → same points, byModel included")
  assert.deepEqual(
    secondRunPoints.map((trendPoint) => Object.keys(trendPoint.byModel)),
    firstRunPoints.map((trendPoint) => Object.keys(trendPoint.byModel)),
    "model key order is deterministic too — the frontend stack order relies on it",
  )
})

test("bucketDailyTrend never leaks a model whose only activity is outside the window (v0.11.0)", () => {
  const oldNoon = localNoonDaysAgo(30).getTime()
  const todayNoon = localNoonDaysAgo(0).getTime()
  const stepRows = [
    makeAssistantStepRow({
      timeCreated: oldNoon,
      modelId: "example-model-leak",
      tokens: makeTokenUsage({ input: 999 }),
    }),
    makeAssistantStepRow({
      timeCreated: todayNoon,
      modelId: "example-model-a",
      tokens: makeTokenUsage({ input: 10 }),
    }),
  ]
  const trendPoints = bucketDailyTrend(stepRows, 7)
  for (const trendPoint of trendPoints) {
    assert.deepEqual(
      Object.keys(trendPoint.byModel),
      ["example-model-a"],
      "the outside-window model must not appear in any day's byModel",
    )
  }
})

test("bucketDailyTrend degenerates to one dense model layer for single-model input (v0.11.0)", () => {
  const todayNoon = localNoonDaysAgo(0).getTime()
  const stepRows = [
    makeAssistantStepRow({
      timeCreated: todayNoon,
      modelId: "example-model-solo",
      tokens: makeTokenUsage({ input: 100, output: 20, cacheRead: 3 }),
    }),
  ]
  const [yesterdayPoint, todayPoint] = bucketDailyTrend(stepRows, 2)
  assert.deepEqual(todayPoint.byModel, { "example-model-solo": 123 })
  assert.deepEqual(yesterdayPoint.byModel, { "example-model-solo": 0 })
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

/**
 * Tests for per-model metric aggregation (DESIGN.md §5 模型单点指标).
 */

import { test } from "node:test"
import assert from "node:assert/strict"

import {
  computeModelMetrics,
  nearestRankPercentile,
} from "../src/stats/model-metrics.ts"
import { makeAssistantStepRow, makeTokenUsage } from "./helpers/step-factories.ts"

test("computeModelMetrics returns an empty array when there are no steps", () => {
  assert.deepEqual(computeModelMetrics([]), [])
})

test("computeModelMetrics computes every metric for a single step", () => {
  const stepTimeCreated = 1_791_200_000_000
  const singleStep = makeAssistantStepRow({
    timeCreated: stepTimeCreated,
    tokens: makeTokenUsage({ input: 100, output: 200, reasoning: 50, cacheRead: 700, cacheWrite: 200 }),
  })

  const modelMetrics = computeModelMetrics([singleStep])
  assert.equal(modelMetrics.length, 1)
  const modelMetric = modelMetrics[0]
  assert.equal(modelMetric.modelId, "model/sample")
  assert.equal(modelMetric.providerId, "provider-sample")
  assert.equal(modelMetric.steps, 1)
  assert.equal(modelMetric.tokens, 1_000) // 100 + 200 + 700
  assert.equal(modelMetric.hitRate, 700 / 800)
  assert.equal(modelMetric.outputPerStep, 200)
  assert.equal(modelMetric.contextAvg, 1_000) // 100 + 700 + 200
  assert.equal(modelMetric.contextMedian, 1_000)
  assert.equal(modelMetric.contextP95, 1_000)
  assert.equal(modelMetric.reasoningShare, 50 / 250)
  assert.equal(modelMetric.firstSeen, stepTimeCreated)
  assert.equal(modelMetric.lastSeen, stepTimeCreated)
})

test("computeModelMetrics uses nearest-rank median and p95 over sorted per-step contexts", () => {
  // Contexts 100, 200, 300, 400 → median 200 (rank 2), p95 400 (rank 4).
  const contexts = [100, 200, 300, 400]
  const stepRows = contexts.map((contextSize, stepIndex) =>
    makeAssistantStepRow({
      modelId: "model/sample",
      timeCreated: 1_791_200_000_000 + stepIndex,
      tokens: makeTokenUsage({ input: contextSize, output: 1 }),
    }),
  )

  const modelMetric = computeModelMetrics(stepRows)[0]
  assert.equal(modelMetric.steps, 4)
  assert.equal(modelMetric.contextAvg, 250)
  assert.equal(modelMetric.contextMedian, 200)
  assert.equal(modelMetric.contextP95, 400)
})

test("computeModelMetrics stays finite for steps that carry no tokens at all", () => {
  const modelMetric = computeModelMetrics([makeAssistantStepRow()])[0]
  assert.equal(modelMetric.tokens, 0)
  assert.equal(modelMetric.hitRate, 0)
  assert.equal(modelMetric.outputPerStep, 0)
  assert.equal(modelMetric.contextAvg, 0)
  assert.equal(modelMetric.reasoningShare, 0)
  assert.ok(Number.isFinite(modelMetric.contextMedian))
  assert.ok(Number.isFinite(modelMetric.contextP95))
})

test("computeModelMetrics groups by model and sorts groups by total tokens descending", () => {
  const stepRows = [
    makeAssistantStepRow({
      modelId: "model/small",
      tokens: makeTokenUsage({ input: 100 }),
    }),
    makeAssistantStepRow({
      modelId: "model/large",
      tokens: makeTokenUsage({ input: 400, output: 400 }),
    }),
    makeAssistantStepRow({
      modelId: "model/large",
      tokens: makeTokenUsage({ input: 400, output: 400 }),
    }),
  ]

  const modelMetrics = computeModelMetrics(stepRows)
  assert.equal(modelMetrics.length, 2)
  assert.equal(modelMetrics[0].modelId, "model/large")
  assert.equal(modelMetrics[0].tokens, 1_600)
  assert.equal(modelMetrics[1].modelId, "model/small")
  assert.equal(modelMetrics[1].tokens, 100)
})

test("computeModelMetrics tracks firstSeen/lastSeen across the model's steps", () => {
  const earliestTime = 1_791_000_000_000
  const middleTime = 1_791_100_000_000
  const latestTime = 1_791_200_000_000
  const stepRows = [
    makeAssistantStepRow({ modelId: "model/sample", timeCreated: middleTime }),
    makeAssistantStepRow({ modelId: "model/sample", timeCreated: latestTime }),
    makeAssistantStepRow({ modelId: "model/sample", timeCreated: earliestTime }),
  ]

  const modelMetric = computeModelMetrics(stepRows)[0]
  assert.equal(modelMetric.firstSeen, earliestTime)
  assert.equal(modelMetric.lastSeen, latestTime)
})

test("computeModelMetrics takes the model's first non-empty providerId (P2-17)", () => {
  // Some steps carry no providerId at all; the metric must not adopt the
  // empty value but keep scanning for the first step that has one.
  const mixedProviderRows = [
    makeAssistantStepRow({ modelId: "model/sample", providerId: "" }),
    makeAssistantStepRow({ modelId: "model/sample", providerId: "provider-second" }),
    makeAssistantStepRow({ modelId: "model/sample", providerId: "provider-third" }),
  ]
  assert.equal(computeModelMetrics(mixedProviderRows)[0].providerId, "provider-second")

  // All steps empty → the metric degrades to "" rather than inventing a name.
  const emptyProviderRows = [
    makeAssistantStepRow({ modelId: "model/sample", providerId: "" }),
    makeAssistantStepRow({ modelId: "model/sample", providerId: "" }),
  ]
  assert.equal(computeModelMetrics(emptyProviderRows)[0].providerId, "")
})

test("nearestRankPercentile clamps the rank into the sample for extreme fractions", () => {
  assert.equal(nearestRankPercentile([], 0.95), 0)
  assert.equal(nearestRankPercentile([10], 0.95), 10)
  assert.equal(nearestRankPercentile([10, 20], 0), 10) // rank clamped up to 1
  assert.equal(nearestRankPercentile([10, 20], 1), 20)
})

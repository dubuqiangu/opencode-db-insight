/**
 * Tests for per-model metric aggregation (DESIGN.md §5 模型单点指标).
 */

import { test } from "node:test"
import assert from "node:assert/strict"

import {
  attachPreviousWindowTokens,
  compositeModelKey,
  computeModelMetrics,
  nearestRankPercentile,
  type ModelMetric,
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
  assert.equal(modelMetric.tokenShare, 1) // sole model owns the full denominator
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
  assert.equal(modelMetric.tokenShare, 0) // all-zero denominator → share stays 0
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
  // 复合分组后 providerId 是键的一部分：同一 modelId 的不同 provider 各自成行，
  // 每行只看自己组内的 provider。全空的组降级为 ""，不臆造名字。
  const mixedProviderRows = [
    makeAssistantStepRow({ modelId: "model/sample", providerId: "" }),
    makeAssistantStepRow({ modelId: "model/sample", providerId: "provider-second" }),
    makeAssistantStepRow({ modelId: "model/sample", providerId: "provider-third" }),
  ]
  const mixedProviders = computeModelMetrics(mixedProviderRows)
    .map((modelMetric) => modelMetric.providerId)
    .sort((left, right) => left.localeCompare(right))
  assert.deepEqual(mixedProviders, ["", "provider-second", "provider-third"])

  const emptyProviderRows = [
    makeAssistantStepRow({ modelId: "model/sample", providerId: "" }),
    makeAssistantStepRow({ modelId: "model/sample", providerId: "" }),
  ]
  assert.deepEqual(computeModelMetrics(emptyProviderRows).map((metric) => metric.providerId), [""])
})

test("computeModelMetrics groups by composite modelId+providerId+variant", () => {
  // 同一 modelId 的真实 variant 横跨：必须按复合键各自成行，而不是并成一行。
  const sameModelTwoVariants = [
    makeAssistantStepRow({ modelId: "z-ai/glm-5.3", providerId: "futureppo", variant: "high" }),
    makeAssistantStepRow({ modelId: "z-ai/glm-5.3", providerId: "futureppo", variant: "high" }),
    makeAssistantStepRow({ modelId: "z-ai/glm-5.3", providerId: "futureppo", variant: "default" }),
  ]
  const variantRows = computeModelMetrics(sameModelTwoVariants)
  assert.equal(variantRows.length, 2, "同一 modelId 的两个 variant 各成一行")
  assert.deepEqual(
    variantRows.map((modelMetric) => [modelMetric.modelId, modelMetric.providerId, modelMetric.variant, modelMetric.steps]),
    [
      ["z-ai/glm-5.3", "futureppo", "high", 2],
      ["z-ai/glm-5.3", "futureppo", "default", 1],
    ],
  )

  // provider 也是复合键的一段：同 modelId+同 variant、不同 provider → 两行。
  const sameModelTwoProviders = [
    makeAssistantStepRow({ modelId: "z-ai/glm-5.3", providerId: "futureppo", variant: "high" }),
    makeAssistantStepRow({ modelId: "z-ai/glm-5.3", providerId: "furryvg", variant: "high" }),
  ]
  assert.equal(computeModelMetrics(sameModelTwoProviders).length, 2)

  // 缺失 variant（undefined）归 ""，不与 "high" 合并，也不丢行。
  const missingVariantRows = [
    makeAssistantStepRow({ modelId: "z-ai/glm-5.3", providerId: "futureppo", variant: "high" }),
    makeAssistantStepRow({ modelId: "z-ai/glm-5.3", providerId: "futureppo", variant: "" }),
  ]
  const missingVariantRowsMetrics = computeModelMetrics(missingVariantRows)
  assert.equal(missingVariantRowsMetrics.length, 2)
  assert.deepEqual(
    missingVariantRowsMetrics.map((modelMetric) => modelMetric.variant).sort(),
    ["", "high"],
  )
})

test("computeModelMetrics sets tokenShare to each model's raw fraction of all models' tokens", () => {
  // Denominator = 1_600 + 100 = 1_700 (input+output+cache.read across every row).
  const stepRows = [
    makeAssistantStepRow({
      modelId: "model/large",
      tokens: makeTokenUsage({ input: 400, output: 400 }),
    }),
    makeAssistantStepRow({
      modelId: "model/large",
      tokens: makeTokenUsage({ input: 400, output: 400 }),
    }),
    makeAssistantStepRow({
      modelId: "model/small",
      tokens: makeTokenUsage({ input: 100 }),
    }),
  ]

  const modelMetrics = computeModelMetrics(stepRows)
  assert.equal(modelMetrics[0].tokenShare, 1_600 / 1_700)
  assert.equal(modelMetrics[1].tokenShare, 100 / 1_700)

  // Same source rows, same denominator → the shares sum to 1, up to
  // floating-point rounding (each division rounds by ≤ 0.5 ulp; a strict
  // === 1 would only pass by fixture-number luck).
  const tokenShareSum = modelMetrics.reduce(
    (sum: number, modelMetric) => sum + modelMetric.tokenShare,
    0,
  )
  assert.ok(Math.abs(tokenShareSum - 1) < 1e-9)
})

test("computeModelMetrics returns tokenShare 0 for every model when all tokens are 0", () => {
  const zeroTokenRows = [
    makeAssistantStepRow({ modelId: "model/alpha" }),
    makeAssistantStepRow({ modelId: "model/beta" }),
  ]

  const modelMetrics = computeModelMetrics(zeroTokenRows)
  assert.equal(modelMetrics.length, 2)
  for (const modelMetric of modelMetrics) {
    assert.equal(modelMetric.tokens, 0)
    assert.equal(modelMetric.tokenShare, 0)
  }
})

test("nearestRankPercentile clamps the rank into the sample for extreme fractions", () => {
  assert.equal(nearestRankPercentile([], 0.95), 0)
  assert.equal(nearestRankPercentile([10], 0.95), 10)
  assert.equal(nearestRankPercentile([10, 20], 0), 10) // rank clamped up to 1
  assert.equal(nearestRankPercentile([10, 20], 1), 20)
})

/* ---------------- 环比基数（attachPreviousWindowTokens，B-part-2） ---------------- */

/** 最小 ModelMetric 夹具：只声明比对用到的字段，其余给零值。 */
function modelMetricFixture(overrides: Partial<ModelMetric>): ModelMetric {
  return {
    modelId: "model/alpha",
    providerId: "provider",
    variant: "",
    steps: 1,
    tokens: 100,
    tokenShare: 1,
    hitRate: 0,
    outputPerStep: 0,
    contextAvg: 0,
    contextMedian: 0,
    contextP95: 0,
    reasoningShare: 0,
    firstSeen: 0,
    lastSeen: 0,
    ...overrides,
  }
}

test("compositeModelKey joins modelId+providerId+variant with the \\u0000 delimiter and never emits undefined", () => {
  assert.equal(
    compositeModelKey({ modelId: "glm-5.3", providerId: "futureppo", variant: "high" }),
    "glm-5.3\u0000futureppo\u0000high",
  )
  assert.equal(
    compositeModelKey({ modelId: "m", providerId: "", variant: "" }),
    "m\u0000\u0000",
  )
  // 缺字段（旧 wire / 运行时脏值）归一为 ""，绝不能拼进 "undefined"。
  assert.equal(
    compositeModelKey({
      modelId: "m",
      providerId: undefined,
      variant: undefined,
    } as unknown as { modelId: string; providerId: string; variant: string }),
    "m\u0000\u0000",
  )
})

test("attachPreviousWindowTokens copies previousTokens for matching composite keys and 0 for fresh models", () => {
  const currentMetrics = [
    modelMetricFixture({ modelId: "model/alpha", providerId: "p", variant: "high", tokens: 300 }),
    modelMetricFixture({ modelId: "model/beta", providerId: "p", variant: "", tokens: 100 }),
  ]
  const previousMetrics = [
    modelMetricFixture({ modelId: "model/alpha", providerId: "p", variant: "high", tokens: 200 }),
  ]

  const comparison = attachPreviousWindowTokens(currentMetrics, previousMetrics)
  assert.equal(comparison.length, 2, "every current row survives, disappeared models add nothing")
  const alpha = comparison.find((row) => row.modelId === "model/alpha")!
  assert.equal(alpha.tokens, 300, "the current-window total is untouched")
  assert.equal(alpha.previousTokens, 200, "matching composite key copies the previous-window total")
  const beta = comparison.find((row) => row.modelId === "model/beta")!
  assert.equal(beta.previousTokens, 0, "a model absent from the previous window gets 0")
})

test("attachPreviousWindowTokens drops previous-only models and sums duplicate previous rows", () => {
  const currentMetrics = [
    modelMetricFixture({ modelId: "model/alpha", providerId: "p", variant: "", tokens: 100 }),
    modelMetricFixture({ modelId: "model/fresh", providerId: "p", variant: "", tokens: 10 }),
  ]
  // 同一复合键在上一窗口拆成两行（管线正常唯一，这里兜底求和），
  // 外加一个只存在于上一窗口、当前窗口缺席的模型。
  const previousMetrics = [
    modelMetricFixture({ modelId: "model/alpha", providerId: "p", variant: "", tokens: 30 }),
    modelMetricFixture({ modelId: "model/alpha", providerId: "p", variant: "", tokens: 70 }),
    modelMetricFixture({ modelId: "model/gone", providerId: "p", variant: "", tokens: 999 }),
  ]

  const comparison = attachPreviousWindowTokens(currentMetrics, previousMetrics)
  assert.deepEqual(
    comparison.map((row) => row.modelId),
    ["model/alpha", "model/fresh"],
    "a previous-only model is absent from the current-window output",
  )
  assert.equal(comparison[0].previousTokens, 100, "duplicate previous rows sum into one base")
  assert.equal(comparison[1].previousTokens, 0)
})

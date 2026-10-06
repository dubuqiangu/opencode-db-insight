/**
 * Per-model metric aggregation for the leaderboard (DESIGN.md §5 模型单点指标).
 * Pure functions, zero IO; input is the parsed assistant step rows.
 */

import type { TokenUsage } from "../db/types.ts"
import { hitRate, totalUsageTokens } from "./hit-rate.ts"

/** One model row of GET /api/models. */
export interface ModelMetric {
  modelId: string
  providerId: string
  steps: number
  /** Σ total usage (input+output+cache.read) across this model's steps. */
  tokens: number
  hitRate: number
  outputPerStep: number
  /** Context = input + cache.read + cache.write of one step. */
  contextAvg: number
  contextMedian: number
  contextP95: number
  /** reasoning / (reasoning + output); 0 when both are 0. */
  reasoningShare: number
  firstSeen: number
  lastSeen: number
}

/**
 * Minimal per-step shape the model metrics need. Deliberately structural:
 * the SQL-side lightweight model rows satisfy it without carrying the full
 * AssistantStepRow, and full step rows keep satisfying it too.
 */
export interface ModelUsageSample {
  timeCreated: number
  modelId: string
  providerId: string
  tokens: TokenUsage
}

/**
 * Nearest-rank percentile over an ascending-sorted sample.
 * Empty input yields 0; rank is clamped into [1, length].
 */
export function nearestRankPercentile(sortedAscending: number[], fraction: number): number {
  if (sortedAscending.length === 0) return 0
  const rank = Math.ceil(fraction * sortedAscending.length)
  const clampedRank = Math.min(Math.max(rank, 1), sortedAscending.length)
  return sortedAscending[clampedRank - 1]
}

/**
 * Aggregate assistant steps into per-model metrics, sorted by total tokens
 * descending. Each model's providerId comes from its first step that
 * actually carries one (empty providerIds are skipped, P2-17).
 */
export function computeModelMetrics(sampleRows: ModelUsageSample[]): ModelMetric[] {
  const stepRowsByModel = new Map<string, ModelUsageSample[]>()
  for (const sampleRow of sampleRows) {
    const existingRows = stepRowsByModel.get(sampleRow.modelId)
    if (existingRows === undefined) {
      stepRowsByModel.set(sampleRow.modelId, [sampleRow])
    } else {
      existingRows.push(sampleRow)
    }
  }

  const modelMetrics: ModelMetric[] = []
  for (const [modelId, modelStepRows] of stepRowsByModel) {
    let tokenSum = 0
    let inputSum = 0
    let cacheReadSum = 0
    let outputSum = 0
    let reasoningSum = 0
    let firstSeen = Number.POSITIVE_INFINITY
    let lastSeen = Number.NEGATIVE_INFINITY
    const contextsPerStep: number[] = []

    for (const stepRow of modelStepRows) {
      const { tokens } = stepRow
      tokenSum += totalUsageTokens(tokens)
      inputSum += tokens.input
      cacheReadSum += tokens.cacheRead
      outputSum += tokens.output
      reasoningSum += tokens.reasoning
      contextsPerStep.push(tokens.input + tokens.cacheRead + tokens.cacheWrite)
      firstSeen = Math.min(firstSeen, stepRow.timeCreated)
      lastSeen = Math.max(lastSeen, stepRow.timeCreated)
    }

    const stepCount = modelStepRows.length
    contextsPerStep.sort((left: number, right: number) => left - right)
    const reasoningDenominator = reasoningSum + outputSum
    const firstNonEmptyProviderId =
      modelStepRows.find((stepRow) => stepRow.providerId !== "")?.providerId ?? ""

    modelMetrics.push({
      modelId,
      providerId: firstNonEmptyProviderId,
      steps: stepCount,
      tokens: tokenSum,
      hitRate: hitRate(cacheReadSum, inputSum),
      outputPerStep: outputSum / stepCount,
      contextAvg: contextsPerStep.reduce((sum: number, value: number) => sum + value, 0) / stepCount,
      contextMedian: nearestRankPercentile(contextsPerStep, 0.5),
      contextP95: nearestRankPercentile(contextsPerStep, 0.95),
      reasoningShare: reasoningDenominator > 0 ? reasoningSum / reasoningDenominator : 0,
      firstSeen,
      lastSeen,
    })
  }

  modelMetrics.sort((left: ModelMetric, right: ModelMetric) => right.tokens - left.tokens)
  return modelMetrics
}

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
  /** model variant ("high"/"max"/"default"/"" — empty displays as "—"). */
  variant: string
  steps: number
  /** Σ total usage (input+output+cache.read) across this model's steps. */
  tokens: number
  /**
   * This model's tokens / Σ tokens of ALL models within the same
   * computeModelMetrics invocation (raw fraction 0..1, never rounded or
   * scaled — the display side formats it). 0 for every model when the
   * all-models denominator is ≤ 0 (empty input or all-zero tokens); the
   * per-model shares sum to 1 up to floating-point rounding (each
   * division carries ≤ 0.5 ulp of rounding; an 85-model live database
   * measured a 1 ulp total deviation).
   */
  tokenShare: number
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
  /** model variant ("high"/"max"/"default"/"" — empty maps to ""). */
  variant: string
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
 * 复合行键：modelId + providerId + variant，分隔符 \u0000（与前端
 * model-table.js 的 compositeModelKey 同一分隔符——下钻/环比按同一键
 * 对齐）。缺字段/空值一律归一为 ""，恒为全字符串，绝不产出 "undefined"。
 */
export function compositeModelKey(metric: {
  modelId: string
  providerId: string
  variant: string
}): string {
  const modelId = metric.modelId ?? ""
  const providerId = metric.providerId ?? ""
  const variant = metric.variant ?? ""
  return `${modelId}\u0000${providerId}\u0000${variant}`
}

/**
 * Aggregate assistant steps into per-(modelId, providerId, variant) metrics,
 * sorted by total tokens descending. Each composite group's providerId comes
 * from its first step that actually carries one (empty providerIds are
 * skipped, P2-17).
 */
export function computeModelMetrics(sampleRows: ModelUsageSample[]): ModelMetric[] {
  const stepRowsByModel = new Map<string, ModelUsageSample[]>()
  // Token-share denominator: Σ tokens over ALL models of this invocation
  // (same input rows, same input+output+cache.read 口径 as per-model tokens),
  // accumulated during the single grouping scan below.
  let totalTokensAllModels = 0
  for (const sampleRow of sampleRows) {
    totalTokensAllModels += totalUsageTokens(sampleRow.tokens)
    // 复合分组键：modelId + providerId + variant。同一 modelId 可真实横跨
    // 多个 (providerId, variant) 组合，故不能只用 modelId 分组；空值与空
    // 变体均归 ""，键内用 \u0000 分隔避免碰撞（见 compositeModelKey）。
    const groupKey = compositeModelKey(sampleRow)
    const existingRows = stepRowsByModel.get(groupKey)
    if (existingRows === undefined) {
      stepRowsByModel.set(groupKey, [sampleRow])
    } else {
      existingRows.push(sampleRow)
    }
  }

  const modelMetrics: ModelMetric[] = []
  for (const [, modelStepRows] of stepRowsByModel) {
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
    // 复合分组下组内已按 provider 划分：providerId 取组内首个非空值（P2-17 保留）。
    const firstNonEmptyProviderId =
      modelStepRows.find((stepRow) => stepRow.providerId !== "")?.providerId ?? ""
    const firstStepRow = modelStepRows[0]

    modelMetrics.push({
      modelId: firstStepRow.modelId,
      providerId: firstNonEmptyProviderId,
      variant: firstStepRow.variant,
      steps: stepCount,
      tokens: tokenSum,
      // Raw 0..1 share; 0 for every model when the denominator is ≤ 0
      // (empty input or all-zero tokens) — never NaN/Infinity.
      tokenShare: totalTokensAllModels > 0 ? tokenSum / totalTokensAllModels : 0,
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

  // 主序 tokens 降序；tokens 平局按复合键升序稳定排序（gotcha: 仅比 tokens
  // 时平局顺序取决于 Map 插入序，非确定）。复合键与前端下钻/环比同键。
  modelMetrics.sort(
    (left: ModelMetric, right: ModelMetric) =>
      right.tokens - left.tokens ||
      compareTextAscending(compositeModelKey(left), compositeModelKey(right)),
  )
  return modelMetrics
}

/** 文本升序比较（码元序，与 locale 无关，供平局稳定排序用）。 */
function compareTextAscending(left: string, right: string): number {
  if (left < right) return -1
  if (left > right) return 1
  return 0
}

/** 环比榜行：ModelMetric 加一个「上一等长窗口」的 token 合计。 */
export interface ModelMetricComparison extends ModelMetric {
  /**
   * 同一复合键在「上一等长窗口」的 token 合计；该窗口无此模型时为 0
   * （无环比基数，前端渲染 "— 环比"）。
   */
  previousTokens: number
}

/**
 * 给当前窗口的榜行逐行附上「上一等长窗口」的同键 token 合计（环比基数）：
 * 先按 compositeModelKey 聚合 previousMetrics（同一键若重复出现则求和——
 * SQL/JS 管线正常只产生唯一键，这里仍做求和兜底），再逐行映射
 * currentMetrics，找不到对应键的 previousTokens 归 0。当前窗口缺席、
 * 仅上一窗口出现的模型不会出现在输出里（它本就不是当前榜行）。
 */
export function attachPreviousWindowTokens(
  currentMetrics: ModelMetric[],
  previousMetrics: ModelMetric[],
): ModelMetricComparison[] {
  const previousTokensByKey = new Map<string, number>()
  for (const previousMetric of previousMetrics) {
    const previousKey = compositeModelKey(previousMetric)
    previousTokensByKey.set(
      previousKey,
      (previousTokensByKey.get(previousKey) ?? 0) + previousMetric.tokens,
    )
  }
  return currentMetrics.map((currentMetric) => ({
    ...currentMetric,
    previousTokens: previousTokensByKey.get(compositeModelKey(currentMetric)) ?? 0,
  }))
}

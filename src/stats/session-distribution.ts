/**
 * 数值分布（桶 / 分位 / 均值 / 最大值）的通用纯计算（v0.21.0 泛化：
 * 由 v0.20.0 的 computeSessionTokenDistribution 改名而来，输入从
 * 「每会话 tokens 三列合计」泛化为任意正数值序列）。纯函数、零 IO：
 * 输入是 SQL 侧已收窄的数值序列，输出桶 / 分位 / 均值 / 最大值。
 * 三个分布端点（tokens / 步数 / 时长）复用本函数；桶轴 / 分位方法论
 * 与 v0.20.0 完全一致（契约：行为零变化）。分位方法论复用
 * nearestRankPercentile（与模型排行榜的 p95 同一最近秩口径——方法论
 * 单点，各处不各写一套）。
 *
 * 桶轴选择（v0.20.0 报告已注明，泛化后沿用）：对数轴、半个数量级一档
 * （边 = 10^(k/2)，首桶 [0, 1) 兜底亚单位值）。理由：这些分布是典型
 * 重尾分布——活库跨度从几十到数百万（3~7 个数量级），固定宽度的线性
 * 轴要么挤扁头部、要么把 p99 之后拉成一整桶；对数半档在真实数据的
 * 1e5~1e7 区间给出 11~15 桶，落在契约建议的 12-16 桶邻域，且每档
 * 边界值圆整到 3 位有效数字后是对人类友好的 3.16 / 31.6 / 316 …
 * 序列（10 的整数次幂保持精确）。桶数由数据上限自动决定（上限
 * 10^D → 2D+1 桶），不固定。
 */

import { nearestRankPercentile } from "./model-metrics.ts"

/** 一个数值分布桶（左闭右开；末桶含上限，见 compute 说明）。 */
export interface NumericDistributionBucket {
  start: number
  end: number
  count: number
}

/** 数值分布端点的载荷形状（tokens / 步数 / 时长三端点共用）。 */
export interface NumericDistributionStats {
  /** 进入分布的样本数（已排除非正值样本）。 */
  totalSessions: number
  buckets: NumericDistributionBucket[]
  percentiles: { p50: number; p90: number; p99: number }
  mean: number
  max: number
}

/**
 * 圆整到 3 位有效数字：10 的整数次幂保持精确（10^3.5 → 3160，
 * 10^4 → 10000），桶边界因此是稳定、可读的数，不受浮点尾数影响。
 */
function roundToThreeSignificantDigits(value: number): number {
  if (value === 0) return 0
  const magnitude = Math.floor(Math.log10(Math.abs(value)))
  const digitScale = Math.pow(10, magnitude - 2)
  return Math.round(value / digitScale) * digitScale
}

/**
 * 对数半档的桶边界（升序，已圆整）：[1, 10^(0.5), 10, 10^1.5, …,
 * 10^D, 10^(D+0.5)]。D = ceil(log10(maxTokens))，最末边界
 * 10^(D+0.5) > max，保证上限值落进末桶（末桶 [10^D, 10^(D+0.5))
 * 含 max——max ≤ 10^D 当且仅当 max 恰为 10 的整数次幂，此时它落在
 * 末桶下界上，计数按「>= 下界」判定仍然归属末桶）。
 */
function buildLogBucketEdges(maxTokens: number): number[] {
  const decadeCeiling = Math.max(1, Math.ceil(Math.log10(maxTokens)))
  const edges: number[] = []
  for (let halfDecadeIndex = 0; halfDecadeIndex <= 2 * decadeCeiling + 1; halfDecadeIndex += 1) {
    edges.push(roundToThreeSignificantDigits(Math.pow(10, halfDecadeIndex / 2)))
  }
  return edges
}

/**
 * 计算分布。空输入诚实返回零载荷（totalSessions 0 / 空桶数组 /
 * 分位与均值最大值全 0），不伪造桶。
 *
 * 归桶语义：按圆整后的边界逐值比较（线性扫 11~17 条边，开销可
 * 忽略），而不是用 floor(log10(v)) 反推——圆整后的边界与真实
 * 10^(k/2) 有 <0.1% 的偏差（如 3.16 vs 3.1623），反推会把边界邻域
 * 的值归进与报告边界不一致的桶；逐值比较保证「报告的边」与
 * 「计数的边」是同一条。
 */
export function computeNumericDistribution(values: number[]): NumericDistributionStats {
  const positiveValues = values.filter(
    (value) => Number.isFinite(value) && value > 0,
  )
  if (positiveValues.length === 0) {
    return {
      totalSessions: 0,
      buckets: [],
      percentiles: { p50: 0, p90: 0, p99: 0 },
      mean: 0,
      max: 0,
    }
  }

  const sortedValues = [...positiveValues].sort((leftValue, rightValue) => leftValue - rightValue)
  const maxValue = sortedValues[sortedValues.length - 1]
  const edges = buildLogBucketEdges(maxValue)

  // 首桶 [0, edges[0]) 兜底亚单位值；其余桶 [edges[i], edges[i+1])。
  const buckets: NumericDistributionBucket[] = [{ start: 0, end: edges[0], count: 0 }]
  for (let edgeIndex = 0; edgeIndex + 1 < edges.length; edgeIndex += 1) {
    buckets.push({ start: edges[edgeIndex], end: edges[edgeIndex + 1], count: 0 })
  }

  let valuesSum = 0
  for (const value of sortedValues) {
    valuesSum += value
    // 末桶下界之后（含恰好等于末桶下界的值，如 max = 10^D）一律归末桶；
    // 其余从后往前找第一个「值 >= 桶下界」的桶。
    let bucketIndex = buckets.length - 1
    while (bucketIndex > 0 && value < buckets[bucketIndex].start) {
      bucketIndex -= 1
    }
    buckets[bucketIndex].count += 1
  }

  return {
    totalSessions: sortedValues.length,
    buckets,
    percentiles: {
      p50: nearestRankPercentile(sortedValues, 0.5),
      p90: nearestRankPercentile(sortedValues, 0.9),
      p99: nearestRankPercentile(sortedValues, 0.99),
    },
    mean: valuesSum / sortedValues.length,
    max: maxValue,
  }
}

/**
 * 会话 tokens 总量分布的薄封装（v0.21.0）：v0.20.0 的端点查询与既有
 * 测试继续调它，行为零变化；实际计算全部委托给泛化的
 * computeNumericDistribution。保留它让 tokens 路径的调用点不需要改
 * 名迁移（实现成本最低），新端点（步数 / 时长）直接调泛化版。
 */
export function computeSessionTokenDistribution(
  sessionTokenTotals: number[],
): NumericDistributionStats {
  return computeNumericDistribution(sessionTokenTotals)
}

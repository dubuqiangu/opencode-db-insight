/**
 * 每工具 token 归因（自包含分词估算权重）for GET /api/tool-tokens
 * (DESIGN.md §5). Pure functions, zero IO; style mirrors tool-health.ts.
 *
 * 口径（冻结）：
 * - 一步 = 一条 assistant 消息；步 token = input + output + cache.read
 *   （复用 totalUsageTokens，与模型排行榜「总 token」同口径）。
 * - 每步按该步内各**去重后工具名**的 token 估算权重分摊：
 *   weight = estimateTokens(tool) / Σ estimateTokens(step)。
 * - estimateTokens 是自包含分词估算（零外部依赖，见
 *   estimateTokensFromLengths）：ASCII 约 4 字符 = 1 token、非 ASCII
 *   （CJK 等，UTF-8 3 字节/字符）约 1 字符 = 1 token——比裸字节更贴近真实
 *   token 比例（裸字节会把 CJK 相对 ASCII 低估约 1/3）。
 * - estimateTokens(tool) 的输入是该工具所有 part 的 state.input 与工具输出
 *   （state.metadata.output 字符串，否则 state.content[] 各 text 块 "\n\n"
 *   拼接）的「字符数 + UTF-8 字节数」（由查询层用 length() 与
 *   length(CAST(... AS BLOB)) 抽取：object/array → 紧凑 JSON 文本、string →
 *   其值本身；NULL → 0）。估算对输入线性，故 input/output 可先各自求和。
 * - 单工具步 → 整步全额归该工具；同一步同一工具出现多次，其权重先
 *   求和再参与分摊（即按去重工具名加权）。
 * - Σweight(step) == 0 且该步 k≥1 个工具 → 等权 1/k（避免除零）。
 * - 零工具步 → 整步 token 归「无工具」桶（tool === ""）。
 * - 整数守恒：先算浮点 raw 分摊，再用最大余数法取整，使
 *   Σ stat.tokens === Σ stepTokens 精确相等（余数按小数部分从大到小 +1，
 *   平局按工具名升序稳定）。
 *
 * 精度标签：🟡 估算（归因，非 DB 字段）——只体现在前端脚注，后端不管。
 */

import type { TokenUsage } from "../db/types.ts"
import { totalUsageTokens } from "./hit-rate.ts"

/** 工具名 → 该步内该工具所有 part 的文本规模（字符数 + UTF-8 字节数，已求和）。 */
export interface ToolTokenPartSize {
  name: string
  /** 该 part `state.input` + 工具输出（`state.metadata.output` 或 `state.content[]`）的字符数（code point）之和。 */
  charCount: number
  /** 该 part `state.input` + 工具输出（`state.metadata.output` 或 `state.content[]`）的 UTF-8 字节数之和。 */
  byteCount: number
}

/** 一步的归因输入：步 token 用量 + 该步内各工具 part 的文本规模。 */
export interface ToolTokenSample {
  tokens: TokenUsage
  tools: ToolTokenPartSize[]
}

/** 一条工具归因榜行 of GET /api/tool-tokens. */
export interface ToolTokenStat {
  /** 工具名；"" = 无工具桶（零工具步）。 */
  tool: string
  /** 整数 token，已最大余数取整；Σ === grandTokens。 */
  tokens: number
  /** tokens / grandTokens，raw 0..1 分数（展示侧格式化）。 */
  share: number
  /** 该工具出现在多少步（"无工具"桶 = 零工具步数）。 */
  steps: number
}

/** 一步内一次（去重后）工具的整数分摊结果。 */
interface ToolTokenAllocation {
  name: string
  tokens: number
}

/**
 * 自包含分词估算权重（零外部依赖）。
 *
 * 输入为一段文本的字符数与 UTF-8 字节数（由查询层用 length() 与
 * length(CAST(... AS BLOB)) 抽取）。估算模型：
 *
 * - 非 ASCII 字符（CJK 等按 UTF-8 3 字节/字符假说）≈ 1 字符 = 1 token；
 *   `nonAsciiChars = max(0, (byteCount - charCount) / 2)`；
 * - 其余（ASCII）≈ 4 字符 = 1 token；
 *   `asciiChars = max(0, charCount - nonAsciiChars)`；
 * - `weight = asciiChars / 4 + nonAsciiChars`。
 *
 * 等价于线性式 `0.25 * charCount + 0.375 * (byteCount - charCount)`（在
 * byteCount ≥ charCount 的合法 UTF-8 输入下与上式逐点相等），故对输入
 * 线性——input/output 可先各自求和再代入，结果一致。对合法 UTF-8，
 * byteCount ≥ charCount 恒成立，clamp 只是对异常输入的防御。
 *
 * 相比裸字节权重：CJK 每字符 3 字节但 ≈1 token，裸字节会把 CJK 相对
 * ASCII 高估约 3 倍；本估算把这一偏差收敛到更接近真实 BPE 的比例。
 */
export function estimateTokensFromLengths(charCount: number, byteCount: number): number {
  const safeCharCount = Number.isFinite(charCount) && charCount > 0 ? charCount : 0
  const safeByteCount = Number.isFinite(byteCount) && byteCount > 0 ? byteCount : 0
  const nonAsciiChars = Math.max(0, (safeByteCount - safeCharCount) / 2)
  const asciiChars = Math.max(0, safeCharCount - nonAsciiChars)
  return asciiChars / 4 + nonAsciiChars
}

/** 累加计数器：Map<工具名, 数值>。 */
function addCounterValue(
  counterByTool: Map<string, number>,
  tool: string,
  amount: number,
): void {
  counterByTool.set(tool, (counterByTool.get(tool) ?? 0) + amount)
}

/**
 * 对一步内 k 个（去重后）条目做最大余数取整分摊，保证
 * Σ 结果 tokens === stepTokens（整数守恒）。浮点 raw 先 floor，剩余
 * deficit 按小数部分从大到小 +1，平局按工具名升序稳定。
 */
function allocateStepTokens(
  entryWeights: Array<{ name: string; weight: number }>,
  stepTokens: number,
): ToolTokenAllocation[] {
  const flooredEntries = entryWeights.map((entry) => {
    const rawTokens = stepTokens * entry.weight
    const flooredTokens = Math.floor(rawTokens)
    return {
      name: entry.name,
      tokens: flooredTokens,
      remainder: rawTokens - flooredTokens,
    }
  })

  let deficit = stepTokens - flooredEntries.reduce((sum, entry) => sum + entry.tokens, 0)
  // 余数从大到小 +1；平局按工具名升序（稳定、确定性）。
  const byRemainderDesc = [...flooredEntries].sort(
    (left, right) =>
      right.remainder - left.remainder ||
      (left.name < right.name ? -1 : left.name > right.name ? 1 : 0),
  )
  for (const entry of byRemainderDesc) {
    if (deficit <= 0) break
    entry.tokens += 1
    deficit -= 1
  }
  // 浮点极端下 deficit 理论上不会超过条目数；若超过，把剩余全给首个
  // （工具名最小）条目，保证整数守恒不被破坏。
  if (deficit > 0 && byRemainderDesc.length > 0) {
    byRemainderDesc[0].tokens += deficit
  }

  return flooredEntries.map((entry) => ({ name: entry.name, tokens: entry.tokens }))
}

/**
 * 把逐步样本聚合成每工具归因行，按 tokens 降序、tool 名升序稳定排序
 * （与样本插入顺序无关）。整数守恒：Σ 全部行 tokens === Σ 全部步 token。
 */
export function computeToolTokens(samples: ToolTokenSample[]): ToolTokenStat[] {
  const tokensByTool = new Map<string, number>()
  const stepsByTool = new Map<string, number>()
  let grandTokens = 0

  for (const sample of samples) {
    const stepTokens = totalUsageTokens(sample.tokens)
    grandTokens += stepTokens

    // 同一步内按去重工具名先求和估算权重（同一工具多次出现 → 先合并再加权）。
    const weightByToolInStep = new Map<string, number>()
    for (const tool of sample.tools) {
      if (tool.name === "") continue
      const weight = estimateTokensFromLengths(tool.charCount, tool.byteCount)
      addCounterValue(weightByToolInStep, tool.name, weight)
    }

    if (weightByToolInStep.size === 0) {
      // 零工具步：整步 token 归「无工具」桶。
      addCounterValue(tokensByTool, "", stepTokens)
      addCounterValue(stepsByTool, "", 1)
      continue
    }

    const totalStepWeight = [...weightByToolInStep.values()].reduce(
      (sum: number, weight: number) => sum + weight,
      0,
    )
    // Σweight == 0 → 等权 1/k；否则按估算权重。
    const entryWeights = [...weightByToolInStep.entries()].map(([name, weight]) => ({
      name,
      weight:
        totalStepWeight > 0 ? weight / totalStepWeight : 1 / weightByToolInStep.size,
    }))

    for (const allocation of allocateStepTokens(entryWeights, stepTokens)) {
      addCounterValue(tokensByTool, allocation.name, allocation.tokens)
    }
    for (const toolName of weightByToolInStep.keys()) {
      addCounterValue(stepsByTool, toolName, 1)
    }
  }

  const toolTokenStats: ToolTokenStat[] = []
  for (const [tool, tokens] of tokensByTool) {
    toolTokenStats.push({
      tool,
      tokens,
      share: grandTokens > 0 ? tokens / grandTokens : 0,
      steps: stepsByTool.get(tool) ?? 0,
    })
  }

  toolTokenStats.sort(
    (left: ToolTokenStat, right: ToolTokenStat) =>
      right.tokens - left.tokens ||
      (left.tool < right.tool ? -1 : left.tool > right.tool ? 1 : 0),
  )
  return toolTokenStats
}

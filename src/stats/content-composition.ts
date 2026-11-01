/**
 * 会话内容构成（A4）for GET /api/content-composition. Pure functions,
 * zero IO; style mirrors tool-tokens.ts / token-ledger.ts.
 *
 * 口径（冻结，合同 §5.2 点 1）：
 * - 单位是**字符量**（`length()`，code point），**不是 token 量**。真实
 *   token 无法归因到内容分类（会话侧只有每消息聚合的 `$.tokens.*`），
 *   唯一许可的估算 `tokenWeight` 只授权给工具输入/输出那一条 🟡。
 *   故**不得**出现「每分类 token 数」，toolEstimatedTokens 是全量唯一的
 *   推算值，且只标注工具输入+输出两类。
 * - 六分类（key 白名单，恒定出现、按 chars desc + key asc 排序）：
 *     assistantText —— assistant content[] 中 type='text' 的 `text` 字符量
 *     toolOutput    —— 工具 part 输出文本的字符量（state.metadata.output
 *                      或 state.content[] 各 text 块 "\n\n" 拼接）
 *     toolInput     —— 工具 part `state.input` 的字符量（对象/数组为其紧凑
 *                      JSON 文本，字符串为其值本身）
 *     reasoning     —— assistant content[] 中 type='reasoning' 的 `text` 字符量
 *     userText      —— 非 assistant 文本（user / synthetic / system /
 *                      compaction）的字符量：`$.text` 否则 `$.summary`
 *     other         —— assistant content[] 中既非 text / reasoning / tool 的
 *                      part 的 `$.text` 字符量（真库为 0，留作未来 part 类型）
 * - totalChars = 六分类之和；share = chars / totalChars（totalChars 0 → 0，
 *   绝不编造 1）。
 * - sessions = 出现过的会话数（样本里去重后的 sessionId 计数）。
 * - toolEstimatedTokens = estimateTokensFromLengths(Σ工具字符, Σ工具字节)，
 *   与 tool-tokens 端点同一自包含分词估算（🟡，只作量级参考）。
 * - 后端只返回原始数字，不做四舍五入（精度标签在前端）。
 */

import { estimateTokensFromLengths } from "./tool-tokens.ts"

/**
 * 六分类 key 白名单（恒定出现，与前端 mock / 图例一一对应）。
 * 顺序本身不决定 wire 顺序——wire 顺序由 chars desc + key asc 的
 * 确定性比较器给出。
 */
export const CONTENT_COMPOSITION_CATEGORY_KEYS = [
  "assistantText",
  "toolOutput",
  "toolInput",
  "reasoning",
  "userText",
  "other",
] as const

export type ContentCompositionCategoryKey = (typeof CONTENT_COMPOSITION_CATEGORY_KEYS)[number]

/**
 * 一条内容构成样本（查询层原样抽出，无派生值）。
 *
 * 查询层对 assistant parts 扫描 / 非 assistant 文本扫描各按 session_id
 * 归组，两次扫描 UNION ALL 成同一形状的行：一行 = 一个会话的原始字符量。
 * 同一会话可能在两半各出现一次，故 stat 侧按 sessionId 去重计 sessions。
 */
export interface ContentCompositionSample {
  sessionId: string
  /** assistant content[] type='text' 的 `text` 字符量。 */
  assistantTextChars: number
  /** assistant content[] type='reasoning' 的 `text` 字符量。 */
  reasoningChars: number
  /** 工具 part `state.input` 的字符量（对象/数组为紧凑 JSON 文本）。 */
  toolInputChars: number
  /** 工具 part 输出的字符量（metadata.output 或 content[] text 拼接）。 */
  toolOutputChars: number
  /** 工具 part `state.input` 的 UTF-8 字节量（供估算权重用）。 */
  toolInputBytes: number
  /** 工具 part 输出的 UTF-8 字节量（供估算权重用）。 */
  toolOutputBytes: number
  /** 其余 assistant part（非 text/reasoning/tool）的 `text` 字符量。 */
  otherChars: number
  /** 非 assistant 文本（user/synthetic/system/compaction）字符量。 */
  nonAssistantTextChars: number
}

/** 一条构成分类行 of GET /api/content-composition. */
export interface ContentCompositionCategory {
  key: ContentCompositionCategoryKey
  /** 该分类的字符量（code point）。 */
  chars: number
  /** chars / totalChars，raw 0..1 分数；totalChars 0 → 0。 */
  share: number
}

/** Payload for GET /api/content-composition. */
export interface ContentCompositionStats {
  /** 六分类字符量之和。 */
  totalChars: number
  /** 六分类恒定出现，按 chars desc + key asc。 */
  categories: ContentCompositionCategory[]
  /** 🟡 工具输入+输出的自包含分词估算（estimateTokensFromLengths）。 */
  toolEstimatedTokens: number
  /** 出现过的会话数（样本 sessionId 去重）。 */
  sessions: number
}

/**
 * 把每会话样本聚合成 { totalChars, categories, toolEstimatedTokens,
 * sessions }（纯函数、确定性）。空输入返回全零、六分类恒在（share 0）、
 * 估算 0、会话 0。
 */
export function computeContentComposition(
  samples: ContentCompositionSample[],
): ContentCompositionStats {
  let assistantTextChars = 0
  let reasoningChars = 0
  let toolInputChars = 0
  let toolOutputChars = 0
  let toolInputBytes = 0
  let toolOutputBytes = 0
  let otherChars = 0
  let userTextChars = 0
  const sessionIds = new Set<string>()

  for (const sample of samples) {
    assistantTextChars += sample.assistantTextChars
    reasoningChars += sample.reasoningChars
    toolInputChars += sample.toolInputChars
    toolOutputChars += sample.toolOutputChars
    toolInputBytes += sample.toolInputBytes
    toolOutputBytes += sample.toolOutputBytes
    otherChars += sample.otherChars
    userTextChars += sample.nonAssistantTextChars
    if (sample.sessionId !== "") sessionIds.add(sample.sessionId)
  }

  const charsByKey: Record<ContentCompositionCategoryKey, number> = {
    assistantText: assistantTextChars,
    toolOutput: toolOutputChars,
    toolInput: toolInputChars,
    reasoning: reasoningChars,
    userText: userTextChars,
    other: otherChars,
  }
  const totalChars =
    assistantTextChars +
    reasoningChars +
    toolInputChars +
    toolOutputChars +
    otherChars +
    userTextChars

  const categories: ContentCompositionCategory[] = CONTENT_COMPOSITION_CATEGORY_KEYS.map(
    (key) => ({
      key,
      chars: charsByKey[key],
      share: totalChars === 0 ? 0 : charsByKey[key] / totalChars,
    }),
  )
  categories.sort(
    (left, right) =>
      right.chars - left.chars || (left.key < right.key ? -1 : left.key > right.key ? 1 : 0),
  )

  return {
    totalChars,
    categories,
    // 🟡 估算只覆盖工具输入+输出（合同 §5.2 点 1）；只作量级参考。
    toolEstimatedTokens: estimateTokensFromLengths(
      toolInputChars + toolOutputChars,
      toolInputBytes + toolOutputBytes,
    ),
    sessions: sessionIds.size,
  }
}

/**
 * 记账守恒（A1）for GET /api/token-ledger. Pure functions, zero IO;
 * style mirrors tool-tokens.ts / session-outcome.ts.
 *
 * 口径（冻结）：
 * - 输入是查询层抽出的「每会话一行」样本：message 侧 token 三分解
 *   （promptInput / promptCacheRead / promptCacheWrite）与 output /
 *   reasoning，外加 session_v2 的对照列（v2Input / v2CacheRead /
 *   v2CacheWrite / v2Output）。
 * - promptTotal = promptInput + promptCacheRead + promptCacheWrite
 *   （message 侧 prompt 三分之和）。
 * - cacheHitRate = promptCacheRead / promptTotal；promptTotal === 0 → null。
 * - conservation（**真正的完整性校验**）：只有异常计数与 balanced，
 *   balanced = 两个异常计数均为 0。跨源对照绝**不**参与这一判定：
 *     negativeComponents = 任一 token 分量（message 侧 5 个 + v2 侧 4 个）
 *       为负的会话数；
 *     cacheReadExceedsPrompt = 该会话 promptCacheRead > promptTotal 的
 *       会话数（命中率 > 1，即 100% 之上）。
 * - reconciliation（**仅信息性，绝不是 pass/fail**）：把 message 侧总量与
 *   session_v2 对照总量相减：
 *     messageSideTotal = Σ promptTotal
 *     sessionTableTotal = Σ(v2Input + v2CacheRead + v2CacheWrite)
 *     residualTokens = sessionTableTotal - messageSideTotal
 *     residualRatio = sessionTableTotal === 0 ? null : residualTokens / sessionTableTotal
 *   偏差点来自压缩：session_v2 保留被 compaction 从上下文裁掉的历史，故
 *   message 侧通常 ≤ session 表侧，**跨源比较天然不可能相等**。因此
 *   withinTolerance 只是一个中性提示（|residualRatio| <= tolerance），
 *   超差不代表记账异常。
 * - 排序：promptTotal desc，sessionId asc（确定性，与插入顺序无关）。
 *
 * 后端只返回原始数字，不做四舍五入 / 格式化（精度标签在前端）。
 */

/**
 * 跨源对照（信息性）的容差：|residualRatio| 在此之内仅表示「与
 * session_v2 接近」，不参与 balanced 判定。
 */
export const TOKEN_LEDGER_RECONCILIATION_TOLERANCE = 0.02

/** 一条每会话 ledger 样本（查询层原样抽出，无派生值）。 */
export interface TokenLedgerSample {
  sessionId: string
  /** 该会话 assistant 行数。 */
  messages: number
  /** Σ session_message.data.$.tokens.input。 */
  promptInput: number
  /** Σ session_message.data.$.tokens.cache.read。 */
  promptCacheRead: number
  /** Σ session_message.data.$.tokens.cache.write。 */
  promptCacheWrite: number
  /** Σ session_message.data.$.tokens.output。 */
  output: number
  /** Σ session_message.data.$.tokens.reasoning。 */
  reasoning: number
  /** session_v2.tokens_input（对照列）。 */
  v2Input: number
  /** session_v2.tokens_cache_read（对照列）。 */
  v2CacheRead: number
  /** session_v2.tokens_cache_write（对照列）。 */
  v2CacheWrite: number
  /** session_v2.tokens_output（对照列）。 */
  v2Output: number
}

/** 一条会话 ledger 行 of GET /api/token-ledger（含派生 promptTotal / 命中率）。 */
export interface TokenLedgerSessionStat {
  sessionId: string
  messages: number
  promptInput: number
  promptCacheRead: number
  promptCacheWrite: number
  /** promptInput + promptCacheRead + promptCacheWrite。 */
  promptTotal: number
  output: number
  reasoning: number
  /** promptCacheRead / promptTotal，raw 0..1 分数；promptTotal 0 → null。 */
  cacheHitRate: number | null
  v2Input: number
  v2CacheRead: number
  v2CacheWrite: number
  v2Output: number
}

/** 全会话汇总 of GET /api/token-ledger. */
export interface TokenLedgerTotals {
  promptInput: number
  promptCacheRead: number
  promptCacheWrite: number
  /** promptInput + promptCacheRead + promptCacheWrite。 */
  promptTotal: number
  output: number
  reasoning: number
  /** promptCacheRead / promptTotal，raw 0..1 分数；promptTotal 0 → null。 */
  cacheHitRate: number | null
  /** 纳入统计的会话数（= 样本行数）。 */
  sessions: number
}

/**
 * 记账完整性校验（**pass/fail**）：只看异常计数，跨源对照不参与。
 * balanced = 两个异常计数均为 0。
 */
export interface TokenLedgerConservation {
  anomalies: {
    /** 任一 token 分量为负的会话数。 */
    negativeComponents: number
    /** promptCacheRead > promptTotal（命中率 > 100%）的会话数。 */
    cacheReadExceedsPrompt: number
  }
  /** negativeComponents === 0 && cacheReadExceedsPrompt === 0。 */
  balanced: boolean
}

/**
 * message 侧账 vs session_v2 对照账的**信息性**跨源对照，绝不是
 * pass/fail：session_v2 含被 compaction 剪掉的历史，message 侧必然
 * 偏小，超差是已知差值而非异常。
 */
export interface TokenLedgerReconciliation {
  /** sessionTableTotal - messageSideTotal（message 侧偏小时为正）。 */
  residualTokens: number
  /** residualTokens / sessionTableTotal；sessionTableTotal 0 → null。 */
  residualRatio: number | null
  /** |residualRatio| <= tolerance（residualRatio null → false）。 */
  withinTolerance: boolean
  /** TOKEN_LEDGER_RECONCILIATION_TOLERANCE（0.02）。 */
  tolerance: number
}

/** Payload for GET /api/token-ledger. */
export interface TokenLedgerStats {
  totals: TokenLedgerTotals
  /** 记账完整性（pass/fail）。 */
  conservation: TokenLedgerConservation
  /** 跨源对照（信息性）。 */
  reconciliation: TokenLedgerReconciliation
  /** 每会话一行，promptTotal desc + sessionId asc。 */
  sessions: TokenLedgerSessionStat[]
}

/** 判定一条样本的任一 token 分量是否为负（message 侧 5 个 + v2 侧 4 个）。 */
function hasNegativeComponent(sample: TokenLedgerSample): boolean {
  return (
    sample.promptInput < 0 ||
    sample.promptCacheRead < 0 ||
    sample.promptCacheWrite < 0 ||
    sample.output < 0 ||
    sample.reasoning < 0 ||
    sample.v2Input < 0 ||
    sample.v2CacheRead < 0 ||
    sample.v2CacheWrite < 0 ||
    sample.v2Output < 0
  )
}

/**
 * 把每会话样本聚合成 totals / conservation / reconciliation / sessions
 * （纯函数、确定性）。空输入返回零 totals、balanced true、residualRatio
 * null 与空 sessions。
 */
export function computeTokenLedger(samples: TokenLedgerSample[]): TokenLedgerStats {
  const sessionStats: TokenLedgerSessionStat[] = []
  let promptInput = 0
  let promptCacheRead = 0
  let promptCacheWrite = 0
  let output = 0
  let reasoning = 0
  let sessionTableTotal = 0
  let negativeComponents = 0
  let cacheReadExceedsPrompt = 0

  for (const sample of samples) {
    const promptTotal =
      sample.promptInput + sample.promptCacheRead + sample.promptCacheWrite
    if (hasNegativeComponent(sample)) negativeComponents += 1
    if (sample.promptCacheRead > promptTotal) cacheReadExceedsPrompt += 1

    sessionStats.push({
      sessionId: sample.sessionId,
      messages: sample.messages,
      promptInput: sample.promptInput,
      promptCacheRead: sample.promptCacheRead,
      promptCacheWrite: sample.promptCacheWrite,
      promptTotal,
      output: sample.output,
      reasoning: sample.reasoning,
      cacheHitRate: promptTotal === 0 ? null : sample.promptCacheRead / promptTotal,
      v2Input: sample.v2Input,
      v2CacheRead: sample.v2CacheRead,
      v2CacheWrite: sample.v2CacheWrite,
      v2Output: sample.v2Output,
    })

    promptInput += sample.promptInput
    promptCacheRead += sample.promptCacheRead
    promptCacheWrite += sample.promptCacheWrite
    output += sample.output
    reasoning += sample.reasoning
    sessionTableTotal += sample.v2Input + sample.v2CacheRead + sample.v2CacheWrite
  }

  const promptTotal = promptInput + promptCacheRead + promptCacheWrite
  const messageSideTotal = promptTotal
  const residualTokens = sessionTableTotal - messageSideTotal
  const residualRatio = sessionTableTotal === 0 ? null : residualTokens / sessionTableTotal
  const withinTolerance =
    residualRatio !== null && Math.abs(residualRatio) <= TOKEN_LEDGER_RECONCILIATION_TOLERANCE
  // 完整性只看异常计数：跨源对照（residualRatio）天然受 compaction 影响，
  // 绝不作为 pass/fail 门。
  const balanced = negativeComponents === 0 && cacheReadExceedsPrompt === 0

  sessionStats.sort(
    (left: TokenLedgerSessionStat, right: TokenLedgerSessionStat) =>
      right.promptTotal - left.promptTotal ||
      (left.sessionId < right.sessionId ? -1 : left.sessionId > right.sessionId ? 1 : 0),
  )

  return {
    totals: {
      promptInput,
      promptCacheRead,
      promptCacheWrite,
      promptTotal,
      output,
      reasoning,
      cacheHitRate: promptTotal === 0 ? null : promptCacheRead / promptTotal,
      sessions: samples.length,
    },
    conservation: {
      anomalies: { negativeComponents, cacheReadExceedsPrompt },
      balanced,
    },
    reconciliation: {
      residualTokens,
      residualRatio,
      withinTolerance,
      tolerance: TOKEN_LEDGER_RECONCILIATION_TOLERANCE,
    },
    sessions: sessionStats,
  }
}

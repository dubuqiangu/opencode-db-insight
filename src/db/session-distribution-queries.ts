/**
 * SQL 侧查询：三个「全部会话」分布端点（v0.20.0 tokens + v0.21.0
 * 步数 / 时长）+ 子会话占比端点（v0.21.0）。
 *
 * 口径：
 * - GET /api/session-distribution（v0.20.0）：每会话 tokens 三列合计
 *   （input + output + cache_read）——与 /api/sessions 列表 Tokens 列
 *   同一折叠口径。COALESCE 按列兜底 NULL 再相加，镜像
 *   parseSessionSummaryRow 的 coerceNumber(NULL → 0) + 逐值相加；
 *   WHERE … > 0 排除 tokens 全 0 的会话（契约），也在 SQL 侧就砍掉了
 *   空转行。
 * - GET /api/step-distribution（v0.21.0）：每会话步数 = session_message
 *   中 type='assistant' 的行数（无 JSON 谓词，纯行计数——与列表富化
 *   stepCount 同口径）。GROUP BY 天然只产出「至少一条 assistant 行」的
 *   会话，零步会话不进分布（与分布「仅正值」纪律一致）。
 * - GET /api/duration-distribution（v0.21.0）：每会话墙钟时长（毫秒）
 *   = time_updated - time_created，仅取 time_updated > time_created 的
 *   正值会话（回拨 / 缺列的行被 WHERE 排除）。桶值 / 分位用毫秒原始值，
 *   前端 formatDuration 负责人类可读——与 token 分布「不预换算单位」
 *   纪律一致。
 * - GET /api/child-share（v0.21.0）：父子结构 tokens 占比。tokens 三列
 *   合计口径与上一致（COALESCE 兜底）；childSessionCount / rootSessionCount
 *   按 parent_id 是否 NULL 划分；childShare = childTokens / totalTokens
 *   （totalTokens 为 0 时为 0）。topChildTrees 按「直接子代 tokens 合计」
 *   降序 top5，只做一层直接子代（与 SessionSummary.childSessionCount 同
 *   一不做递归树纪律）。
 *
 * SQL 侧对结构列做算术是既有纪律（directory-queries：opencode writer
 * 恒写数值的结构列；勿复制到 message JSON 数据上）。step 计数只做
 * type 等值谓词、零 JSON 解析，与列表富化的轻查询同款。
 *
 * 「全部会话」口径：三个分布端点都不吃 ?session= 参数（传入即忽略）。
 *
 * 返回 null 当且仅当 db 连接缺失（API 层统一答 503）；空库 / 全 0 会话
 * 返回零载荷（totalSessions 0），不是 null——与 tokens 端点同惯例。
 */

import type { ChildShareStats, SqliteReadConnection } from "./types.ts"
import { asRecord, coerceNumber, coerceText } from "./rows.ts"
import {
  computeNumericDistribution,
  computeSessionTokenDistribution,
  type NumericDistributionStats,
} from "../stats/session-distribution.ts"

/** tokens 三列合计的 SQL 表达式（三个端点 / 列表 Tokens 列同款折叠）。 */
const TOKENS_TOTAL_EXPRESSION =
  "COALESCE(tokens_input, 0) + COALESCE(tokens_output, 0) + COALESCE(tokens_cache_read, 0)"

/**
 * 会话 tokens 总量分布（v0.20.0）。返回 null 当且仅当 db 连接缺失；
 * 空库 / 全 0 会话返回零载荷（totalSessions 0），不是 null。
 */
export function querySessionTokenDistribution(
  db: SqliteReadConnection | null,
): NumericDistributionStats | null {
  if (db === null) return null
  const rawRows = db
    .prepare(
      `SELECT ${TOKENS_TOTAL_EXPRESSION} AS tokens_total
       FROM session_v2
       WHERE ${TOKENS_TOTAL_EXPRESSION} > 0`,
    )
    .all()

  const sessionTokenTotals: number[] = []
  for (const rawRow of rawRows) {
    const rowRecord = asRecord(rawRow)
    if (rowRecord === null) continue
    sessionTokenTotals.push(coerceNumber(rowRecord["tokens_total"]))
  }
  return computeSessionTokenDistribution(sessionTokenTotals)
}

/**
 * 会话步数分布（v0.21.0）：每会话 assistant 消息行数。GROUP BY 只产出
 * 有步数的会话（零步会话在 SQL 侧就消失），与分布「仅正值」纪律一致。
 *
 * 「全部会话口径」以 session_v2 为准：`session_id IN (SELECT id FROM
 * session_v2)` 把孤儿消息（会话已删、消息残留）排除在外，与 token / 时长
 * 分布（都 FROM session_v2）和列表富化（分页会话来自 session_v2）同锚。
 * 真库孤儿为 0，此约束不改变当前输出，只防未来不一致。
 */
export function queryStepDistribution(
  db: SqliteReadConnection | null,
): NumericDistributionStats | null {
  if (db === null) return null
  const rawRows = db
    .prepare(
      `SELECT COUNT(*) AS step_count
       FROM session_message
       WHERE type = 'assistant'
         AND session_id IN (SELECT id FROM session_v2)
       GROUP BY session_id`,
    )
    .all()

  const sessionStepCounts: number[] = []
  for (const rawRow of rawRows) {
    const rowRecord = asRecord(rawRow)
    if (rowRecord === null) continue
    sessionStepCounts.push(coerceNumber(rowRecord["step_count"]))
  }
  return computeNumericDistribution(sessionStepCounts)
}

/**
 * 会话墙钟时长分布（v0.21.0，毫秒）。WHERE time_updated > time_created
 * 在 SQL 侧排除回拨 / 缺列 / 0 时间戳的行（真库 950/964 正值）。
 */
export function queryDurationDistribution(
  db: SqliteReadConnection | null,
): NumericDistributionStats | null {
  if (db === null) return null
  const rawRows = db
    .prepare(
      `SELECT time_updated - time_created AS duration_ms
       FROM session_v2
       WHERE time_updated > time_created`,
    )
    .all()

  const sessionDurationsMs: number[] = []
  for (const rawRow of rawRows) {
    const rowRecord = asRecord(rawRow)
    if (rowRecord === null) continue
    sessionDurationsMs.push(coerceNumber(rowRecord["duration_ms"]))
  }
  return computeNumericDistribution(sessionDurationsMs)
}

/** topChildTrees 榜长（契约：top5）。 */
const TOP_CHILD_TREES_LIMIT = 5

/**
 * 子会话占比（v0.21.0）。整体归总 + top5 直接子代树两条 SQL；父会话的
 * title / agent 按 id 点查（榜上每个父会话补自己的标题与 agent）。
 */
export function queryChildShare(db: SqliteReadConnection | null): ChildShareStats | null {
  if (db === null) return null

  const overallRow = db
    .prepare(
      `SELECT COUNT(*) AS total_sessions,
              COALESCE(SUM(CASE WHEN parent_id IS NOT NULL THEN 1 ELSE 0 END), 0)
                AS child_session_count,
              COALESCE(SUM(CASE WHEN parent_id IS NULL THEN 1 ELSE 0 END), 0)
                AS root_session_count,
              COALESCE(SUM(CASE WHEN parent_id IS NOT NULL
                                THEN ${TOKENS_TOTAL_EXPRESSION} ELSE 0 END), 0)
                AS child_tokens,
              COALESCE(SUM(${TOKENS_TOTAL_EXPRESSION}), 0) AS total_tokens
       FROM session_v2`,
    )
    .get()
  const overallRecord = asRecord(overallRow)
  // 空库：COUNT(*) 恒返回一行（total_sessions 0），asRecord 失败只在
  // 连接损坏这类异常场景，按零载荷兜底。
  const totalSessions = overallRecord === null ? 0 : coerceNumber(overallRecord["total_sessions"])
  const childSessionCount =
    overallRecord === null ? 0 : coerceNumber(overallRecord["child_session_count"])
  const rootSessionCount =
    overallRecord === null ? 0 : coerceNumber(overallRecord["root_session_count"])
  const childTokens = overallRecord === null ? 0 : coerceNumber(overallRecord["child_tokens"])
  const totalTokens = overallRecord === null ? 0 : coerceNumber(overallRecord["total_tokens"])
  const rootTokens = totalTokens - childTokens

  // 直接子代归总：只做一层直接子代（不做递归树，与列表富化同一纪律），
  // 按直接子代 tokens 合计降序，parent_id ASC 决胜——榜单确定性。
  const topChildTreeRows = db
    .prepare(
      `SELECT parent_id AS session_id,
              COUNT(*) AS child_session_count,
              COALESCE(SUM(${TOKENS_TOTAL_EXPRESSION}), 0) AS child_tokens
       FROM session_v2
       WHERE parent_id IS NOT NULL
       GROUP BY parent_id
       ORDER BY child_tokens DESC, session_id ASC
       LIMIT ${TOP_CHILD_TREES_LIMIT}`,
    )
    .all()

  const topChildTreeParents: string[] = []
  const topChildTreeRowsByParentId = new Map<string, { childSessionCount: number; tokens: number }>()
  for (const rawRow of topChildTreeRows) {
    const rowRecord = asRecord(rawRow)
    if (rowRecord === null) continue
    const parentSessionId = coerceText(rowRecord["session_id"])
    if (parentSessionId === "") continue
    topChildTreeParents.push(parentSessionId)
    topChildTreeRowsByParentId.set(parentSessionId, {
      childSessionCount: coerceNumber(rowRecord["child_session_count"]),
      tokens: coerceNumber(rowRecord["child_tokens"]),
    })
  }

  // 父会话自身的 title / agent 点查（榜上每项补这两个展示字段）。
  const parentTitleBySessionId = new Map<string, string>()
  const parentAgentBySessionId = new Map<string, string>()
  if (topChildTreeParents.length > 0) {
    const parentIdFilterSql = `id IN (${topChildTreeParents.map(() => "?").join(", ")})`
    const parentRows = db
      .prepare(
        `SELECT id, title, agent
         FROM session_v2
         WHERE ${parentIdFilterSql}`,
      )
      .all(...topChildTreeParents)
    for (const rawRow of parentRows) {
      const rowRecord = asRecord(rawRow)
      if (rowRecord === null) continue
      const parentSessionId = coerceText(rowRecord["id"])
      if (parentSessionId === "") continue
      parentTitleBySessionId.set(parentSessionId, coerceText(rowRecord["title"]))
      parentAgentBySessionId.set(parentSessionId, coerceText(rowRecord["agent"]))
    }
  }

  const topChildTrees = topChildTreeParents.map((parentSessionId) => {
    const childTreeRow = topChildTreeRowsByParentId.get(parentSessionId)!
    return {
      sessionId: parentSessionId,
      title: parentTitleBySessionId.get(parentSessionId) ?? "",
      agent: parentAgentBySessionId.get(parentSessionId) ?? "",
      tokens: childTreeRow.tokens,
      childSessionCount: childTreeRow.childSessionCount,
    }
  })

  return {
    totalSessions,
    childSessionCount,
    rootSessionCount,
    childTokens,
    rootTokens,
    totalTokens,
    childShare: totalTokens === 0 ? 0 : childTokens / totalTokens,
    topChildTrees,
  }
}
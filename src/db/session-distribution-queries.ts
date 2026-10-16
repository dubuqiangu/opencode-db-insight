/**
 * SQL 侧查询：GET /api/session-distribution（v0.20.0）。
 *
 * 口径：每会话 tokens 三列合计（input + output + cache_read）——与
 * /api/sessions 列表 Tokens 列同一折叠口径。COALESCE 按列兜底 NULL
 * 再相加，镜像 parseSessionSummaryRow 的 coerceNumber(NULL → 0) +
 * 逐值相加；WHERE … > 0 排除 tokens 全 0 的会话（契约），也在 SQL
 * 侧就砍掉了空转行。SQL 侧对这三列做算术是既有纪律（directory-
 * queries：opencode writer 恒写数值的结构列；勿复制到 message
 * JSON 数据上）。
 *
 * 「全部会话」口径：本端点不吃 ?session= 参数（传入即忽略）。
 */

import type { SqliteReadConnection } from "./types.ts"
import { asRecord, coerceNumber } from "./rows.ts"
import {
  computeSessionTokenDistribution,
  type TokenDistributionStats,
} from "../stats/session-distribution.ts"

/**
 * 会话 tokens 总量分布。返回 null 当且仅当 db 连接缺失（API 层统一
 * 答 503）；空库 / 全 0 会话返回零载荷（totalSessions 0），不是 null。
 */
export function querySessionTokenDistribution(
  db: SqliteReadConnection | null,
): TokenDistributionStats | null {
  if (db === null) return null
  const sessionTokensExpression =
    "COALESCE(tokens_input, 0) + COALESCE(tokens_output, 0) + COALESCE(tokens_cache_read, 0)"
  const rawRows = db
    .prepare(
      `SELECT ${sessionTokensExpression} AS tokens_total
       FROM session_v2
       WHERE ${sessionTokensExpression} > 0`,
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

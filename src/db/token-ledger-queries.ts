/**
 * SQL-side query for GET /api/token-ledger (A1 记账守恒): one row per
 * session_v2 session, pairing the message-level token decomposition with
 * the session-table 对照列.
 *
 * 口径（冻结）：本文件只做「每会话一行」的原样抽取，聚合与守恒校验全部
 * 落在纯函数 computeTokenLedger（src/stats/token-ledger.ts）。
 *
 * - 驱动表是 session_v2（每会话恰一行，含零 assistant 行的会话）：
 *   LEFT JOIN 一个按 session_id 归总的 session_message 子查询；
 * - message 侧子查询锚定 session_v2（SESSION_V2_ANCHOR_PREDICATE_SQL），
 *   把「会话已删、消息残留」的孤儿消息排除在外，assistant 过滤用共享
 *   ASSISTANT_OBJECT_DATA_PREDICATE；
 * - 每个 token 标量走 json_extract（与模型排行榜 usage_fields 同形状）；
 * - session_v2 对照列直接取 tokens_input / tokens_cache_read /
 *   tokens_cache_write / tokens_output；
 * - ?session= 过滤（buildSessionFilterSqlFragments）：非空时 message 子
 *   查询前置 `session_id = ? AND `（step 级片段，先收窄再解析 JSON），外层
 *   会话行追加 ` WHERE id = ?`（session 级片段），两个绑定值相同；
 *   缺省不过滤，片段全空，SQL 字节与全量口径一致。
 */

import type { SqliteReadConnection } from "./types.ts"
import { asRecord, coerceNumber, coerceText } from "./rows.ts"
import {
  ASSISTANT_OBJECT_DATA_PREDICATE,
  buildSessionFilterSqlFragments,
} from "./scan-conventions.ts"
import type { TokenLedgerSample } from "../stats/token-ledger.ts"

/**
 * 孤儿锚定：会话级消息扫描一律限定 session_id IN (SELECT id FROM session_v2)，
 * 与 tool-token-queries.ts / 各分布查询同锚（真库孤儿为 0，此约束只防未来
 * 不一致）。这是**无条件**口径锚定，与可选的 ?session= 过滤互相独立。
 */
const SESSION_V2_ANCHOR_PREDICATE_SQL = "session_id IN (SELECT id FROM session_v2)"

/**
 * 每会话一行的 ledger 抽取：session_v2 的会话行 LEFT JOIN 一个按
 * session_id 归总的 assistant-token 子查询。子查询只用 json_extract 取
 * token 标量（不物化消息体），SUM 后每会话一行；零 assistant 行的会话
 * COALESCE 成 0，仍出现在结果里（诚实：会话表有记录、消息侧为空）。
 */
function buildTokenLedgerSql(
  stepPredicatePrefixSql: string,
  sessionRowWhereSql: string,
): string {
  return `SELECT s.id AS session_id,
                 s.tokens_input AS v2_input,
                 s.tokens_cache_read AS v2_cache_read,
                 s.tokens_cache_write AS v2_cache_write,
                 s.tokens_output AS v2_output,
                 COALESCE(agg.message_count, 0) AS message_count,
                 COALESCE(agg.prompt_input, 0) AS prompt_input,
                 COALESCE(agg.prompt_cache_read, 0) AS prompt_cache_read,
                 COALESCE(agg.prompt_cache_write, 0) AS prompt_cache_write,
                 COALESCE(agg.output, 0) AS output,
                 COALESCE(agg.reasoning, 0) AS reasoning
          FROM session_v2 s
          LEFT JOIN (
            SELECT session_id,
                   COUNT(*) AS message_count,
                   SUM(json_extract(data, '$.tokens.input')) AS prompt_input,
                   SUM(json_extract(data, '$.tokens.cache.read')) AS prompt_cache_read,
                   SUM(json_extract(data, '$.tokens.cache.write')) AS prompt_cache_write,
                   SUM(json_extract(data, '$.tokens.output')) AS output,
                   SUM(json_extract(data, '$.tokens.reasoning')) AS reasoning
            FROM session_message
            WHERE ${stepPredicatePrefixSql}${ASSISTANT_OBJECT_DATA_PREDICATE}
              AND ${SESSION_V2_ANCHOR_PREDICATE_SQL}
            GROUP BY session_id
          ) agg ON agg.session_id = s.id${sessionRowWhereSql}`
}

/**
 * Per-session token ledger for GET /api/token-ledger. Returns null when the
 * db connection is missing (the API layer surfaces the shared 503).
 *
 * ?session= 过滤：sessionFilterId 非空时 message 子查询前置 `session_id = ?`
 * 且外层会话行追加 ` WHERE id = ?`（两个片段都来自共享构造器，绑定同一个
 * id）；缺省不过滤，SQL 字节与全量口径一致。
 */
export function queryTokenLedger(
  db: SqliteReadConnection | null,
  sessionFilterId: string | null = null,
): TokenLedgerSample[] | null {
  if (db === null) return null
  const sessionFilter = buildSessionFilterSqlFragments(sessionFilterId)
  const sessionFilterBinds =
    sessionFilter.sessionFilterId === null
      ? []
      : [sessionFilter.sessionFilterId, sessionFilter.sessionFilterId]

  const rawRows = db
    .prepare(
      buildTokenLedgerSql(
        sessionFilter.stepPredicatePrefixSql,
        sessionFilter.sessionRowWhereSql,
      ),
    )
    .all(...sessionFilterBinds)

  const tokenLedgerSamples: TokenLedgerSample[] = []
  for (const rawRow of rawRows) {
    const rowRecord = asRecord(rawRow)
    if (rowRecord === null) continue
    tokenLedgerSamples.push({
      sessionId: coerceText(rowRecord["session_id"]),
      messages: coerceNumber(rowRecord["message_count"]),
      promptInput: coerceNumber(rowRecord["prompt_input"]),
      promptCacheRead: coerceNumber(rowRecord["prompt_cache_read"]),
      promptCacheWrite: coerceNumber(rowRecord["prompt_cache_write"]),
      output: coerceNumber(rowRecord["output"]),
      reasoning: coerceNumber(rowRecord["reasoning"]),
      v2Input: coerceNumber(rowRecord["v2_input"]),
      v2CacheRead: coerceNumber(rowRecord["v2_cache_read"]),
      v2CacheWrite: coerceNumber(rowRecord["v2_cache_write"]),
      v2Output: coerceNumber(rowRecord["v2_output"]),
    })
  }
  return tokenLedgerSamples
}

/**
 * SQL-side query for GET /api/session-lineage (B6 Agent 血缘图): one row per
 * session_v2 session carrying its parent link plus display/size fields.
 *
 * 口径（冻结，合同 §5.2 点 3、§5.6）：
 * - **只读 session_v2**（不扫 session_message → 无需
 *   ASSISTANT_OBJECT_DATA_PREDICATE / SESSION_V2_ANCHOR_PREDICATE_SQL 锚定）。
 *   fork 维度**丢弃**：真库 fork_session_id / fork_boundary 1213 行全 NULL，
 *   只有 parent_id 有值（839 子节点）。
 * - 本文件只做「一行一会话」的原样抽取；环检测 / 深度 / 节点预算 / 聚焦
 *   全部落在纯函数 computeSessionLineage（src/stats/session-lineage.ts）。
 * - tokens = COALESCE(tokens_input,0)+COALESCE(tokens_output,0)+
 *   COALESCE(tokens_cache_read,0)（与 child-share 同一 v2 汇总口径）。
 * - child_count = 直接子会话数（相关子查询 COUNT，按 parent_id 计数）。
 * - **无 ?session= 过滤落点**：聚焦由纯函数按 focusSessionId 完成，扫描始终
 *   是全表（重建祖先链需要完整的父指针），故本查询不接受 sessionFilterId。
 *   路由层仍走共享 ?session= 存在性 gate（未知 id 统一 404）。
 *
 * 返回 null 当且仅当 db 连接缺失（上层统一 503）。
 */

import type { SqliteReadConnection } from "./types.ts"
import { asRecord, coerceNumber, coerceText } from "./rows.ts"
import type { SessionLineageSample } from "../stats/session-lineage.ts"

/**
 * 一行一会话的 lineage 抽取。tokens 三列是 opencode writer 恒写数值的
 * session_v2 结构列，故 SQL 侧 SUM/COALESCE 安全（与 directory-queries.ts
 * 同一类型假设，勿把该模式复制到 message 的 JSON 文本值上）。
 */
function buildSessionLineageSql(): string {
  return `SELECT s.id AS session_id,
                 s.parent_id AS parent_id,
                 s.title AS title,
                 s.agent AS agent,
                 s.time_created AS time_created,
                 COALESCE(s.tokens_input, 0) + COALESCE(s.tokens_output, 0) + COALESCE(s.tokens_cache_read, 0) AS tokens,
                 (SELECT COUNT(*) FROM session_v2 c WHERE c.parent_id = s.id) AS child_count
          FROM session_v2 s`
}

/**
 * Per-session lineage samples for GET /api/session-lineage. Returns null when
 * the db connection is missing (the API layer surfaces the shared 503).
 *
 * 缺省不过滤、无绑定参数；聚焦在纯函数侧完成（见文件头）。
 */
export function querySessionLineage(
  db: SqliteReadConnection | null,
): SessionLineageSample[] | null {
  if (db === null) return null

  const rawRows = db.prepare(buildSessionLineageSql()).all()

  const lineageSamples: SessionLineageSample[] = []
  for (const rawRow of rawRows) {
    const rowRecord = asRecord(rawRow)
    if (rowRecord === null) continue
    const sessionId = coerceText(rowRecord["session_id"])
    if (sessionId === "") continue
    const rawParentId = rowRecord["parent_id"]
    lineageSamples.push({
      sessionId,
      parentSessionId:
        rawParentId === null || rawParentId === undefined ? null : coerceText(rawParentId) || null,
      title: coerceText(rowRecord["title"]),
      agent: coerceText(rowRecord["agent"]),
      tokens: coerceNumber(rowRecord["tokens"]),
      timeCreated: coerceNumber(rowRecord["time_created"]),
      childCount: coerceNumber(rowRecord["child_count"]),
    })
  }
  return lineageSamples
}

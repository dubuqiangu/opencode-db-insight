/**
 * SQL-side query for GET /api/content-composition (A4 会话内容构成): the
 * character volume each content category accumulates across sessions.
 *
 * 口径（冻结，合同 §5.2 点 1、§5.3）：单位是**字符量**，不是 token 量。
 * 本文件只做两次锚定扫描的原样抽取，聚合 / 排序 / share 全部落在纯函数
 * computeContentComposition（src/stats/content-composition.ts）。
 *
 * - 扫描 A（assistant parts）：`FROM (SELECT session_id, data FROM
 *   session_message WHERE <步谓词>) m, json_each(m.data, '$.content') p`，
 *   按 session_id 归组。**必须**把 session_message 扫描包进子查询：
 *   json_each 自身暴露 `type` 列，裸 join 下 ASSISTANT_OBJECT_DATA_PREDICATE
 *   里未限定的 `type` 会以 "ambiguous column name: type" 响亮报错（子查询
 *   内该谓词只面对 session_message 一表，无歧义）。text / reasoning 取
 *   `$.text` 的 `length()`；tool input 取 `state.input` 的 `length()`
 *   （对象/数组 → 紧凑 JSON 文本）；tool output **复用** tool-token-queries.ts 的精确表达式
 *   （buildToolOutputTextSql，state.metadata.output 否则 state.content[]
 *   text 拼接）——两模块共享同一常量，工具输出口径不可能漂移；同时抽
 *   input/output 的 UTF-8 字节量供 🟡 估算；其余 part 类型计入 other。
 * - 扫描 B（非 assistant 文本）：`type IN ('user','synthetic','system',
 *   'compaction')`，`json_valid(data)` 守卫，文本 = `COALESCE(length($.text),
 *   length($.summary), 0)`，按 session_id 归组。
 * - 两次扫描 UNION ALL 成同一形状（一行一会话），由查询层折叠成样本数组；
 *   同一会话可能在两半各出现一次，sessions 的去重交 stat 侧处理。
 * - 两次扫描都带 ASSISTANT_OBJECT_DATA_PREDICATE（仅扫描 A）/ json_valid
 *   守卫（扫描 B）、SESSION_V2_ANCHOR_PREDICATE_SQL 锚定与
 *   buildSessionFilterSqlFragments.stepPredicatePrefixSql（?session= 前置）。
 *
 * 缺省（不过滤）时 stepPredicatePrefixSql 为空串，SQL 字节与全量口径一致；
 * 过滤时两个 UNION 分支各带一个 `session_id = ?`，绑定同一 id 两次。
 */

import type { SqliteReadConnection } from "./types.ts"
import { asRecord, coerceNumber, coerceText } from "./rows.ts"
import {
  ASSISTANT_OBJECT_DATA_PREDICATE,
  buildSessionFilterSqlFragments,
  SESSION_V2_ANCHOR_PREDICATE_SQL,
} from "./scan-conventions.ts"
import { buildToolOutputTextSql } from "./tool-part-extraction.ts"
import type { ContentCompositionSample } from "../stats/content-composition.ts"

/** assistant part 的类型表达式（json_extract on 每个 content part）。 */
const ASSISTANT_PART_TYPE_SQL = "json_extract(p.value, '$.type')"

/**
 * 两次锚定扫描的 UNION ALL。扫 A 每会话一行（assistant parts 的字符/字节
 * 量），扫 B 每会话一行（非 assistant 文本字符量、其余列恒 0）。列名取扫 A
 * 的别名，扫 B 复用同名列位置。
 */
function buildContentCompositionSql(stepPredicatePrefixSql: string): string {
  const toolOutputTextSql = buildToolOutputTextSql("p.value")
  return `SELECT m.session_id AS session_id,
                 SUM(CASE WHEN ${ASSISTANT_PART_TYPE_SQL} = 'text' THEN length(json_extract(p.value, '$.text')) ELSE 0 END) AS assistant_text_chars,
                 SUM(CASE WHEN ${ASSISTANT_PART_TYPE_SQL} = 'reasoning' THEN length(json_extract(p.value, '$.text')) ELSE 0 END) AS reasoning_chars,
                 SUM(CASE WHEN ${ASSISTANT_PART_TYPE_SQL} = 'tool' THEN length(json_extract(p.value, '$.state.input')) ELSE 0 END) AS tool_input_chars,
                 SUM(CASE WHEN ${ASSISTANT_PART_TYPE_SQL} = 'tool' THEN length(${toolOutputTextSql}) ELSE 0 END) AS tool_output_chars,
                 SUM(CASE WHEN ${ASSISTANT_PART_TYPE_SQL} = 'tool' THEN length(CAST(json_extract(p.value, '$.state.input') AS BLOB)) ELSE 0 END) AS tool_input_bytes,
                 SUM(CASE WHEN ${ASSISTANT_PART_TYPE_SQL} = 'tool' THEN length(CAST(${toolOutputTextSql} AS BLOB)) ELSE 0 END) AS tool_output_bytes,
                 SUM(CASE WHEN ${ASSISTANT_PART_TYPE_SQL} NOT IN ('text', 'reasoning', 'tool') THEN COALESCE(length(json_extract(p.value, '$.text')), 0) ELSE 0 END) AS other_chars,
                 0 AS non_assistant_text_chars
          FROM (SELECT session_id, data FROM session_message
                WHERE ${stepPredicatePrefixSql}${ASSISTANT_OBJECT_DATA_PREDICATE}
                  AND ${SESSION_V2_ANCHOR_PREDICATE_SQL}) m,
               json_each(m.data, '$.content') p
          GROUP BY m.session_id
          UNION ALL
          SELECT session_id,
                 0,
                 0,
                 0,
                 0,
                 0,
                 0,
                 0,
                 SUM(COALESCE(length(json_extract(data, '$.text')), length(json_extract(data, '$.summary')), 0)) AS non_assistant_text_chars
          FROM session_message
          WHERE ${stepPredicatePrefixSql}json_valid(data)
            AND type IN ('user', 'synthetic', 'system', 'compaction')
            AND ${SESSION_V2_ANCHOR_PREDICATE_SQL}
          GROUP BY session_id`
}

/**
 * Per-session content-volume samples for GET /api/content-composition.
 * Returns null when the db connection is missing (the API layer surfaces
 * the shared 503).
 *
 * ?session= 过滤：sessionFilterId 非空时两个 UNION 分支各前置
 * `session_id = ?`（共享片段，绑定同一 id 两次）；缺省不过滤，SQL 字节
 * 与全量口径一致。
 */
export function queryContentComposition(
  db: SqliteReadConnection | null,
  sessionFilterId: string | null = null,
): ContentCompositionSample[] | null {
  if (db === null) return null
  const sessionFilter = buildSessionFilterSqlFragments(sessionFilterId)
  const sessionFilterBinds =
    sessionFilter.sessionFilterId === null
      ? []
      : [sessionFilter.sessionFilterId, sessionFilter.sessionFilterId]

  const rawRows = db
    .prepare(buildContentCompositionSql(sessionFilter.stepPredicatePrefixSql))
    .all(...sessionFilterBinds)

  const contentCompositionSamples: ContentCompositionSample[] = []
  for (const rawRow of rawRows) {
    const rowRecord = asRecord(rawRow)
    if (rowRecord === null) continue
    contentCompositionSamples.push({
      sessionId: coerceText(rowRecord["session_id"]),
      assistantTextChars: coerceNumber(rowRecord["assistant_text_chars"]),
      reasoningChars: coerceNumber(rowRecord["reasoning_chars"]),
      toolInputChars: coerceNumber(rowRecord["tool_input_chars"]),
      toolOutputChars: coerceNumber(rowRecord["tool_output_chars"]),
      toolInputBytes: coerceNumber(rowRecord["tool_input_bytes"]),
      toolOutputBytes: coerceNumber(rowRecord["tool_output_bytes"]),
      otherChars: coerceNumber(rowRecord["other_chars"]),
      nonAssistantTextChars: coerceNumber(rowRecord["non_assistant_text_chars"]),
    })
  }
  return contentCompositionSamples
}

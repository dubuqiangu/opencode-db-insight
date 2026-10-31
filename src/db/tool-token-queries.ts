/**
 * SQL-side query for GET /api/tool-tokens: per-tool token attribution
 * (self-contained token-estimate weighting) over every assistant step's tool parts.
 *
 * 口径见 src/stats/tool-tokens.ts 文件头与 DESIGN.md §5。本文件只做
 * 「一行一 assistant 消息」的原样抽取：token 标量
 * （input/output/cache.read）与每个 content part 的
 * [type, name, tool, inputBytes, outputBytes, inputChars, outputChars]
 * 七元组；归因、取整、聚合全部落在纯函数 computeToolTokens。
 *
 * 与 tool-health-queries.ts 同一锚定与过滤纪律（step 谓词 +
 * SESSION_V2_ANCHOR_PREDICATE_SQL + 可选 ?session= 前置），但本查询不采用
 * 快路径：token 归因需要每个 part 的 state.input/state.output 规模，
 * 只有 json_each 遍历每个 part 才拿得到——快路径的多路径 json_extract
 * 换取的正是「不遍历 part」，与本查询的需求相反。
 */

import type { SqliteReadConnection } from "./types.ts"
import { asRecord, coerceNumber, coerceText, parseExtractedFieldList } from "./rows.ts"
import {
  ASSISTANT_OBJECT_DATA_PREDICATE,
  buildSessionFilterSqlFragments,
} from "./scan-conventions.ts"
import {
  computeToolTokens,
  type ToolTokenPartSize,
  type ToolTokenSample,
  type ToolTokenStat,
} from "../stats/tool-tokens.ts"

/**
 * 孤儿锚定：会话级消息扫描一律限定 session_id IN (SELECT id FROM session_v2)，
 * 把「会话已删、消息残留」的孤儿消息排除出「全部会话口径」——与
 * tool-health-queries.ts / 各分布查询同锚（真库孤儿为 0，此约束只防未来
 * 不一致）。这是**无条件**口径锚定，与可选的 ?session= 过滤互相独立。
 */
const SESSION_V2_ANCHOR_PREDICATE_SQL = "session_id IN (SELECT id FROM session_v2)"

/**
 * 每 assistant 消息一行的抽取：token 三标量 + 每个 content part 的七元组。
 *
 * - token 标量走 json_extract 多路径（与模型排行榜 usage_fields 同一形状）；
 * - part 七元组走 json_each 遍历 `$.content`，json_array 包住
 *   [type, name, tool, inputBytes, outputBytes, inputChars, outputChars]，
 *   再由 json_group_array 收成一行嵌套数组字符串（空 content → "[]"）；
 * - inputBytes / outputBytes = `length(CAST(json_extract(c.value,
 *   '$.state.input') AS BLOB))`：CAST(... AS BLOB) 取原始 UTF-8 字节，
 *   length() 对 BLOB 返回字节数；
 * - inputChars / outputChars = `length(json_extract(c.value, '$.state.input'))`：
 *   json_extract（对象/数组 → 紧凑 JSON 文本，字符串 → 其值本身），
 *   length() 对文本返回字符数（code point）；
 * - 字段缺失 → NULL → 绑定为 null（JS 侧按 0 处理）。
 *
 * 缺省（不过滤）时 stepPredicatePrefixSql 为空串，SQL 字节与全量口径
 * 逐字节一致（与其余消费 ?session= 的查询同契约）。
 */
function buildToolTokenScanSql(stepPredicatePrefixSql: string): string {
  return `SELECT json_extract(m.data, '$.tokens.input', '$.tokens.output', '$.tokens.cache.read') AS usage_fields,
              (SELECT json_group_array(json_array(
                        json_extract(c.value, '$.type'),
                        json_extract(c.value, '$.name'),
                        json_extract(c.value, '$.tool'),
                        length(CAST(json_extract(c.value, '$.state.input') AS BLOB)),
                        length(CAST(json_extract(c.value, '$.state.output') AS BLOB)),
                        length(json_extract(c.value, '$.state.input')),
                        length(json_extract(c.value, '$.state.output'))))
               FROM json_each(m.data, '$.content') c) AS tool_part_sizes
       FROM session_message m
       WHERE ${stepPredicatePrefixSql}${ASSISTANT_OBJECT_DATA_PREDICATE}
         AND ${SESSION_V2_ANCHOR_PREDICATE_SQL}`
}

/**
 * Per-tool token attribution leaderboard for GET /api/tool-tokens,
 * aggregated from one assistant scan (no message bodies or tool outputs
 * are materialized — only the character/byte counts per part). Returns null
 * when the db connection is missing (the API layer surfaces the shared
 * 503).
 *
 * 口径：全部会话、锚定 session_v2（见 SESSION_V2_ANCHOR_PREDICATE_SQL）。
 * ?session= 过滤：sessionFilterId 非空时扫描再前置 `session_id = ?`
 * （共享片段）——只统计目标会话的工具归因。缺省不过滤，SQL 字节与
 * 全量口径一致。
 */
export function queryToolTokens(
  db: SqliteReadConnection | null,
  sessionFilterId: string | null = null,
): ToolTokenStat[] | null {
  if (db === null) return null
  const sessionFilter = buildSessionFilterSqlFragments(sessionFilterId)

  const rawRows = db
    .prepare(buildToolTokenScanSql(sessionFilter.stepPredicatePrefixSql))
    .all(...(sessionFilter.sessionFilterId === null ? [] : [sessionFilter.sessionFilterId]))

  const toolTokenSamples: ToolTokenSample[] = []
  for (const rawRow of rawRows) {
    const rowRecord = asRecord(rawRow)
    if (rowRecord === null) continue
    const [inputValue, outputValue, cacheReadValue] = parseExtractedFieldList(
      rowRecord["usage_fields"],
    )
    toolTokenSamples.push({
      tokens: {
        input: coerceNumber(inputValue),
        output: coerceNumber(outputValue),
        reasoning: 0,
        cacheRead: coerceNumber(cacheReadValue),
        cacheWrite: 0,
      },
      tools: parseToolPartSizes(rowRecord["tool_part_sizes"]),
    })
  }

  return computeToolTokens(toolTokenSamples)
}

/**
 * 从 json_group_array 产物解析每 part 的规模七元组。产出一律是嵌套数组
 * （json_array 包 json_group_array），空 content → "[]"。每行取
 * [type, name, tool, inputBytes, outputBytes, inputChars, outputChars]：
 * 仅 type === "tool" 计入；name 非空优先，空则回退 legacy "tool" 键；
 * 仍空则丢弃。四个计数经 coerceNumber（NULL / 非数值 → 0），再折叠为
 * {charCount = inputChars + outputChars, byteCount = inputBytes + outputBytes}
 * （估算对输入线性，故先求和再代入与逐 part 估算求和一致）。
 */
function parseToolPartSizes(rawPartRows: unknown): ToolTokenPartSize[] {
  const partRows = parseExtractedFieldList(rawPartRows)
  const toolPartSizes: ToolTokenPartSize[] = []
  for (const partRow of partRows) {
    if (!Array.isArray(partRow)) continue
    if (coerceText(partRow[0]) !== "tool") continue
    let toolName = coerceText(partRow[1])
    if (toolName === "") toolName = coerceText(partRow[2])
    if (toolName === "") continue
    toolPartSizes.push({
      name: toolName,
      charCount: coerceNumber(partRow[5]) + coerceNumber(partRow[6]),
      byteCount: coerceNumber(partRow[3]) + coerceNumber(partRow[4]),
    })
  }
  return toolPartSizes
}

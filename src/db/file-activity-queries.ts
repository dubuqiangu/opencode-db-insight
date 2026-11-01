/**
 * SQL-side query for GET /api/file-activity (B5 文件活动): per-file read /
 * edit / write counts across sessions.
 *
 * 口径（冻结，合同 §5.2 点 2/4、§5.3）：
 * - SQL 按 `(session_id, raw_path, tool)` 归组（一行 = 一会话对一原始路径
 *   的一个工具的次数），把每个 part 的原始 `state.input.[path|filePath|
 *   file_path]` 抽成 `raw_path`；工具名取 `$.name` 否则 legacy `$.tool`。
 * - 只统计 `read` / `edit` / `write`：`grep` / `glob` / `shell` / `bash` /
 *   `patch` / `ast_grep` 一律由 WHERE 排除（合同 §5.2 点 2）。不提供「改动
 *   行数 / 文件大小」——DB 里没有这些字段。
 * - JS 侧对每条 `raw_path` 先 normalizeFilePath（`\`→`/`、折叠 `//`、去尾
 *   `/`、仅盘符首字母大写）再 applyHomeRedaction（homedir 前缀 → `~`）。
 *   同一物理路径在 `\` / `/` 两种写法、或落在 home 目录时，都归到同一个
 *   展示键，然后按展示键重新聚合。
 * - 全量聚合交给纯函数 computeFileActivity（排序 ops desc + path asc、
 *   报截断前 tabs 口径）；本层只做「按归一化路径聚合样本 → 截断 files 到
 *   夹紧后的 limit」。
 * - assistant part 扫描必须把 session_message 包进子查询：json_each 自身
 *   暴露 `type` 列，裸 join 下 ASSISTANT_OBJECT_DATA_PREDICATE 里未限定的
 *   `type` 会以 "ambiguous column name: type" 报错（与 content-composition
 *   -queries.ts 同纪律）。
 * - 会话级扫描锚定 session_v2（SESSION_V2_ANCHOR_PREDICATE_SQL）；?session=
 *   过滤用 buildSessionFilterSqlFragments.stepPredicatePrefixSql 前置，
 *   缺省片段为空串，SQL 字节与全量口径一致。
 *
 * 返回 null 当且仅当 db 连接缺失（API 层统一答 503）。
 */

import { homedir } from "node:os"

import type { SqliteReadConnection } from "./types.ts"
import { asRecord, coerceNumber, coerceText } from "./rows.ts"
import {
  ASSISTANT_OBJECT_DATA_PREDICATE,
  buildSessionFilterSqlFragments,
} from "./scan-conventions.ts"
import {
  applyHomeRedaction,
  computeFileActivity,
  MAX_FILE_ACTIVITY_LIMIT,
  normalizeFilePath,
  type FileActivitySample,
  type FileActivityStats,
} from "../stats/file-activity.ts"

/**
 * 孤儿锚定：会话级消息扫描一律限定 session_id IN (SELECT id FROM session_v2)，
 * 排除「会话已删、消息残留」的孤儿消息（真库孤儿为 0，此约束只防未来不一致）。
 * 这是**无条件**口径锚定，与可选的 ?session= 过滤互相独立。
 */
const SESSION_V2_ANCHOR_PREDICATE_SQL = "session_id IN (SELECT id FROM session_v2)"

/** 参与统计的三个文件工具（合同 §5.2 点 2 白名单）。 */
const FILE_ACTIVITY_TOOL_NAMES = "'read', 'edit', 'write'"

/**
 * 按 `(session_id, raw_path, tool)` 归组的扫描。内层子查询先收窄
 * session_message（步谓词 + 锚定），外层 json_each 遍历 `$.content`，
 * 只保留 type='tool' 的 part。
 */
function buildFileActivitySql(stepPredicatePrefixSql: string): string {
  return `SELECT session_id, raw_path, tool_name,
                 COUNT(*) AS op_count,
                 MAX(last_active_ms) AS last_active_ms
          FROM (
            SELECT m.session_id AS session_id,
                   m.time_created AS last_active_ms,
                   COALESCE(json_extract(p.value, '$.state.input.path'),
                            json_extract(p.value, '$.state.input.filePath'),
                            json_extract(p.value, '$.state.input.file_path')) AS raw_path,
                   COALESCE(json_extract(p.value, '$.name'),
                            json_extract(p.value, '$.tool')) AS tool_name
            FROM (SELECT session_id, time_created, data FROM session_message
                  WHERE ${stepPredicatePrefixSql}${ASSISTANT_OBJECT_DATA_PREDICATE}
                    AND ${SESSION_V2_ANCHOR_PREDICATE_SQL}) m,
                 json_each(m.data, '$.content') p
            WHERE json_extract(p.value, '$.type') = 'tool'
          )
          WHERE typeof(raw_path) = 'text' AND raw_path <> ''
            AND raw_path NOT LIKE '{%' AND raw_path NOT LIKE '[%'
            AND tool_name IN (${FILE_ACTIVITY_TOOL_NAMES})
          GROUP BY session_id, raw_path, tool_name`
}

/**
 * Per-file activity payload for GET /api/file-activity?limit=20[&session=].
 * Returns null when the db connection is missing (the API layer surfaces the
 * shared 503).
 *
 * homeDirectory 可注入（默认 os.homedir()）：便于测试固定脱敏前缀。
 */
export function queryFileActivity(
  db: SqliteReadConnection | null,
  limit: number,
  sessionFilterId: string | null = null,
  homeDirectory: string = homedir(),
): FileActivityStats | null {
  if (db === null) return null
  const sessionFilter = buildSessionFilterSqlFragments(sessionFilterId)

  const rawRows = db
    .prepare(buildFileActivitySql(sessionFilter.stepPredicatePrefixSql))
    .all(...(sessionFilter.sessionFilterId === null ? [] : [sessionFilter.sessionFilterId]))

  // 按归一化 + 脱敏后的展示路径重新聚合（同物理路径的 \ / 两种写法、
  // 以及 home 目录前缀都在此折叠到同一键）。
  interface PathAggregate {
    reads: number
    edits: number
    writes: number
    sessionIds: Set<string>
    lastActiveMs: number
  }
  const aggregatesByPath = new Map<string, PathAggregate>()
  for (const rawRow of rawRows) {
    const rowRecord = asRecord(rawRow)
    if (rowRecord === null) continue
    const normalizedPath = applyHomeRedaction(
      normalizeFilePath(coerceText(rowRecord["raw_path"])),
      homeDirectory,
    )
    if (normalizedPath === "") continue

    let aggregate = aggregatesByPath.get(normalizedPath)
    if (aggregate === undefined) {
      aggregate = { reads: 0, edits: 0, writes: 0, sessionIds: new Set(), lastActiveMs: 0 }
      aggregatesByPath.set(normalizedPath, aggregate)
    }
    const opCount = coerceNumber(rowRecord["op_count"])
    const toolName = coerceText(rowRecord["tool_name"])
    if (toolName === "read") aggregate.reads += opCount
    else if (toolName === "edit") aggregate.edits += opCount
    else if (toolName === "write") aggregate.writes += opCount

    const sessionId = coerceText(rowRecord["session_id"])
    if (sessionId !== "") aggregate.sessionIds.add(sessionId)

    const lastActiveMs = coerceNumber(rowRecord["last_active_ms"])
    if (lastActiveMs > aggregate.lastActiveMs) aggregate.lastActiveMs = lastActiveMs
  }

  const fileActivitySamples: FileActivitySample[] = []
  for (const [path, aggregate] of aggregatesByPath) {
    fileActivitySamples.push({
      path,
      reads: aggregate.reads,
      edits: aggregate.edits,
      writes: aggregate.writes,
      sessions: aggregate.sessionIds.size,
      lastActiveMs: aggregate.lastActiveMs,
    })
  }

  // computeFileActivity 给出全量 totals 与排序后的全量 files；limit 只在
  // 这里按夹紧后的值截断 files（totals 保持截断前口径，合同 §5.3）。
  const stats = computeFileActivity(fileActivitySamples)
  const boundedLimit = Math.min(Math.max(Math.trunc(limit), 1), MAX_FILE_ACTIVITY_LIMIT)
  return {
    totalFiles: stats.totalFiles,
    totalOps: stats.totalOps,
    files: stats.files.slice(0, boundedLimit),
  }
}

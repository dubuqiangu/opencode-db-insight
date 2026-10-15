/**
 * db read layer: path resolution, read-only connection and the row-level
 * SQL queries of the insight API (DESIGN.md §4/§6). Row-level SQL lives in
 * this file; the SQL-side statistics aggregations live in
 * aggregate-queries.ts (P0-1) and are re-exported below so callers keep a
 * single import surface.
 *
 * Conventions:
 * - Statistics always come from `session_message` (the old `part`/`message`
 *   tables stopped being written 2026-09-23 and must not be double-counted);
 *   `session_v2` is only used for the session list and per-session
 *   dimensions (DESIGN §2.2/§10).
 * - SQL only extracts raw rows; aggregation (median/p95/fingerprints/...)
 *   happens in the pure `src/stats/` functions.
 * - Every query accepts `null` (db missing or node:sqlite unavailable) and
 *   returns `null` so the M2 API layer can answer 503.
 */

import { createRequire } from "node:module"
import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

import type {
  AssistantStepRow,
  SessionMessageRecord,
  SessionSummary,
  SqliteReadConnection,
  TodoStats,
} from "./types.ts"
import {
  asRecord,
  coerceNumber,
  coerceText,
  parseAssistantStepRow,
  parseSessionModelColumn,
  readAgentName,
  readRowNumber,
  UNKNOWN_MODEL_ID,
} from "./rows.ts"
// 与聚合统计共用的 step 级谓词（单点纪律）：modelIds 的 step 集合必须
// 和模型排行榜扫的是同一批行，否则下钻口径又会漂移。
import { ASSISTANT_OBJECT_DATA_PREDICATE } from "./scan-conventions.ts"

// SQL-side statistics aggregations (P0-1); re-exported for the API layer.
export {
  queryOverview,
  queryDailyTrend,
  queryModelMetrics,
  queryAgentStats,
} from "./aggregate-queries.ts"

type SqliteDatabaseConstructor = new (
  databasePath: string,
  options: { readOnly: true },
) => SqliteReadConnection

let databaseConstructor: SqliteDatabaseConstructor | null | undefined

/**
 * Resolve the node:sqlite DatabaseSync constructor once, defensively:
 * environments without `node:sqlite` yield null instead of a module-load
 * crash (DESIGN §4 feature detection).
 */
function resolveDatabaseConstructor(): SqliteDatabaseConstructor | null {
  if (databaseConstructor !== undefined) return databaseConstructor
  try {
    const requireNodeModule = createRequire(import.meta.url)
    const sqliteModule = requireNodeModule("node:sqlite") as {
      DatabaseSync: SqliteDatabaseConstructor
    }
    databaseConstructor = sqliteModule.DatabaseSync
  } catch {
    databaseConstructor = null
  }
  return databaseConstructor
}

/**
 * Resolve the opencode database path from the user home directory.
 * Never a hardcoded absolute path: USERPROFILE (Windows) / HOME (unix)
 * with an os.homedir() fallback.
 */
export function resolveOpencodeDbPath(): string {
  const homeDirectory = process.env.USERPROFILE ?? process.env.HOME ?? homedir()
  return join(homeDirectory, ".local", "share", "opencode", "opencode.db")
}

/**
 * Open a read-only connection to the opencode database.
 * Returns null when node:sqlite is unavailable or the file does not exist /
 * cannot be opened — callers surface that as a 503 (DESIGN §4).
 */
export function openOpencodeDb(
  databasePath: string = resolveOpencodeDbPath(),
): SqliteReadConnection | null {
  const constructor = resolveDatabaseConstructor()
  if (constructor === null) return null
  if (!existsSync(databasePath)) return null
  try {
    return new constructor(databasePath, { readOnly: true })
  } catch {
    return null
  }
}

/**
 * Every assistant message of `session_message`, parsed into step rows. The
 * single shared scan behind the stats queries and the TUI status panel
 * (which passes a `sinceMs` lower bound so its 7-day window prunes old rows
 * in SQL). Returns null when the database is unavailable.
 */
export function queryAssistantStepRows(
  db: SqliteReadConnection | null,
  sinceMs?: number,
): AssistantStepRow[] | null {
  if (db === null) return null
  const hasTimeFloor = typeof sinceMs === "number" && Number.isFinite(sinceMs)
  const rawRows = db
    .prepare(
      hasTimeFloor
        ? "SELECT id, session_id, time_created, data FROM session_message WHERE type = 'assistant' AND time_created >= ?"
        : "SELECT id, session_id, time_created, data FROM session_message WHERE type = 'assistant'",
    )
    .all(...(hasTimeFloor ? [sinceMs] : []))

  const stepRows: AssistantStepRow[] = []
  for (const rawRow of rawRows) {
    const rowRecord = asRecord(rawRow)
    if (rowRecord === null) continue
    const stepRow = parseAssistantStepRow(rowRecord)
    if (stepRow !== null) stepRows.push(stepRow)
  }
  return stepRows
}

/** Clamp helper for list pagination parameters. */
function clampPaginationValue(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) return minimum
  return Math.min(Math.max(Math.floor(value), minimum), maximum)
}

/**
 * Sort whitelist for the session list (v0.2-B server-side sorting): each
 * allowed ?sort= key maps to a fixed SQL fragment. Raw query-string text
 * never reaches the SQL string — only these fragments do, which is what
 * makes the ordering injection-proof by construction. `tokens` is the
 * three-column sum the SessionSummary contract reports (not a column).
 */
export const SESSION_SORT_SQL_BY_SORT_KEY = {
  time_updated: "time_updated",
  time_created: "time_created",
  tokens: "tokens_input + tokens_output + tokens_cache_read",
  cost: "cost",
  title: "title",
} as const

export type SessionSortKey = keyof typeof SESSION_SORT_SQL_BY_SORT_KEY

/** Default sort key: newest activity first, exactly the pre-0.4.0 wire order. */
export const DEFAULT_SESSION_SORT_KEY: SessionSortKey = "time_updated"

export type SessionSortOrder = "asc" | "desc"

export const DEFAULT_SESSION_SORT_ORDER: SessionSortOrder = "desc"

/**
 * Resolve ?sort= against the whitelist. Missing, empty, unknown or
 * hostile values fall back to the default — the same degrade-not-reject
 * semantics as limit/offset (no 400s). Idempotent: resolving an already
 * resolved key returns it unchanged, so the API layer can resolve once
 * for the cache key and pass the same value on to the query.
 */
export function resolveSessionSortKey(
  sortKeyValue: string | null | undefined,
): SessionSortKey {
  // Own-property check, deliberately not `in`: Object.prototype keys
  // ("toString" / "__proto__" / "constructor" / ...) pass `in` via the
  // prototype chain and would then resolve to an inherited function
  // whose stringification lands in the SQL text → a permanent 500
  // instead of the contractual fallback (P1-1, v0.4.1).
  if (
    sortKeyValue !== null &&
    sortKeyValue !== undefined &&
    Object.hasOwn(SESSION_SORT_SQL_BY_SORT_KEY, sortKeyValue)
  ) {
    return sortKeyValue as SessionSortKey
  }
  return DEFAULT_SESSION_SORT_KEY
}

/**
 * Resolve ?order= against the whitelist: only the exact lowercase "asc"
 * flips the direction, everything else (missing, "DESC", garbage) falls
 * back to the default desc.
 */
export function resolveSessionSortOrder(
  sortOrderValue: string | null | undefined,
): SessionSortOrder {
  return sortOrderValue === "asc" ? "asc" : DEFAULT_SESSION_SORT_ORDER
}

/**
 * SELECT list + FROM clause of the session list (single point so the
 * filtered and unfiltered shapes below can never drift apart — the
 * scan-conventions.ts single-source discipline, applied to this query).
 */
const SESSION_LIST_SELECT_SQL =
  `SELECT id, title, model, agent, directory, time_created, time_updated,
              tokens_input, tokens_output, tokens_cache_read, cost
       FROM session_v2`

/**
 * Directory drill-down condition (v0.7.0): parameterized exact match on
 * the session_v2.directory column. The value is a free-form string (NOT a
 * whitelist key like ?sort=), so it only ever reaches SQLite as a bind
 * parameter — every other token of the constructed SQL stays a
 * compile-time literal.
 */
const SESSION_DIRECTORY_FILTER_SQL = "directory = ?"

/**
 * Time-range window condition (v0.9.0): parameterized floor on the
 * epoch-ms session_v2.time_updated column (the same numeric-ms storage
 * the scan layer already floors with `time_created >= ?` in this file).
 * The threshold is computed server-side per request and only ever
 * reaches SQLite as a bind parameter.
 */
const SESSION_RANGE_FILTER_SQL = "time_updated >= ?"

/** One day in milliseconds, for the ?range= window presets. */
export const SESSION_RANGE_WINDOW_MS_PER_DAY = 86_400_000

/**
 * Vocabulary of the ?range= presets (v0.9.0): each allowed key maps to
 * the window length in days. Like the ?sort= whitelist this is a fixed
 * map — raw query-string text never reaches the SQL string, only the
 * days count does, via the computed threshold bind.
 */
export const SESSION_RANGE_WINDOW_DAYS_BY_RANGE_KEY = {
  "7d": 7,
  "30d": 30,
  "90d": 90,
} as const

export type SessionRangeKey = keyof typeof SESSION_RANGE_WINDOW_DAYS_BY_RANGE_KEY

/**
 * Tri-state resolution of ?range= (v0.9.0):
 * - "none": missing, null or empty parameter → no window at all;
 * - "window": a vocabulary key → the epoch-ms floor (now − N days);
 * - "invalid": an unknown non-empty value → the caller answers a loud
 *   400. Deliberately NOT the sort/order fallback semantics: a typo'd
 *   range that silently returned the full list would read as "filtered"
 *   to the caller — the exact "自以为筛了" trap this contract rejects.
 * Unlike a directory miss (a legitimate empty result for a legal value),
 * an illegal range word is rejected outright.
 */
export type SessionRangeResolution =
  | { rangeKind: "none" }
  | { rangeKind: "window"; rangeStartMs: number }
  | { rangeKind: "invalid" }

/**
 * Resolve ?range= per the tri-state contract above. Own-property check
 * (`Object.hasOwn`, not `in`) so prototype-chain keys like "toString" /
 * "__proto__" resolve to "invalid" — the P1-1 (v0.4.1) discipline
 * applied to this vocabulary too.
 */
export function resolveSessionRange(
  rangeParamValue: string | null | undefined,
): SessionRangeResolution {
  if (rangeParamValue === null || rangeParamValue === undefined || rangeParamValue === "") {
    return { rangeKind: "none" }
  }
  if (!Object.hasOwn(SESSION_RANGE_WINDOW_DAYS_BY_RANGE_KEY, rangeParamValue)) {
    return { rangeKind: "invalid" }
  }
  const windowDays =
    SESSION_RANGE_WINDOW_DAYS_BY_RANGE_KEY[rangeParamValue as SessionRangeKey]
  return {
    rangeKind: "window",
    rangeStartMs: Date.now() - windowDays * SESSION_RANGE_WINDOW_MS_PER_DAY,
  }
}

/**
 * Session list for GET /api/sessions. `tokens` comes from the
 * session_v2 summary columns, and since v0.13.0 the three components
 * (tokens_input / tokens_output / tokens_cache_read) also pass through
 * per-field. session_v2 KEEPS the message-level history that
 * compaction prunes, so the message-level aggregate UNDERCOUNTS
 * compacted sessions against these columns — live-db probe: v2 is
 * never below the message-level sum (844 sessions, 0 lagging / 69
 * ahead, 28/28 compacted sessions ahead). Cross-panel caveat: the v2
 * and message-level 口径 still differ by ~0.36% systematically.
 *
 * Ordering (v0.2-B): primary key from the ?sort= whitelist (default
 * time_updated), direction from ?order= (default desc). The `id ASC`
 * secondary key is mandatory for deterministic pagination — ties on the
 * primary key must paginate without duplicates or gaps. Callers may pass
 * raw query-string values; they are whitelisted here again (defense in
 * depth next to the API layer's own resolution for the cache key).
 *
 * Directory drill-down (v0.7.0): a non-empty `directoryValue` adds an
 * exact-match WHERE. Its semantics are deliberately NOT the sort/order
 * fallback semantics: a directory that matches nothing is a legitimate
 * EMPTY result (200 []), because the caller asked to filter, not to
 * sort. Missing, null or empty-string means no filter at all, and the
 * no-filter SQL stays byte-identical to the pre-0.7.0 statement (locked
 * by test/session-directory-filter.test.ts).
 *
 * Time-range window (v0.9.0): a numeric `rangeStartMs` adds an
 * epoch-ms floor (`time_updated >= ?`), computed per request by
 * resolveSessionRange. It composes with the directory filter in the
 * same WHERE (AND), and like the directory value it only ever reaches
 * SQLite as a bind parameter. Bind order (v0.9.0, locked by
 * test/session-range-filter.test.ts): directory, range threshold,
 * limit, offset.
 *
 * Step enrichment switch (v0.19.1, P2-4): `includeStepModelIds`
 * defaults to true (the dashboard sessions page consumes modelIds for
 * the client-side model drill-down). Callers that never read
 * modelIds — the CSV export loop and the TUI export picker — pass
 * false to skip the per-page step-model aggregation entirely; their
 * summaries then carry only the launch model in modelIds.
 */
export function querySessionList(
  db: SqliteReadConnection | null,
  limit: number = 50,
  offset: number = 0,
  sortKeyValue: string | null | undefined = DEFAULT_SESSION_SORT_KEY,
  sortOrderValue: string | null | undefined = DEFAULT_SESSION_SORT_ORDER,
  directoryValue: string | null | undefined = null,
  rangeStartMs: number | null | undefined = null,
  includeStepModelIds: boolean = true,
): SessionSummary[] | null {
  if (db === null) return null
  const safeLimit = clampPaginationValue(limit, 1, 500)
  const safeOffset = clampPaginationValue(offset, 0, Number.MAX_SAFE_INTEGER)
  const safeSortKey = resolveSessionSortKey(sortKeyValue)
  const safeSortOrder = resolveSessionSortOrder(sortOrderValue)
  const primarySortSql = SESSION_SORT_SQL_BY_SORT_KEY[safeSortKey]
  const primaryDirectionSql = safeSortOrder === "asc" ? "ASC" : "DESC"
  const hasDirectoryFilter = typeof directoryValue === "string" && directoryValue !== ""
  const hasRangeFilter = typeof rangeStartMs === "number" && Number.isFinite(rangeStartMs)

  // Filter conditions compose in a fixed order (directory first, then
  // the range window) so the bind-parameter order is deterministic:
  // [directory,] [range threshold,] limit, offset.
  const sessionFilterConditionsSql: string[] = []
  const sessionFilterBindValues: unknown[] = []
  if (hasDirectoryFilter) {
    sessionFilterConditionsSql.push(SESSION_DIRECTORY_FILTER_SQL)
    sessionFilterBindValues.push(directoryValue)
  }
  if (hasRangeFilter) {
    sessionFilterConditionsSql.push(SESSION_RANGE_FILTER_SQL)
    sessionFilterBindValues.push(rangeStartMs)
  }
  // The "\n       " prefix keeps the filtered shapes byte-identical to
  // the pre-0.9.0 statements (locked by the directory-filter and
  // sorting tests); the empty no-filter case keeps the pre-0.7.0 shape.
  const sessionFilterWhereSql =
    sessionFilterConditionsSql.length === 0
      ? ""
      : `\n       WHERE ${sessionFilterConditionsSql.join(" AND ")}`

  const rawRows = db
    .prepare(
      `${SESSION_LIST_SELECT_SQL}${sessionFilterWhereSql}
       ORDER BY ${primarySortSql} ${primaryDirectionSql}, id ASC
       LIMIT ? OFFSET ?`,
    )
    .all(...sessionFilterBindValues, safeLimit, safeOffset)

  const sessionSummaries: SessionSummary[] = []
  for (const rawRow of rawRows) {
    const rowRecord = asRecord(rawRow)
    if (rowRecord === null) continue
    sessionSummaries.push(parseSessionSummaryRow(rowRecord, undefined))
  }
  // 空页不做聚合：没有任何 summary 需要装饰，省掉一次全表扫描；
  // 这也使「捕获空结果连接」的既有 SQL 字节锁测试（目录/范围/排序
  // 注入面）继续只捕获列表语句本身。非空页才建 step 模型 Map。
  if (sessionSummaries.length === 0) return sessionSummaries
  // P2-4（v0.19.1 性能热修）第一档：不消费 modelIds 的调用点（CSV
  // 导出循环、TUI 导出选单）传 false 跳过 step 富化——modelIds 只由
  // 会话列表的客户端模型过滤消费，为不读它的路径逐行解析 47k 条
  // assistant JSON 是纯浪费。此时 modelIds 只含启动模型。
  if (!includeStepModelIds) return sessionSummaries
  // P2-4 第二档：富化查询改 IN 下推——只扫当页会话的 id 集（全表版
  // 真库实测 ~2.6s/次，IN 下推版 ~531ms/页，见 queryStepModelIdsBySessionId）。
  const stepModelIdsBySessionId = queryStepModelIdsBySessionId(
    db,
    sessionSummaries.map((sessionSummary) => sessionSummary.id),
  )
  for (const sessionSummary of sessionSummaries) {
    sessionSummary.modelIds = buildSessionModelIds(
      sessionSummary.modelId,
      stepModelIdsBySessionId.get(sessionSummary.id),
    )
  }
  return sessionSummaries
}

/**
 * One session's summary by id via a direct `WHERE id = ?` lookup (P2-2 —
 * replaced the old paginated full-list scan). Returns null for unknown
 * ids, which is exactly how legacy pre-2026-09-23 sessions (absent from
 * session_v2) surface as 404 to callers.
 */
export function querySessionSummaryById(
  db: SqliteReadConnection | null,
  sessionId: string,
): SessionSummary | null {
  if (db === null) return null
  const rawRow = db
    .prepare(
      `SELECT id, title, model, agent, directory, time_created, time_updated,
              tokens_input, tokens_output, tokens_cache_read, cost
       FROM session_v2
       WHERE id = ?`,
    )
    .get(sessionId)
  const rowRecord = asRecord(rawRow)
  if (rowRecord === null) return null
  // 单查路径也填 modelIds（仅扫该会话的 step 行，低频路径，代价可忽略）：
  // 与列表路径同一口径，保证同一会话从两条路径取出的形状逐字段一致。
  const stepModelIdsBySessionId = queryStepModelIdsBySessionId(db, [sessionId])
  return parseSessionSummaryRow(rowRecord, stepModelIdsBySessionId.get(sessionId))
}

/**
 * Step 级模型 id 聚合（v0.19.0 模型下钻口径修复）：每对
 * (session_id, $.model.id) 一行。为什么需要它——模型排行榜的行来自
 * step 级 `$.model.id`，而会话的 `modelId` 只是 session_v2.model 声明的
 * 启动模型；实测 top 榜模型（glm-5.3-flash / claude-opus-5 …）从不作为
 * 启动模型出现，按启动模型过滤必然点出行列表空。会话列表因此改按
 * 「会话内 step 级出现过」过滤，本查询就是那个集合的 SQL 侧来源。
 *
 * `sessionIds` 是本次富化要覆盖的会话 id 集（by-id 单查路径传单个
 * id；列表路径传当页整页 id 集——P2-4 IN 下推：谓词置于 json 函数
 * 谓词之前，SQLite 的 AND 按书写序短路，47k 行逐行 JSON 解析缩到
 * 只解析当页会话的行，真库实测 ~2.6s/次 → ~531ms/页）。两条路径复用
 * 同一口径，保证产出的 SessionSummary 形状一致（sql-aggregation-parity
 * 的 by-id 逐字段锁依赖这一点）。谓词复用聚合统计的共享
 * ASSISTANT_OBJECT_DATA_PREDICATE：与排行榜扫描同一批行，空 model.id
 * 由 JS 侧归一为 "unknown"（镜像 parseAssistantStepRow / queryModelMetrics
 * 的归一，保证点排行榜的 "unknown" 行下钻也能命中）。
 */
function queryStepModelIdsBySessionId(
  db: SqliteReadConnection,
  sessionIds: string[],
): Map<string, Set<string>> {
  // 空 id 集不发 SQL：IN () 不是合法语句，且没有会话就没有富化可做。
  if (sessionIds.length === 0) return new Map()
  const sessionFilterSql = `session_id IN (${sessionIds.map(() => "?").join(", ")})`
  let rawRows: unknown[]
  try {
    rawRows = db
      .prepare(
        `SELECT session_id, json_extract(data, '$.model.id') AS model_id
         FROM session_message
         WHERE ${sessionFilterSql} AND ${ASSISTANT_OBJECT_DATA_PREDICATE}
         GROUP BY session_id, model_id`,
      )
      .all(...sessionIds)
  } catch (error) {
    // R-D（v0.19.1 catch 宽度加固）：「no such table」是已知且合法的
    // 降级场景——只有 session_v2 的库（CSV 导出测试夹具即此形态）没有
    // session_message 表，静默降级即可；其余任何错误（真实 SQL 错误、
    // 库损坏）必须先 console.error 再降级，防无痕复发 v0.19.0 修过的
    // bug。降级语义不变：step 集合整体置空，summary 的 modelIds 只含
    // 启动模型；富化失败不得牵连列表/导出主查询（后者依赖 session_v2
    // 单表，语义上就不需要 step 数据）。
    const failureMessage = error instanceof Error ? error.message : String(error)
    if (!/no such table/i.test(failureMessage)) {
      console.error("opencode-db-insight: step model id aggregation failed", error)
    }
    return new Map()
  }

  const stepModelIdsBySessionId = new Map<string, Set<string>>()
  for (const rawRow of rawRows) {
    const rowRecord = asRecord(rawRow)
    if (rowRecord === null) continue
    const stepSessionId = coerceText(rowRecord["session_id"])
    // json_extract 对缺失/JSON null 的 $.model.id 返回 NULL——那是
    // 「没有模型可下钻」的行，不是 "unknown" 桶；只有显式空串才归一
    // 为 "unknown"（与排行榜 JS 侧 rawModelId === "" 的判定一致）。
    const rawModelId = rowRecord["model_id"]
    if (rawModelId === null || rawModelId === undefined) continue
    const stepModelId = coerceText(rawModelId)
    const normalizedModelId = stepModelId === "" ? UNKNOWN_MODEL_ID : stepModelId
    const modelIdSet = stepModelIdsBySessionId.get(stepSessionId) ?? new Set<string>()
    modelIdSet.add(normalizedModelId)
    stepModelIdsBySessionId.set(stepSessionId, modelIdSet)
  }
  return stepModelIdsBySessionId
}

/**
 * 组装单个 summary 的 modelIds：step 集合 ∪ 启动模型（"unknown" 占位
 * 不计入——缺数据不是「用过」）。无 step 且启动模型未知 → 空数组。
 */
function buildSessionModelIds(
  modelId: string,
  stepModelIdSet: Set<string> | undefined,
): string[] {
  const modelIds = new Set<string>(stepModelIdSet ?? [])
  if (modelId !== UNKNOWN_MODEL_ID) modelIds.add(modelId)
  return [...modelIds]
}

/** Shared column mapping of one session_v2 row into a SessionSummary. */
function parseSessionSummaryRow(
  rowRecord: Record<string, unknown>,
  stepModelIdSet: Set<string> | undefined,
): SessionSummary {
  const { modelId } = parseSessionModelColumn(rowRecord["model"])
  return {
    id: coerceText(rowRecord["id"]),
    title: coerceText(rowRecord["title"]),
    modelId,
    modelIds: buildSessionModelIds(modelId, stepModelIdSet),
    agent: readAgentName(rowRecord["agent"]),
    directory: coerceText(rowRecord["directory"]),
    timeCreated: coerceNumber(rowRecord["time_created"]),
    timeUpdated: coerceNumber(rowRecord["time_updated"]),
    tokens:
      coerceNumber(rowRecord["tokens_input"]) +
      coerceNumber(rowRecord["tokens_output"]) +
      coerceNumber(rowRecord["tokens_cache_read"]),
    tokensInput: coerceNumber(rowRecord["tokens_input"]),
    tokensOutput: coerceNumber(rowRecord["tokens_output"]),
    tokensCacheRead: coerceNumber(rowRecord["tokens_cache_read"]),
    cost: coerceNumber(rowRecord["cost"]),
  }
}

/**
 * All messages of one session for the replay view, ordered by seq.
 * `data` keeps the parsed original JSON structure. Unknown session ids
 * yield an empty array.
 */
export function querySessionMessages(
  db: SqliteReadConnection | null,
  sessionId: string,
): SessionMessageRecord[] | null {
  if (db === null) return null
  const rawRows = db
    .prepare(
      `SELECT id, session_id, type, seq, time_created, time_updated, data
       FROM session_message
       WHERE session_id = ?
       ORDER BY seq ASC`,
    )
    .all(sessionId)

  const messageRecords: SessionMessageRecord[] = []
  for (const rawRow of rawRows) {
    const rowRecord = asRecord(rawRow)
    if (rowRecord === null) continue
    let parsedData: unknown
    const rawData = rowRecord["data"]
    if (typeof rawData === "string") {
      try {
        parsedData = JSON.parse(rawData)
      } catch {
        parsedData = null
      }
    } else {
      parsedData = rawData ?? null
    }
    messageRecords.push({
      id: coerceText(rowRecord["id"]),
      sessionId: coerceText(rowRecord["session_id"]),
      type: coerceText(rowRecord["type"]),
      seq: coerceNumber(rowRecord["seq"]),
      timeCreated: coerceNumber(rowRecord["time_created"]),
      timeUpdated: coerceNumber(rowRecord["time_updated"]),
      data: parsedData,
    })
  }
  return messageRecords
}

/**
 * Todo completion counters for the todo widget. Statuses outside the three
 * known ones (e.g. "cancelled") only count towards `total`.
 */
export function queryTodoStats(db: SqliteReadConnection | null): TodoStats | null {
  if (db === null) return null
  const rawRows = db.prepare("SELECT status, COUNT(*) AS statusCount FROM todo GROUP BY status").all()

  const todoStats: TodoStats = { total: 0, completed: 0, pending: 0, inProgress: 0 }
  for (const rawRow of rawRows) {
    const rowRecord = asRecord(rawRow)
    if (rowRecord === null) continue
    const status = coerceText(rowRecord["status"])
    const statusCount = coerceNumber(rowRecord["statusCount"])
    todoStats.total += statusCount
    if (status === "completed") todoStats.completed += statusCount
    else if (status === "pending") todoStats.pending += statusCount
    else if (status === "in_progress") todoStats.inProgress += statusCount
  }
  return todoStats
}

/**
 * System prompt pieces of one session for GET /api/session/:id/system-prompt:
 * the latest instruction_state row maps instruction keys to instruction_blob
 * hashes; blob values are stored JSON-encoded. Returns null when the session
 * has no instruction state; unknown hash entries are skipped.
 */
export function querySessionSystemPrompt(
  db: SqliteReadConnection | null,
  sessionId: string,
): Record<string, string> | null {
  if (db === null) return null
  const stateRow = db
    .prepare(
      `SELECT current_values FROM instruction_state
       WHERE session_id = ?
       ORDER BY epoch_start DESC
       LIMIT 1`,
    )
    .get(sessionId)
  const stateRecord = asRecord(stateRow)
  if (stateRecord === null) return null

  let currentValues: unknown = stateRecord["current_values"]
  if (typeof currentValues === "string") {
    try {
      currentValues = JSON.parse(currentValues)
    } catch {
      return null
    }
  }
  const valuesRecord = asRecord(currentValues)
  if (valuesRecord === null) return null

  const selectBlobValue = db.prepare("SELECT value FROM instruction_blob WHERE hash = ?")
  const promptByInstructionKey: Record<string, string> = {}
  for (const [instructionKey, blobHash] of Object.entries(valuesRecord)) {
    const blobRow = asRecord(selectBlobValue.get(coerceText(blobHash)))
    if (blobRow === null) continue
    const rawValue = blobRow["value"]
    let content: string
    if (typeof rawValue === "string") {
      try {
        const decodedValue: unknown = JSON.parse(rawValue)
        content = typeof decodedValue === "string" ? decodedValue : rawValue
      } catch {
        content = rawValue
      }
    } else {
      content = coerceText(rawValue)
    }
    if (content !== "") promptByInstructionKey[instructionKey] = content
  }
  return promptByInstructionKey
}

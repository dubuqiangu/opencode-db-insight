/**
 * API request handling: maps a matched route (router.ts) onto the M1 query
 * functions (src/db/queries.ts) behind the 60s TTL cache (src/stats/cache.ts).
 *
 * Status conventions (DESIGN.md §6/§9/§10):
 * - db unavailable (node:sqlite missing or file absent) → 503 {error};
 * - session absent from session_v2 (legacy pre-2026-09-23 or unknown) →
 *   404 {error: "session not found in current tables"};
 * - session present in session_v2 but without messages →
 *   404 {error: "session exists but has no messages"} (P2-7);
 * - /api/health always answers 200 and carries dbStatus, derived from a
 *   live SELECT 1 probe rather than connection-null-ness (P1-4), plus the
 *   service identity the TUI port discovery validates against
 *   (src/tui/discover-dashboard-port.ts);
 * - /api/refresh always answers 200 too (v0.14.0): clearing the
 *   process-local result cache needs no database and no cache slot;
 * - v0.20.0 ?session=（聚合端点可选）：仅统计该会话；未知 id → 统一
 *   404 {error: "session not found"}；空串按缺省（全部会话）处理。
 */

import type { SessionMessageRecord, SessionSummary, SqliteReadConnection } from "../db/types.ts"
import { INSIGHT_SERVICE_NAME } from "../insight-service-identity.ts"
import {
  DEFAULT_SESSION_SORT_KEY,
  DEFAULT_SESSION_SORT_ORDER,
  queryAgentStats,
  queryDailyTrend,
  queryModelMetricsComparison,
  queryOverview,
  querySessionList,
  querySessionMessages,
  querySessionSummaryById,
  querySessionSystemPrompt,
  queryTodoStats,
  resolveSessionRange,
  resolveSessionSortKey,
  resolveSessionSortOrder,
  sessionExistsInSessionV2,
} from "../db/queries.ts"
import { queryCrossSessionSearch } from "../db/search-queries.ts"
import {
  queryCompactionStats,
  queryHourHeatmap,
  querySessionSurvival,
} from "../db/behavior-queries.ts"
import { queryToolHealth } from "../db/tool-health-queries.ts"
import {
  DEFAULT_DIRECTORY_LIMIT,
  MAX_DIRECTORY_LIMIT,
  queryDirectoryStats,
} from "../db/directory-queries.ts"
import {
  queryChildShare,
  queryDurationDistribution,
  querySessionTokenDistribution,
  queryStepDistribution,
} from "../db/session-distribution-queries.ts"
import { queryToolErrorTrend } from "../db/tool-error-trend-queries.ts"
import { querySessionOutcome } from "../db/session-outcome-queries.ts"
import { renderSessionMarkdown } from "../export/markdown.ts"
import {
  renderSessionSummaryCsv,
  SESSION_SUMMARY_CSV_CONTENT_TYPE,
  SESSION_SUMMARY_CSV_FILENAME,
} from "./session-summary-csv.ts"
import { buildCacheKey, cachedResult, clearResultCache, resultCacheSize } from "../stats/cache.ts"
import { MAX_TREND_DAYS } from "../stats/daily-buckets.ts"
import {
  parseNonNegativeIntegerParam,
  parsePositiveIntegerParam,
  type InsightRoute,
} from "./router.ts"

/** Keep in sync with package.json version (bumped together in M7). */
export const INSIGHT_VERSION = "0.25.2"

export const DATABASE_UNAVAILABLE_MESSAGE =
  "opencode database unavailable: node:sqlite missing or db file not found"

/** 404 for sessions absent from the current tables (legacy or unknown). */
export const SESSION_NOT_FOUND_MESSAGE = "session not found in current tables"

/** 404 for sessions that exist in session_v2 but carry no messages (P2-7). */
export const SESSION_EMPTY_MESSAGE = "session exists but has no messages"

/**
 * 404 for ?session= 参数指向不存在的会话（v0.20.0）：所有消费该参数
 * 的聚合端点共用这一个 body——契约定稿为 { error: "session not found" }，
 * 与路径路由的 SESSION_NOT_FOUND_MESSAGE（"session not found in
 * current tables"）刻意不同：那是「legacy 表里也找不到」的历史语义，
 * 这是参数校验语义，前端按新常量统一处理。
 */
export const SESSION_FILTER_NOT_FOUND_MESSAGE = "session not found"

/**
 * 消费 ?session= 的路由清单（v0.20.0 契约核心）：全部聚合端点。
 * step 级（session_message 出发）与 会话级（session_v2 出发）的
 * 过滤落点见各查询函数；/api/sessions（列表，已有自己的过滤维度）、
 * 会话路径路由（/api/session/:id/…）与导出路由不吃该参数——传入
 * 即忽略，不校验。
 */
const SESSION_FILTER_CONSUMING_ROUTE_NAMES: ReadonlySet<string> = new Set([
  "overview",
  "trend",
  "models",
  "tool-health",
  "agents",
  "todo",
  "hour-heatmap",
  "session-survival",
  "compaction",
  "directories",
])

/**
 * ?range= rejection (v0.9.0): an unknown non-empty preset answers a
 * loud 400 — never a silent fallback to the full list, which the
 * caller would mistake for a filtered result. Legal values that match
 * nothing do not exist here (unlike ?directory=), because the range
 * vocabulary is closed: 7d, 30d, 90d.
 */
export const INVALID_RANGE_MESSAGE = "invalid range parameter; expected one of: 7d, 30d, 90d"

/** Opaque 500 error body; the real cause is logged, never sent (P2-11). */
export const INTERNAL_ERROR_MESSAGE = "internal error"

/**
 * /api/models ?days= sentinel for "no time window" (full history): the
 * parameter is optional, and parsePositiveIntegerParam maps every
 * missing/empty/non-integer/zero/negative value back onto this default,
 * so 0 unambiguously means "window disabled" — a legal window is always
 * > 0, and an illegal ?days= silently means full history (DESIGN.md M2
 * default-value convention), never a 400.
 */
const MODEL_METRICS_FULL_HISTORY_DAYS = 0

/** What one API exchange produced, before touching node:http. */
export interface ApiResponsePayload {
  statusCode: number
  body: unknown
  /**
   * Non-JSON responses (the markdown export): when set, `body` is ignored
   * and the raw text is sent with its own content type and headers.
   */
  rawText?: RawTextResponse
}

/** A raw (non-JSON) response body plus its exact headers. */
export interface RawTextResponse {
  text: string
  contentType: string
  headers: Record<string, string>
}

/** Illegal on Windows filenames; mapped to "-" in export slugs. */
const ILLEGAL_FILENAME_CHARACTER_PATTERN = /[\\/:*?"<>|\u0000-\u001f]/g

/** Slug portion of export filenames is capped at 60 characters (T5.1). */
const EXPORT_SLUG_MAX_LENGTH = 60

/**
 * Sanitize a session title into an export filename slug: keep CJK and other
 * unicode intact, replace illegal filename characters with "-", collapse
 * whitespace, trim, truncate to 60 characters without splitting a surrogate
 * pair, and never end on dots/spaces (Windows). Empty/degenerate titles
 * degrade to "untitled-session".
 */
export function buildExportSlug(sessionTitle: string): string {
  const sanitizedTitle = sessionTitle
    // Tabs/newlines are whitespace, not punctuation — collapse them to
    // spaces before the illegal-character pass turns control chars into "-".
    .replace(/[\t\n\r\f\v]+/g, " ")
    .replace(ILLEGAL_FILENAME_CHARACTER_PATTERN, "-")
    .replace(/\s+/g, " ")
    .trim()
  if (sanitizedTitle === "") return "untitled-session"

  let truncatedTitle =
    sanitizedTitle.length > EXPORT_SLUG_MAX_LENGTH
      ? sanitizedTitle.slice(0, EXPORT_SLUG_MAX_LENGTH)
      : sanitizedTitle
  // A cut in the middle of a surrogate pair (emoji) would leave a lone
  // high surrogate, which filesystems reject.
  if (/[\ud800-\udbff]$/.test(truncatedTitle)) truncatedTitle = truncatedTitle.slice(0, -1)

  const windowsSafeTitle = truncatedTitle.replace(/[. ]+$/, "")
  return windowsSafeTitle === "" ? "untitled-session" : windowsSafeTitle
}

/** Download filename for the export route: <session-created YYYY-MM-DD>-<slug>.md */
export function buildExportDownloadFilename(sessionSummary: SessionSummary): string {
  const createdDate = new Date(sessionSummary.timeCreated)
  const twoDigits = (value: number) => String(value).padStart(2, "0")
  const dateStamp = Number.isNaN(createdDate.getTime())
    ? "unknown-date"
    : `${createdDate.getFullYear()}-${twoDigits(createdDate.getMonth() + 1)}-${twoDigits(createdDate.getDate())}`
  return `${dateStamp}-${buildExportSlug(sessionSummary.title)}.md`
}

/**
 * ASCII-only fallback for the Content-Disposition filename parameter (the
 * header itself must be ASCII; the real UTF-8 name travels via filename*).
 */
function asciiFilenameFallback(downloadFilename: string): string {
  const asciiOnly = downloadFilename
    .replace(/[^\x20-\x7e]/g, "")
    .replace(/["\\]/g, "")
    .replace(/\s+/g, "-")
  return asciiOnly === "" ? "session-export.md" : asciiOnly
}

/**
 * Find one session's summary by id. A direct `WHERE id = ?` lookup on
 * session_v2 (P2-2 — no paginated list scan any more). Returns null for
 * unknown ids — which is exactly how legacy pre-2026-09-23 sessions
 * (absent from session_v2) surface as 404 to callers.
 */
export function findSessionSummaryById(
  database: SqliteReadConnection,
  sessionId: string,
): SessionSummary | null {
  return querySessionSummaryById(database, sessionId)
}

/**
 * Flatten the system-prompt record (instruction key → prompt text) into the
 * single string the markdown renderer expects. Each piece is labeled with
 * its instruction key; an empty record degrades to null (section omitted).
 */
export function flattenSystemPromptForExport(
  systemPrompt: Record<string, string> | null,
): string | null {
  if (systemPrompt === null) return null
  const promptEntries = Object.entries(systemPrompt)
  if (promptEntries.length === 0) return null
  return promptEntries
    .map(([instructionKey, promptText]) => `[${instructionKey}]\n${promptText}`)
    .join("\n\n")
}

/** Inputs the API layer needs; all injected so tests can pass fakes. */
export interface ApiRequestContext {
  route: InsightRoute
  searchParams: URLSearchParams
  database: SqliteReadConnection | null
  databasePath: string
  serverPort: number
}

/**
 * Light liveness probe for /api/health (P1-4): "non-null connection" is
 * not enough — the file may have been deleted or corrupted after the
 * server started, which only shows up when a statement actually runs.
 */
function probeDatabaseAlive(database: SqliteReadConnection): boolean {
  try {
    database.prepare("SELECT 1").get()
    return true
  } catch {
    return false
  }
}

/** Health probe always succeeds; dbStatus tells the real story. */
function healthResponse(requestContext: ApiRequestContext): ApiResponsePayload {
  const databaseAlive =
    requestContext.database !== null && probeDatabaseAlive(requestContext.database)
  return {
    statusCode: 200,
    body: {
      // Service identity the TUI-side port discovery checks — the marker
      // that separates this server from any foreign process answering in
      // the 18789..18798 probe range.
      service: INSIGHT_SERVICE_NAME,
      status: "ok",
      version: INSIGHT_VERSION,
      port: requestContext.serverPort,
      dbStatus: databaseAlive ? "ok" : "unavailable",
      dbPath: requestContext.databasePath,
    },
  }
}

/** A local calendar day's start in epoch-ms, or null for missing/empty/malformed dates. */
const DAY_PARAM_PATTERN = /^\d{4}-\d{2}-\d{2}$/

/**
 * Parse ?day=YYYY-MM-DD into the local calendar-day start epoch-ms
 * (new Date(year, month-1, day) — local midnight, matching the frontend
 * dateKeyToEpoch so a heatmap day-click filters the same local-day window
 * the heatmap itself renders). Missing, empty or malformed dates return
 * null (no filter, degrade silently like sort/order).
 */
export function parseDayStartMs(dayParamValue: string): number | null {
  if (dayParamValue === "" || !DAY_PARAM_PATTERN.test(dayParamValue)) return null
  const year = Number(dayParamValue.slice(0, 4))
  const month = Number(dayParamValue.slice(5, 7))
  const day = Number(dayParamValue.slice(8, 10))
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) {
    return null
  }
  if (month < 1 || month > 12 || day < 1 || day > 31) return null
  return new Date(year, month - 1, day).getTime()
}

/**
 * Parse one bounded positive-integer window parameter and return both things
 * its caller must keep in lockstep (P2-6 clamp-before-key discipline): the
 * bounded value handed to the query, and the exact cache-key fragment that
 * value must appear as. The four windowed routes (trend / hour-heatmap /
 * directories / tool-error-trend) used to hand-copy that parse / clamp / key
 * triple; one call site keeps a route's query window and its cache key from
 * ever drifting apart (a drift silently changes which requests share an entry).
 *
 * cacheKeyParameters is a one-element array so a route either uses it as the
 * whole key tail (queryToolErrorTrend, no trailing dimension) or spreads it
 * ahead of a session filter dim (queryDailyTrend / queryHourHeatmap /
 * directory-stats). Both shapes reproduce the historical key bytes exactly.
 */
export function boundedIntParamKey(
  searchParams: URLSearchParams,
  paramName: string,
  defaultValue: number,
  maxValue: number,
): { boundedValue: number; cacheKeyParameters: number[] } {
  const parsedValue = parsePositiveIntegerParam(searchParams, paramName, defaultValue)
  const boundedValue = Math.min(parsedValue, maxValue)
  return { boundedValue, cacheKeyParameters: [boundedValue] }
}

/**
 * Handle one matched API route. Pure bookkeeping around the cached queries;
 * unexpected database errors degrade to 500 {error} instead of crashing the
 * server process.
 */
export function handleApiRequest(requestContext: ApiRequestContext): ApiResponsePayload {
  const { route } = requestContext

  if (route.routeName === "health") return healthResponse(requestContext)

  // Cache control plane (v0.14.0): clearing the process-local result
  // cache needs NO database, so this route deliberately sits in front
  // of the db-null 503 short-circuit below. It is equally deliberately
  // NOT wrapped in cachedResult — a cache-clearing route consuming one
  // of the 64 cache slots would defeat itself. The count is read
  // BEFORE clearing so the response reports how many entries the call
  // actually evicted.
  if (route.routeName === "refresh") {
    const clearedEntryCount = resultCacheSize()
    clearResultCache()
    return { statusCode: 200, body: { status: "ok", cleared: clearedEntryCount } }
  }

  const database = requestContext.database
  if (database === null) {
    return { statusCode: 503, body: { error: DATABASE_UNAVAILABLE_MESSAGE } }
  }

  // v0.20.0 ?session= 参数（只对消费它的聚合端点生效）：空串/缺省 =
  // 现行「全部会话」行为；非空则先做存在性校验（一次 session_v2 点
  // 查，不进 TTL 缓存——新建会话立即可见），未知 id 统一 404，body
  // 各端点一致（SESSION_FILTER_NOT_FOUND_MESSAGE），前端统一处理。
  // 校验放在 switch 之前：一处实现，所有消费端点共享，不散落复制。
  let sessionFilterId: string | null = null
  if (SESSION_FILTER_CONSUMING_ROUTE_NAMES.has(route.routeName)) {
    const sessionFilterParamValue = requestContext.searchParams.get("session") ?? ""
    if (sessionFilterParamValue !== "") {
      if (!sessionExistsInSessionV2(database, sessionFilterParamValue)) {
        return { statusCode: 404, body: { error: SESSION_FILTER_NOT_FOUND_MESSAGE } }
      }
      sessionFilterId = sessionFilterParamValue
    }
  }

  try {
    switch (route.routeName) {
      case "overview": {
        // v0.20.0：缓存键追加 session 维度（"" = 缺省不过滤，与
        // directory 同一等价纪律），同一会话的重复请求共享一条 60s
        // TTL 条目。
        const overview = cachedResult(
          buildCacheKey("queryOverview", [sessionFilterId ?? ""]),
          () => queryOverview(database, sessionFilterId),
        )
        return { statusCode: 200, body: overview }
      }
      case "trend": {
        // parse / clamp / key 三连收敛到 boundedIntParamKey（P2-6）：查询与
        // 缓存键看到同一个收窄后的窗口，?days=1000 与 ?days=366 共享一条
        // 条目，而不是各自喷一条近似重复项。
        const trendWindow = boundedIntParamKey(
          requestContext.searchParams,
          "days",
          30,
          MAX_TREND_DAYS,
        )
        const trendPoints = cachedResult(
          buildCacheKey("queryDailyTrend", [
            ...trendWindow.cacheKeyParameters,
            sessionFilterId ?? "",
          ]),
          () => queryDailyTrend(database, trendWindow.boundedValue, sessionFilterId),
        )
        return { statusCode: 200, body: trendPoints }
      }
      case "models": {
        // Optional ?days= window PLUS a full-history sentinel: ?days=0 (the
        // parse default) means "no window", so the trend route's plain
        // parse / clamp / key helper cannot fold in here — the sentinel has
        // to survive the clamp step.
        const modelWindowDays = parsePositiveIntegerParam(
          requestContext.searchParams,
          "days",
          MODEL_METRICS_FULL_HISTORY_DAYS,
        )
        // Clamp before keying (P2-6 discipline, same as the trend route):
        // the query clamps internally, so the key must carry the bounded
        // value too or ?days=1000 and ?days=366 would spray the same
        // result as near-duplicate cache entries. The no-window call
        // keeps the historical parameterless key shape ([]), so it never
        // shares an entry with any ?days= window.
        const boundedModelWindowDays =
          modelWindowDays <= MODEL_METRICS_FULL_HISTORY_DAYS
            ? undefined
            : Math.min(modelWindowDays, MAX_TREND_DAYS)
        const modelMetrics = cachedResult(
          buildCacheKey(
            "queryModelMetricsComparison",
            boundedModelWindowDays === undefined
              ? [sessionFilterId ?? ""]
              : [boundedModelWindowDays, sessionFilterId ?? ""],
          ),
          () => queryModelMetricsComparison(database, boundedModelWindowDays, sessionFilterId),
        )
        return { statusCode: 200, body: modelMetrics }
      }
      case "tool-health": {
        const toolHealthStats = cachedResult(
          buildCacheKey("queryToolHealth", [sessionFilterId ?? ""]),
          () => queryToolHealth(database, sessionFilterId),
        )
        return { statusCode: 200, body: toolHealthStats }
      }
      case "agents": {
        const agentStats = cachedResult(
          buildCacheKey("queryAgentStats", [sessionFilterId ?? ""]),
          () => queryAgentStats(database, sessionFilterId),
        )
        return { statusCode: 200, body: agentStats }
      }
      case "search": {
        // v0.24.0 跨会话搜索端点。mode 校验：只有 "regex" 是正则，其余
        // （缺失/空/其它）一律降级为 substring（degrade，不 400）。空/缺
        // q 由 queryCrossSessionSearch 答空载荷（200）。缓存键带 mode+query
        // 两个维度。
        const searchQuery = requestContext.searchParams.get("q") ?? ""
        const rawSearchMode = requestContext.searchParams.get("mode") ?? ""
        const searchMode: "substring" | "regex" =
          rawSearchMode === "regex" ? "regex" : "substring"
        const searchResult = cachedResult(
          buildCacheKey("search", [searchMode, searchQuery]),
          () => queryCrossSessionSearch(database, searchQuery, searchMode),
        )
        if (searchResult === null) {
          return { statusCode: 503, body: { error: DATABASE_UNAVAILABLE_MESSAGE } }
        }
        return { statusCode: 200, body: searchResult }
      }
      case "sessions": {
        const sessionLimit = parsePositiveIntegerParam(requestContext.searchParams, "limit", 50)
        const sessionOffset = parseNonNegativeIntegerParam(requestContext.searchParams, "offset", 0)
        // Resolve ?sort=/?order= against the whitelist before keying, so
        // the cache entry carries the resolved values — garbage never
        // sprays near-duplicate entries and every entry maps to exactly
        // one whitelisted SQL shape. Key prefix "sessions" (not
        // "querySessionList") is a deliberate, CHANGELOG-documented
        // naming choice for this route (v0.2-B), like "directory-stats".
        const sessionSortKey = resolveSessionSortKey(requestContext.searchParams.get("sort"))
        const sessionSortOrder = resolveSessionSortOrder(requestContext.searchParams.get("order"))
        // Directory drill-down (v0.7.0): the decoded raw string straight
        // from URLSearchParams (paths with spaces/CJK/quotes decode
        // here — never via the router's path-segment decoding). The
        // cache key carries it with "" for a missing parameter, so an
        // empty ?directory= shares the "no filter" key with no parameter
        // at all. Unlike sort/order this is NOT a fallback dimension: a
        // directory with zero matches is a legitimate empty 200 result.
        const sessionDirectoryFilter = requestContext.searchParams.get("directory") ?? ""
        // Time-range window (v0.9.0): tri-state resolution shared with
        // the CSV export below — one vocabulary, one resolver, never
        // two copies (contract #7). An unknown non-empty word is a
        // LOUD 400 before any cache write, not the sort/order-style
        // silent fallback: a typo'd range silently returning the full
        // list is exactly the "自以为筛了" trap this contract rejects.
        const sessionRangeParamValue = requestContext.searchParams.get("range") ?? ""
        const sessionRangeResolution = resolveSessionRange(sessionRangeParamValue)
        if (sessionRangeResolution.rangeKind === "invalid") {
          return { statusCode: 400, body: { error: INVALID_RANGE_MESSAGE } }
        }
        const sessionRangeStartMs =
          sessionRangeResolution.rangeKind === "window"
            ? sessionRangeResolution.rangeStartMs
            : null
        // Calendar-day filter (v0.24.0): a well-formed ?day=YYYY-MM-DD
        // pins the local calendar-day window [dayStartMs, dayStartMs +
        // 86400000) via Date.UTC (no timezone drift). Missing, empty or
        // malformed dates degrade to no filter (silent, like sort/order).
        // The cache key carries the RAW day string ("" for no filter), not
        // the computed threshold — same discipline as range/directory.
        const sessionDayParamValue = requestContext.searchParams.get("day") ?? ""
        const sessionDayStartMs = parseDayStartMs(sessionDayParamValue)
        // The cache key carries the RAW range word ("" for a missing
        // parameter), not the computed threshold: the threshold moves
        // every millisecond, so keying on it would spray a
        // near-duplicate entry per request and defeat the cache; the
        // word is the stable dimension (same discipline as directory).
        const sessionPage = cachedResult(
          buildCacheKey("sessions", [
            sessionLimit,
            sessionOffset,
            sessionSortKey,
            sessionSortOrder,
            sessionDirectoryFilter,
            sessionRangeParamValue,
            sessionDayParamValue,
          ]),
          () =>
            querySessionList(
              database,
              sessionLimit,
              sessionOffset,
              sessionSortKey,
              sessionSortOrder,
              sessionDirectoryFilter,
              sessionRangeStartMs,
              sessionDayStartMs,
            ),
        )
        return { statusCode: 200, body: sessionPage }
      }
      case "todo": {
        const todoStats = cachedResult(
          buildCacheKey("queryTodoStats", [sessionFilterId ?? ""]),
          () => queryTodoStats(database, sessionFilterId),
        )
        return { statusCode: 200, body: todoStats }
      }
      case "hour-heatmap": {
        // 同 trend 的 clamped-key 纪律（P2-6），抽到 boundedIntParamKey。
        const heatmapWindow = boundedIntParamKey(
          requestContext.searchParams,
          "days",
          90,
          MAX_TREND_DAYS,
        )
        const heatmapCells = cachedResult(
          buildCacheKey("queryHourHeatmap", [
            ...heatmapWindow.cacheKeyParameters,
            sessionFilterId ?? "",
          ]),
          () => queryHourHeatmap(database, heatmapWindow.boundedValue, sessionFilterId),
        )
        return { statusCode: 200, body: heatmapCells }
      }
      case "session-survival": {
        const survivalStats = cachedResult(
          buildCacheKey("querySessionSurvival", [sessionFilterId ?? ""]),
          () => querySessionSurvival(database, sessionFilterId),
        )
        return { statusCode: 200, body: survivalStats }
      }
      case "compaction": {
        const compactionStats = cachedResult(
          buildCacheKey("queryCompactionStats", [sessionFilterId ?? ""]),
          () => queryCompactionStats(database, sessionFilterId),
        )
        return { statusCode: 200, body: compactionStats }
      }
      case "directories": {
        // parse / clamp / key 三连收敛到 boundedIntParamKey（P2-6）；
        // Key prefix "directory-stats" (not "queryDirectoryStats") is a
        // deliberate, CHANGELOG-documented naming choice for this route.
        const directoryWindow = boundedIntParamKey(
          requestContext.searchParams,
          "limit",
          DEFAULT_DIRECTORY_LIMIT,
          MAX_DIRECTORY_LIMIT,
        )
        const directoryStats = cachedResult(
          buildCacheKey("directory-stats", [
            ...directoryWindow.cacheKeyParameters,
            sessionFilterId ?? "",
          ]),
          () => queryDirectoryStats(database, directoryWindow.boundedValue, sessionFilterId),
        )
        return { statusCode: 200, body: directoryStats }
      }
      case "session-distribution": {
        // v0.20.0 会话 tokens 总量分布：「全部会话」口径，不吃
        // ?session=（该参数在本路由被忽略，不校验）。无查询参数 →
        // 单一缓存键，走既有 60s TTL 惯例。
        const distributionStats = cachedResult(
          buildCacheKey("querySessionTokenDistribution", []),
          () => querySessionTokenDistribution(database),
        )
        return { statusCode: 200, body: distributionStats }
      }
      case "step-distribution": {
        // v0.21.0 会话步数分布：与 token 分布同一「全部会话」口径与
        // 缓存惯例（无参数单一键，60s TTL）。
        const stepDistributionStats = cachedResult(
          buildCacheKey("queryStepDistribution", []),
          () => queryStepDistribution(database),
        )
        return { statusCode: 200, body: stepDistributionStats }
      }
      case "duration-distribution": {
        // v0.21.0 会话墙钟时长分布（毫秒）：同一「全部会话」口径与
        // 无参缓存惯例。
        const durationDistributionStats = cachedResult(
          buildCacheKey("queryDurationDistribution", []),
          () => queryDurationDistribution(database),
        )
        return { statusCode: 200, body: durationDistributionStats }
      }
      case "child-share": {
        // v0.21.0 子会话占比：同一「全部会话」口径、不吃 ?session=、
        // 无参单一缓存键。
        const childShareStats = cachedResult(
          buildCacheKey("queryChildShare", []),
          () => queryChildShare(database),
        )
        return { statusCode: 200, body: childShareStats }
      }
      case "tool-error-trend": {
        // v0.22.0 B 档工具错误逐日趋势：「全部会话」口径，不吃 ?session=。
        // 与 trend/heatmap 同一 parse/clamp/key 三连（P2-6），收敛到
        // boundedIntParamKey：days 先按 MAX_TREND_DAYS 收窄再进缓存键，
        // ?days=1000 与 ?days=366 共享一条，缺省 30。
        const toolErrorTrendWindow = boundedIntParamKey(
          requestContext.searchParams,
          "days",
          30,
          MAX_TREND_DAYS,
        )
        const toolErrorTrend = cachedResult(
          buildCacheKey("queryToolErrorTrend", toolErrorTrendWindow.cacheKeyParameters),
          () => queryToolErrorTrend(database, toolErrorTrendWindow.boundedValue),
        )
        return { statusCode: 200, body: toolErrorTrend }
      }
      case "session-outcomes": {
        // v0.22.0 B 档会话结局：「全部会话」口径、不吃 ?session=、无参
        // 单一缓存键。
        const sessionOutcome = cachedResult(
          buildCacheKey("querySessionOutcome", []),
          () => querySessionOutcome(database),
        )
        return { statusCode: 200, body: sessionOutcome }
      }
      case "sessionMessages": {
        const messageRecords = cachedResult(
          buildCacheKey("querySessionMessages", [route.sessionId]),
          () => querySessionMessages(database, route.sessionId),
        )
        if (messageRecords === null) {
          return { statusCode: 404, body: { error: SESSION_NOT_FOUND_MESSAGE } }
        }
        if (messageRecords.length === 0) {
          // Distinguish "no such session" from "exists but has no messages"
          // (P2-7) — legacy pre-2026-09-23 sessions only ever hit the first.
          const sessionSummary = querySessionSummaryById(database, route.sessionId)
          return {
            statusCode: 404,
            body: {
              error: sessionSummary === null ? SESSION_NOT_FOUND_MESSAGE : SESSION_EMPTY_MESSAGE,
            },
          }
        }
        return { statusCode: 200, body: messageRecords }
      }
      case "sessionSystemPrompt": {
        const systemPrompt = cachedResult(
          buildCacheKey("querySessionSystemPrompt", [route.sessionId]),
          () => querySessionSystemPrompt(database, route.sessionId),
        )
        if (systemPrompt === null) {
          return { statusCode: 404, body: { error: SESSION_NOT_FOUND_MESSAGE } }
        }
        return { statusCode: 200, body: systemPrompt }
      }
      case "sessionExport": {
        // Low-frequency full export: fetch + render directly, no TTL cache.
        const sessionSummary = findSessionSummaryById(database, route.sessionId)
        if (sessionSummary === null) {
          return { statusCode: 404, body: { error: SESSION_NOT_FOUND_MESSAGE } }
        }
        const messageRecords = querySessionMessages(database, route.sessionId)
        if (messageRecords === null || messageRecords.length === 0) {
          return { statusCode: 404, body: { error: SESSION_EMPTY_MESSAGE } }
        }
        const systemPrompt = querySessionSystemPrompt(database, route.sessionId)
        const markdownDocument = renderSessionMarkdown(
          sessionSummary,
          messageRecords,
          flattenSystemPromptForExport(systemPrompt),
        )
        const downloadFilename = buildExportDownloadFilename(sessionSummary)
        return {
          statusCode: 200,
          body: null,
          rawText: {
            text: markdownDocument,
            contentType: "text/markdown; charset=utf-8",
            headers: {
              "Content-Disposition": `attachment; filename="${asciiFilenameFallback(downloadFilename)}"; filename*=UTF-8''${encodeURIComponent(downloadFilename)}`,
            },
          },
        }
      }
      case "sessionSummaryExport": {
        // One-shot click export, deliberately NOT wrapped in cachedResult
        // (same reasoning as the .md export above): the CSV must reflect
        // the moment of the click, and a 60s TTL entry would only occupy
        // a slot of the 64-entry cache. An export is a snapshot, not a
        // view: ?sort=/?order= are intentionally ignored — the row order
        // is the sessions list's default (time_updated desc, id ASC).
        // ?directory= reuses the sessions drill-down contract verbatim
        // (v0.7.0): the decoded raw string from URLSearchParams, exact
        // match, missing/empty = the whole list, a miss = a header-only
        // CSV — filter semantics, not fallback semantics.
        const exportDirectoryFilter = requestContext.searchParams.get("directory") ?? ""
        // Time-range window (v0.9.0): the SAME tri-state resolution as
        // the sessions list above (contract #7) — the export is a
        // filtered-view snapshot. An unknown non-empty word is a loud
        // 400 here too; a legal window that matches nothing would be a
        // header-only CSV, but that cannot happen with the closed
        // vocabulary unless the db is that young.
        const exportRangeParamValue = requestContext.searchParams.get("range") ?? ""
        const exportRangeResolution = resolveSessionRange(exportRangeParamValue)
        if (exportRangeResolution.rangeKind === "invalid") {
          return { statusCode: 400, body: { error: INVALID_RANGE_MESSAGE } }
        }
        const exportRangeStartMs =
          exportRangeResolution.rangeKind === "window"
            ? exportRangeResolution.rangeStartMs
            : null
        const exportSummaries: SessionSummary[] = []
        // Full-pull semantics: page through at querySessionList's clamp
        // ceiling (limit 500 — its hard maximum, see
        // clampPaginationValue) until a short page. The live db
        // (~800 rows) therefore exports whole. The fixed ordering plus
        // the id ASC tie-break make the pagination deterministic: no
        // duplicated or skipped rows across page boundaries. The range
        // window rides EVERY page (contract #3) — same threshold, same
        // bind slot — so the no-dup/no-skip invariant holds on the
        // filtered subset exactly as it does unfiltered.
        const exportPageSize = 500
        for (let pageOffset = 0; ; pageOffset += exportPageSize) {
          // P2-4（v0.19.1）：CSV 不消费 modelIds，导出循环的每页查询
          // 关掉 step 富化——真库实测富化占导出耗时的大头（全表版
          // ~2.6s/次），而这里写出的列一个都不来自 step 数据。
          const summaryPage = querySessionList(
            database,
            exportPageSize,
            pageOffset,
            DEFAULT_SESSION_SORT_KEY,
            DEFAULT_SESSION_SORT_ORDER,
            exportDirectoryFilter,
            exportRangeStartMs,
            null,
            false,
          )
          // Unreachable with a non-null db; kept as belt-and-braces so a
          // mid-export null can never crash the handler.
          if (summaryPage === null) break
          exportSummaries.push(...summaryPage)
          if (summaryPage.length < exportPageSize) break
        }
        return {
          statusCode: 200,
          body: null,
          rawText: {
            text: renderSessionSummaryCsv(exportSummaries),
            contentType: SESSION_SUMMARY_CSV_CONTENT_TYPE,
            headers: {
              "Content-Disposition": `attachment; filename="${SESSION_SUMMARY_CSV_FILENAME}"`,
            },
          },
        }
      }
      default:
        return { statusCode: 404, body: { error: "not found" } }
    }
  } catch (queryError) {
    // The response body stays opaque (P2-11); the real cause is logged.
    console.error("opencode-db-insight: api query failed", queryError)
    return { statusCode: 500, body: { error: INTERNAL_ERROR_MESSAGE } }
  }
}

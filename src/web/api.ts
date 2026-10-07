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
 *   live SELECT 1 probe rather than connection-null-ness (P1-4).
 */

import type { SessionMessageRecord, SessionSummary, SqliteReadConnection } from "../db/types.ts"
import {
  DEFAULT_SESSION_SORT_KEY,
  DEFAULT_SESSION_SORT_ORDER,
  queryAgentStats,
  queryDailyTrend,
  queryModelMetrics,
  queryOverview,
  querySessionList,
  querySessionMessages,
  querySessionSummaryById,
  querySessionSystemPrompt,
  queryTodoStats,
  resolveSessionRange,
  resolveSessionSortKey,
  resolveSessionSortOrder,
} from "../db/queries.ts"
import {
  queryCompactionStats,
  queryHourHeatmap,
  querySessionSurvival,
} from "../db/behavior-queries.ts"
import {
  DEFAULT_DIRECTORY_LIMIT,
  MAX_DIRECTORY_LIMIT,
  queryDirectoryStats,
} from "../db/directory-queries.ts"
import { renderSessionMarkdown } from "../export/markdown.ts"
import {
  renderSessionSummaryCsv,
  SESSION_SUMMARY_CSV_CONTENT_TYPE,
  SESSION_SUMMARY_CSV_FILENAME,
} from "./session-summary-csv.ts"
import { buildCacheKey, cachedResult } from "../stats/cache.ts"
import { MAX_TREND_DAYS } from "../stats/daily-buckets.ts"
import {
  parseNonNegativeIntegerParam,
  parsePositiveIntegerParam,
  type InsightRoute,
} from "./router.ts"

/** Keep in sync with package.json version (bumped together in M7). */
export const INSIGHT_VERSION = "0.9.0"

export const DATABASE_UNAVAILABLE_MESSAGE =
  "opencode database unavailable: node:sqlite missing or db file not found"

/** 404 for sessions absent from the current tables (legacy or unknown). */
export const SESSION_NOT_FOUND_MESSAGE = "session not found in current tables"

/** 404 for sessions that exist in session_v2 but carry no messages (P2-7). */
export const SESSION_EMPTY_MESSAGE = "session exists but has no messages"

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
      status: "ok",
      version: INSIGHT_VERSION,
      port: requestContext.serverPort,
      dbStatus: databaseAlive ? "ok" : "unavailable",
      dbPath: requestContext.databasePath,
    },
  }
}

/**
 * Handle one matched API route. Pure bookkeeping around the cached queries;
 * unexpected database errors degrade to 500 {error} instead of crashing the
 * server process.
 */
export function handleApiRequest(requestContext: ApiRequestContext): ApiResponsePayload {
  const { route } = requestContext

  if (route.routeName === "health") return healthResponse(requestContext)

  const database = requestContext.database
  if (database === null) {
    return { statusCode: 503, body: { error: DATABASE_UNAVAILABLE_MESSAGE } }
  }

  try {
    switch (route.routeName) {
      case "overview": {
        const overview = cachedResult(buildCacheKey("queryOverview", []), () =>
          queryOverview(database),
        )
        return { statusCode: 200, body: overview }
      }
      case "trend": {
        const trendDays = parsePositiveIntegerParam(requestContext.searchParams, "days", 30)
        // Clamp before keying: both the cache key and the query see the
        // same bounded window, so ?days=1000 and ?days=366 share one entry
        // instead of spraying near-duplicates across the cache (P2-6).
        const boundedTrendDays = Math.min(trendDays, MAX_TREND_DAYS)
        const trendPoints = cachedResult(buildCacheKey("queryDailyTrend", [boundedTrendDays]), () =>
          queryDailyTrend(database, boundedTrendDays),
        )
        return { statusCode: 200, body: trendPoints }
      }
      case "models": {
        const modelMetrics = cachedResult(buildCacheKey("queryModelMetrics", []), () =>
          queryModelMetrics(database),
        )
        return { statusCode: 200, body: modelMetrics }
      }
      case "agents": {
        const agentStats = cachedResult(buildCacheKey("queryAgentStats", []), () =>
          queryAgentStats(database),
        )
        return { statusCode: 200, body: agentStats }
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
            ),
        )
        return { statusCode: 200, body: sessionPage }
      }
      case "todo": {
        const todoStats = cachedResult(buildCacheKey("queryTodoStats", []), () =>
          queryTodoStats(database),
        )
        return { statusCode: 200, body: todoStats }
      }
      case "hour-heatmap": {
        const heatmapDays = parsePositiveIntegerParam(requestContext.searchParams, "days", 90)
        // Same clamp-before-key discipline as the trend route (P2-6):
        // the query clamps internally, so the key must clamp too or
        // ?days=1000 and ?days=366 would cache the same result twice.
        const boundedHeatmapDays = Math.min(heatmapDays, MAX_TREND_DAYS)
        const heatmapCells = cachedResult(
          buildCacheKey("queryHourHeatmap", [boundedHeatmapDays]),
          () => queryHourHeatmap(database, boundedHeatmapDays),
        )
        return { statusCode: 200, body: heatmapCells }
      }
      case "session-survival": {
        const survivalStats = cachedResult(buildCacheKey("querySessionSurvival", []), () =>
          querySessionSurvival(database),
        )
        return { statusCode: 200, body: survivalStats }
      }
      case "compaction": {
        const compactionStats = cachedResult(buildCacheKey("queryCompactionStats", []), () =>
          queryCompactionStats(database),
        )
        return { statusCode: 200, body: compactionStats }
      }
      case "directories": {
        const directoryLimit = parsePositiveIntegerParam(
          requestContext.searchParams,
          "limit",
          DEFAULT_DIRECTORY_LIMIT,
        )
        // Clamp before keying (P2-6 discipline): the query clamps
        // internally, so the cache key must carry the clamped value too
        // or ?limit=999 and ?limit=50 would cache the same result twice.
        // Key prefix "directory-stats" (not "queryDirectoryStats") is a
        // deliberate, CHANGELOG-documented naming choice for this route.
        const boundedDirectoryLimit = Math.min(directoryLimit, MAX_DIRECTORY_LIMIT)
        const directoryStats = cachedResult(
          buildCacheKey("directory-stats", [boundedDirectoryLimit]),
          () => queryDirectoryStats(database, boundedDirectoryLimit),
        )
        return { statusCode: 200, body: directoryStats }
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
          const summaryPage = querySessionList(
            database,
            exportPageSize,
            pageOffset,
            DEFAULT_SESSION_SORT_KEY,
            DEFAULT_SESSION_SORT_ORDER,
            exportDirectoryFilter,
            exportRangeStartMs,
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

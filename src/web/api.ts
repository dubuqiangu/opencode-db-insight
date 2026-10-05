/**
 * API request handling: maps a matched route (router.ts) onto the M1 query
 * functions (src/db/queries.ts) behind the 60s TTL cache (src/stats/cache.ts).
 *
 * Status conventions (DESIGN.md §6/§9/§10):
 * - db unavailable (node:sqlite missing or file absent) → 503 {error};
 * - session absent from session_message (legacy pre-2026-09-23 tables) →
 *   404 {error: "session not found in current tables"};
 * - /api/health always answers 200 and carries dbStatus for probing.
 */

import type { SessionMessageRecord, SessionSummary, SqliteReadConnection } from "../db/types.ts"
import {
  queryAgentStats,
  queryDailyTrend,
  queryModelMetrics,
  queryOverview,
  querySessionList,
  querySessionMessages,
  querySessionSystemPrompt,
  queryTodoStats,
} from "../db/queries.ts"
import { renderSessionMarkdown } from "../export/markdown.ts"
import { buildCacheKey, cachedResult } from "../stats/cache.ts"
import {
  parseNonNegativeIntegerParam,
  parsePositiveIntegerParam,
  type InsightRoute,
} from "./router.ts"

/** Keep in sync with package.json version (bumped together in M7). */
export const INSIGHT_VERSION = "0.0.1"

export const DATABASE_UNAVAILABLE_MESSAGE =
  "opencode database unavailable: node:sqlite missing or db file not found"

export const SESSION_NOT_FOUND_MESSAGE = "session not found in current tables"

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

/** Page size for the session-id lookup scan below (session_v2 only). */
const SESSION_LOOKUP_PAGE_SIZE = 500

/**
 * Find one session's summary by id via the paginated session list. Returns
 * null for unknown ids — which is exactly how legacy pre-2026-09-23 sessions
 * (absent from session_v2) surface as 404 to callers.
 */
export function findSessionSummaryById(
  database: SqliteReadConnection,
  sessionId: string,
): SessionSummary | null {
  for (let pageOffset = 0; ; pageOffset += SESSION_LOOKUP_PAGE_SIZE) {
    const sessionPage = querySessionList(database, SESSION_LOOKUP_PAGE_SIZE, pageOffset)
    if (sessionPage === null) return null
    const foundSession = sessionPage.find((sessionSummary) => sessionSummary.id === sessionId)
    if (foundSession !== undefined) return foundSession
    if (sessionPage.length < SESSION_LOOKUP_PAGE_SIZE) return null
  }
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

/** Health probe always succeeds; dbStatus tells the real story. */
function healthResponse(requestContext: ApiRequestContext): ApiResponsePayload {
  return {
    statusCode: 200,
    body: {
      status: "ok",
      version: INSIGHT_VERSION,
      port: requestContext.serverPort,
      dbStatus: requestContext.database === null ? "unavailable" : "ok",
      dbPath: requestContext.databasePath,
    },
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
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
        const trendPoints = cachedResult(buildCacheKey("queryDailyTrend", [trendDays]), () =>
          queryDailyTrend(database, trendDays),
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
        const sessionPage = cachedResult(
          buildCacheKey("querySessionList", [sessionLimit, sessionOffset]),
          () => querySessionList(database, sessionLimit, sessionOffset),
        )
        return { statusCode: 200, body: sessionPage }
      }
      case "todo": {
        const todoStats = cachedResult(buildCacheKey("queryTodoStats", []), () =>
          queryTodoStats(database),
        )
        return { statusCode: 200, body: todoStats }
      }
      case "sessionMessages": {
        const messageRecords = cachedResult(
          buildCacheKey("querySessionMessages", [route.sessionId]),
          () => querySessionMessages(database, route.sessionId),
        )
        if (messageRecords === null || messageRecords.length === 0) {
          return { statusCode: 404, body: { error: SESSION_NOT_FOUND_MESSAGE } }
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
        const messageRecords = querySessionMessages(database, route.sessionId)
        if (sessionSummary === null || messageRecords === null || messageRecords.length === 0) {
          return { statusCode: 404, body: { error: SESSION_NOT_FOUND_MESSAGE } }
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
      default:
        return { statusCode: 404, body: { error: "not found" } }
    }
  } catch (queryError) {
    return { statusCode: 500, body: { error: `internal error: ${describeError(queryError)}` } }
  }
}

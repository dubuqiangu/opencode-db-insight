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

import type { SqliteReadConnection } from "../db/types.ts"
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
      default:
        return { statusCode: 404, body: { error: "not found" } }
    }
  } catch (queryError) {
    return { statusCode: 500, body: { error: `internal error: ${describeError(queryError)}` } }
  }
}

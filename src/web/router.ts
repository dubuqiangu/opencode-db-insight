/**
 * Pure route matching and query-parameter parsing for the insight API
 * (DESIGN.md §6). No IO — fully unit-testable.
 *
 * Wire conventions: all API paths live under /api/; a session id may be
 * percent-encoded and is decoded here; malformed encodings fail the match.
 */

/** One matched API route, with its path parameters already extracted. */
export type InsightRoute =
  | { routeName: "health" }
  | { routeName: "overview" }
  | { routeName: "trend" }
  | { routeName: "models" }
  | { routeName: "tool-health" }
  | { routeName: "agents" }
  | { routeName: "sessions" }
  | { routeName: "todo" }
  | { routeName: "hour-heatmap" }
  | { routeName: "session-survival" }
  | { routeName: "compaction" }
  | { routeName: "directories" }
  | { routeName: "session-distribution" }
  | { routeName: "step-distribution" }
  | { routeName: "duration-distribution" }
  | { routeName: "child-share" }
  // v0.22.0 B 档：工具错误逐日趋势与会话结局两个「全部会话」口径端点。
  | { routeName: "tool-error-trend" }
  | { routeName: "session-outcomes" }
  | { routeName: "refresh" }
  | { routeName: "sessionMessages"; sessionId: string }
  | { routeName: "sessionSystemPrompt"; sessionId: string }
  | { routeName: "sessionExport"; sessionId: string }
  | { routeName: "sessionSummaryExport" }

/** Percent-decode a single path segment; malformed encoding yields "". */
function decodePathSegment(segment: string): string {
  try {
    return decodeURIComponent(segment)
  } catch {
    return ""
  }
}

/**
 * Match an URL pathname (e.g. "/api/session/ses_1/messages") against the
 * route table. Trailing slashes are tolerated; anything unmatched returns
 * null (caller answers 404).
 */
export function matchApiRoute(pathname: string): InsightRoute | null {
  const trimmedPathname =
    pathname.length > 1 && pathname.endsWith("/") ? pathname.slice(0, -1) : pathname
  const pathSegments = trimmedPathname.split("/").filter((segment) => segment !== "")
  if (pathSegments[0] !== "api") return null

  const routeSegment = pathSegments[1]
  switch (routeSegment) {
    case undefined:
      return null // "/api" alone matches nothing
    case "health":
    case "overview":
    case "trend":
    case "models":
    case "tool-health":
    case "agents":
    case "sessions":
    case "todo":
    case "hour-heatmap":
    case "session-survival":
    case "compaction":
    case "directories":
    // v0.20.0 会话 tokens 总量分布端点：「全部会话」口径，不吃
    // ?session= 参数，与上面两个面板路由同一两段形状。
    case "session-distribution":
    // v0.21.0 步数 / 时长分布与子会话占比端点：同为「全部会话」口径、
    // 不吃 ?session=，与 token 分布同一两段形状。
    case "step-distribution":
    case "duration-distribution":
    case "child-share":
    // v0.22.0 B 档工具错误趋势 / 会话结局端点：同为「全部会话」口径、
    // 不吃 ?session=，与 token 分布同一两段形状。
    case "tool-error-trend":
    case "session-outcomes":
    // "refresh" is the cache-control plane (v0.14.0), not a panel, but
    // it shares the same two-segment shape — and like the panel routes
    // it never carries path parameters.
    case "refresh": {
      if (pathSegments.length !== 2) return null
      // routeSegment is narrowed to one of the literal two-segment
      // route names listed above (matchApiRoute only reaches the body
      // for exactly these cases).
      return { routeName: routeSegment }
    }
    case "session": {
      if (pathSegments.length !== 4) return null
      const sessionId = decodePathSegment(pathSegments[2])
      if (sessionId === "") return null
      if (pathSegments[3] === "messages") return { routeName: "sessionMessages", sessionId }
      if (pathSegments[3] === "system-prompt") return { routeName: "sessionSystemPrompt", sessionId }
      return null
    }
    case "export": {
      // /api/export/sessions.csv — the session-summary CSV export
      // (v0.8.0); the ".csv" suffix is as literal as the ".md" one
      // below. The two export shapes coexist: [export, sessions.csv]
      // (3 segments) vs [export, session, :id.md] (4 segments).
      if (pathSegments.length === 3 && pathSegments[2] === "sessions.csv") {
        return { routeName: "sessionSummaryExport" }
      }
      // /api/export/session/:id.md — the ".md" suffix is literal (DESIGN §6).
      if (pathSegments.length !== 4 || pathSegments[2] !== "session") return null
      const sessionSegment = pathSegments[3]
      if (!sessionSegment.endsWith(".md")) return null
      const sessionId = decodePathSegment(sessionSegment.slice(0, -3))
      if (sessionId === "") return null
      return { routeName: "sessionExport", sessionId }
    }
    default:
      return null
  }
}

/**
 * Parse a query parameter as a positive integer (> 0); missing, empty,
 * non-integer, zero or negative values fall back to the default
 * (DESIGN.md M2: 坏 query 参数用默认值).
 */
export function parsePositiveIntegerParam(
  searchParams: URLSearchParams,
  paramName: string,
  defaultValue: number,
): number {
  const rawValue = searchParams.get(paramName)
  if (rawValue === null || rawValue === "") return defaultValue
  const parsedValue = Number(rawValue)
  if (!Number.isInteger(parsedValue) || parsedValue <= 0) return defaultValue
  return parsedValue
}

/** Like parsePositiveIntegerParam but also accepts 0 (for offsets). */
export function parseNonNegativeIntegerParam(
  searchParams: URLSearchParams,
  paramName: string,
  defaultValue: number,
): number {
  const rawValue = searchParams.get(paramName)
  if (rawValue === null || rawValue === "") return defaultValue
  const parsedValue = Number(rawValue)
  if (!Number.isInteger(parsedValue) || parsedValue < 0) return defaultValue
  return parsedValue
}

/**
 * /insight-refresh command logic (v0.14.0): clear the insight server's
 * 60s result cache on demand.
 *
 * Process topology (the trap this design exists for): the TUI plugin
 * flavor (./tui) and the server plugin flavor (.) run in DIFFERENT
 * processes — the result cache is a module-level Map inside the server
 * process. A direct `import { clearResultCache }` from here would clear
 * the TUI process's own (empty) Map: a silent no-op. The correct route
 * is loopback HTTP — GET /api/refresh on the port the server flavor
 * published in storage, which clears the cache where it actually
 * lives.
 *
 * The dashboard page has no auto-polling, so the success toast tells
 * the user to reload the page (static assets are Cache-Control: no-store
 * — an F5 always picks up fresh API data once the cache is empty).
 *
 * Same never-throw discipline as open-dashboard-command: every failure
 * path toasts a hint and returns false.
 */

import { readInsightServerPort, showInsightToast } from "./tui-context.ts"

/** Refresh request budget (v0.14.0); mirrors data-source.js's 5s gate. */
const REFRESH_REQUEST_TIMEOUT_MS = 5_000

/** Loopback refresh endpoint URL for one bound insight server port. */
export function buildRefreshUrl(serverPort: number): string {
  return `http://127.0.0.1:${serverPort}/api/refresh`
}

/**
 * Abort budget for the loopback call, mirroring data-source.js:170-174 —
 * AbortSignal.timeout when the platform ships it, undefined (no abort
 * pressure) otherwise; a hung loopback fetch must never hang the TUI.
 */
function buildRefreshTimeoutSignal(): AbortSignal | undefined {
  return typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function"
    ? AbortSignal.timeout(REFRESH_REQUEST_TIMEOUT_MS)
    : undefined
}

/**
 * The minimal response shape the refresh command reads off fetch — a
 * structural type so tests can pass a plain fake without building a
 * real Response.
 */
export interface RefreshFetchResponse {
  ok: boolean
  status: number
  json: () => Promise<unknown>
}

/** Injectable fetch shape; the global fetch satisfies it structurally. */
export type RefreshFetch = (
  refreshUrl: string,
  requestInit?: { signal?: AbortSignal },
) => Promise<RefreshFetchResponse>

/** Injectable knobs for tests; production calls use the defaults. */
export interface RefreshCommandDependencies {
  /** Fetch implementation that reaches the loopback refresh route. */
  fetchImpl?: RefreshFetch
  /** Port reader override (defaults to readInsightServerPort). */
  readPortImpl?: (context: unknown) => Promise<number | null>
}

/** Wire shape of GET /api/refresh, as far as the toast needs it. */
interface RefreshResponseBody {
  status?: unknown
  cleared?: unknown
}

/**
 * Run /insight-refresh: read the published port, call the loopback
 * refresh route, toast the evicted entry count. Returns true when the
 * server reported a successful clear; every failure path (no port,
 * timeout, non-200, malformed body) toasts an error and returns false —
 * the command never throws.
 */
export async function runRefreshCommand(
  context: unknown,
  dependencies: RefreshCommandDependencies = {},
): Promise<boolean> {
  try {
    const readServerPort = dependencies.readPortImpl ?? readInsightServerPort
    const fetchImpl = dependencies.fetchImpl ?? fetch
    const serverPort = await readServerPort(context)
    if (serverPort === null) {
      showInsightToast(context, "db-insight: 看板服务未启动（storage 中无端口记录）", "error")
      return false
    }

    const response = await fetchImpl(buildRefreshUrl(serverPort), {
      signal: buildRefreshTimeoutSignal(),
    })
    if (!response.ok) {
      showInsightToast(context, `db-insight: 刷新缓存失败：HTTP ${response.status}`, "error")
      return false
    }

    const parsedBody = (await response.json()) as RefreshResponseBody | null
    const clearedCount = Number(parsedBody?.cleared)
    if (parsedBody?.status !== "ok" || !Number.isInteger(clearedCount)) {
      showInsightToast(context, "db-insight: 刷新缓存失败：响应格式异常", "error")
      return false
    }

    showInsightToast(
      context,
      `db-insight: 已清除 ${clearedCount} 条统计缓存（看板刷新页面后生效）`,
      "success",
    )
    return true
  } catch (commandError) {
    showInsightToast(
      context,
      `db-insight: 刷新缓存失败：${commandError instanceof Error ? commandError.message : String(commandError)}`,
      "error",
    )
    return false
  }
}

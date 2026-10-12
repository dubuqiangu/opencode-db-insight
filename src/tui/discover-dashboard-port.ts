/**
 * TUI-side dashboard port discovery (P0 fix for /insight + /insight-refresh).
 *
 * Why probing at all: the TUI plugin flavor and the server plugin flavor
 * run in DIFFERENT processes. The TUI host's storage surface
 * (node_modules/@opencode/plugin/dist/tui/context.d.ts) only exposes
 * store/memory key-value stores — there is no `get` reader, and even if
 * there were, the TUI process's storage backend is not the server
 * process's backend, so a port the server wrote would never arrive
 * here. @opencode/client exposes no storage API either. The one channel
 * that reaches the server process is loopback HTTP.
 *
 * Strategy: the server binds 127.0.0.1 starting at port 18789 and retries
 * port+1 on EADDRINUSE at most 10 times (src/web/server.ts), so a live
 * server always answers somewhere in 18789..18798. Probe all ten ports
 * concurrently (Promise.allSettled, ~400ms per-port budget, well under 1s
 * total) against GET /api/health and accept only bodies carrying our
 * service identity — a foreign process squatting in the range is
 * ignored by the shape check.
 */

import { INSIGHT_SERVICE_NAME } from "../insight-service-identity.ts"

/**
 * First port the server flavor may bind. Must stay in sync with
 * src/web/server.ts DEFAULT_INSIGHT_PORT (kept as a literal here so the
 * TUI process never imports the server module).
 */
export const DASHBOARD_DISCOVERY_FIRST_PORT = 18_789

/**
 * Last port of the discovery range: FIRST + MAX_PORT_ATTEMPTS - 1.
 * Must stay in sync with src/web/server.ts MAX_PORT_ATTEMPTS.
 */
export const DASHBOARD_DISCOVERY_LAST_PORT = 18_798

/** Per-port probe budget; the concurrent sweep stays well under 1s total. */
const HEALTH_PROBE_TIMEOUT_MS = 400

/**
 * Error toast for the no-server case; names the probed range so the user
 * can tell this is a discovery-based diagnosis, not a storage lookup.
 */
export const DASHBOARD_NOT_RUNNING_MESSAGE =
  "db-insight: 看板服务未启动（127.0.0.1:18789-18798 无健康响应）——请确认插件已启用并重启 OpenCode"

/**
 * The minimal response shape the health probe reads off fetch — a
 * structural type so tests can pass a plain fake without building a real
 * Response.
 */
export interface HealthProbeFetchResponse {
  ok: boolean
  json(): Promise<unknown>
}

/** Injectable fetch shape; the global fetch satisfies it structurally. */
export type HealthProbeFetch = (
  healthUrl: string,
  requestInit?: { signal?: AbortSignal },
) => Promise<HealthProbeFetchResponse>

/** Wire shape of GET /api/health as far as discovery cares. */
interface InsightHealthBody {
  service?: unknown
  status?: unknown
}

/**
 * Pure: does this health body belong to the insight server? The service
 * identity is the anti-false-positive gate — other processes listening in
 * the same port range fail here and get ignored.
 */
export function isInsightHealthBody(healthBody: unknown): boolean {
  if (typeof healthBody !== "object" || healthBody === null) return false
  const bodyRecord = healthBody as InsightHealthBody
  return bodyRecord.service === INSIGHT_SERVICE_NAME && bodyRecord.status === "ok"
}

/** AbortSignal.timeout when the platform ships it, undefined otherwise. */
function buildProbeTimeoutSignal(): AbortSignal | undefined {
  return typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function"
    ? AbortSignal.timeout(HEALTH_PROBE_TIMEOUT_MS)
    : undefined
}

/**
 * Resolve to null when the probe neither settles nor aborts in time —
 * a hung fetch must never hang the whole discovery sweep.
 */
function withProbeTimeout(probeOutcome: Promise<number | null>): Promise<number | null> {
  return new Promise((resolve) => {
    const timeoutHandle = setTimeout(() => resolve(null), HEALTH_PROBE_TIMEOUT_MS)
    // A pending probe timer must never hold the event loop open by itself.
    if (typeof timeoutHandle.unref === "function") timeoutHandle.unref()
    probeOutcome.then(
      (probedPort) => {
        clearTimeout(timeoutHandle)
        resolve(probedPort)
      },
      () => {
        clearTimeout(timeoutHandle)
        resolve(null)
      },
    )
  })
}

/**
 * Probe one candidate port; resolves to the port on a valid insight
 * health answer, null on refusal, non-2xx, malformed body, error or
 * timeout. Never rejects.
 */
function probePortForInsightServer(
  candidatePort: number,
  fetchImpl: HealthProbeFetch,
): Promise<number | null> {
  const healthUrl = `http://127.0.0.1:${candidatePort}/api/health`
  const probeOutcome = fetchImpl(healthUrl, { signal: buildProbeTimeoutSignal() }).then(
    async (response) => {
      if (!response.ok) return null
      return isInsightHealthBody(await response.json()) ? candidatePort : null
    },
  )
  return withProbeTimeout(probeOutcome)
}

/** Injectable knobs; production calls use the defaults. */
export interface DiscoverDashboardPortDependencies {
  /** Fetch implementation the health probes use (tests inject fakes). */
  fetchImpl?: HealthProbeFetch
}

/**
 * Discover the port the insight dashboard server listens on: probe
 * 127.0.0.1:18789..18798 concurrently against GET /api/health and accept
 * only bodies carrying the insight service identity. Resolves to the
 * lowest port that answered as the insight server, or null when none did
 * (the server flavor is not running). Never rejects.
 */
export async function discoverInsightDashboardPort(
  dependencies: DiscoverDashboardPortDependencies = {},
): Promise<number | null> {
  const fetchImpl = dependencies.fetchImpl ?? fetch
  const candidatePorts: number[] = []
  for (
    let candidatePort = DASHBOARD_DISCOVERY_FIRST_PORT;
    candidatePort <= DASHBOARD_DISCOVERY_LAST_PORT;
    candidatePort += 1
  ) {
    candidatePorts.push(candidatePort)
  }

  const probeOutcomes = await Promise.allSettled(
    candidatePorts.map((candidatePort) => probePortForInsightServer(candidatePort, fetchImpl)),
  )
  const discoveredPorts = probeOutcomes.flatMap((probeOutcome) =>
    probeOutcome.status === "fulfilled" && probeOutcome.value !== null
      ? [probeOutcome.value]
      : [],
  )
  if (discoveredPorts.length === 0) return null
  return Math.min(...discoveredPorts)
}

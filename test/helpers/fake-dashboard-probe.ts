/**
 * Shared fixture for TUI command/discovery tests: a fake health-probe
 * fetch that answers the insight discovery range without ever touching a
 * real socket (fixture discipline: no real network, no real ports).
 */

import type { HealthProbeFetch } from "../../src/tui/discover-dashboard-port.ts"

/** Valid /api/health body fixture (mirrors src/web/api.ts healthResponse). */
export function buildValidInsightHealthBody(): Record<string, unknown> {
  return { service: "opencode-db-insight", status: "ok", version: "0.15.3", port: 18789 }
}

/**
 * Fake probe fetch: ports present in `healthBodyByPort` answer with that
 * body (HTTP-200 shape); every other port refuses the connection, the
 * common all-ports-dead case. Records every requested probe URL.
 */
export function buildRecordingDashboardProbeFetch(
  healthBodyByPort: Record<number, unknown>,
): {
  probeFetch: HealthProbeFetch
  requestedProbeUrls: string[]
} {
  const requestedProbeUrls: string[] = []
  const probeFetch: HealthProbeFetch = async (probeUrl) => {
    requestedProbeUrls.push(probeUrl)
    const portMatch = /:(\d+)\/api\/health$/.exec(probeUrl)
    if (portMatch === null) throw new Error(`unexpected probe url: ${probeUrl}`)
    const probedPort = Number(portMatch[1])
    if (!Object.prototype.hasOwnProperty.call(healthBodyByPort, probedPort)) {
      throw new Error(`connection refused (fixture): ${probedPort}`)
    }
    return { ok: true, json: async () => healthBodyByPort[probedPort] }
  }
  return { probeFetch, requestedProbeUrls }
}

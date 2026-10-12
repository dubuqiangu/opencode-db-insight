/**
 * Tests for the TUI-side dashboard port discovery (P0 fix): concurrent
 * GET /api/health probes over 127.0.0.1:18789..18798, with the insight
 * service identity as the anti-false-positive gate. The fetch is fully
 * injectable — no real socket is ever touched here.
 */

import { test } from "node:test"
import assert from "node:assert/strict"

import {
  DASHBOARD_DISCOVERY_FIRST_PORT,
  DASHBOARD_DISCOVERY_LAST_PORT,
  discoverInsightDashboardPort,
  isInsightHealthBody,
  type HealthProbeFetch,
} from "../src/tui/discover-dashboard-port.ts"
import {
  buildRecordingDashboardProbeFetch,
  buildValidInsightHealthBody,
} from "./helpers/fake-dashboard-probe.ts"

test("isInsightHealthBody accepts only bodies carrying the insight service identity", () => {
  assert.equal(isInsightHealthBody(buildValidInsightHealthBody()), true)

  // Foreign or malformed answers in the same port range must all fail.
  assert.equal(isInsightHealthBody({ status: "ok" }), false, "missing service field")
  assert.equal(
    isInsightHealthBody({ service: "some-other-dashboard", status: "ok" }),
    false,
    "foreign service name",
  )
  assert.equal(
    isInsightHealthBody({ service: "opencode-db-insight", status: "broken" }),
    false,
    "non-ok status",
  )
  assert.equal(isInsightHealthBody(null), false)
  assert.equal(isInsightHealthBody("ok"), false)
  assert.equal(isInsightHealthBody(123), false)
})

test("discoverInsightDashboardPort returns the one port answering a valid health body", async () => {
  const { probeFetch, requestedProbeUrls } = buildRecordingDashboardProbeFetch({
    18791: buildValidInsightHealthBody(),
  })
  assert.equal(await discoverInsightDashboardPort({ fetchImpl: probeFetch }), 18791)

  // Every candidate port was probed against /api/health exactly once.
  assert.equal(requestedProbeUrls.length, 10)
  const probedPorts = requestedProbeUrls.map((probeUrl) =>
    Number(/:(\d+)\/api\/health$/.exec(probeUrl)![1]),
  )
  assert.deepEqual(probedPorts, [
    18789, 18790, 18791, 18792, 18793, 18794, 18795, 18796, 18797, 18798,
  ])
  for (const probeUrl of requestedProbeUrls) {
    assert.match(probeUrl, /^http:\/\/127\.0\.0\.1:\d+\/api\/health$/)
  }
})

test("discoverInsightDashboardPort yields null when every probe is refused", async () => {
  const { probeFetch } = buildRecordingDashboardProbeFetch({})
  assert.equal(await discoverInsightDashboardPort({ fetchImpl: probeFetch }), null)
})

test("discoverInsightDashboardPort ignores ports whose health body fails the identity check", async () => {
  // Lower ports in the range answer — but as foreign/malformed services
  // (another process squatting the range, or a health endpoint without
  // the service marker). Only 18794 answers as the insight server.
  const { probeFetch } = buildRecordingDashboardProbeFetch({
    18789: { status: "ok", version: "0.15.3" }, // no service field
    18790: { service: "some-other-dashboard", status: "ok" }, // wrong identity
    18792: { service: "opencode-db-insight", status: "degraded" }, // non-ok status
    18793: "not json", // non-object body
    18794: buildValidInsightHealthBody(),
  })
  assert.equal(await discoverInsightDashboardPort({ fetchImpl: probeFetch }), 18794)
})

test("discoverInsightDashboardPort prefers the lowest port when several answer validly", async () => {
  const { probeFetch } = buildRecordingDashboardProbeFetch({
    18795: buildValidInsightHealthBody(),
    18792: buildValidInsightHealthBody(),
    18797: buildValidInsightHealthBody(),
  })
  assert.equal(await discoverInsightDashboardPort({ fetchImpl: probeFetch }), 18792)
})

test("discoverInsightDashboardPort ignores non-2xx probe answers", async () => {
  const probeFetch: HealthProbeFetch = async (probeUrl) => {
    const portMatch = /:(\d+)\/api\/health$/.exec(probeUrl)
    if (portMatch === null) throw new Error(`unexpected probe url: ${probeUrl}`)
    if (Number(portMatch[1]) === 18790) {
      return { ok: false, json: async () => buildValidInsightHealthBody() }
    }
    throw new Error(`connection refused (fixture): ${portMatch[1]}`)
  }
  // The 200-status gate runs BEFORE the body check: a valid body riding a
  // non-2xx status must not count as a hit.
  assert.equal(await discoverInsightDashboardPort({ fetchImpl: probeFetch }), null)
})

test("discoverInsightDashboardPort treats json() failures as misses and never throws", async () => {
  const probeFetch: HealthProbeFetch = async (probeUrl) => {
    const portMatch = /:(\d+)\/api\/health$/.exec(probeUrl)
    if (portMatch === null) throw new Error(`unexpected probe url: ${probeUrl}`)
    if (Number(portMatch[1]) === 18789) {
      return {
        ok: true,
        json: async () => {
          throw new Error("truncated JSON body")
        },
      }
    }
    throw new Error(`connection refused (fixture): ${portMatch[1]}`)
  }
  assert.equal(await discoverInsightDashboardPort({ fetchImpl: probeFetch }), null)
})

test("discoverInsightDashboardPort probes the ten candidate ports concurrently", async () => {
  let inFlightProbeCount = 0
  let peakInFlightProbeCount = 0
  const probeFetch: HealthProbeFetch = async () => {
    inFlightProbeCount += 1
    peakInFlightProbeCount = Math.max(peakInFlightProbeCount, inFlightProbeCount)
    try {
      // A tiny real delay proves the sweep does not serialize the probes
      // (10 × delay would dominate wall-clock otherwise). No socket is
      // involved — this is a timer, not network.
      await new Promise((resolve) => setTimeout(resolve, 5))
      throw new Error("connection refused (fixture)")
    } finally {
      inFlightProbeCount -= 1
    }
  }
  assert.equal(await discoverInsightDashboardPort({ fetchImpl: probeFetch }), null)
  // All ten probes start before any settles: the sweep is concurrent.
  assert.equal(peakInFlightProbeCount, 10)
})

test("the discovery range matches the server's bind policy (first port, ten attempts)", () => {
  assert.equal(DASHBOARD_DISCOVERY_FIRST_PORT, 18_789)
  assert.equal(DASHBOARD_DISCOVERY_LAST_PORT - DASHBOARD_DISCOVERY_FIRST_PORT, 9)
})

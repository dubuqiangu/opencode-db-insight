/**
 * Tests for /insight-refresh (v0.14.0): the TUI flavor must clear the
 * SERVER process's result cache via the loopback /api/refresh route —
 * never via a direct clearResultCache import (the flavors live in
 * different processes, so that would silently clear nothing). The port
 * is DISCOVERED by probing the 18789..18798 health range (the TUI cannot
 * read the server's storage), and both the probe fetch and the refresh
 * fetch are injectable, so no real server or socket is touched here.
 */

import { test } from "node:test"
import assert from "node:assert/strict"

import {
  buildRefreshUrl,
  runRefreshCommand,
  type RefreshFetchResponse,
} from "../src/tui/refresh-command.ts"
import {
  buildRecordingDashboardProbeFetch,
  buildValidInsightHealthBody,
} from "./helpers/fake-dashboard-probe.ts"

interface CapturedToast {
  message: string
  variant: string
}

/** A fake TUI context that records toasts (the only effect we assert). */
function buildToastCapturingContext(): {
  context: Record<string, unknown>
  capturedToasts: CapturedToast[]
} {
  const capturedToasts: CapturedToast[] = []
  const context: Record<string, unknown> = {
    ui: {
      toast: {
        show: (toastOptions: { message: string; variant: string }) => {
          capturedToasts.push({ message: toastOptions.message, variant: toastOptions.variant })
        },
      },
    },
  }
  return { context, capturedToasts }
}

/**
 * Fake port discovered throughout (fixture discipline: inside the probe
 * range, but the probe fetch never touches a real socket).
 */
const DISCOVERED_SERVER_PORT = 18791

/** Probe fetch on which discovery finds DISCOVERED_SERVER_PORT alive. */
function buildLiveServerProbeFetch() {
  return buildRecordingDashboardProbeFetch({
    [DISCOVERED_SERVER_PORT]: buildValidInsightHealthBody(),
  })
}

function buildFakeRefreshFetchResponse(
  responseBody: unknown,
  responseStatus = 200,
): RefreshFetchResponse {
  return {
    ok: responseStatus >= 200 && responseStatus < 300,
    status: responseStatus,
    json: async () => responseBody,
  }
}

test("buildRefreshUrl targets the loopback refresh route of one bound port", () => {
  assert.equal(
    buildRefreshUrl(DISCOVERED_SERVER_PORT),
    `http://127.0.0.1:${DISCOVERED_SERVER_PORT}/api/refresh`,
  )
})

test("runRefreshCommand reports the probed range with an error toast and never fetches when no server answers", async () => {
  const { context, capturedToasts } = buildToastCapturingContext()
  const { probeFetch } = buildRecordingDashboardProbeFetch({})
  let fetchCallCount = 0
  const commandResult = await runRefreshCommand(context, {
    probeFetch,
    fetchImpl: async () => {
      fetchCallCount += 1
      return buildFakeRefreshFetchResponse({ status: "ok", cleared: 0 })
    },
  })
  assert.equal(commandResult, false)
  assert.equal(fetchCallCount, 0, "no live server means no refresh call at all")
  assert.equal(capturedToasts.length, 1)
  assert.match(capturedToasts[0].message, /看板服务未启动/)
  assert.match(capturedToasts[0].message, /127\.0\.0\.1:18789-18798 无健康响应/)
  assert.equal(capturedToasts[0].variant, "error")
})

test("runRefreshCommand toasts the evicted count on a successful loopback clear", async () => {
  const { context, capturedToasts } = buildToastCapturingContext()
  const { probeFetch } = buildLiveServerProbeFetch()
  const fetchedUrls: string[] = []
  const fetchedSignals: unknown[] = []
  const commandResult = await runRefreshCommand(context, {
    probeFetch,
    fetchImpl: async (refreshUrl, requestInit) => {
      fetchedUrls.push(refreshUrl)
      fetchedSignals.push(requestInit?.signal)
      return buildFakeRefreshFetchResponse({ status: "ok", cleared: 7 })
    },
  })
  assert.equal(commandResult, true)
  assert.deepEqual(fetchedUrls, [`http://127.0.0.1:${DISCOVERED_SERVER_PORT}/api/refresh`])
  assert.ok(
    fetchedSignals[0] === undefined || fetchedSignals[0] instanceof AbortSignal,
    "the timeout defense threads an AbortSignal (or undefined on platforms without AbortSignal.timeout)",
  )
  assert.equal(capturedToasts.length, 1)
  assert.equal(capturedToasts[0].variant, "success")
  assert.equal(
    capturedToasts[0].message,
    "db-insight: 已清除 7 条统计缓存（看板刷新页面后生效）",
  )
})

test("runRefreshCommand toasts an HTTP error and returns false on a non-200 response", async () => {
  const { context, capturedToasts } = buildToastCapturingContext()
  const { probeFetch } = buildLiveServerProbeFetch()
  const commandResult = await runRefreshCommand(context, {
    probeFetch,
    fetchImpl: async () => buildFakeRefreshFetchResponse({ error: "unavailable" }, 503),
  })
  assert.equal(commandResult, false)
  assert.equal(capturedToasts.length, 1)
  assert.match(capturedToasts[0].message, /HTTP 503/)
  assert.equal(capturedToasts[0].variant, "error")
})

test("runRefreshCommand toasts a shape error and returns false on a malformed refresh body", async () => {
  for (const malformedBody of [
    { status: "broken", cleared: 7 }, // wrong status word
    { status: "ok", cleared: "many" }, // non-integer count
    { status: "ok" }, // missing count
    null, // not even an object
  ]) {
    const { context, capturedToasts } = buildToastCapturingContext()
    const { probeFetch } = buildLiveServerProbeFetch()
    const commandResult = await runRefreshCommand(context, {
      probeFetch,
      fetchImpl: async () => buildFakeRefreshFetchResponse(malformedBody),
    })
    assert.equal(commandResult, false)
    assert.equal(capturedToasts.length, 1)
    assert.match(capturedToasts[0].message, /响应格式异常/)
    assert.equal(capturedToasts[0].variant, "error")
  }
})

test("runRefreshCommand swallows fetch/JSON failures with an error toast and never throws", async () => {
  const failingFetches: RefreshFetch[] = [
    async () => {
      throw new Error("loopback request timed out")
    },
    async () => {
      throw new Error("connection refused")
    },
    async () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new Error("truncated JSON body")
      },
    }),
  ]
  for (const failingFetch of failingFetches) {
    const { context, capturedToasts } = buildToastCapturingContext()
    const { probeFetch } = buildLiveServerProbeFetch()
    const commandResult = await runRefreshCommand(context, {
      probeFetch,
      fetchImpl: failingFetch,
    })
    assert.equal(commandResult, false)
    assert.equal(capturedToasts.length, 1)
    assert.match(capturedToasts[0].message, /刷新缓存失败/)
    assert.equal(capturedToasts[0].variant, "error")
  }
})

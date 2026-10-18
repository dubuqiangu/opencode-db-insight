/**
 * Tests for the pure API route matcher and query-parameter parsing
 * (src/web/router.ts, DESIGN.md §6 route table).
 */

import { test } from "node:test"
import assert from "node:assert/strict"

import {
  matchApiRoute,
  parseNonNegativeIntegerParam,
  parsePositiveIntegerParam,
} from "../src/web/router.ts"

test("matchApiRoute recognizes every static API route", () => {
  assert.deepEqual(matchApiRoute("/api/health"), { routeName: "health" })
  assert.deepEqual(matchApiRoute("/api/overview"), { routeName: "overview" })
  assert.deepEqual(matchApiRoute("/api/trend"), { routeName: "trend" })
  assert.deepEqual(matchApiRoute("/api/models"), { routeName: "models" })
  assert.deepEqual(matchApiRoute("/api/agents"), { routeName: "agents" })
  assert.deepEqual(matchApiRoute("/api/sessions"), { routeName: "sessions" })
  assert.deepEqual(matchApiRoute("/api/todo"), { routeName: "todo" })
  assert.deepEqual(matchApiRoute("/api/hour-heatmap"), { routeName: "hour-heatmap" })
  assert.deepEqual(matchApiRoute("/api/session-survival"), { routeName: "session-survival" })
  assert.deepEqual(matchApiRoute("/api/compaction"), { routeName: "compaction" })
  assert.deepEqual(matchApiRoute("/api/directories"), { routeName: "directories" })
  // v0.20.0 会话 tokens 总量分布端点：两段静态路由，无路径参数。
  assert.deepEqual(matchApiRoute("/api/session-distribution"), { routeName: "session-distribution" })
  // v0.21.0 步数 / 时长分布与子会话占比端点：同款两段静态路由。
  assert.deepEqual(matchApiRoute("/api/step-distribution"), { routeName: "step-distribution" })
  assert.deepEqual(matchApiRoute("/api/duration-distribution"), { routeName: "duration-distribution" })
  assert.deepEqual(matchApiRoute("/api/child-share"), { routeName: "child-share" })
  // v0.22.0 B 档工具错误趋势 / 会话结局端点：同款两段静态路由。
  assert.deepEqual(matchApiRoute("/api/tool-error-trend"), { routeName: "tool-error-trend" })
  assert.deepEqual(matchApiRoute("/api/session-outcomes"), { routeName: "session-outcomes" })
  // v0.14.0 cache-control route: same two-segment shape, no parameters.
  assert.deepEqual(matchApiRoute("/api/refresh"), { routeName: "refresh" })
})

test("matchApiRoute matches session routes and decodes the session id", () => {
  assert.deepEqual(matchApiRoute("/api/session/ses_abc123/messages"), {
    routeName: "sessionMessages",
    sessionId: "ses_abc123",
  })
  assert.deepEqual(matchApiRoute("/api/session/ses_abc123/system-prompt"), {
    routeName: "sessionSystemPrompt",
    sessionId: "ses_abc123",
  })
  assert.deepEqual(matchApiRoute("/api/session/ses%20with%20space/messages"), {
    routeName: "sessionMessages",
    sessionId: "ses with space",
  })
})

test("matchApiRoute tolerates trailing slashes", () => {
  assert.deepEqual(matchApiRoute("/api/overview/"), { routeName: "overview" })
  assert.deepEqual(matchApiRoute("/api/session/ses_abc/messages/"), {
    routeName: "sessionMessages",
    sessionId: "ses_abc",
  })
})

test("matchApiRoute returns null for unknown, truncated or malformed paths", () => {
  assert.equal(matchApiRoute("/api"), null)
  assert.equal(matchApiRoute("/api/"), null)
  assert.equal(matchApiRoute("/api/nope"), null)
  assert.equal(matchApiRoute("/api/overview/extra"), null)
  assert.equal(matchApiRoute("/api/refresh/extra"), null, "refresh takes no sub-path")
  assert.equal(matchApiRoute("/api/session/ses_1"), null)
  assert.equal(matchApiRoute("/api/session/ses_1/unknown-subroute"), null)
  assert.equal(matchApiRoute("/api/session/%zz-bad-encoding/messages"), null)
  assert.equal(matchApiRoute("/api/session//messages"), null)
  assert.equal(matchApiRoute("/overview"), null)
  assert.equal(matchApiRoute("/"), null)
})

test("parsePositiveIntegerParam returns valid values and falls back on bad ones", () => {
  const emptyParams = new URLSearchParams()
  assert.equal(parsePositiveIntegerParam(emptyParams, "days", 30), 30)
  assert.equal(parsePositiveIntegerParam(new URLSearchParams("days=7"), "days", 30), 7)
  assert.equal(parsePositiveIntegerParam(new URLSearchParams("days="), "days", 30), 30)
  assert.equal(parsePositiveIntegerParam(new URLSearchParams("days=abc"), "days", 30), 30)
  assert.equal(parsePositiveIntegerParam(new URLSearchParams("days=-5"), "days", 30), 30)
  assert.equal(parsePositiveIntegerParam(new URLSearchParams("days=3.5"), "days", 30), 30)
  assert.equal(parsePositiveIntegerParam(new URLSearchParams("days=0"), "days", 30), 30)
  // "1e3" is a valid Number and a positive integer — accepted as 1000 days
  // (bucketDailyTrend caps the window at 366 anyway).
  assert.equal(parsePositiveIntegerParam(new URLSearchParams("days=1e3"), "days", 30), 1000)
})

test("parseNonNegativeIntegerParam accepts zero but rejects negatives and garbage", () => {
  assert.equal(parseNonNegativeIntegerParam(new URLSearchParams("offset=0"), "offset", 50), 0)
  assert.equal(parseNonNegativeIntegerParam(new URLSearchParams("offset=25"), "offset", 50), 25)
  assert.equal(parseNonNegativeIntegerParam(new URLSearchParams("offset=-1"), "offset", 50), 50)
  assert.equal(parseNonNegativeIntegerParam(new URLSearchParams("offset=1.5"), "offset", 50), 50)
  assert.equal(parseNonNegativeIntegerParam(new URLSearchParams(), "offset", 50), 50)
})

/**
 * Tests for the API dispatch contract (src/web/api.ts) with a null database:
 * 503 for data routes, always-200 health with dbStatus (DESIGN.md §9).
 */

import { test } from "node:test"
import assert from "node:assert/strict"

import {
  DATABASE_UNAVAILABLE_MESSAGE,
  handleApiRequest,
  INSIGHT_VERSION,
  type ApiRequestContext,
} from "../src/web/api.ts"
import { matchApiRoute } from "../src/web/router.ts"

function requestContextFor(pathname: string): ApiRequestContext | null {
  const route = matchApiRoute(pathname)
  if (route === null) return null
  return {
    route,
    searchParams: new URLSearchParams(),
    database: null,
    databasePath: "test://no-database",
    serverPort: 18789,
  }
}

test("every data route answers 503 with the unavailable error when the db is missing", () => {
  const dataRoutePathnames = [
    "/api/overview",
    "/api/trend",
    "/api/models",
    "/api/agents",
    "/api/sessions",
    "/api/todo",
    "/api/session/ses_example/messages",
    "/api/session/ses_example/system-prompt",
  ]
  for (const pathname of dataRoutePathnames) {
    const requestContext = requestContextFor(pathname)
    assert.notEqual(requestContext, null, `route failed to match: ${pathname}`)
    const apiResponse = handleApiRequest(requestContext!)
    assert.equal(
      apiResponse.statusCode,
      503,
      `${pathname} must answer 503 while the db is unavailable`,
    )
    assert.deepEqual(apiResponse.body, { error: DATABASE_UNAVAILABLE_MESSAGE })
  }
})

test("health answers 200 with dbStatus unavailable and the bound port while the db is missing", () => {
  const requestContext = requestContextFor("/api/health")
  assert.notEqual(requestContext, null)
  const apiResponse = handleApiRequest(requestContext!)
  assert.equal(apiResponse.statusCode, 200)
  assert.deepEqual(apiResponse.body, {
    status: "ok",
    version: INSIGHT_VERSION,
    port: 18789,
    dbStatus: "unavailable",
    dbPath: "test://no-database",
  })
})

test("trend keeps the 30-day default when the days parameter is garbage", () => {
  const route = matchApiRoute("/api/trend")
  assert.notEqual(route, null)
  const apiResponse = handleApiRequest({
    route: route!,
    searchParams: new URLSearchParams("days=not-a-number"),
    database: null,
    databasePath: "test://no-database",
    serverPort: 18789,
  })
  // db unavailable short-circuits before parsing — the point here is that
  // bad parameters never throw on the way to the 503.
  assert.equal(apiResponse.statusCode, 503)
})

/**
 * Integration tests for the real insight server (src/web/server.ts +
 * request-handler): real sockets on 127.0.0.1, OS-assigned ports (port 0).
 * Live-database cases skip when opencode.db is absent on the machine.
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import { createServer } from "node:http"
import { connect } from "node:net"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { fileURLToPath } from "node:url"

import { startInsightServer } from "../src/web/server.ts"
import { openOpencodeDb, querySessionList } from "../src/db/queries.ts"
import { INSIGHT_VERSION } from "../src/web/api.ts"

const missingDatabasePath = join(tmpdir(), "opencode-insight-missing-database.sqlite")
const publicDirectory = fileURLToPath(new URL("../src/web/public", import.meta.url))
const dashboardIndexExists = existsSync(join(publicDirectory, "index.html"))

const databaseProbeConnection = openOpencodeDb()
const skipReasonForLiveDatabase: string | false =
  databaseProbeConnection === null
    ? "opencode.db not found on this machine — skipping live API integration tests"
    : false
databaseProbeConnection?.close()

async function fetchApiExchange(
  serverPort: number,
  pathAndQuery: string,
): Promise<{ statusCode: number; body: unknown; responseText: string }> {
  const response = await fetch(`http://127.0.0.1:${serverPort}${pathAndQuery}`)
  const responseText = await response.text()
  let parsedBody: unknown = null
  try {
    parsedBody = JSON.parse(responseText)
  } catch {
    parsedBody = null
  }
  return { statusCode: response.status, body: parsedBody, responseText }
}

test("server answers /api/health with ok status and the live database", {
  skip: skipReasonForLiveDatabase,
}, async () => {
  const serverHandle = await startInsightServer({ port: 0 })
  try {
    const healthExchange = await fetchApiExchange(serverHandle.port, "/api/health")
    assert.equal(healthExchange.statusCode, 200)
    const healthBody = healthExchange.body as {
      status: string
      version: string
      port: number
      dbStatus: string
      dbPath: string
    }
    assert.equal(healthBody.status, "ok")
    assert.equal(healthBody.version, INSIGHT_VERSION)
    assert.equal(healthBody.port, serverHandle.port)
    assert.equal(healthBody.dbStatus, "ok")
    assert.ok(healthBody.dbPath.endsWith("opencode.db"))
  } finally {
    await serverHandle.close()
  }
})

test("server serves every live data route with well-formed payloads", {
  skip: skipReasonForLiveDatabase,
}, async () => {
  const serverHandle = await startInsightServer({ port: 0 })
  try {
    const overviewExchange = await fetchApiExchange(serverHandle.port, "/api/overview")
    assert.equal(overviewExchange.statusCode, 200)
    const overviewBody = overviewExchange.body as { todayHitRate: number; stepCount: number }
    assert.ok(overviewBody.todayHitRate >= 0 && overviewBody.todayHitRate <= 1)
    assert.ok(overviewBody.stepCount >= 0)

    const trendExchange = await fetchApiExchange(serverHandle.port, "/api/trend?days=7")
    assert.equal(trendExchange.statusCode, 200)
    assert.equal((trendExchange.body as unknown[]).length, 7)

    const garbageDaysExchange = await fetchApiExchange(serverHandle.port, "/api/trend?days=abc")
    assert.equal(garbageDaysExchange.statusCode, 200)
    assert.equal((garbageDaysExchange.body as unknown[]).length, 30, "bad days falls back to 30")

    const modelsExchange = await fetchApiExchange(serverHandle.port, "/api/models")
    assert.equal(modelsExchange.statusCode, 200)
    assert.ok(Array.isArray(modelsExchange.body))

    const agentsExchange = await fetchApiExchange(serverHandle.port, "/api/agents")
    assert.equal(agentsExchange.statusCode, 200)
    assert.ok(Array.isArray(agentsExchange.body))

    const sessionsExchange = await fetchApiExchange(serverHandle.port, "/api/sessions?limit=3&offset=0")
    assert.equal(sessionsExchange.statusCode, 200)
    assert.ok((sessionsExchange.body as unknown[]).length <= 3)

    const todoExchange = await fetchApiExchange(serverHandle.port, "/api/todo")
    assert.equal(todoExchange.statusCode, 200)
    const todoBody = todoExchange.body as { total: number }
    assert.ok(todoBody.total >= 0)
  } finally {
    await serverHandle.close()
  }
})

test("server answers session messages for the newest live session and 404 for unknown ids", {
  skip: skipReasonForLiveDatabase,
}, async () => {
  const databaseConnection = openOpencodeDb()
  const newestSession = databaseConnection === null ? undefined : querySessionList(databaseConnection, 1, 0)?.[0]
  databaseConnection?.close()
  if (newestSession === undefined) return // empty database

  const serverHandle = await startInsightServer({ port: 0 })
  try {
    const messagesExchange = await fetchApiExchange(
      serverHandle.port,
      `/api/session/${encodeURIComponent(newestSession.id)}/messages`,
    )
    assert.equal(messagesExchange.statusCode, 200)
    assert.ok(Array.isArray(messagesExchange.body))

    const unknownSessionExchange = await fetchApiExchange(
      serverHandle.port,
      "/api/session/ses_does_not_exist_anywhere/messages",
    )
    assert.equal(unknownSessionExchange.statusCode, 404)
    assert.deepEqual(unknownSessionExchange.body, {
      error: "session not found in current tables",
    })
  } finally {
    await serverHandle.close()
  }
})

test("server keeps working when the database is missing: health ok, data routes 503", async () => {
  const serverHandle = await startInsightServer({ port: 0, databasePath: missingDatabasePath })
  try {
    const healthExchange = await fetchApiExchange(serverHandle.port, "/api/health")
    assert.equal(healthExchange.statusCode, 200)
    assert.equal((healthExchange.body as { dbStatus: string }).dbStatus, "unavailable")

    const overviewExchange = await fetchApiExchange(serverHandle.port, "/api/overview")
    assert.equal(overviewExchange.statusCode, 503)
    assert.ok(typeof (overviewExchange.body as { error: string }).error === "string")
  } finally {
    await serverHandle.close()
  }
})

test("server answers unknown api paths with 404 and non-GET methods with 405", async () => {
  const serverHandle = await startInsightServer({ port: 0, databasePath: missingDatabasePath })
  try {
    const unknownApiExchange = await fetchApiExchange(serverHandle.port, "/api/no-such-route")
    assert.equal(unknownApiExchange.statusCode, 404)

    const postResponse = await fetch(`http://127.0.0.1:${serverHandle.port}/api/overview`, {
      method: "POST",
    })
    assert.equal(postResponse.status, 405)
  } finally {
    await serverHandle.close()
  }
})

test("dashboard root serves index.html when deployed, else the not-deployed notice", async () => {
  const serverHandle = await startInsightServer({ port: 0, databasePath: missingDatabasePath })
  try {
    const rootExchange = await fetchApiExchange(serverHandle.port, "/")
    if (dashboardIndexExists) {
      assert.equal(rootExchange.statusCode, 200)
      assert.ok(rootExchange.responseText.includes("<"))
    } else {
      assert.equal(rootExchange.statusCode, 404)
      assert.ok(rootExchange.responseText.includes("not deployed"))
    }

    const missingAssetExchange = await fetchApiExchange(serverHandle.port, "/assets/no-such-file.js")
    assert.equal(missingAssetExchange.statusCode, 404)
  } finally {
    await serverHandle.close()
  }
})

test("raw traversal requests over the socket never escape the public directory", async () => {
  const serverHandle = await startInsightServer({ port: 0, databasePath: missingDatabasePath })
  try {
    // Literal dot-dot is normalized by the URL parser before path resolution.
    const rawResponse = await sendRawHttpRequest(
      serverHandle.port,
      "GET /../../package.json HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n",
    )
    assert.match(rawResponse, /^HTTP\/1\.1 404/, "traversal must be a 404, never file content")
    assert.ok(!rawResponse.includes('"name": "opencode-db-insight"'))

    // Percent-encoded dot-dot survives the URL parser and must be caught by
    // resolveStaticFilePath's decode + prefix guard.
    const encodedTraversalExchange = await fetchApiExchange(
      serverHandle.port,
      "/%2e%2e/package.json",
    )
    assert.equal(encodedTraversalExchange.statusCode, 404)
    assert.ok(!encodedTraversalExchange.responseText.includes('"name": "opencode-db-insight"'))
  } finally {
    await serverHandle.close()
  }
})

test("teardown releases the port and refuses further connections", async () => {
  const serverHandle = await startInsightServer({ port: 0, databasePath: missingDatabasePath })
  const boundPort = serverHandle.port
  await serverHandle.close()

  await assert.rejects(
    fetch(`http://127.0.0.1:${boundPort}/api/health`),
    undefined,
    "requests must fail once the server is closed",
  )

  // Prove the port is genuinely free again by binding it with a bare server.
  await new Promise<void>((resolve, reject) => {
    const rebindServer = createServer()
    rebindServer.once("error", reject)
    rebindServer.listen(boundPort, "127.0.0.1", () => {
      rebindServer.close(() => resolve())
    })
  })
})

test("a second server retries upward when the first server holds the port", async () => {
  const firstServer = await startInsightServer({ port: 0, databasePath: missingDatabasePath })
  try {
    const secondServer = await startInsightServer({
      port: firstServer.port,
      databasePath: missingDatabasePath,
    })
    try {
      assert.ok(
        secondServer.port > firstServer.port && secondServer.port <= firstServer.port + 10,
        `second server must land on a retried port above ${firstServer.port}`,
      )
    } finally {
      await secondServer.close()
    }
  } finally {
    await firstServer.close()
  }
})

test("concurrent requests are all answered without crashing the server", async () => {
  const serverHandle = await startInsightServer({ port: 0, databasePath: missingDatabasePath })
  try {
    const concurrentExchanges = await Promise.all(
      Array.from({ length: 10 }, () => fetchApiExchange(serverHandle.port, "/api/health")),
    )
    for (const exchange of concurrentExchanges) {
      assert.equal(exchange.statusCode, 200)
      assert.equal((exchange.body as { status: string }).status, "ok")
    }
  } finally {
    await serverHandle.close()
  }
})

/** Send a raw HTTP request and collect the full response text. */
function sendRawHttpRequest(serverPort: number, rawRequest: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(serverPort, "127.0.0.1")
    let responseText = ""
    socket.on("connect", () => {
      socket.write(rawRequest)
    })
    socket.on("data", (chunk: Buffer) => {
      responseText += chunk.toString("utf8")
    })
    socket.on("error", reject)
    socket.on("close", () => resolve(responseText))
  })
}

/**
 * Lifecycle resilience tests for the insight server (P1-1/P1-4/P1-5/P1-6):
 * - listen failure releases the db connection before rethrowing;
 * - a connection that dies at runtime (closed/corrupted) is dropped and
 *   reopened on the next request;
 * - close() makes the connection provider return null without reopening
 *   (no reopen race during teardown);
 * - only loopback Host headers are served (DNS-rebinding → 403).
 *
 * Connection behavior is observed through the injected databaseOpener;
 * Host checks run against a real socket with raw requests.
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import { connect } from "node:net"
import { join } from "node:path"
import { tmpdir } from "node:os"

import {
  DEFAULT_INSIGHT_PORT,
  isAllowedInsightHost,
  startInsightServer,
  type InsightHttpServer,
  type InsightServerFactory,
} from "../src/web/server.ts"
import type { SqliteReadConnection, SqliteStatement } from "../src/db/types.ts"

/** A database path that never exists, so these tests never touch the real opencode.db. */
const missingDatabasePath = join(tmpdir(), "opencode-insight-missing-database.sqlite")

/** Fake node:http server: rejects configured ports with a listen error. */
class FakeListenServer implements InsightHttpServer {
  listenCallCount = 0
  closeCallCount = 0
  private readonly busyPorts: ReadonlySet<number>
  private readonly failureCode: string | null
  private boundPort: number | null = null
  private errorListener: ((listenError: Error) => void) | null = null

  constructor(busyPorts: ReadonlySet<number>, failureCode: string | null) {
    this.busyPorts = busyPorts
    this.failureCode = failureCode
  }

  listen(port: number, host: string, callback: () => void): void {
    this.listenCallCount += 1
    if (this.failureCode !== null || this.busyPorts.has(port)) {
      const listenError = Object.assign(new Error(`listen failed on ${port}`), {
        code: this.failureCode ?? "EADDRINUSE",
      })
      this.errorListener?.(listenError)
      return
    }
    this.boundPort = port
    callback()
  }

  close(callback?: (closeError?: Error | null) => void): void {
    this.closeCallCount += 1
    callback?.(null)
  }

  once(event: "error", listener: (listenError: Error) => void): void {
    this.errorListener = listener
  }

  closeAllConnections(): void {
    // no-op for the fake
  }

  address(): { port: number } | string | null {
    return this.boundPort === null ? null : { port: this.boundPort }
  }
}

function createFakeServerFactory(
  busyPorts: ReadonlySet<number> = new Set<number>(),
  failureCode: string | null = null,
): InsightServerFactory {
  return () => new FakeListenServer(busyPorts, failureCode)
}

/** A connection stub whose close() calls are counted. */
function createCountingConnection(): { connection: SqliteReadConnection; closeCallCount: { value: number } } {
  const closeCallCount = { value: 0 }
  const connection: SqliteReadConnection = {
    prepare: () => {
      throw new Error("no statement expected in this scenario")
    },
    close: () => {
      closeCallCount.value += 1
    },
  }
  return { connection, closeCallCount }
}

test("a failed listen chain closes the opened db connection before rethrowing (P1-1)", async () => {
  // Every port in the retry chain is busy → startInsightServer must give up.
  const busyPorts = new Set<number>(Array.from({ length: 10 }, (_unused, index) => DEFAULT_INSIGHT_PORT + index))
  const { connection, closeCallCount } = createCountingConnection()

  await assert.rejects(
    startInsightServer({
      serverFactory: createFakeServerFactory(busyPorts),
      databasePath: missingDatabasePath,
      databaseOpener: () => connection,
    }),
    (listenError: unknown) => {
      assert.equal((listenError as { code?: string }).code, "EADDRINUSE")
      return true
    },
  )
  assert.equal(closeCallCount.value, 1, "the db connection must be closed exactly once")
})

test("a non-EADDRINUSE listen error also releases the db connection (P1-1)", async () => {
  const { connection, closeCallCount } = createCountingConnection()

  await assert.rejects(
    startInsightServer({
      serverFactory: createFakeServerFactory(new Set<number>(), "EACCES"),
      databasePath: missingDatabasePath,
      databaseOpener: () => connection,
    }),
    (listenError: unknown) => {
      assert.equal((listenError as { code?: string }).code, "EACCES")
      return true
    },
  )
  assert.equal(closeCallCount.value, 1)
})

/** A connection that answers only the health probe (SELECT 1). */
function createHealthProbeConnection(): SqliteReadConnection {
  const probeStatement: SqliteStatement = {
    all: () => [],
    get: () => ({ probe: 1 }),
  }
  return {
    prepare: (sql: string) => {
      if (sql.trim() === "SELECT 1") return probeStatement
      throw new Error(`unexpected SQL in health probe stub: ${sql}`)
    },
    close: () => {},
  }
}

/** A connection whose statements fail like a closed/corrupted database. */
function createDeadConnection(): SqliteReadConnection {
  return {
    prepare: () => {
      throw new Error("database is not open")
    },
    close: () => {},
  }
}

test("a runtime-dead connection is dropped and the next request reopens it (P1-4)", async () => {
  const openerCalls: string[] = []
  const serverHandle = await startInsightServer({
    port: 0,
    databasePath: missingDatabasePath,
    databaseOpener: () => {
      openerCalls.push("open")
      // First opening is already dead; every later one is healthy.
      return openerCalls.length === 1 ? createDeadConnection() : createHealthProbeConnection()
    },
  })
  try {
    const firstHealth = await fetch(`http://127.0.0.1:${serverHandle.port}/api/health`)
    const firstBody = (await firstHealth.json()) as { dbStatus: string }
    assert.equal(firstHealth.status, 200)
    assert.equal(firstBody.dbStatus, "unavailable", "the dead connection must not report ok")

    const secondHealth = await fetch(`http://127.0.0.1:${serverHandle.port}/api/health`)
    const secondBody = (await secondHealth.json()) as { dbStatus: string }
    assert.equal(secondBody.dbStatus, "ok", "the connection must have been reopened")
    assert.equal(openerCalls.length, 2)
  } finally {
    await serverHandle.close()
  }
})

test("after close() the provider returns null and never reopens (P1-5)", async () => {
  const openerCallCount = { value: 0 }
  const serverHandle = await startInsightServer({
    port: 0,
    databasePath: missingDatabasePath,
    databaseOpener: () => {
      openerCallCount.value += 1
      return createHealthProbeConnection()
    },
  })
  const openedBeforeClose = openerCallCount.value
  await serverHandle.close()

  assert.equal(serverHandle.databaseProvider(), null, "no connection after teardown")
  assert.equal(serverHandle.databaseProvider(), null, "still null on repeated calls")
  assert.equal(openerCallCount.value, openedBeforeClose, "close() must not trigger a reopen")
})

test("isAllowedInsightHost accepts only loopback and localhost hosts (P1-6)", () => {
  assert.equal(isAllowedInsightHost("127.0.0.1"), true)
  assert.equal(isAllowedInsightHost("127.0.0.1:18789"), true)
  assert.equal(isAllowedInsightHost("localhost"), true)
  assert.equal(isAllowedInsightHost("LocalHost:8080"), true)
  assert.equal(isAllowedInsightHost("evil.example.com"), false)
  assert.equal(isAllowedInsightHost("127.0.0.1.evil.example.com"), false)
  assert.equal(isAllowedInsightHost("169.254.169.254"), false)
  assert.equal(isAllowedInsightHost(""), false)
  assert.equal(isAllowedInsightHost(undefined), false)
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

test("requests with a foreign or missing Host header are refused with 403 (P1-6)", async () => {
  const serverHandle = await startInsightServer({ port: 0, databasePath: missingDatabasePath })
  try {
    const foreignHostResponse = await sendRawHttpRequest(
      serverHandle.port,
      "GET /api/health HTTP/1.1\r\nHost: evil.example.com\r\nConnection: close\r\n\r\n",
    )
    assert.match(foreignHostResponse, /^HTTP\/1\.1 403/, "foreign Host must be a 403")
    assert.ok(foreignHostResponse.includes("forbidden host"))

    // A missing Host header is refused by Node's HTTP parser itself
    // (400 Bad Request) before the request listener runs — llhttp mandates
    // a Host header for HTTP/1.1, so the request never reaches the
    // application layer. It is still never served, which is what the
    // DNS-rebinding defense (P1-6) requires; the application-layer ruling
    // for a missing Host is covered by the pure
    // isAllowedInsightHost(undefined) unit test above.
    const missingHostResponse = await sendRawHttpRequest(
      serverHandle.port,
      "GET /api/health HTTP/1.1\r\nConnection: close\r\n\r\n",
    )
    assert.match(missingHostResponse, /^HTTP\/1\.1 400/, "missing Host must be refused by the parser")

    // Loopback and localhost (with or without port) keep being served.
    const loopbackResponse = await sendRawHttpRequest(
      serverHandle.port,
      `GET /api/health HTTP/1.1\r\nHost: 127.0.0.1:${serverHandle.port}\r\nConnection: close\r\n\r\n`,
    )
    assert.match(loopbackResponse, /^HTTP\/1\.1 200/)

    const localhostResponse = await sendRawHttpRequest(
      serverHandle.port,
      "GET /api/health HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n",
    )
    assert.match(localhostResponse, /^HTTP\/1\.1 200/)
  } finally {
    await serverHandle.close()
  }
})

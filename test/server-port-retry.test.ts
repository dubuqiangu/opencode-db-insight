/**
 * Tests for the listen/retry lifecycle (src/web/server.ts) using an injectable
 * fake server factory — no real sockets, deterministic EADDRINUSE simulation.
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import { join } from "node:path"
import { tmpdir } from "node:os"

import {
  DEFAULT_INSIGHT_PORT,
  startInsightServer,
  type InsightHttpServer,
  type InsightServerFactory,
} from "../src/web/server.ts"

/** A database path that never exists, so these tests never touch the real opencode.db. */
const missingDatabasePath = join(tmpdir(), "opencode-insight-missing-database.sqlite")

/** Fake node:http server: rejects configured ports with a listen error. */
class FakeListenServer implements InsightHttpServer {
  listenCallCount = 0
  closeCallCount = 0
  connectionDropCallCount = 0
  private readonly busyPorts: ReadonlySet<number>
  private readonly failureCode: string | null
  /** Ports the OS refuses to bind (Windows WinNAT reserved ranges → EACCES). */
  private readonly deniedPorts: ReadonlySet<number>
  private boundPort: number | null = null
  private errorListener: ((listenError: Error) => void) | null = null

  constructor(
    busyPorts: ReadonlySet<number>,
    failureCode: string | null,
    deniedPorts: ReadonlySet<number> = new Set<number>(),
  ) {
    this.busyPorts = busyPorts
    this.failureCode = failureCode
    this.deniedPorts = deniedPorts
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
    if (this.deniedPorts.has(port)) {
      const listenError = Object.assign(new Error(`listen denied on ${port}`), {
        code: "EACCES",
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
    this.connectionDropCallCount += 1
  }

  address(): { port: number } | string | null {
    return this.boundPort === null ? null : { port: this.boundPort }
  }
}

function createFakeServerFactory(
  busyPorts: ReadonlySet<number> = new Set<number>(),
  failureCode: string | null = null,
  deniedPorts: ReadonlySet<number> = new Set<number>(),
): { serverFactory: InsightServerFactory; createdServers: FakeListenServer[] } {
  const createdServers: FakeListenServer[] = []
  return {
    serverFactory: () => {
      const fakeServer = new FakeListenServer(busyPorts, failureCode, deniedPorts)
      createdServers.push(fakeServer)
      return fakeServer
    },
    createdServers,
  }
}

test("startInsightServer binds the default port when it is free", async () => {
  const { serverFactory, createdServers } = createFakeServerFactory()
  const serverHandle = await startInsightServer({ serverFactory, databasePath: missingDatabasePath })
  assert.equal(serverHandle.port, DEFAULT_INSIGHT_PORT)
  assert.equal(serverHandle.host, "127.0.0.1")
  await serverHandle.close()
  assert.equal(createdServers[0].closeCallCount, 1)
  assert.ok(createdServers[0].connectionDropCallCount >= 1, "close must drop keep-alive connections")
})

test("startInsightServer walks the port upward on EADDRINUSE until it finds a free port", async () => {
  const busyPorts = new Set<number>([18789, 18790, 18791])
  const { serverFactory, createdServers } = createFakeServerFactory(busyPorts)
  const serverHandle = await startInsightServer({ serverFactory, databasePath: missingDatabasePath })
  assert.equal(serverHandle.port, 18792)
  assert.equal(createdServers[0].listenCallCount, 4, "one attempt per busy port plus the successful one")
  await serverHandle.close()
})

test("startInsightServer gives up after the configured attempt count and rethrows the last error", async () => {
  const busyPorts = new Set<number>([18789, 18790, 18791, 18792, 18793, 18794, 18795, 18796, 18797, 18798])
  const { serverFactory, createdServers } = createFakeServerFactory(busyPorts)
  await assert.rejects(
    startInsightServer({ serverFactory, databasePath: missingDatabasePath }),
    (listenError: unknown) => {
      assert.equal((listenError as { code?: string }).code, "EADDRINUSE")
      return true
    },
  )
  assert.equal(createdServers[0].listenCallCount, 10, "exactly ten attempts, no more")
})

test("startInsightServer respects a custom maxPortAttempts", async () => {
  const busyPorts = new Set<number>([18789])
  const { serverFactory, createdServers } = createFakeServerFactory(busyPorts)
  const serverHandle = await startInsightServer({
    serverFactory,
    databasePath: missingDatabasePath,
    maxPortAttempts: 2,
  })
  assert.equal(serverHandle.port, 18790)
  assert.equal(createdServers[0].listenCallCount, 2)
  await serverHandle.close()
})

test("startInsightServer rejects once the custom attempt budget is exhausted", async () => {
  const busyPorts = new Set<number>([18789, 18790])
  const { serverFactory, createdServers } = createFakeServerFactory(busyPorts)
  await assert.rejects(
    startInsightServer({ serverFactory, databasePath: missingDatabasePath, maxPortAttempts: 2 }),
    (listenError: unknown) => {
      assert.equal((listenError as { code?: string }).code, "EADDRINUSE")
      return true
    },
  )
  assert.equal(createdServers[0].listenCallCount, 2)
})

test("startInsightServer does not retry on non-advance listen errors (EADDRNOTAVAIL)", async () => {
  // EADDRNOTAVAIL 是宿主/地址层面的问题，换端口无济于事——必须一次失败。
  // （EACCES 已属「前进」类：Windows 保留端口段拒绝 bind，+1 即可绕开。）
  const { serverFactory, createdServers } = createFakeServerFactory(
    new Set<number>(),
    "EADDRNOTAVAIL",
  )
  await assert.rejects(
    startInsightServer({ serverFactory, databasePath: missingDatabasePath }),
    (listenError: unknown) => {
      assert.equal((listenError as { code?: string }).code, "EADDRNOTAVAIL")
      return true
    },
  )
  assert.equal(
    createdServers[0].listenCallCount,
    1,
    "a host-level error must fail fast without port+1 retries",
  )
})

test("startInsightServer walks the port upward on EACCES (Windows reserved ranges)", async () => {
  // 真机回归锁（2026-10-14 全量套件实证）：WinNAT 保留段跨重启漂移，
  // 旧契约把 EACCES 当致命错误 → 端口撞保留段时看板服务启动即死。
  const deniedPorts = new Set<number>([18789, 18790])
  const { serverFactory, createdServers } = createFakeServerFactory(
    new Set<number>(),
    null,
    deniedPorts,
  )
  const serverHandle = await startInsightServer({ serverFactory, databasePath: missingDatabasePath })
  assert.equal(serverHandle.port, 18791, "EACCES ports are skipped exactly like EADDRINUSE ones")
  assert.equal(createdServers[0].listenCallCount, 3)
  await serverHandle.close()
})

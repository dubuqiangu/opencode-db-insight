/**
 * Tests for the plugin assembly (src/index.ts): setup must start the real
 * server and publish its port via plugin storage; the returned cleanup must
 * tear the server down again (DESIGN.md §3/§9). Only context.storage is used
 * by setup, so a storage-only fake context suffices.
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import { createServer } from "node:http"

const SERVER_PORT_STORAGE_KEY = "insight-server-port"
/** Default listen range of the insight server (18789 + up to 10 retries). */
const DEFAULT_PORT_RANGE = Array.from({ length: 12 }, (_unused, index) => 18789 + index)

/**
 * Which of the candidate ports can be bound right now — the observable
 * for "no insight server leaked": a leaked server keeps its port out of
 * the bindable set.
 */
async function findBindablePorts(candidatePorts: number[]): Promise<Set<number>> {
  const bindablePorts = new Set<number>()
  for (const candidatePort of candidatePorts) {
    const isBindable = await new Promise<boolean>((resolve) => {
      const probeServer = createServer()
      probeServer.once("error", () => resolve(false))
      probeServer.listen(candidatePort, "127.0.0.1", () => {
        probeServer.close(() => resolve(true))
      })
    })
    if (isBindable) bindablePorts.add(candidatePort)
  }
  return bindablePorts
}

test("plugin setup starts the server, publishes the port, and teardown stops it", async () => {
  const pluginModule = await import("../src/index.ts")
  const insightPlugin = pluginModule.default
  assert.equal(insightPlugin.id, "opencode-db-insight")

  const storageEntries = new Map<string, unknown>()
  const fakeStorageDomain = {
    get: async (storageKey: string): Promise<unknown> => storageEntries.get(storageKey),
    set: async (storageKey: string, storageValue: unknown): Promise<void> => {
      storageEntries.set(storageKey, storageValue)
    },
    remove: async (storageKey: string): Promise<void> => {
      storageEntries.delete(storageKey)
    },
  }

  const cleanup = await insightPlugin.setup({
    storage: fakeStorageDomain,
  } as unknown as Parameters<typeof insightPlugin.setup>[0])
  assert.notEqual(cleanup, undefined, "setup must return a cleanup function")

  const publishedPort = storageEntries.get(SERVER_PORT_STORAGE_KEY)
  assert.equal(typeof publishedPort, "number", "actual bound port must be published via storage")

  try {
    const healthResponse = await fetch(`http://127.0.0.1:${publishedPort}/api/health`)
    assert.equal(healthResponse.status, 200)
    const healthBody = (await healthResponse.json()) as { status: string }
    assert.equal(healthBody.status, "ok")
  } finally {
    await cleanup!()
  }

  assert.equal(
    storageEntries.has(SERVER_PORT_STORAGE_KEY),
    false,
    "teardown must remove the published port",
  )
  // The server that answered a moment ago must now refuse connections.
  await assert.rejects(fetch(`http://127.0.0.1:${publishedPort}/api/health`))
})

test("setup honors a stored database path override and still starts", async () => {
  const pluginModule = await import("../src/index.ts")
  const insightPlugin = pluginModule.default

  const storageEntries = new Map<string, unknown>([["insight-db-path", "Z:/definitely/not/a/database.sqlite"]])
  const fakeStorageDomain = {
    get: async (storageKey: string): Promise<unknown> => storageEntries.get(storageKey),
    set: async (storageKey: string, storageValue: unknown): Promise<void> => {
      storageEntries.set(storageKey, storageValue)
    },
    remove: async (storageKey: string): Promise<void> => {
      storageEntries.delete(storageKey)
    },
  }

  const cleanup = await insightPlugin.setup({
    storage: fakeStorageDomain,
  } as unknown as Parameters<typeof insightPlugin.setup>[0])
  assert.notEqual(cleanup, undefined)

  const serverPort = storageEntries.get(SERVER_PORT_STORAGE_KEY)
  assert.equal(typeof serverPort, "number")

  try {
    // With a bogus override the server still runs, but data routes must 503
    // and health must report the database as unavailable.
    const healthResponse = await fetch(`http://127.0.0.1:${serverPort}/api/health`)
    const healthBody = (await healthResponse.json()) as { dbStatus: string }
    assert.equal(healthBody.dbStatus, "unavailable")

    const overviewResponse = await fetch(`http://127.0.0.1:${serverPort}/api/overview`)
    assert.equal(overviewResponse.status, 503)
  } finally {
    await cleanup!()
  }
})

test("setup closes the server when publishing the port fails (P1-2)", async () => {
  const pluginModule = await import("../src/index.ts")
  const insightPlugin = pluginModule.default

  const storageEntries = new Map<string, unknown>()
  const failingStorageDomain = {
    get: async (storageKey: string): Promise<unknown> => storageEntries.get(storageKey),
    set: async (): Promise<void> => {
      throw new Error("storage is broken")
    },
    remove: async (storageKey: string): Promise<void> => {
      storageEntries.delete(storageKey)
    },
  }

  const bindablePortsBefore = await findBindablePorts(DEFAULT_PORT_RANGE)
  await assert.rejects(
    insightPlugin.setup({ storage: failingStorageDomain } as unknown as Parameters<typeof insightPlugin.setup>[0]),
    /storage is broken/,
  )
  // The server that started for this setup must be gone again: every port
  // that was bindable before must be bindable after (no leaked listener).
  const bindablePortsAfter = await findBindablePorts(DEFAULT_PORT_RANGE)
  assert.deepEqual(
    [...bindablePortsAfter].sort((left, right) => left - right),
    [...bindablePortsBefore].sort((left, right) => left - right),
    "a failed setup must not leave a server bound",
  )
})

test("teardown closes the server even when storage.remove fails (P1-2)", async () => {
  const pluginModule = await import("../src/index.ts")
  const insightPlugin = pluginModule.default

  const storageEntries = new Map<string, unknown>()
  const removeFailingStorageDomain = {
    get: async (storageKey: string): Promise<unknown> => storageEntries.get(storageKey),
    set: async (storageKey: string, storageValue: unknown): Promise<void> => {
      storageEntries.set(storageKey, storageValue)
    },
    remove: async (): Promise<void> => {
      throw new Error("remove is broken")
    },
  }

  const cleanup = await insightPlugin.setup({
    storage: removeFailingStorageDomain,
  } as unknown as Parameters<typeof insightPlugin.setup>[0])
  const publishedPort = storageEntries.get(SERVER_PORT_STORAGE_KEY)

  // The failing remove must not swallow the close: teardown resolves and
  // the server is down afterwards (and the error only surfaces on the
  // console, not to the plugin host).
  await cleanup!()
  await assert.rejects(fetch(`http://127.0.0.1:${publishedPort}/api/health`))
})

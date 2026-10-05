/**
 * Tests for the plugin assembly (src/index.ts): setup must start the real
 * server and publish its port via plugin storage; the returned cleanup must
 * tear the server down again (DESIGN.md §3/§9). Only context.storage is used
 * by setup, so a storage-only fake context suffices.
 */

import { test } from "node:test"
import assert from "node:assert/strict"

const SERVER_PORT_STORAGE_KEY = "insight-server-port"

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

/**
 * opencode-db-insight server plugin entry (DESIGN.md §3/§9).
 * Pure assembly: start the insight server, publish its actual port via the
 * plugin storage (for the M6 TUI commands), tear everything down on cleanup.
 * No business logic lives here.
 */

import { Plugin } from "@opencode/plugin"

import { startInsightServer } from "./web/server.ts"

/** storage key holding a user override for the opencode.db path (DESIGN §4). */
const DATABASE_PATH_STORAGE_KEY = "insight-db-path"
/** storage key publishing the actually bound port for TUI commands (DESIGN §9). */
const SERVER_PORT_STORAGE_KEY = "insight-server-port"

export default Plugin.define({
  id: "opencode-db-insight",
  async setup(context) {
    const storedDatabasePath = await context.storage.get(DATABASE_PATH_STORAGE_KEY)
    const databasePathOverride =
      typeof storedDatabasePath === "string" && storedDatabasePath !== ""
        ? storedDatabasePath
        : undefined

    const insightServer = await startInsightServer({ databasePath: databasePathOverride })
    await context.storage.set(SERVER_PORT_STORAGE_KEY, insightServer.port)

    return async () => {
      await context.storage.remove(SERVER_PORT_STORAGE_KEY)
      await insightServer.close()
    }
  },
})

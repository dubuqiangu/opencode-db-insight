/**
 * opencode-db-insight server plugin entry (DESIGN.md §3/§9).
 * Pure assembly: start the insight server, tear everything down on cleanup.
 * No business logic lives here.
 *
 * The storage port write below is a legacy leftover with no reader: the
 * TUI plugin flavor runs in a different process with a different storage
 * backend and now discovers the port via loopback health probing
 * (src/tui/discover-dashboard-port.ts, 18789..18798 /api/health). The
 * write stays for one more release and will be dropped later.
 */

import { Plugin } from "@opencode/plugin"

import { startInsightServer } from "./web/server.ts"

/** storage key holding a user override for the opencode.db path (DESIGN §4). */
const DATABASE_PATH_STORAGE_KEY = "insight-db-path"
/** Legacy storage key holding the actually bound port — no reader since the
 * TUI flavor moved to health probing (DESIGN §9); kept briefly for cleanup. */
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
    try {
      await context.storage.set(SERVER_PORT_STORAGE_KEY, insightServer.port)
    } catch (storageSetError) {
      // Never leak a running server when the port could not be published.
      try {
        await insightServer.close()
      } catch (serverCloseError) {
        console.error("opencode-db-insight: closing server after storage.set failed", serverCloseError)
      }
      throw storageSetError
    }

    return async () => {
      // Server first, then the storage key: a failing remove() must never
      // prevent the close (and vice versa) — both are best-effort here.
      try {
        await insightServer.close()
      } catch (serverCloseError) {
        console.error("opencode-db-insight: server close failed during teardown", serverCloseError)
      }
      try {
        await context.storage.remove(SERVER_PORT_STORAGE_KEY)
      } catch (storageRemoveError) {
        console.error("opencode-db-insight: removing published port failed", storageRemoveError)
      }
    }
  },
})

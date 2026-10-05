/**
 * opencode-db-insight server entry.
 * Placeholder for M0 scaffold; the insight web server (src/web/server.ts)
 * is assembled here in M2 — see DESIGN.md §3 / tasks.md.
 */
import { Plugin } from "@opencode/plugin"

export default Plugin.define({
  id: "opencode-db-insight",
  setup() {
    return () => {
      // teardown: server shutdown lands in M2
    }
  },
})

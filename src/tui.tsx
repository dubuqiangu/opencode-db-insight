/**
 * opencode-db-insight TUI entry (DESIGN.md §8, M6): thin assembly only.
 * Command registration lives in src/tui/command-registry.ts; this file
 * just wires it into the plugin lifecycle.
 *
 * v0.24.0: the sidebar todo block is loaded through a dynamic import on
 * purpose. `src/tui/sidebar-todo.tsx` is the only module in this plugin that
 * needs the host-provided `@opentui/solid` / `solid-js` runtime, and that
 * runtime is resolved by the host at async-import time. Loading it lazily
 * keeps a failure to a *silent sidebar downgrade* instead of taking the whole
 * TUI entry — and with it the /insight slash commands — down at load time.
 */
import { defineInsightPlugin } from "./plugin-definition.ts"

import { registerInsightTuiCommands } from "./tui/command-registry.ts"

export default defineInsightPlugin({
  id: "opencode-db-insight",
  setup(context: any) {
    const commandsDispose = registerInsightTuiCommands(context)
    let sidebarDispose: (() => void) | undefined
    // The sidebar registers asynchronously (dynamic import). If the plugin is
    // torn down before that import resolves, the cleanup below runs with
    // sidebarDispose still undefined and never disposes the slot that the
    // late-resolving import is about to claim (plus its 1s setInterval). This
    // flag lets the `.then` detect that race and unregister immediately —
    // mirroring the isDisposed owner pattern in src/tui/sidebar-todo.tsx.
    let disposed = false

    void import("./tui/sidebar-todo.tsx")
      .then((sidebarModule) => {
        const disposeSidebar = sidebarModule.registerSessionTodoSidebar(context)
        if (disposed) {
          // Unloaded while the import was in flight: never leave the slot
          // claimed. Dispose the just-registered sidebar right away.
          disposeSidebar()
          return
        }
        sidebarDispose = disposeSidebar
      })
      .catch((sidebarLoadError) => {
        // Host without the solid/opentui runtime (or a slot API mismatch):
        // drop the block, keep the commands. Never rethrow from setup.
        console.error("db-insight: 侧栏 todo 侧栏加载失败，已跳过（命令不受影响）", sidebarLoadError)
      })

    return () => {
      disposed = true
      sidebarDispose?.()
      commandsDispose?.()
    }
  },
})

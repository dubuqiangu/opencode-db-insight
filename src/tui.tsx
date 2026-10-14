/**
 * opencode-db-insight TUI entry (DESIGN.md §8, M6): thin assembly only.
 * Command registration lives in src/tui/command-registry.ts; this file
 * just wires it into the plugin lifecycle.
 */
import { defineInsightPlugin } from "./plugin-definition.ts"

import { registerInsightTuiCommands } from "./tui/command-registry.ts"

export default defineInsightPlugin({
  id: "opencode-db-insight",
  setup(context: any) {
    const commandsDispose = registerInsightTuiCommands(context)
    return () => {
      commandsDispose?.()
    }
  },
})

/** @jsxImportSource @opentui/solid */
/**
 * opencode-db-insight TUI entry (DESIGN.md §8, M6): thin assembly only.
 * Command registration lives in src/tui/command-registry.ts, the status
 * dialog lifecycle in src/tui/status-dialog.ts and its JSX in
 * src/tui/status-dialog-render.tsx; this file just wires them together.
 */
import { defineInsightPlugin } from "./plugin-definition.ts"

import { registerInsightTuiCommands } from "./tui/command-registry.ts"
import { renderStatusDialog } from "./tui/status-dialog-render.tsx"
import { createStatusDialog, registerStatusDialogKeymap } from "./tui/status-dialog.ts"

export default defineInsightPlugin({
  id: "opencode-db-insight",
  setup(context: any) {
    // One setup-scoped dialog: its ESC/r modal keymap layer is registered
    // once and stays dormant (enabled: false) while the dialog is closed.
    const statusDialog = createStatusDialog(context, renderStatusDialog)

    const commandsDispose = registerInsightTuiCommands(context, {
      runStatusDialog: () => {
        statusDialog.open()
      },
    })
    const statusKeymapDispose = registerStatusDialogKeymap(context, {
      isActive: statusDialog.isOpen,
      close: statusDialog.close,
      refresh: statusDialog.refreshData,
    })

    return () => {
      commandsDispose?.()
      statusKeymapDispose?.()
      statusDialog.dispose()
    }
  },
})

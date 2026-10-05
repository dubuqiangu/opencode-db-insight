/** @jsxImportSource @opentui/solid */
/**
 * opencode-db-insight TUI entry.
 * Registers slash commands (/insight, /insight-status, /insight-export).
 * Panel implementation lives in src/tui/ (see DESIGN.md §8); placeholder
 * commands until M6 lands.
 */
import { Plugin } from "@opencode/plugin/tui"

export default Plugin.define({
  id: "opencode-db-insight",
  setup(context: any) {
    const keymapDispose = context.keymap?.layer(() => ({
      mode: "global",
      commands: [
        {
          id: "opencode-db-insight.open",
          title: "打开 db-insight 看板",
          bind: "",
          palette: true,
          slash: { name: "insight", aliases: [] },
          run: () => {
            context.ui?.toast?.show?.("db-insight 看板开发中（见 tasks.md M6）")
          },
        },
      ],
    }))
    return () => {
      keymapDispose?.()
    }
  },
})

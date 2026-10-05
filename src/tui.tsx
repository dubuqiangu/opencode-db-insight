/** @jsxImportSource @opentui/solid */
/**
 * opencode-db-insight TUI entry.
 * Registers slash commands (/insight, /insight-status, /insight-export);
 * this file only wires commands, the logic lives in src/tui/ (DESIGN.md §8).
 */
import { Plugin } from "@opencode/plugin/tui"
import { runExportCommand } from "./tui/export-command.ts"

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
            context.ui?.toast?.show?.({
              message: "db-insight 看板开发中（见 tasks.md M6）",
              variant: "info",
            })
          },
        },
        {
          id: "opencode-db-insight.export",
          title: "导出会话为 Markdown",
          bind: "",
          palette: true,
          // arguments: true makes the raw text after "/insight-export " reach
          // run(input) — an explicit session id skips the picker dialog.
          slash: { name: "insight-export", aliases: [], arguments: true },
          run: (commandInput?: string) => {
            void runExportCommand(context, commandInput)
          },
        },
      ],
    }))
    return () => {
      keymapDispose?.()
    }
  },
})

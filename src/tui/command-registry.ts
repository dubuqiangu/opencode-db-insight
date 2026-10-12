/**
 * Command registration for the insight TUI (DESIGN.md §8, M6).
 *
 * Everything except the JSX render lambda lives here so tests can drive a
 * fake context: the four slash commands, with /insight-status delegating to
 * the status dialog runner wired by tui.tsx (the retired sidebar-panel
 * route — ui.panel.open + the session.panel slot claim — is gone as of
 * v0.16.0; the command now opens a ui.dialog).
 *
 * All context access is defensive: a host without keymap / ui.dialog
 * degrades silently (T6.3) — a TUI must never crash because a plugin
 * expected an API the host does not ship.
 */

import { runExportCommand } from "./export-command.ts"
import { runOpenDashboardCommand } from "./open-dashboard-command.ts"
import { runRefreshCommand } from "./refresh-command.ts"
import { showInsightToast } from "./tui-context.ts"

/** Injectable command runners; tests replace them to observe calls. */
export interface InsightTuiCommandDependencies {
  runOpenDashboard?: (context: unknown) => Promise<boolean>
  runExport?: (context: unknown, explicitSessionId?: string) => Promise<string | null>
  /**
   * /insight-refresh (v0.14.0): clears the SERVER process result cache
   * via the loopback /api/refresh route — never a direct
   * clearResultCache import (the TUI is a different process, so that
   * would be a silent no-op).
   */
  runRefresh?: (context: unknown) => Promise<boolean>
  /**
   * Opens the /insight-status dialog. tui.tsx wires this to the shared
   * setup-scoped StatusDialog (its ESC/r modal keymap layer is registered
   * once at setup), so the dialog cannot be built per invocation here.
   */
  runStatusDialog?: (context: unknown) => void
}

/**
 * Register the four slash commands (/insight, /insight-status,
 * /insight-export, /insight-refresh) on the context keymap. Returns the
 * dispose function (or undefined when the host ships no keymap).
 */
export function registerInsightTuiCommands(
  context: unknown,
  dependencies: InsightTuiCommandDependencies = {},
): (() => void) | undefined {
  const openDashboardRunner = dependencies.runOpenDashboard ?? runOpenDashboardCommand
  const exportRunner = dependencies.runExport ?? runExportCommand
  const refreshRunner = dependencies.runRefresh ?? runRefreshCommand
  // Without an injected dialog runner there is no ESC-wired dialog to open;
  // a silent no-op would hide the wiring bug, so complain loudly instead.
  const statusDialogRunner =
    dependencies.runStatusDialog ??
    (() => {
      showInsightToast(context, "db-insight: 用量弹窗未装配", "error")
    })

  try {
    const contextRecord = context as
      | { keymap?: { layer?: (buildLayer: () => unknown) => () => void } }
      | null
      | undefined
    const layerRegistrar = contextRecord?.keymap?.layer
    if (typeof layerRegistrar !== "function") return undefined

    const keymapDispose = layerRegistrar.call(contextRecord?.keymap, () => ({
      mode: "global",
      commands: [
        {
          id: "opencode-db-insight.open",
          title: "打开 db-insight 看板",
          palette: true,
          slash: { name: "insight", aliases: [] },
          run: () => {
            void openDashboardRunner(context)
          },
        },
        {
          id: "opencode-db-insight.status",
          title: "显示 db-insight 用量弹窗",
          palette: true,
          slash: { name: "insight-status", aliases: [] },
          run: () => {
            statusDialogRunner(context)
          },
        },
        {
          id: "opencode-db-insight.export",
          title: "导出会话为 Markdown",
          palette: true,
          // arguments: true makes the raw text after "/insight-export "
          // reach run(input); an explicit session id skips the picker.
          slash: { name: "insight-export", aliases: [], arguments: true },
          run: (commandInput?: string) => {
            void exportRunner(context, commandInput)
          },
        },
        {
          id: "opencode-db-insight.refresh",
          title: "刷新看板缓存",
          palette: true,
          // No arguments: the refresh clears the whole server-side
          // cache, there is nothing to parameterize.
          slash: { name: "insight-refresh", aliases: [] },
          run: () => {
            void refreshRunner(context)
          },
        },
      ],
    }))
    return () => {
      keymapDispose?.()
    }
  } catch (registrationError) {
    // Never throw (T6.3: a host without the API degrades silently), but a
    // swallowed registration failure must be diagnosable — a layer() shape
    // rejection otherwise makes the slash commands vanish without a trace.
    console.error("db-insight: TUI 命令注册失败", registrationError)
    return undefined
  }
}

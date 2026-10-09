/**
 * Command and slot registration for the insight TUI (DESIGN.md §8, M6).
 *
 * Everything except the JSX render lambda lives here so tests can drive a
 * fake context: the four slash commands, the panel-open call behind
 * /insight-status, and the defensive session.panel slot claim.
 *
 * All context access is defensive: a host without keymap / ui.panel / ui.slot
 * degrades silently (T6.3) — a TUI must never crash because a plugin
 * expected an API the host does not ship.
 */

import { runExportCommand } from "./export-command.ts"
import { runOpenDashboardCommand } from "./open-dashboard-command.ts"
import { runRefreshCommand } from "./refresh-command.ts"
import { showInsightToast } from "./tui-context.ts"

/** Panel content name /insight-status opens via ui.panel.open. */
export const INSIGHT_STATUS_PANEL_NAME = "insight-status"

/** slot input shape we read in shouldRenderStatusPanel / the render guard. */
interface SessionPanelSlotInput {
  name?: unknown
}

/**
 * Pure: should this slot render claim draw the insight panel?
 * Only when the host selected our panel name (ui.panel.open sets it).
 */
export function shouldRenderStatusPanel(slotInput: unknown): boolean {
  const inputRecord = slotInput as SessionPanelSlotInput | null | undefined
  return inputRecord?.name === INSIGHT_STATUS_PANEL_NAME
}

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
   * Notified when /insight-status successfully opened the panel — the
   * status-panel controller uses this to start its lazy refresh loop
   * (P2-13). Not called when the host refuses the panel.
   */
  onStatusPanelOpened?: () => void
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
  const onStatusPanelOpened = dependencies.onStatusPanelOpened

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
          bind: "",
          palette: true,
          slash: { name: "insight", aliases: [] },
          run: () => {
            void openDashboardRunner(context)
          },
        },
        {
          id: "opencode-db-insight.status",
          title: "显示 db-insight 用量面板",
          bind: "",
          palette: true,
          slash: { name: "insight-status", aliases: [] },
          run: () => {
            openStatusPanel(context, onStatusPanelOpened)
          },
        },
        {
          id: "opencode-db-insight.export",
          title: "导出会话为 Markdown",
          bind: "",
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
          bind: "",
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
  } catch {
    return undefined
  }
}

/**
 * Open (or complain about) the insight status panel; never throws. On a
 * successful open the optional onStatusPanelOpened callback fires so the
 * panel controller can begin its lazy refresh loop (P2-13).
 */
function openStatusPanel(context: unknown, onStatusPanelOpened?: () => void): void {
  try {
    const contextRecord = context as
      | { ui?: { panel?: { open?: (panelName: string) => boolean } } }
      | null
      | undefined
    const panelOpener = contextRecord?.ui?.panel?.open
    if (typeof panelOpener !== "function") {
      showInsightToast(context, "db-insight: 当前界面不支持面板", "error")
      return
    }
    const openedPanel = panelOpener.call(contextRecord?.ui?.panel, INSIGHT_STATUS_PANEL_NAME)
    if (openedPanel === false) {
      showInsightToast(context, "db-insight: 当前界面不支持面板", "error")
      return
    }
    try {
      onStatusPanelOpened?.()
    } catch {
      // A broken controller callback must never break the command.
    }
  } catch {
    showInsightToast(context, "db-insight: 当前界面不支持面板", "error")
  }
}

/**
 * Claim the session.panel slot with an injected render function.
 * Returns the slot dispose, or undefined when the host ships no ui.slot
 * (sidebar-less environment → silently not registered, T6.2).
 */
export function registerStatusPanelSlot(
  context: unknown,
  renderPanel: (slotInput: unknown) => unknown,
): (() => void) | undefined {
  try {
    const contextRecord = context as
      | { ui?: { slot?: (claim: unknown) => () => void } }
      | null
      | undefined
    const slotRegistrar = contextRecord?.ui?.slot
    if (typeof slotRegistrar !== "function") return undefined

    const slotDispose = slotRegistrar.call(contextRecord?.ui?.slot, {
      append: "session.panel",
      render: (slotInput: unknown) => renderPanel(slotInput),
    })
    return typeof slotDispose === "function"
      ? () => {
          slotDispose()
        }
      : undefined
  } catch {
    return undefined
  }
}

/**
 * Dialog lifecycle for /insight-status (redesign v0.16.0): one bounded scan
 * per snapshot, ui.dialog.show + size "large", ESC/r via a modal keymap
 * layer that lives only while the dialog is open.
 *
 * The dialog is a transient snapshot — the retired panel's 60s auto-refresh
 * loop is intentionally gone. Pressing r (wired through the same modal
 * layer) recomputes on demand; ESC closes.
 *
 * Host facts (node_modules/@opencode/plugin/dist/tui/context.d.ts):
 * - dialog.show(render, onClose?) / dialog.set({size, centered}) /
 *   dialog.clear(); DialogSize is "medium" | "large" | "xlarge".
 * - The host handles ESC only for its built-in alert/confirm/prompt/select;
 *   a custom dialog content must register its own keymap layer
 *   (mode: "modal", per the host storybook precedent). keymap.layer()
 *   returns void per the typings, so the layer cannot be torn down
 *   manually — its `enabled` flag therefore lives only while the dialog is
 *   open, backed by a Solid signal the host layer evaluates reactively.
 *
 * Every host access is defensive: a host without ui.dialog / keymap
 * degrades to a toast instead of crashing the TUI.
 */

import { createSignal } from "solid-js"

import type { SqliteReadConnection } from "../db/types.ts"
import { openOpencodeDb } from "../db/queries.ts"
import { toLocalDateKey } from "../stats/daily-buckets.ts"
import { collectStatusPanelData } from "./status-panel-data.ts"
import {
  buildStatusDialogLines,
  formatClockTime,
  type StatusDialogLine,
} from "./status-dialog-content.ts"
import { showInsightToast } from "./tui-context.ts"

/** Presentation options we ask the host to apply to the dialog. */
const STATUS_DIALOG_PRESENTATION = { size: "large", centered: true } as const

/** What the whole dialog needs to render: pre-built, styled-role lines. */
export interface StatusDialogSnapshot {
  readonly lines: readonly StatusDialogLine[]
}

/** Injectable knobs; production calls use the defaults. */
export interface StatusDialogDependencies {
  /** Opens a read-only connection; defaults to the real opencode.db. */
  databaseProvider?: () => SqliteReadConnection | null
  /** Clock, injectable so tests pin "now". */
  nowMs?: () => number
}

/** The setup-scoped status dialog handle owned by tui.tsx. */
export interface StatusDialog {
  /** Collect a fresh snapshot and show the dialog. */
  open(): void
  /** Close the dialog (idempotent). */
  close(): void
  /** True while the dialog is shown; drives the modal keymap layer. */
  isOpen(): boolean
  /** Recompute the snapshot behind the open dialog (the r key). */
  refreshData(): void
  /** Close for good — called from the plugin teardown. */
  dispose(): void
}

/** Structural shape of the slice of `context.ui.dialog` we rely on. */
interface DialogHostSurface {
  show?: (render: () => unknown, onClose?: () => void) => void
  set?: (options: { size?: string; centered?: boolean }) => void
  clear?: () => void
}

/** Read `context.ui.dialog` defensively; null on any missing piece. */
function readDialogHost(context: unknown): DialogHostSurface | null {
  try {
    const contextRecord = context as
      | { ui?: { dialog?: DialogHostSurface } }
      | null
      | undefined
    return contextRecord?.ui?.dialog ?? null
  } catch {
    return null
  }
}

/**
 * Create the status dialog for one plugin setup. `renderSnapshot` turns a
 * snapshot into renderable content (the JSX lives in
 * status-dialog-render.tsx so this module stays testable in plain node);
 * it is re-evaluated reactively whenever r refreshes the data.
 */
export function createStatusDialog(
  context: unknown,
  renderSnapshot: (readSnapshot: () => StatusDialogSnapshot) => unknown,
  dependencies: StatusDialogDependencies = {},
): StatusDialog {
  const databaseProvider = dependencies.databaseProvider ?? openOpencodeDb
  const nowMs = dependencies.nowMs ?? Date.now
  const dialogHost = readDialogHost(context)

  const [snapshot, setSnapshot] = createSignal<StatusDialogSnapshot>({ lines: [] })
  const [dialogOpen, setDialogOpen] = createSignal(false)

  const refreshData = (): void => {
    let databaseConnection: SqliteReadConnection | null = null
    let currentNowMs = Date.now()
    try {
      currentNowMs = nowMs()
      databaseConnection = databaseProvider()
      const statusData =
        databaseConnection === null
          ? null
          : collectStatusPanelData(databaseConnection, currentNowMs)
      setSnapshot({
        lines: buildStatusDialogLines(
          statusData,
          formatClockTime(currentNowMs),
          toLocalDateKey(currentNowMs),
        ),
      })
    } catch {
      // A missing database, a throwing provider or a broken query all
      // collapse into the dignified unavailable copy — never a raw error.
      setSnapshot({
        lines: buildStatusDialogLines(
          null,
          formatClockTime(currentNowMs),
          toLocalDateKey(currentNowMs),
        ),
      })
    } finally {
      try {
        databaseConnection?.close()
      } catch {
        // Closing a broken connection must not surface as a crash.
      }
    }
  }

  const open = (): void => {
    // Capability check first: a host without ui.dialog must not pay for a
    // full-database scan it can never show.
    const showDialog = dialogHost?.show
    if (typeof showDialog !== "function") {
      showInsightToast(context, "db-insight: 当前界面不支持弹窗", "error")
      return
    }
    refreshData()
    setDialogOpen(true)
    try {
      showDialog.call(dialogHost, () => renderSnapshot(() => snapshot()), () => {
        setDialogOpen(false)
      })
    } catch (dialogShowError) {
      // The host rejected the show: drop the open flag before reporting —
      // a stuck-true flag would keep the modal keymap layer active with no
      // dialog on screen, r hijacking keys and re-scanning per keypress.
      setDialogOpen(false)
      showInsightToast(context, "db-insight: 用量弹窗打开失败", "error")
      return
    }
    const setDialogOptions = dialogHost?.set
    if (typeof setDialogOptions === "function") {
      try {
        setDialogOptions.call(dialogHost, { ...STATUS_DIALOG_PRESENTATION })
      } catch {
        // Presentation options are best-effort; the dialog still shows.
      }
    }
  }

  const close = (): void => {
    // Guard: ui.dialog.clear() closes *the currently active* host dialog.
    // When ours is already gone, whatever is on screen belongs to another
    // plugin (e.g. the /insight-export select) and must not be killed.
    if (!dialogOpen()) return
    setDialogOpen(false)
    try {
      dialogHost?.clear?.()
    } catch {
      // Closing must never throw into the keymap handler.
    }
  }

  return {
    open,
    close,
    isOpen: () => dialogOpen(),
    refreshData,
    dispose: () => {
      close()
    },
  }
}

/** Handlers the modal keymap layer dispatches to. */
export interface StatusDialogKeymapHandlers {
  /** True while the dialog is open (read from a Solid signal). */
  isActive: () => boolean
  /** ESC. */
  close: () => void
  /** r. */
  refresh: () => void
}

/**
 * Register the modal keymap layer that owns ESC (close) and r (refresh)
 * while the /insight-status dialog is open. The layer is registered once
 * at plugin setup; its `enabled` flag keeps it dormant outside the
 * dialog's lifetime because keymap.layer() exposes no manual disposal
 * (it returns void per the host typings).
 */
export function registerStatusDialogKeymap(
  context: unknown,
  handlers: StatusDialogKeymapHandlers,
): (() => void) | undefined {
  try {
    const contextRecord = context as
      | { keymap?: { layer?: (buildLayer: () => unknown) => unknown } }
      | null
      | undefined
    const layerRegistrar = contextRecord?.keymap?.layer
    if (typeof layerRegistrar !== "function") return undefined

    const layerResult = layerRegistrar.call(contextRecord?.keymap, () => ({
      mode: "modal",
      enabled: () => handlers.isActive(),
      commands: [
        {
          bind: "escape",
          title: "关闭用量弹窗",
          group: "opencode-db-insight",
          run: () => handlers.close(),
        },
        {
          bind: "r",
          title: "刷新用量数据",
          group: "opencode-db-insight",
          run: () => handlers.refresh(),
        },
      ],
    }))
    // The host typings say layer() returns void; treat a dispose function
    // as a bonus instead of relying on it.
    return typeof layerResult === "function" ? () => (layerResult as () => void)() : undefined
  } catch (keymapRegistrationError) {
    // Same contract as the command registration: degrade, never throw,
    // but leave a diagnosable trace in the host log.
    console.error("db-insight: 状态弹窗键位层注册失败", keymapRegistrationError)
    return undefined
  }
}

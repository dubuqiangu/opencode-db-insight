/**
 * Refresh lifecycle for the /insight-status panel (task T6.2/T6.3):
 * computes the panel text, re-computes on an interval, and cleans the
 * interval up on dispose (the plugin teardown calls it).
 *
 * The auto-refresh interval starts lazily (P2-13): creating the
 * controller is free, and only beginAutoRefresh() — called when the
 * panel is actually opened — computes the first text and starts the
 * timer. Until then the plugin startup does not pay for a scan.
 *
 * The controller never throws: a missing database, a throwing provider or
 * a broken query all collapse into the single "数据不可用" line. The db
 * connection (when opened here) is closed after every refresh.
 */

import type { SqliteReadConnection } from "../db/types.ts"
import { openOpencodeDb } from "../db/queries.ts"
import { collectStatusPanelData } from "./status-panel-data.ts"
import { renderStatusPanelText, UNAVAILABLE_STATUS_PANEL_TEXT } from "./status-panel-text.ts"

/** Panel auto-refresh cadence (DESIGN.md §8: 60s). */
export const STATUS_PANEL_REFRESH_INTERVAL_MS = 60_000

/** Injectable knobs; production calls use the defaults. */
export interface StatusPanelControllerDependencies {
  /** Opens a read-only connection; defaults to the real opencode.db. */
  databaseProvider?: () => SqliteReadConnection | null
  /** Refresh cadence; 0 or negative disables auto refresh (tests). */
  refreshIntervalMs?: number
  /** Clock, injectable so tests pin "today". */
  nowMs?: () => number
  /** Notified on every recomputed text (tui.tsx wires a Solid signal). */
  onPanelTextChanged?: (panelText: string) => void
}

export interface StatusPanelController {
  /** Latest panel text (read reactively by the slot render). */
  currentPanelText(): string
  /** Recompute now; also what the interval runs. */
  refresh(): void
  /**
   * Start the lazy auto-refresh loop — call when the panel is first
   * opened (P2-13). Idempotent: computes the first text immediately and
   * schedules the interval; later calls are no-ops.
   */
  beginAutoRefresh(): void
  /** Stop the interval — must be called from the plugin teardown. */
  dispose(): void
}

export function createStatusPanelController(
  dependencies: StatusPanelControllerDependencies = {},
): StatusPanelController {
  const databaseProvider = dependencies.databaseProvider ?? openOpencodeDb
  const nowMs = dependencies.nowMs ?? Date.now
  const onPanelTextChanged = dependencies.onPanelTextChanged

  let currentPanelText = ""
  let refreshTimer: ReturnType<typeof setInterval> | undefined
  let autoRefreshStarted = false

  const refresh = (): void => {
    try {
      const databaseConnection = databaseProvider()
      try {
        currentPanelText = renderStatusPanelText(collectStatusPanelData(databaseConnection, nowMs()))
      } finally {
        databaseConnection?.close()
      }
    } catch {
      currentPanelText = UNAVAILABLE_STATUS_PANEL_TEXT
    }
    try {
      onPanelTextChanged?.(currentPanelText)
    } catch {
      // A broken subscriber must never break the refresh loop.
    }
  }

  const refreshIntervalMs = dependencies.refreshIntervalMs ?? STATUS_PANEL_REFRESH_INTERVAL_MS

  const beginAutoRefresh = (): void => {
    if (autoRefreshStarted) return
    autoRefreshStarted = true
    refresh()
    if (Number.isFinite(refreshIntervalMs) && refreshIntervalMs > 0) {
      refreshTimer = setInterval(refresh, refreshIntervalMs)
    }
  }

  return {
    currentPanelText: () => currentPanelText,
    refresh,
    beginAutoRefresh,
    dispose: () => {
      autoRefreshStarted = true // never start a stray interval after dispose
      if (refreshTimer !== undefined) {
        clearInterval(refreshTimer)
        refreshTimer = undefined
      }
    },
  }
}

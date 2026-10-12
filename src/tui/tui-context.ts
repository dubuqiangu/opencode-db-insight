/**
 * Defensive access helpers for the opencode TUI plugin context.
 *
 * The host TUI may not expose `ui.toast` / `ui.dialog` on every build, and
 * its storage surface (store/memory key-value stores, per
 * node_modules/@opencode/plugin/dist/tui/context.d.ts) offers NO readable
 * channel to the server plugin flavor — a different process with a
 * different storage backend. The dashboard port therefore never travels
 * through storage in the TUI; it is discovered by loopback health probing
 * (see ./discover-dashboard-port.ts). Every helper here must degrade
 * silently instead of breaking the TUI.
 */

/** Show a toast; any missing API or failure degrades silently. */
export function showInsightToast(
  context: unknown,
  message: string,
  variant: "info" | "error" | "success",
): void {
  try {
    const contextRecord = context as
      | { ui?: { toast?: { show?: (toastOptions: unknown) => void } } }
      | null
      | undefined
    contextRecord?.ui?.toast?.show?.({ message, variant })
  } catch {
    // The host TUI may not implement toasts — nothing we can do about it.
  }
}

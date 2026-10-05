/**
 * Defensive access helpers for the opencode TUI plugin context.
 *
 * The host TUI may not expose `ui.toast` / `ui.dialog` / `storage`, and the
 * storage surface differs between the server plugin flavor (get/set/remove,
 * used by src/index.ts to publish the port) and the TUI flavor (store/memory).
 * Every helper here must degrade silently instead of breaking the TUI.
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

/** storage key the server plugin publishes the actually bound port under. */
export const SERVER_PORT_STORAGE_KEY = "insight-server-port"

function coerceServerPort(storedPort: unknown): number | null {
  const portNumber =
    typeof storedPort === "number" ? storedPort : Number(storedPort)
  if (!Number.isInteger(portNumber)) return null
  if (portNumber < 1 || portNumber > 65535) return null
  return portNumber
}

/**
 * Read the port the server plugin published under SERVER_PORT_STORAGE_KEY.
 * Handles the server-flavor storage contract (get(key), possibly async) and
 * yields null when storage is missing, throws, or holds no usable port.
 */
export async function readInsightServerPort(context: unknown): Promise<number | null> {
  try {
    const contextRecord = context as
      | { storage?: { get?: (storageKey: string) => unknown } }
      | null
      | undefined
    const storageObject = contextRecord?.storage
    const getReader = storageObject?.get
    if (typeof getReader !== "function") return null

    const retrievedPort = getReader.call(storageObject, SERVER_PORT_STORAGE_KEY)
    // The server plugin's storage.get is async; tolerate a sync value too.
    const settledPort =
      retrievedPort !== null &&
      typeof retrievedPort === "object" &&
      typeof (retrievedPort as { then?: unknown }).then === "function"
        ? await (retrievedPort as Promise<unknown>)
        : retrievedPort
    return coerceServerPort(settledPort)
  } catch {
    return null
  }
}

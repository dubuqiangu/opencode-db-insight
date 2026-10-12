/**
 * Service identity shared by both plugin flavors (server and TUI).
 *
 * The TUI flavor cannot read the server flavor's storage — the two flavors
 * run in different processes with different storage backends (the TUI host
 * only exposes store/memory key-value stores, no `get` reader), so the
 * dashboard port cannot travel through storage. Instead GET /api/health
 * carries this name in its `service` field, and the TUI-side port
 * discovery (src/tui/discover-dashboard-port.ts) validates against it: a
 * foreign process answering in the same port range must never be mistaken
 * for the insight server.
 *
 * This module is deliberately dependency-free: importing it from the TUI
 * must never drag server-side modules (node:sqlite glue, node:http wiring)
 * into the TUI process.
 */

/** Wire value of the `service` field in the GET /api/health body. */
export const INSIGHT_SERVICE_NAME = "opencode-db-insight"

/**
 * Insight HTTP server lifecycle (DESIGN.md §9):
 * - node:http, bound to 127.0.0.1 only, never exposed externally;
 * - default port 18789, on EADDRINUSE retry port+1, at most 10 attempts;
 * - close() rejects new connections (server.close), drops keep-alive
 *   sockets (closeAllConnections) and releases the db connection;
 * - serverFactory is injectable so tests can simulate EADDRINUSE chains.
 */

import { createServer } from "node:http"
import type { RequestListener } from "node:http"
import { fileURLToPath } from "node:url"

import type { SqliteReadConnection } from "../db/types.ts"
import { openOpencodeDb, resolveOpencodeDbPath } from "../db/queries.ts"
import { createInsightRequestHandler } from "./request-handler.ts"

export const DEFAULT_INSIGHT_HOST = "127.0.0.1"
export const DEFAULT_INSIGHT_PORT = 18_789
export const MAX_PORT_ATTEMPTS = 10

/**
 * Minimal structural interface over node:http.Server so tests can inject
 * fakes that simulate EADDRINUSE without binding real sockets.
 */
export interface InsightHttpServer {
  listen(port: number, host: string, callback: () => void): void
  close(callback?: (closeError?: Error | null) => void): void
  once(event: "error", listener: (listenError: Error) => void): void
  closeAllConnections?(): void
  address(): { port: number } | string | null
}

export type InsightServerFactory = (requestListener: RequestListener) => InsightHttpServer

const defaultServerFactory: InsightServerFactory = (requestListener) =>
  createServer(requestListener) as unknown as InsightHttpServer

/** Default dashboard directory: src/web/public (created by M3). */
export function resolveDefaultPublicDirectory(): string {
  return fileURLToPath(new URL("./public", import.meta.url))
}

export interface InsightServerOptions {
  host?: string
  /** 0 lets the OS assign a free port (used by tests). */
  port?: number
  /** Total listen attempts across the port+1 retry chain. */
  maxPortAttempts?: number
  /** Defaults to the opencode.db path (overridable via storage, DESIGN §4). */
  databasePath?: string
  /** Defaults to src/web/public. */
  publicDirectory?: string
  /** Injection point for tests; defaults to node:http.createServer. */
  serverFactory?: InsightServerFactory
}

export interface InsightServerHandle {
  host: string
  port: number
  /** Stop accepting connections, drop keep-alive sockets, close the db. */
  close(): Promise<void>
}

/** Listen once; rejects on the server's "error" event (e.g. EADDRINUSE). */
function listenOnPort(
  httpServer: InsightHttpServer,
  host: string,
  port: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    // The once-listener stays attached after success, which keeps later
    // server-level errors from crashing the process (rejecting a settled
    // promise is a no-op).
    httpServer.once("error", reject)
    httpServer.listen(port, host, () => {
      resolve()
    })
  })
}

function isAddressInUseError(listenError: unknown): boolean {
  return (
    typeof listenError === "object" &&
    listenError !== null &&
    (listenError as { code?: unknown }).code === "EADDRINUSE"
  )
}

/** Close the server, resolving/rejecting via node's close callback. */
function closeHttpServer(httpServer: InsightHttpServer): Promise<void> {
  return new Promise((resolve, reject) => {
    httpServer.close((closeError) => {
      if (closeError !== null && closeError !== undefined) reject(closeError)
      else resolve()
    })
  })
}

/**
 * Start the insight server. Throws only when every port attempt failed or a
 * non-EADDRINUSE listen error occurred; the returned handle's close() is the
 * plugin teardown path.
 */
export async function startInsightServer(
  options: InsightServerOptions = {},
): Promise<InsightServerHandle> {
  const host = options.host ?? DEFAULT_INSIGHT_HOST
  const initialPort = options.port ?? DEFAULT_INSIGHT_PORT
  const maxPortAttempts = Math.max(options.maxPortAttempts ?? MAX_PORT_ATTEMPTS, 1)
  const databasePath = options.databasePath ?? resolveOpencodeDbPath()
  const publicDirectory = options.publicDirectory ?? resolveDefaultPublicDirectory()
  const serverFactory = options.serverFactory ?? defaultServerFactory

  // Read-only connection kept for the server lifetime; if the db is absent
  // at startup (or node:sqlite unavailable) each request re-probes so the
  // API recovers once the file appears, without a plugin restart.
  let liveDatabase: SqliteReadConnection | null = openOpencodeDb(databasePath)
  const databaseProvider = (): SqliteReadConnection | null => {
    if (liveDatabase !== null) return liveDatabase
    liveDatabase = openOpencodeDb(databasePath)
    return liveDatabase
  }

  let boundPort = initialPort
  const requestListener = createInsightRequestHandler({
    databaseProvider,
    databasePath,
    publicDirectory,
    serverPortProvider: () => boundPort,
  })

  const httpServer = serverFactory(requestListener)
  let chosenPort = initialPort
  let remainingAttempts = maxPortAttempts
  while (true) {
    try {
      await listenOnPort(httpServer, host, chosenPort)
      break
    } catch (listenError) {
      if (!isAddressInUseError(listenError) || remainingAttempts <= 1) throw listenError
      remainingAttempts -= 1
      chosenPort += 1
    }
  }

  const boundAddress = httpServer.address()
  if (typeof boundAddress === "object" && boundAddress !== null) {
    boundPort = boundAddress.port
  } else {
    boundPort = chosenPort
  }

  return {
    host,
    port: boundPort,
    close: async () => {
      // Keep-alive sockets (fetch reuses them) would otherwise keep
      // server.close() pending until they time out.
      httpServer.closeAllConnections?.()
      liveDatabase?.close()
      liveDatabase = null
      await closeHttpServer(httpServer)
    },
  }
}

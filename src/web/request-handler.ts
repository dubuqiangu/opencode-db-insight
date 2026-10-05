/**
 * node:http glue: turns an IncomingMessage into a JSON API answer or a
 * static file response. All routing/paths decisions come from the pure
 * modules (router.ts / api.ts / static-files.ts); this file only parses,
 * dispatches and writes.
 */

import type { IncomingMessage, RequestListener, ServerResponse } from "node:http"
import { readFile } from "node:fs/promises"

import type { SqliteReadConnection } from "../db/types.ts"
import { handleApiRequest, type RawTextResponse } from "./api.ts"
import { matchApiRoute } from "./router.ts"
import { contentTypeForFilePath, resolveStaticFilePath } from "./static-files.ts"

/** Message shown for GET / until the M3 dashboard lands in public/. */
export const DASHBOARD_NOT_DEPLOYED_MESSAGE =
  "dashboard not deployed yet: src/web/public/index.html is missing (frontend arrives in M3)"

/** Everything the request handler needs, injected for testability. */
export interface InsightRequestHandlerDependencies {
  /** Current read-only db connection, or null while unavailable. */
  databaseProvider: () => SqliteReadConnection | null
  databasePath: string
  publicDirectory: string
  /** Bound port; only known after listen, hence a provider. */
  serverPortProvider: () => number
}

/** Write a JSON body with the given status. */
function respondWithJson(response: ServerResponse, statusCode: number, body: unknown): void {
  const bodyText = JSON.stringify(body)
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": String(Buffer.byteLength(bodyText)),
  })
  response.end(bodyText)
}

/** Write a plain text body with the given status. */
function respondWithText(response: ServerResponse, statusCode: number, bodyText: string): void {
  response.writeHead(statusCode, {
    "Content-Type": "text/plain; charset=utf-8",
    "Content-Length": String(Buffer.byteLength(bodyText)),
  })
  response.end(bodyText)
}

/** Write a raw (non-JSON) API body, e.g. the markdown export download. */
function respondWithRawText(
  response: ServerResponse,
  statusCode: number,
  rawText: RawTextResponse,
): void {
  response.writeHead(statusCode, {
    "Content-Type": rawText.contentType,
    "Content-Length": String(Buffer.byteLength(rawText.text)),
    ...rawText.headers,
  })
  response.end(rawText.text)
}

/** Serve one static file (or the right 404) for a non-API pathname. */
async function serveStaticExchange(
  response: ServerResponse,
  publicDirectory: string,
  pathname: string,
): Promise<void> {
  const filePath = resolveStaticFilePath(publicDirectory, pathname)
  if (filePath === null) {
    respondWithJson(response, 404, { error: "not found" })
    return
  }

  let fileContent: Buffer
  try {
    fileContent = await readFile(filePath)
  } catch {
    // Root missing its index.html means the front-end is not deployed yet;
    // other missing files are plain 404s.
    if (pathname === "/" || pathname === "") {
      respondWithText(response, 404, DASHBOARD_NOT_DEPLOYED_MESSAGE)
    } else {
      respondWithJson(response, 404, { error: "not found" })
    }
    return
  }

  response.writeHead(200, {
    "Content-Type": contentTypeForFilePath(filePath),
    "Content-Length": String(fileContent.length),
    "Cache-Control": "no-store",
  })
  response.end(fileContent)
}

/** Handle one exchange; never throws (all failures become 4xx/5xx). */
async function handleInsightExchange(
  request: IncomingMessage,
  response: ServerResponse,
  dependencies: InsightRequestHandlerDependencies,
): Promise<void> {
  const requestMethod = request.method ?? "GET"
  if (requestMethod !== "GET" && requestMethod !== "HEAD") {
    respondWithJson(response, 405, { error: "method not allowed" })
    return
  }

  let requestUrl: URL
  try {
    requestUrl = new URL(request.url ?? "/", "http://127.0.0.1")
  } catch {
    respondWithJson(response, 400, { error: "bad request" })
    return
  }

  const pathname = requestUrl.pathname
  if (pathname === "/api" || pathname.startsWith("/api/")) {
    const route = matchApiRoute(pathname)
    if (route === null) {
      respondWithJson(response, 404, { error: "not found" })
      return
    }
    const apiResponse = handleApiRequest({
      route,
      searchParams: requestUrl.searchParams,
      database: dependencies.databaseProvider(),
      databasePath: dependencies.databasePath,
      serverPort: dependencies.serverPortProvider(),
    })
    if (apiResponse.rawText !== undefined) {
      respondWithRawText(response, apiResponse.statusCode, apiResponse.rawText)
    } else {
      respondWithJson(response, apiResponse.statusCode, apiResponse.body)
    }
    return
  }

  await serveStaticExchange(response, dependencies.publicDirectory, pathname)
}

/** Build the node:http request listener for the insight server. */
export function createInsightRequestHandler(
  dependencies: InsightRequestHandlerDependencies,
): RequestListener {
  return (request, response) => {
    handleInsightExchange(request, response, dependencies).catch((handlerError: unknown) => {
      if (!response.headersSent) {
        const errorMessage = handlerError instanceof Error ? handlerError.message : String(handlerError)
        respondWithJson(response, 500, { error: `internal error: ${errorMessage}` })
      } else {
        response.end()
      }
    })
  }
}

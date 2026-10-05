/**
 * Static file resolution for the dashboard (DESIGN.md §3: GET /* → 静态看板页面).
 * Pure path logic; actual file reading lives in request-handler.ts.
 *
 * Security: every request path is decoded, resolved against the public
 * directory and must stay inside it — anything that would escape (dot-dot,
 * encoded traversal, absolute device paths) is rejected with null (404).
 */

import { extname, resolve, sep } from "node:path"

/** Content types for the zero-build front-end's file kinds (DESIGN §7). */
const CONTENT_TYPE_BY_FILE_EXTENSION: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
}

/** Content-Type for a file path by extension; unknown extensions stream as octet-stream. */
export function contentTypeForFilePath(filePath: string): string {
  const fileExtension = extname(filePath).toLowerCase()
  return CONTENT_TYPE_BY_FILE_EXTENSION[fileExtension] ?? "application/octet-stream"
}

/** Percent-decode a full pathname; malformed encoding yields null. */
function decodeRequestPathname(pathname: string): string | null {
  try {
    return decodeURIComponent(pathname)
  } catch {
    return null
  }
}

/**
 * Map a request pathname to a file inside the public directory.
 * "/" maps to index.html. Returns the absolute file path, or null when the
 * path is malformed or would escape the public directory (404).
 */
export function resolveStaticFilePath(publicDirectory: string, requestPathname: string): string | null {
  const publicRoot = resolve(publicDirectory)
  const relativePath = requestPathname === "/" || requestPathname === "" ? "/index.html" : requestPathname

  const decodedPath = decodeRequestPathname(relativePath)
  if (decodedPath === null || !decodedPath.startsWith("/")) return null

  // Prefix with "." so the path is always joined relative to publicRoot,
  // never interpreted as an absolute/device path.
  const candidatePath = resolve(publicRoot, "." + decodedPath)

  const publicRootPrefix = publicRoot.endsWith(sep) ? publicRoot : publicRoot + sep
  if (candidatePath !== publicRoot && !candidatePath.startsWith(publicRootPrefix)) return null
  return candidatePath
}

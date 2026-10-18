/**
 * Shared tool-part extraction for the SQL read layer.
 *
 * Extracted verbatim from tool-health-queries.ts so that
 * GET /api/tool-health and GET /api/tool-error-trend share ONE wire-rule
 * implementation: any change to the two-tier path list, the name
 * resolution or the status fallback now applies to both endpoints at
 * once, instead of leaving two byte-identical copies that could drift
 * apart and silently break the Σ-conservation between them.
 *
 * The extraction mirrors the two-tier discipline of aggregate-queries.ts
 * (agent stats): content arrays at or below the fast-path part limit are
 * read with direct multi-path json_extract() — content parts are never
 * serialized — while longer arrays fall back to a json_each walk that
 * sees every part. The agent-stats extraction stays deliberately
 * INDEPENDENT (extractToolNamesFromPartFields): its path list and output
 * shape are load-bearing for the agent-stats wire contract, so it is
 * NOT part of this shared module.
 */

import { coerceText, parseExtractedFieldList } from "./rows.ts"

/**
 * Content arrays longer than this take the json_each fallback (same
 * bound and reasoning as the agent-stats tool-name fast path in
 * aggregate-queries.ts).
 */
export const TOOL_PART_FAST_PATH_LIMIT = 8

/** Status bucket for tool parts whose state.status is not a string. */
export const UNKNOWN_TOOL_STATUS = "unknown"

/**
 * SQL path list for the fast pass: [type, name, tool, state.status] for
 * every content index below the part limit. Each entry is a ready-to-join
 * SQL string literal (single quotes included), so callers reproduce the
 * exact json_extract() argument fragment with `.join(", ")`. Direct path
 * lookups return only the small field values; the multi-KB tool states
 * and outputs stay in the parse-cached JSON document.
 */
export function buildToolPartFieldPaths(): string[] {
  const partFieldPaths: string[] = []
  for (let partIndex = 0; partIndex < TOOL_PART_FAST_PATH_LIMIT; partIndex += 1) {
    partFieldPaths.push(
      `'$.content[${partIndex}].type'`,
      `'$.content[${partIndex}].name'`,
      `'$.content[${partIndex}].tool'`,
      `'$.content[${partIndex}].state.status'`,
    )
  }
  return partFieldPaths
}

/** One counted tool call part: resolved tool name plus wire status. */
export interface ExtractedToolPart {
  tool: string
  status: string
}

/**
 * Resolve per-part {tool, status} samples from one message's extracted
 * part fields. The fast pass yields a flat [type, name, tool, status,
 * type, ...] list (missing indices are null); the json_each fallback
 * yields one [type, name, tool, status] quadruple per part — flat()
 * normalizes both to the same stride-4 walk.
 *
 * Resolution mirrors parseAssistantStepRow (rows.ts): only
 * type === "tool" parts count, "name" wins, an empty name falls back
 * to the legacy "tool" key, a still-empty name drops the part. The
 * status keeps its wire spelling; a non-string value (missing state,
 * null, numbers) maps to "unknown", which the aggregations count in
 * total but in no status bucket.
 */
export function extractToolParts(rawPartFields: unknown): ExtractedToolPart[] {
  const partFields = parseExtractedFieldList(rawPartFields)
  const flatPartFields =
    partFields.length > 0 && Array.isArray(partFields[0]) ? partFields.flat() : partFields

  const extractedToolParts: ExtractedToolPart[] = []
  for (let fieldIndex = 0; fieldIndex + 3 < flatPartFields.length; fieldIndex += 4) {
    if (coerceText(flatPartFields[fieldIndex]) !== "tool") continue
    let toolName = coerceText(flatPartFields[fieldIndex + 1])
    if (toolName === "") toolName = coerceText(flatPartFields[fieldIndex + 2])
    if (toolName === "") continue
    const rawStatus = flatPartFields[fieldIndex + 3]
    const status = typeof rawStatus === "string" ? rawStatus : UNKNOWN_TOOL_STATUS
    extractedToolParts.push({ tool: toolName, status })
  }
  return extractedToolParts
}

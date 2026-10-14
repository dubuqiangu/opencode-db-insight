/**
 * SQL-side query for GET /api/tool-health: per-tool success/error
 * counters over every tool call part of every assistant message.
 *
 * Mirrors the two-tier extraction discipline of aggregate-queries.ts
 * (agent stats): content arrays at or below the fast-path part limit
 * are read with direct multi-path json_extract() — content parts are
 * never serialized — while longer arrays fall back to a json_each
 * walk that sees every part. The agent-stats fast path stays untouched
 * (its path list and output shape are load-bearing for
 * extractToolNamesFromPartFields); tool-health carries its own parallel
 * helpers with one extra field per part (`$.state.status`).
 */

import type { SqliteReadConnection } from "./types.ts"
import { asRecord, coerceText, parseExtractedFieldList } from "./rows.ts"
import { ASSISTANT_OBJECT_DATA_PREDICATE } from "./scan-conventions.ts"
import {
  computeToolHealth,
  type ToolHealthSample,
  type ToolHealthStat,
} from "../stats/tool-health.ts"

/**
 * Content arrays longer than this take the json_each fallback (same
 * bound and reasoning as the agent-stats tool-name fast path in
 * aggregate-queries.ts, kept as a separate constant so the two
 * extractions can never drift into sharing mutable state).
 */
const TOOL_HEALTH_FAST_PATH_PART_LIMIT = 8

/**
 * SQL path list for the tool-health fast pass: [type, name, tool,
 * state.status] for every content index below the part limit. Direct
 * path lookups return only the small field values; the multi-KB tool
 * states and outputs stay in the parse-cached JSON document.
 */
function buildToolHealthPartFieldPaths(): string {
  const partFieldPaths: string[] = []
  for (let partIndex = 0; partIndex < TOOL_HEALTH_FAST_PATH_PART_LIMIT; partIndex += 1) {
    partFieldPaths.push(
      `'$.content[${partIndex}].type'`,
      `'$.content[${partIndex}].name'`,
      `'$.content[${partIndex}].tool'`,
      `'$.content[${partIndex}].state.status'`,
    )
  }
  return partFieldPaths.join(", ")
}

/** Status bucket for tool parts whose state.status is not a string. */
const UNKNOWN_TOOL_STATUS = "unknown"

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
 * null, numbers) maps to "unknown", which the aggregation counts in
 * total but in no bucket.
 */
function extractToolHealthSamples(rawPartFields: unknown): ToolHealthSample[] {
  const partFields = parseExtractedFieldList(rawPartFields)
  const flatPartFields =
    partFields.length > 0 && Array.isArray(partFields[0]) ? partFields.flat() : partFields

  const toolHealthSamples: ToolHealthSample[] = []
  for (let fieldIndex = 0; fieldIndex + 3 < flatPartFields.length; fieldIndex += 4) {
    if (coerceText(flatPartFields[fieldIndex]) !== "tool") continue
    let toolName = coerceText(flatPartFields[fieldIndex + 1])
    if (toolName === "") toolName = coerceText(flatPartFields[fieldIndex + 2])
    if (toolName === "") continue
    const rawStatus = flatPartFields[fieldIndex + 3]
    const status = typeof rawStatus === "string" ? rawStatus : UNKNOWN_TOOL_STATUS
    toolHealthSamples.push({ tool: toolName, status })
  }
  return toolHealthSamples
}

/**
 * Per-tool health leaderboard for GET /api/tool-health, aggregated
 * from one assistant scan that never materializes message bodies or
 * tool outputs. Returns null when the db connection is missing (the
 * API layer surfaces that as the shared 503).
 */
export function queryToolHealth(db: SqliteReadConnection | null): ToolHealthStat[] | null {
  if (db === null) return null

  const rawRows = db
    .prepare(
      `SELECT CASE
                WHEN COALESCE(json_array_length(data, '$.content'), 0) <= ${TOOL_HEALTH_FAST_PATH_PART_LIMIT}
                THEN json_extract(data, ${buildToolHealthPartFieldPaths()})
                ELSE (SELECT json_group_array(json_extract(c.value, '$.type', '$.name', '$.tool', '$.state.status'))
                      FROM json_each(m.data, '$.content') c)
              END AS tool_part_fields
       FROM session_message m
       WHERE ${ASSISTANT_OBJECT_DATA_PREDICATE}`,
    )
    .all()

  const toolHealthSamples: ToolHealthSample[] = []
  for (const rawRow of rawRows) {
    const rowRecord = asRecord(rawRow)
    if (rowRecord === null) continue
    toolHealthSamples.push(...extractToolHealthSamples(rowRecord["tool_part_fields"]))
  }

  return computeToolHealth(toolHealthSamples)
}

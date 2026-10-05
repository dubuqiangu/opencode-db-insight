/**
 * Row coercion and JSON parsing helpers for the db read layer.
 *
 * Everything coming out of node:sqlite is `unknown`; these helpers convert
 * values defensively: null/undefined/invalid JSON degrade to zero / empty /
 * null instead of throwing, so one malformed row never breaks a whole query.
 */

import type {
  AssistantStepRow,
  TokenUsage,
} from "./types.ts"

/** Fallback display name for rows whose agent column is missing or empty. */
export const UNKNOWN_AGENT_NAME = "unknown"

/** Fallback display id for rows whose model JSON is missing or unparseable. */
export const UNKNOWN_MODEL_ID = "unknown"

/** Coerce a SQL value to a finite number; anything else becomes 0. */
export function coerceNumber(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value === "string") {
    const parsedValue = Number(value)
    if (Number.isFinite(parsedValue)) return parsedValue
  }
  return 0
}

/** Coerce a SQL value to a string; null/undefined become "". */
export function coerceText(value: unknown): string {
  if (typeof value === "string") return value
  if (value === null || value === undefined) return ""
  return String(value)
}

/** Agent display name: empty/missing agent column maps to "unknown". */
export function readAgentName(value: unknown): string {
  const agentName = coerceText(value)
  return agentName === "" ? UNKNOWN_AGENT_NAME : agentName
}

/**
 * Narrow an unknown value to a plain record (not array, not null).
 * Used both for already-parsed objects and for validating JSON.parse output.
 */
export function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null
  }
  return value as Record<string, unknown>
}

/**
 * Parse a JSON string (or pass through an already-parsed value).
 * Unparseable strings and non-string non-objects return null.
 */
export function parseJsonText(rawValue: unknown): unknown {
  if (typeof rawValue !== "string") return rawValue
  try {
    return JSON.parse(rawValue)
  } catch {
    return null
  }
}

/** Look up a possibly-nested JSON object field, null-safe. */
export function readRecordField(record: Record<string, unknown>, key: string): Record<string, unknown> | null {
  return asRecord(record[key])
}

/**
 * Parse one raw `session_message` row (type = 'assistant') into an
 * AssistantStepRow. Returns null when the data JSON is missing or not an
 * object — such rows are skipped by the callers.
 */
export function parseAssistantStepRow(rawRow: Record<string, unknown>): AssistantStepRow | null {
  const parsedData = asRecord(parseJsonText(rawRow["data"]))
  if (parsedData === null) return null

  const modelRecord = readRecordField(parsedData, "model")
  const rawModelId = modelRecord === null ? "" : coerceText(modelRecord["id"])
  const modelId = rawModelId === "" ? UNKNOWN_MODEL_ID : rawModelId
  // Wire key is "providerID" (camelCase with capital D), per session_v2.model JSON.
  const providerId = modelRecord === null ? "" : coerceText(modelRecord["providerID"])

  const tokensRecord = readRecordField(parsedData, "tokens")
  const cacheRecord = tokensRecord === null ? null : readRecordField(tokensRecord, "cache")
  const tokens: TokenUsage = {
    input: tokensRecord === null ? 0 : coerceNumber(tokensRecord["input"]),
    output: tokensRecord === null ? 0 : coerceNumber(tokensRecord["output"]),
    reasoning: tokensRecord === null ? 0 : coerceNumber(tokensRecord["reasoning"]),
    cacheRead: cacheRecord === null ? 0 : coerceNumber(cacheRecord["read"]),
    cacheWrite: cacheRecord === null ? 0 : coerceNumber(cacheRecord["write"]),
  }

  const contentParts = Array.isArray(parsedData["content"])
    ? (parsedData["content"] as unknown[])
    : []
  const toolNames: string[] = []
  for (const contentPart of contentParts) {
    const partRecord = asRecord(contentPart)
    if (partRecord === null) continue
    if (coerceText(partRecord["type"]) !== "tool") continue
    // Current wire shape carries the tool name in "name"; older shapes used "tool".
    let toolName = coerceText(partRecord["name"])
    if (toolName === "") toolName = coerceText(partRecord["tool"])
    if (toolName !== "") toolNames.push(toolName)
  }

  return {
    messageId: coerceText(rawRow["id"]),
    sessionId: coerceText(rawRow["session_id"]),
    timeCreated: coerceNumber(rawRow["time_created"]),
    modelId,
    providerId,
    agent: readAgentName(parsedData["agent"]),
    tokens,
    toolNames,
  }
}

/**
 * Parse the `session_v2.model` JSON column: {"id","providerID","variant"}.
 * Missing/unparseable maps to the "unknown" model.
 */
export function parseSessionModelColumn(rawModel: unknown): { modelId: string; providerId: string } {
  const modelRecord = asRecord(parseJsonText(rawModel))
  if (modelRecord === null) return { modelId: UNKNOWN_MODEL_ID, providerId: "" }
  const rawModelId = coerceText(modelRecord["id"])
  return {
    modelId: rawModelId === "" ? UNKNOWN_MODEL_ID : rawModelId,
    providerId: coerceText(modelRecord["providerID"]),
  }
}

/** Read a named column of a single-row query result as a number. */
export function readRowNumber(row: unknown, column: string): number {
  const rowRecord = asRecord(row)
  if (rowRecord === null) return 0
  return coerceNumber(rowRecord[column])
}

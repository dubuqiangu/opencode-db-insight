/**
 * db read layer: path resolution, read-only connection and every SQL query
 * of the insight API (DESIGN.md §4/§6). All SQL lives in this single file.
 *
 * Conventions:
 * - Statistics always come from `session_message` (the old `part`/`message`
 *   tables stopped being written 2026-09-23 and must not be double-counted);
 *   `session_v2` is only used for the session list and per-session
 *   dimensions (DESIGN §2.2/§10).
 * - SQL only extracts raw rows; aggregation (median/p95/fingerprints/...)
 *   happens in the pure `src/stats/` functions.
 * - Every query accepts `null` (db missing or node:sqlite unavailable) and
 *   returns `null` so the M2 API layer can answer 503.
 */

import { createRequire } from "node:module"
import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

import type {
  AssistantStepRow,
  OverviewStats,
  SessionMessageRecord,
  SessionSummary,
  SqliteReadConnection,
  TodoStats,
} from "./types.ts"
import {
  asRecord,
  coerceNumber,
  coerceText,
  parseAssistantStepRow,
  parseSessionModelColumn,
  readAgentName,
  readRowNumber,
} from "./rows.ts"
import { hitRate } from "../stats/hit-rate.ts"
import { bucketDailyTrend, toLocalDateKey } from "../stats/daily-buckets.ts"
import { computeModelMetrics } from "../stats/model-metrics.ts"
import { computeAgentStats } from "../stats/agent-fingerprint.ts"
import type { AgentStat } from "../stats/agent-fingerprint.ts"
import type { DailyTrendPoint } from "../stats/daily-buckets.ts"
import type { ModelMetric } from "../stats/model-metrics.ts"

type SqliteDatabaseConstructor = new (
  databasePath: string,
  options: { readOnly: true },
) => SqliteReadConnection

let databaseConstructor: SqliteDatabaseConstructor | null | undefined

/**
 * Resolve the node:sqlite DatabaseSync constructor once, defensively:
 * environments without `node:sqlite` yield null instead of a module-load
 * crash (DESIGN §4 feature detection).
 */
function resolveDatabaseConstructor(): SqliteDatabaseConstructor | null {
  if (databaseConstructor !== undefined) return databaseConstructor
  try {
    const requireNodeModule = createRequire(import.meta.url)
    const sqliteModule = requireNodeModule("node:sqlite") as {
      DatabaseSync: SqliteDatabaseConstructor
    }
    databaseConstructor = sqliteModule.DatabaseSync
  } catch {
    databaseConstructor = null
  }
  return databaseConstructor
}

/**
 * Resolve the opencode database path from the user home directory.
 * Never a hardcoded absolute path: USERPROFILE (Windows) / HOME (unix)
 * with an os.homedir() fallback.
 */
export function resolveOpencodeDbPath(): string {
  const homeDirectory = process.env.USERPROFILE ?? process.env.HOME ?? homedir()
  return join(homeDirectory, ".local", "share", "opencode", "opencode.db")
}

/**
 * Open a read-only connection to the opencode database.
 * Returns null when node:sqlite is unavailable or the file does not exist /
 * cannot be opened — callers surface that as a 503 (DESIGN §4).
 */
export function openOpencodeDb(
  databasePath: string = resolveOpencodeDbPath(),
): SqliteReadConnection | null {
  const constructor = resolveDatabaseConstructor()
  if (constructor === null) return null
  if (!existsSync(databasePath)) return null
  try {
    return new constructor(databasePath, { readOnly: true })
  } catch {
    return null
  }
}

/**
 * Every assistant message of `session_message`, parsed into step rows. The
 * single shared scan behind the stats queries and the TUI status panel
 * (which passes a `sinceMs` lower bound so its 7-day window prunes old rows
 * in SQL). Returns null when the database is unavailable.
 */
export function queryAssistantStepRows(
  db: SqliteReadConnection | null,
  sinceMs?: number,
): AssistantStepRow[] | null {
  if (db === null) return null
  const hasTimeFloor = typeof sinceMs === "number" && Number.isFinite(sinceMs)
  const rawRows = db
    .prepare(
      hasTimeFloor
        ? "SELECT id, session_id, time_created, data FROM session_message WHERE type = 'assistant' AND time_created >= ?"
        : "SELECT id, session_id, time_created, data FROM session_message WHERE type = 'assistant'",
    )
    .all(...(hasTimeFloor ? [sinceMs] : []))

  const stepRows: AssistantStepRow[] = []
  for (const rawRow of rawRows) {
    const rowRecord = asRecord(rawRow)
    if (rowRecord === null) continue
    const stepRow = parseAssistantStepRow(rowRecord)
    if (stepRow !== null) stepRows.push(stepRow)
  }
  return stepRows
}

/** Clamp helper for list pagination parameters. */
function clampPaginationValue(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) return minimum
  return Math.min(Math.max(Math.floor(value), minimum), maximum)
}

/** KPI overview for GET /api/overview. A "step" is one assistant message. */
export function queryOverview(db: SqliteReadConnection | null): OverviewStats | null {
  if (db === null) return null
  const stepRows = queryAssistantStepRows(db) ?? []

  const todayDateKey = toLocalDateKey(Date.now())
  let todayTokens = 0
  let totalTokens = 0
  let todayCacheRead = 0
  let todayInput = 0

  for (const stepRow of stepRows) {
    const stepTokens =
      stepRow.tokens.input + stepRow.tokens.output + stepRow.tokens.cacheRead
    totalTokens += stepTokens
    if (toLocalDateKey(stepRow.timeCreated) === todayDateKey) {
      todayTokens += stepTokens
      todayCacheRead += stepRow.tokens.cacheRead
      todayInput += stepRow.tokens.input
    }
  }

  const sessionCountRow = db.prepare("SELECT COUNT(*) AS sessionCount FROM session_v2").get()
  const totalCostRow = db.prepare("SELECT SUM(cost) AS totalCost FROM session_v2").get()

  return {
    todayTokens,
    totalTokens,
    todayHitRate: hitRate(todayCacheRead, todayInput),
    sessionCount: readRowNumber(sessionCountRow, "sessionCount"),
    stepCount: stepRows.length,
    totalCost: readRowNumber(totalCostRow, "totalCost"),
  }
}

/**
 * Daily trend series for GET /api/trend?days=30: local-timezone buckets,
 * zero-filled, oldest first. days <= 0 yields an empty series.
 */
export function queryDailyTrend(
  db: SqliteReadConnection | null,
  days: number = 30,
): DailyTrendPoint[] | null {
  if (db === null) return null
  const stepRows = queryAssistantStepRows(db) ?? []
  return bucketDailyTrend(stepRows, days)
}

/** Per-model leaderboard for GET /api/models, sorted by total tokens. */
export function queryModelMetrics(db: SqliteReadConnection | null): ModelMetric[] | null {
  if (db === null) return null
  const stepRows = queryAssistantStepRows(db) ?? []
  return computeModelMetrics(stepRows)
}

/** Per-agent usage and tool fingerprint for GET /api/agents. */
export function queryAgentStats(db: SqliteReadConnection | null): AgentStat[] | null {
  if (db === null) return null

  const rawSessionRows = db.prepare("SELECT id, agent FROM session_v2").all()
  const memberships = rawSessionRows.flatMap((rawRow): { agent: string; sessionId: string }[] => {
    const rowRecord = asRecord(rawRow)
    if (rowRecord === null) return []
    return [{ agent: readAgentName(rowRecord["agent"]), sessionId: coerceText(rowRecord["id"]) }]
  })

  const stepRows = queryAssistantStepRows(db) ?? []
  return computeAgentStats(memberships, stepRows)
}

/**
 * Session list for GET /api/sessions. `tokens` comes from the session_v2
 * summary columns (lagging for active sessions — the list is the only
 * place they are used, DESIGN §2.2).
 */
export function querySessionList(
  db: SqliteReadConnection | null,
  limit: number = 50,
  offset: number = 0,
): SessionSummary[] | null {
  if (db === null) return null
  const safeLimit = clampPaginationValue(limit, 1, 500)
  const safeOffset = clampPaginationValue(offset, 0, Number.MAX_SAFE_INTEGER)

  const rawRows = db
    .prepare(
      `SELECT id, title, model, agent, directory, time_created, time_updated,
              tokens_input, tokens_output, tokens_cache_read, cost
       FROM session_v2
       ORDER BY time_updated DESC
       LIMIT ? OFFSET ?`,
    )
    .all(safeLimit, safeOffset)

  const sessionSummaries: SessionSummary[] = []
  for (const rawRow of rawRows) {
    const rowRecord = asRecord(rawRow)
    if (rowRecord === null) continue
    const { modelId } = parseSessionModelColumn(rowRecord["model"])
    sessionSummaries.push({
      id: coerceText(rowRecord["id"]),
      title: coerceText(rowRecord["title"]),
      modelId,
      agent: readAgentName(rowRecord["agent"]),
      directory: coerceText(rowRecord["directory"]),
      timeCreated: coerceNumber(rowRecord["time_created"]),
      timeUpdated: coerceNumber(rowRecord["time_updated"]),
      tokens:
        coerceNumber(rowRecord["tokens_input"]) +
        coerceNumber(rowRecord["tokens_output"]) +
        coerceNumber(rowRecord["tokens_cache_read"]),
      cost: coerceNumber(rowRecord["cost"]),
    })
  }
  return sessionSummaries
}

/**
 * All messages of one session for the replay view, ordered by seq.
 * `data` keeps the parsed original JSON structure. Unknown session ids
 * yield an empty array.
 */
export function querySessionMessages(
  db: SqliteReadConnection | null,
  sessionId: string,
): SessionMessageRecord[] | null {
  if (db === null) return null
  const rawRows = db
    .prepare(
      `SELECT id, session_id, type, seq, time_created, time_updated, data
       FROM session_message
       WHERE session_id = ?
       ORDER BY seq ASC`,
    )
    .all(sessionId)

  const messageRecords: SessionMessageRecord[] = []
  for (const rawRow of rawRows) {
    const rowRecord = asRecord(rawRow)
    if (rowRecord === null) continue
    let parsedData: unknown
    const rawData = rowRecord["data"]
    if (typeof rawData === "string") {
      try {
        parsedData = JSON.parse(rawData)
      } catch {
        parsedData = null
      }
    } else {
      parsedData = rawData ?? null
    }
    messageRecords.push({
      id: coerceText(rowRecord["id"]),
      sessionId: coerceText(rowRecord["session_id"]),
      type: coerceText(rowRecord["type"]),
      seq: coerceNumber(rowRecord["seq"]),
      timeCreated: coerceNumber(rowRecord["time_created"]),
      timeUpdated: coerceNumber(rowRecord["time_updated"]),
      data: parsedData,
    })
  }
  return messageRecords
}

/**
 * Todo completion counters for the todo widget. Statuses outside the three
 * known ones (e.g. "cancelled") only count towards `total`.
 */
export function queryTodoStats(db: SqliteReadConnection | null): TodoStats | null {
  if (db === null) return null
  const rawRows = db.prepare("SELECT status, COUNT(*) AS statusCount FROM todo GROUP BY status").all()

  const todoStats: TodoStats = { total: 0, completed: 0, pending: 0, inProgress: 0 }
  for (const rawRow of rawRows) {
    const rowRecord = asRecord(rawRow)
    if (rowRecord === null) continue
    const status = coerceText(rowRecord["status"])
    const statusCount = coerceNumber(rowRecord["statusCount"])
    todoStats.total += statusCount
    if (status === "completed") todoStats.completed += statusCount
    else if (status === "pending") todoStats.pending += statusCount
    else if (status === "in_progress") todoStats.inProgress += statusCount
  }
  return todoStats
}

/**
 * System prompt pieces of one session for GET /api/session/:id/system-prompt:
 * the latest instruction_state row maps instruction keys to instruction_blob
 * hashes; blob values are stored JSON-encoded. Returns null when the session
 * has no instruction state; unknown hash entries are skipped.
 */
export function querySessionSystemPrompt(
  db: SqliteReadConnection | null,
  sessionId: string,
): Record<string, string> | null {
  if (db === null) return null
  const stateRow = db
    .prepare(
      `SELECT current_values FROM instruction_state
       WHERE session_id = ?
       ORDER BY epoch_start DESC
       LIMIT 1`,
    )
    .get(sessionId)
  const stateRecord = asRecord(stateRow)
  if (stateRecord === null) return null

  let currentValues: unknown = stateRecord["current_values"]
  if (typeof currentValues === "string") {
    try {
      currentValues = JSON.parse(currentValues)
    } catch {
      return null
    }
  }
  const valuesRecord = asRecord(currentValues)
  if (valuesRecord === null) return null

  const selectBlobValue = db.prepare("SELECT value FROM instruction_blob WHERE hash = ?")
  const promptByInstructionKey: Record<string, string> = {}
  for (const [instructionKey, blobHash] of Object.entries(valuesRecord)) {
    const blobRow = asRecord(selectBlobValue.get(coerceText(blobHash)))
    if (blobRow === null) continue
    const rawValue = blobRow["value"]
    let content: string
    if (typeof rawValue === "string") {
      try {
        const decodedValue: unknown = JSON.parse(rawValue)
        content = typeof decodedValue === "string" ? decodedValue : rawValue
      } catch {
        content = rawValue
      }
    } else {
      content = coerceText(rawValue)
    }
    if (content !== "") promptByInstructionKey[instructionKey] = content
  }
  return promptByInstructionKey
}

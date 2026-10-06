/**
 * A fake SqliteReadConnection for export / panel / command tests:
 * serves canned session_v2 / session_message / instruction_state /
 * instruction_blob rows in the raw wire shapes the parsers in
 * src/db/rows.ts expect, without touching a real database.
 */

import type { SessionSummary, SqliteReadConnection, SqliteStatement } from "../../src/db/types.ts"

/** Fallback message timestamp when a fixture does not pin one. */
const DEFAULT_MESSAGE_TIMESTAMP = Date.UTC(2026, 9, 5, 6, 31)

/** One fake message, before it is turned into a wire row. */
export interface FakeMessageFixture {
  type: string
  data: unknown
  seq?: number
  id?: string
  /** epoch-ms of the message; panel "today" tests pin this. */
  timeCreated?: number
}

/**
 * One fake session_message row with type = 'compaction' (v0.2-A): `data`
 * keeps the real wire shape, e.g. {"status":"completed","reason":"auto",
 * "summary":"..."} — a missing/NULL reason exercises the "unknown" bucket.
 */
export interface FakeCompactionMessageFixture {
  sessionId: string
  /** epoch-ms of the row; recentDaily tests pin this. */
  timeCreated?: number
  data: unknown
}

/** Reason bucket the SQL CASE emits for unusable json_extract results. */
const UNKNOWN_FAKE_REASON_KEY = "unknown"

/**
 * Mirror the compaction query's SQL CASE (json_valid(data) AND
 * json_extract(data,'$.reason') IS NOT NULL) with real SQLite json_extract
 * semantics instead of JS stringification: booleans come back as 0/1,
 * objects/arrays as their JSON text, numbers as numbers; a missing key,
 * JSON null, or a non-object document yields NULL → 'unknown'. An
 * empty-string reason stays '' — the query layer maps it to 'unknown',
 * exactly like the SQL-side '' key coerces there.
 */
function fakeSqliteReasonKey(rawData: unknown): string {
  let parsedData: unknown
  try {
    parsedData = JSON.parse(String(rawData))
  } catch {
    return UNKNOWN_FAKE_REASON_KEY
  }
  if (typeof parsedData !== "object" || parsedData === null || Array.isArray(parsedData)) {
    return UNKNOWN_FAKE_REASON_KEY // '$.reason' on a non-object document is NULL
  }
  const reasonValue = (parsedData as Record<string, unknown>)["reason"]
  if (reasonValue === undefined || reasonValue === null) return UNKNOWN_FAKE_REASON_KEY
  if (typeof reasonValue === "boolean") return reasonValue ? "1" : "0"
  if (typeof reasonValue === "object") return JSON.stringify(reasonValue)
  return String(reasonValue)
}

/** Everything the fake database serves, grouped per table. */
export interface FakeInsightDatabaseScenario {
  /** Session summaries; the fake keeps this order (time_updated desc). */
  sessions: SessionSummary[]
  /** Messages per session id, already in seq order. */
  messagesBySessionId: Record<string, FakeMessageFixture[]>
  /** System prompt per session id; ids absent here have no instruction_state row. */
  systemPromptBySessionId: Record<string, Record<string, string>>
  /**
   * idle_outcome column per session id (session-survival route); ids
   * absent here serve SQL NULL, which the stats layer buckets as "none".
   */
  idleOutcomeBySessionId?: Record<string, string | null>
  /** Compaction message fixtures served to the /api/compaction scans. */
  compactionMessages?: FakeCompactionMessageFixture[]
}

/** Turn a SessionSummary into the raw column shape of session_v2. */
function toSessionV2Row(sessionSummary: SessionSummary): Record<string, unknown> {
  return {
    id: sessionSummary.id,
    title: sessionSummary.title,
    model: JSON.stringify({ id: sessionSummary.modelId, providerID: "futureppo" }),
    agent: sessionSummary.agent,
    directory: sessionSummary.directory,
    time_created: sessionSummary.timeCreated,
    time_updated: sessionSummary.timeUpdated,
    tokens_input: sessionSummary.tokens,
    tokens_output: 0,
    tokens_cache_read: 0,
    cost: sessionSummary.cost,
  }
}

/**
 * Build a fake connection. Only the SQL statements the export / panel /
 * command paths issue are understood; anything else throws so tests
 * notice unexpected queries.
 */
export function createFakeInsightDatabase(
  scenario: FakeInsightDatabaseScenario,
): SqliteReadConnection {
  const sessionRows = scenario.sessions.map((sessionSummary) => ({
    ...toSessionV2Row(sessionSummary),
    idle_outcome: scenario.idleOutcomeBySessionId?.[sessionSummary.id] ?? null,
  }))
  const compactionRows = (scenario.compactionMessages ?? []).map(
    (compactionFixture) => ({
      session_id: compactionFixture.sessionId,
      type: "compaction",
      time_created: compactionFixture.timeCreated ?? DEFAULT_MESSAGE_TIMESTAMP,
      data: JSON.stringify(compactionFixture.data),
    }),
  )

  const prepareStatement = (sql: string): SqliteStatement => {
    if (sql.trim() === "SELECT 1") {
      // Liveness probe of /api/health (P1-4).
      return { all: () => [], get: () => ({ probe: 1 }) }
    }
    if (sql.includes("FROM session_v2")) {
      if (sql.includes("WHERE id = ?")) {
        // Direct by-id lookup (P2-2).
        return {
          all: () => [],
          get: (...parameters: unknown[]) =>
            sessionRows.find((sessionRow) => sessionRow.id === String(parameters[0] ?? "")) ??
            undefined,
        }
      }
      if (sql.includes("idle_outcome")) {
        // The session-survival scan reads every session row (v0.2-A).
        return { all: () => sessionRows, get: () => undefined }
      }
      return {
        all: (...parameters: unknown[]) => {
          const limit = Number(parameters[0]) || 50
          const offset = Number(parameters[1]) || 0
          return sessionRows.slice(offset, offset + limit)
        },
        get: () => undefined,
      }
    }
    if (sql.includes("type = 'compaction'")) {
      // The three /api/compaction scans (v0.2-A): by-reason GROUP BY,
      // per-session GROUP BY, and the time_created window scan.
      if (sql.includes("GROUP BY") && sql.includes("reason")) {
        const reasonCountByKey = new Map<string, number>()
        for (const compactionRow of compactionRows) {
          const reasonKey = fakeSqliteReasonKey(compactionRow.data)
          reasonCountByKey.set(reasonKey, (reasonCountByKey.get(reasonKey) ?? 0) + 1)
        }
        return {
          all: () =>
            [...reasonCountByKey.entries()].map(([reasonKey, reasonCount]) => ({
              reason_key: reasonKey,
              reason_count: reasonCount,
            })),
          get: () => undefined,
        }
      }
      if (sql.includes("GROUP BY") && sql.includes("session_id")) {
        const countBySessionId = new Map<string, number>()
        for (const compactionRow of compactionRows) {
          countBySessionId.set(
            String(compactionRow.session_id),
            (countBySessionId.get(String(compactionRow.session_id)) ?? 0) + 1,
          )
        }
        const rankedSessionCounts = [...countBySessionId.entries()]
          .map(([sessionId, sessionCount]) => ({ session_id: sessionId, session_count: sessionCount }))
          .sort((left, right) =>
            right.session_count - left.session_count ||
            (left.session_id < right.session_id ? -1 : 1),
          )
          .slice(0, 10)
        return { all: () => rankedSessionCounts, get: () => undefined }
      }
      // recentDaily scan: time_created only, with a >= ? floor.
      return {
        all: (...parameters: unknown[]) =>
          compactionRows
            .map((compactionRow) => ({ time_created: compactionRow.time_created }))
            .filter((compactionRow) => Number(compactionRow.time_created) >= Number(parameters[0])),
        get: () => undefined,
      }
    }
    if (sql.includes("FROM session_message")) {
      const isPerSessionQuery = sql.includes("session_id = ?")
      const hasTimeFloor = sql.includes("time_created >= ?")
      return {
        all: (...parameters: unknown[]) => {
          const messageFixtures = isPerSessionQuery
            ? scenario.messagesBySessionId[String(parameters[0] ?? "")] ?? []
            : // The status-panel scan asks for every assistant message with
              // no session filter; the SQL itself selects type = 'assistant'.
              Object.values(scenario.messagesBySessionId)
                .flat()
                .filter((messageFixture) => messageFixture.type === "assistant")
          const messageRows = messageFixtures.map((messageFixture, messageIndex) => ({
            id: messageFixture.id ?? `msg_${messageIndex}`,
            session_id: isPerSessionQuery ? String(parameters[0] ?? "") : "ses_panel_scan",
            type: messageFixture.type,
            seq: messageFixture.seq ?? messageIndex,
            time_created: messageFixture.timeCreated ?? DEFAULT_MESSAGE_TIMESTAMP,
            time_updated: messageFixture.timeCreated ?? DEFAULT_MESSAGE_TIMESTAMP,
            data: JSON.stringify(messageFixture.data),
          }))
          // The panel scan may carry a time_created >= ? floor.
          return hasTimeFloor
            ? messageRows.filter(
                (messageRow) => Number(messageRow.time_created) >= Number(parameters[0]),
              )
            : messageRows
        },
        get: () => undefined,
      }
    }
    if (sql.includes("FROM instruction_state")) {
      return {
        all: () => [],
        get: (...parameters: unknown[]) => {
          const sessionId = String(parameters[0] ?? "")
          const systemPrompt = scenario.systemPromptBySessionId[sessionId]
          if (systemPrompt === undefined) return undefined
          const hashByInstructionKey: Record<string, string> = {}
          for (const instructionKey of Object.keys(systemPrompt)) {
            hashByInstructionKey[instructionKey] = `blob-hash:${sessionId}:${instructionKey}`
          }
          return { current_values: JSON.stringify(hashByInstructionKey) }
        },
      }
    }
    if (sql.includes("FROM instruction_blob")) {
      return {
        all: () => [],
        get: (...parameters: unknown[]) => {
          const blobHash = String(parameters[0] ?? "")
          if (!blobHash.startsWith("blob-hash:")) return undefined
          const [sessionId, ...keyParts] = blobHash.slice("blob-hash:".length).split(":")
          const instructionKey = keyParts.join(":")
          const promptText = scenario.systemPromptBySessionId[sessionId]?.[instructionKey]
          return promptText === undefined
            ? undefined
            : { value: JSON.stringify(promptText) }
        },
      }
    }
    throw new Error(`createFakeInsightDatabase: unexpected SQL: ${sql}`)
  }

  return {
    prepare: prepareStatement,
    close: () => {},
  }
}

/** Convenience: a session summary fixture in the wire-derived shape. */
export function buildFakeSessionSummary(
  overrides: Partial<SessionSummary> = {},
): SessionSummary {
  return {
    id: "ses_export_fixture",
    title: "导出测试会话",
    modelId: "glm-5.3",
    agent: "fixer",
    directory: "",
    timeCreated: new Date(2026, 9, 5, 15, 30).getTime(),
    timeUpdated: new Date(2026, 9, 5, 16, 15).getTime(),
    tokens: 123456,
    cost: 0,
    ...overrides,
  }
}

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
  /**
   * Raw session_v2.directory column per session id (v0.3-A directory
   * stats); overrides the summary's directory so fixtures can express
   * SQL NULL and empty strings, which the SessionSummary type cannot.
   * Ids absent here keep the summary's directory.
   */
  directoryColumnBySessionId?: Record<string, string | null>
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
    tokens_input: sessionSummary.tokensInput,
    tokens_output: sessionSummary.tokensOutput,
    tokens_cache_read: sessionSummary.tokensCacheRead,
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
    directory:
      scenario.directoryColumnBySessionId?.[sessionSummary.id] !== undefined
        ? scenario.directoryColumnBySessionId[sessionSummary.id]
        : sessionSummary.directory,
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
      if (sql.includes("LEFT JOIN") && sql.includes("directory")) {
        // The /api/directories grouped scan (v0.3-A): session_v2 LEFT
        // JOIN of the assistant-step subquery, grouped per non-empty
        // directory. Sessions with NULL/empty directories drop out of
        // every bucket; steps mirror the assistant-object subquery by
        // counting only assistant messages. Groups come back UNSORTED —
        // the query's JS comparator owns the wire ordering, and serving
        // insertion order here proves exactly that.
        const assistantStepCountBySessionId = new Map<string, number>()
        for (const [sessionId, messageFixtures] of Object.entries(scenario.messagesBySessionId)) {
          assistantStepCountBySessionId.set(
            sessionId,
            messageFixtures.filter(
              (messageFixture) =>
                messageFixture.type === "assistant" &&
                // Mirror json_valid(data) AND json_type(data) = 'object'
                // from the shared predicate: the fake stores data as
                // JSON.stringify(fixture.data), which is always valid
                // JSON, so only non-null, non-array objects qualify —
                // string/number/boolean/null data shapes are not steps.
                typeof messageFixture.data === "object" &&
                messageFixture.data !== null &&
                !Array.isArray(messageFixture.data),
            ).length,
          )
        }
        const statsByDirectoryName = new Map<
          string,
          { session_count: number; step_count: number; last_active_ms: number | null }
        >()
        for (const sessionRow of sessionRows) {
          const directoryColumn = sessionRow.directory
          if (typeof directoryColumn !== "string" || directoryColumn === "") continue
          const statsRecord =
            statsByDirectoryName.get(directoryColumn) ?? {
              session_count: 0,
              step_count: 0,
              last_active_ms: null,
            }
          statsRecord.session_count += 1
          statsRecord.step_count += assistantStepCountBySessionId.get(String(sessionRow.id)) ?? 0
          const timeUpdated = Number(sessionRow.time_updated)
          statsRecord.last_active_ms =
            statsRecord.last_active_ms === null
              ? timeUpdated
              : Math.max(statsRecord.last_active_ms, timeUpdated)
          statsByDirectoryName.set(directoryColumn, statsRecord)
        }
        return {
          all: () =>
            [...statsByDirectoryName.entries()].map(([directoryName, statsRecord]) => ({
              directory_name: directoryName,
              session_count: statsRecord.session_count,
              step_count: statsRecord.step_count,
              last_active_ms: statsRecord.last_active_ms,
            })),
          get: () => undefined,
        }
      }
      // The paginated session-list scan (GET /api/sessions). The fake
      // deliberately does NOT mirror the ?sort=/?order= SQL semantics
      // (v0.2-B): it keeps serving the scenario's insertion order, which
      // the pre-existing tests rely on. Ordering correctness — including
      // the deterministic `id ASC` tie-break — is owned exclusively by
      // the real node:sqlite :memory: fixture in
      // test/session-list-sorting.test.ts (发布清单 #2: SQL semantics
      // must be locked against real SQLite, not a fake JS mirror).
      // The v0.7.0 directory drill-down IS mirrored here (exact match
      // on the directory column) and so is the v0.9.0 range window
      // (epoch-ms time_updated >= threshold) — only so filtered route
      // tests get meaningful rows and the bind-parameter positions
      // stay right (without the range mirror, the threshold would
      // consume the limit slot); their authoritative semantics live in
      // test/session-directory-filter.test.ts and
      // test/session-range-filter.test.ts.
      const hasDirectoryFilter = sql.includes("WHERE directory = ?")
      const hasRangeFilter = sql.includes("time_updated >= ?")
      return {
        all: (...parameters: unknown[]) => {
          let remainingParameters = [...parameters]
          let matchedSessionRows = sessionRows
          if (hasDirectoryFilter) {
            const directoryFilterValue = String(remainingParameters.shift() ?? "")
            matchedSessionRows = matchedSessionRows.filter(
              (sessionRow) => sessionRow.directory === directoryFilterValue,
            )
          }
          if (hasRangeFilter) {
            const rangeStartMs = Number(remainingParameters.shift())
            matchedSessionRows = matchedSessionRows.filter(
              (sessionRow) => Number(sessionRow.time_updated) >= rangeStartMs,
            )
          }
          const limit = Number(remainingParameters[0]) || 50
          const offset = Number(remainingParameters[1]) || 0
          return matchedSessionRows.slice(offset, offset + limit)
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

/**
 * Convenience: a session summary fixture in the wire-derived shape. The
 * default token components are distinct non-zero values that sum to
 * `tokens` exactly, so any passthrough bug in the v2-row round trip
 * (e.g. folding all three components into tokens_input, or swapping
 * two columns) shows up as a per-field mismatch instead of cancelling
 * out in the folded total.
 */
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
    tokensInput: 100000,
    tokensOutput: 20000,
    tokensCacheRead: 3456,
    cost: 0,
    ...overrides,
  }
}

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

/** Everything the fake database serves, grouped per table. */
export interface FakeInsightDatabaseScenario {
  /** Session summaries; the fake keeps this order (time_updated desc). */
  sessions: SessionSummary[]
  /** Messages per session id, already in seq order. */
  messagesBySessionId: Record<string, FakeMessageFixture[]>
  /** System prompt per session id; ids absent here have no instruction_state row. */
  systemPromptBySessionId: Record<string, Record<string, string>>
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
  const sessionRows = scenario.sessions.map(toSessionV2Row)

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
      return {
        all: (...parameters: unknown[]) => {
          const limit = Number(parameters[0]) || 50
          const offset = Number(parameters[1]) || 0
          return sessionRows.slice(offset, offset + limit)
        },
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

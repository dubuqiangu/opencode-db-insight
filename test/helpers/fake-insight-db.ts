/**
 * A fake SqliteReadConnection for export / panel / command tests:
 * serves canned session_v2 / session_message / instruction_state /
 * instruction_blob rows in the raw wire shapes the parsers in
 * src/db/rows.ts expect, without touching a real database.
 */

import type { SessionSummary, SqliteReadConnection, SqliteStatement } from "../../src/db/types.ts"
import { coerceNumber } from "../../src/db/rows.ts"

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
 * Narrow a fixture `data` value to a plain record, mirroring SQLite's
 * json_type(data) = 'object' judgment (non-object / array / null → null).
 */
function fakeDataRecord(rawData: unknown): Record<string, unknown> | null {
  if (typeof rawData !== "object" || rawData === null || Array.isArray(rawData)) return null
  return rawData as Record<string, unknown>
}

/** JS mirror of SQLite `length(text)`: a string → its code-point length, else 0. */
function fakeTextLength(value: unknown): number {
  return typeof value === "string" ? value.length : 0
}

/**
 * JS mirror of buildToolOutputTextSql: `state.metadata.output` when it is a
 * non-empty string, else the part's `state.content[]` text blocks joined with
 * "\n\n". Returns "" when neither is present.
 */
function fakeToolOutputText(partRecord: Record<string, unknown>): string {
  const stateRecord = fakeDataRecord(partRecord["state"])
  if (stateRecord === null) return ""
  const metadataRecord = fakeDataRecord(stateRecord["metadata"])
  const metadataOutput = metadataRecord === null ? undefined : metadataRecord["output"]
  if (typeof metadataOutput === "string" && metadataOutput !== "") return metadataOutput
  const stateContent = Array.isArray(stateRecord["content"]) ? stateRecord["content"] : []
  const textBlocks: string[] = []
  for (const block of stateContent) {
    const blockRecord = fakeDataRecord(block)
    if (blockRecord === null) continue
    if (blockRecord["type"] === "text" && typeof blockRecord["text"] === "string") {
      textBlocks.push(blockRecord["text"])
    }
  }
  return textBlocks.join("\n\n")
}

/**
 * JS mirror of `length(json_extract(x,'$.state.input'))`: object/array → its
 * compact JSON text, string → itself, anything else → "".
 */
function fakeToolInputText(partRecord: Record<string, unknown>): string {
  const stateRecord = fakeDataRecord(partRecord["state"])
  if (stateRecord === null) return ""
  const inputValue = stateRecord["input"]
  if (typeof inputValue === "string") return inputValue
  if (typeof inputValue === "object" && inputValue !== null) return JSON.stringify(inputValue)
  return ""
}

/** Resolve a tool part's name: `$.name` wins, empty falls back to legacy `$.tool`. */
function fakeToolName(partRecord: Record<string, unknown>): string {
  const nameValue = partRecord["name"]
  if (typeof nameValue === "string" && nameValue !== "") return nameValue
  const legacyToolValue = partRecord["tool"]
  return typeof legacyToolValue === "string" ? legacyToolValue : ""
}

/**
 * Resolve a tool part's file path: COALESCE over
 * `state.input.[path|filePath|file_path]`, first non-empty string wins.
 */
function fakeToolPath(partRecord: Record<string, unknown>): string | null {
  const stateRecord = fakeDataRecord(partRecord["state"])
  if (stateRecord === null) return null
  const inputRecord = fakeDataRecord(stateRecord["input"])
  if (inputRecord === null) return null
  for (const pathKey of ["path", "filePath", "file_path"]) {
    const pathValue = inputRecord[pathKey]
    if (typeof pathValue === "string" && pathValue !== "") return pathValue
  }
  return null
}

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
    // v0.20.0 载荷富化列：summary 的对应字段重新派生（活库
    // session_v2 实有这三列，见 queries.ts / session-summary-
    // enrichment.ts）。
    tokens_reasoning: sessionSummary.tokensReasoning,
    tokens_cache_write: sessionSummary.tokensCacheWrite,
    parent_id: sessionSummary.parentSessionId,
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
    if (sql.includes("AS prompt_input")) {
      // v0.29.0 GET /api/token-ledger：每会话一行的 message 侧 token 三分解
      // + session_v2 对照列。镜像 SQL 的 LEFT JOIN + GROUP BY SUM——为每个
      // session_v2 会话算一次 assistant 消息聚合（零 assistant 行 → 0）。
      // ?session= 时 SQL 同时含内层 session_id = ? 与外层 id = ?，两个绑定
      // 值相同，取 parameters[0] 即目标会话即可收窄。
      const hasLedgerSessionFilter = sql.includes("session_id = ?")
      const aggregateBySessionId = new Map<
        string,
        {
          messageCount: number
          promptInput: number
          promptCacheRead: number
          promptCacheWrite: number
          output: number
          reasoning: number
        }
      >()
      for (const [sessionId, messageFixtures] of Object.entries(scenario.messagesBySessionId)) {
        const aggregate = {
          messageCount: 0,
          promptInput: 0,
          promptCacheRead: 0,
          promptCacheWrite: 0,
          output: 0,
          reasoning: 0,
        }
        for (const messageFixture of messageFixtures) {
          if (messageFixture.type !== "assistant") continue
          const dataRecord = fakeDataRecord(messageFixture.data)
          if (dataRecord === null) continue
          const tokensRecord = fakeDataRecord(dataRecord["tokens"])
          const cacheRecord = tokensRecord === null ? null : fakeDataRecord(tokensRecord["cache"])
          aggregate.messageCount += 1
          aggregate.promptInput += tokensRecord === null ? 0 : coerceNumber(tokensRecord["input"])
          aggregate.promptCacheRead += cacheRecord === null ? 0 : coerceNumber(cacheRecord["read"])
          aggregate.promptCacheWrite += cacheRecord === null ? 0 : coerceNumber(cacheRecord["write"])
          aggregate.output += tokensRecord === null ? 0 : coerceNumber(tokensRecord["output"])
          aggregate.reasoning += tokensRecord === null ? 0 : coerceNumber(tokensRecord["reasoning"])
        }
        aggregateBySessionId.set(sessionId, aggregate)
      }
      return {
        all: (...parameters: unknown[]) => {
          const sessionFilterValue = hasLedgerSessionFilter ? String(parameters[0] ?? "") : null
          return sessionRows
            .filter(
              (sessionRow) =>
                sessionFilterValue === null || String(sessionRow.id) === sessionFilterValue,
            )
            .map((sessionRow) => {
              const aggregate = aggregateBySessionId.get(String(sessionRow.id)) ?? {
                messageCount: 0,
                promptInput: 0,
                promptCacheRead: 0,
                promptCacheWrite: 0,
                output: 0,
                reasoning: 0,
              }
              return {
                session_id: sessionRow.id,
                v2_input: sessionRow.tokens_input,
                v2_cache_read: sessionRow.tokens_cache_read,
                v2_cache_write: sessionRow.tokens_cache_write,
                v2_output: sessionRow.tokens_output,
                message_count: aggregate.messageCount,
                prompt_input: aggregate.promptInput,
                prompt_cache_read: aggregate.promptCacheRead,
                prompt_cache_write: aggregate.promptCacheWrite,
                output: aggregate.output,
                reasoning: aggregate.reasoning,
              }
            })
        },
        get: () => undefined,
      }
    }
    if (sql.includes("AS compaction_reason")) {
      // v0.29.0 GET /api/session/:id/events：三类会话事件按 seq 升序。镜像
      // SQL 的 json_extract（reason / model.id / previous.id / text）；唯一
      // 绑定参数是会话 id。fake 忽略 session_v2 锚定（与其它分支一致，语义
      // 权威在 test/session-events.test.ts 的真 SQLite 夹具）。
      return {
        all: (...parameters: unknown[]) => {
          const sessionId = String(parameters[0] ?? "")
          const messageFixtures = scenario.messagesBySessionId[sessionId] ?? []
          let fallbackSeq = -1
          const eventRows: Array<Record<string, unknown>> = []
          for (const messageFixture of messageFixtures) {
            if (
              messageFixture.type !== "compaction" &&
              messageFixture.type !== "model-switched" &&
              messageFixture.type !== "system"
            ) {
              continue
            }
            fallbackSeq += 1
            const dataRecord = fakeDataRecord(messageFixture.data)
            const modelRecord = dataRecord === null ? null : fakeDataRecord(dataRecord["model"])
            const previousRecord =
              dataRecord === null ? null : fakeDataRecord(dataRecord["previous"])
            eventRows.push({
              seq: messageFixture.seq ?? fallbackSeq,
              time_created: messageFixture.timeCreated ?? DEFAULT_MESSAGE_TIMESTAMP,
              type: messageFixture.type,
              // 非 compaction 行 SQL 仍产出该列，但查询层按 type 忽略它。
              compaction_reason:
                messageFixture.type === "compaction"
                  ? fakeSqliteReasonKey(JSON.stringify(messageFixture.data))
                  : null,
              switched_to_model:
                messageFixture.type === "model-switched" && modelRecord !== null
                  ? modelRecord["id"] ?? null
                  : null,
              switched_from_model:
                messageFixture.type === "model-switched" && previousRecord !== null
                  ? previousRecord["id"] ?? null
                  : null,
              system_text:
                messageFixture.type === "system" && dataRecord !== null
                  ? dataRecord["text"] ?? null
                  : null,
            })
          }
          return eventRows
        },
        get: () => undefined,
      }
    }
    if (sql.includes("AS assistant_text_chars")) {
      // v0.29.0 GET /api/content-composition（A4）：两段扫描 UNION ALL 的
      // 「一行一 会话×半」形状。镜像 SQL 的 json_each content 遍历与
      // COALESCE(length(text), length(summary)) 口径；空的 content 不产出
      // 扫 A 行（与 json_each 对空数组 0 行一致）。语义权威在
      // test/content-composition.test.ts 的真 SQLite 夹具（fake 不逐字节
      // 复刻 SQLite 的 json 函数语义，见文件头）。
      const hasCompositionSessionFilter = sql.includes("session_id = ?")
      return {
        all: (...parameters: unknown[]) => {
          const sessionFilterValue = hasCompositionSessionFilter
            ? String(parameters[0] ?? "")
            : null
          const compositionRows: Array<Record<string, unknown>> = []
          for (const [sessionId, messageFixtures] of Object.entries(scenario.messagesBySessionId)) {
            if (sessionFilterValue !== null && sessionId !== sessionFilterValue) continue
            let assistantTextChars = 0
            let reasoningChars = 0
            let toolInputChars = 0
            let toolOutputChars = 0
            let toolInputBytes = 0
            let toolOutputBytes = 0
            let otherChars = 0
            let hasAssistantRow = false
            let nonAssistantTextChars = 0
            let hasNonAssistantRow = false
            for (const messageFixture of messageFixtures) {
              const dataRecord = fakeDataRecord(messageFixture.data)
              if (messageFixture.type === "assistant") {
                if (dataRecord === null) continue
                const contentParts = Array.isArray(dataRecord["content"]) ? dataRecord["content"] : []
                if (contentParts.length === 0) continue
                hasAssistantRow = true
                for (const part of contentParts) {
                  const partRecord = fakeDataRecord(part)
                  if (partRecord === null) continue
                  const partType = String(partRecord["type"] ?? "")
                  if (partType === "text") {
                    assistantTextChars += fakeTextLength(partRecord["text"])
                  } else if (partType === "reasoning") {
                    reasoningChars += fakeTextLength(partRecord["text"])
                  } else if (partType === "tool") {
                    const toolInputText = fakeToolInputText(partRecord)
                    const toolOutputText = fakeToolOutputText(partRecord)
                    toolInputChars += toolInputText.length
                    toolOutputChars += toolOutputText.length
                    toolInputBytes += Buffer.byteLength(toolInputText, "utf8")
                    toolOutputBytes += Buffer.byteLength(toolOutputText, "utf8")
                  } else {
                    otherChars += fakeTextLength(partRecord["text"])
                  }
                }
              } else if (
                messageFixture.type === "user" ||
                messageFixture.type === "synthetic" ||
                messageFixture.type === "system" ||
                messageFixture.type === "compaction"
              ) {
                if (dataRecord === null) continue
                hasNonAssistantRow = true
                const textValue = dataRecord["text"]
                const summaryValue = dataRecord["summary"]
                nonAssistantTextChars +=
                  typeof textValue === "string"
                    ? textValue.length
                    : typeof summaryValue === "string"
                      ? summaryValue.length
                      : 0
              }
            }
            if (hasAssistantRow) {
              compositionRows.push({
                session_id: sessionId,
                assistant_text_chars: assistantTextChars,
                reasoning_chars: reasoningChars,
                tool_input_chars: toolInputChars,
                tool_output_chars: toolOutputChars,
                tool_input_bytes: toolInputBytes,
                tool_output_bytes: toolOutputBytes,
                other_chars: otherChars,
                non_assistant_text_chars: 0,
              })
            }
            if (hasNonAssistantRow) {
              compositionRows.push({
                session_id: sessionId,
                assistant_text_chars: 0,
                reasoning_chars: 0,
                tool_input_chars: 0,
                tool_output_chars: 0,
                tool_input_bytes: 0,
                tool_output_bytes: 0,
                other_chars: 0,
                non_assistant_text_chars: nonAssistantTextChars,
              })
            }
          }
          return compositionRows
        },
        get: () => undefined,
      }
    }
    if (sql.includes("AS raw_path")) {
      // v0.29.0 GET /api/file-activity（B5）：按 (session_id, raw_path,
      // tool_name) 归组的扫描。镜像 SQL 的 COALESCE(path|filePath|file_path)
      // 与工具名解析（name 优先，回退 legacy tool），工具白名单 read/edit/
      // write。语义权威在 test/file-activity.test.ts 的真 SQLite 夹具。
      const hasFileActivitySessionFilter = sql.includes("session_id = ?")
      return {
        all: (...parameters: unknown[]) => {
          const sessionFilterValue = hasFileActivitySessionFilter
            ? String(parameters[0] ?? "")
            : null
          const groupedRows = new Map<
            string,
            {
              session_id: string
              raw_path: string
              tool_name: string
              op_count: number
              last_active_ms: number
            }
          >()
          for (const [sessionId, messageFixtures] of Object.entries(scenario.messagesBySessionId)) {
            if (sessionFilterValue !== null && sessionId !== sessionFilterValue) continue
            for (const messageFixture of messageFixtures) {
              if (messageFixture.type !== "assistant") continue
              const dataRecord = fakeDataRecord(messageFixture.data)
              if (dataRecord === null) continue
              const contentParts = Array.isArray(dataRecord["content"]) ? dataRecord["content"] : []
              for (const part of contentParts) {
                const partRecord = fakeDataRecord(part)
                if (partRecord === null || partRecord["type"] !== "tool") continue
                const toolName = fakeToolName(partRecord)
                if (toolName !== "read" && toolName !== "edit" && toolName !== "write") continue
                const rawPath = fakeToolPath(partRecord)
                if (rawPath === null) continue
                const groupKey = `${sessionId}\u0000${rawPath}\u0000${toolName}`
                const lastActiveMs = messageFixture.timeCreated ?? DEFAULT_MESSAGE_TIMESTAMP
                const existingRow = groupedRows.get(groupKey)
                if (existingRow === undefined) {
                  groupedRows.set(groupKey, {
                    session_id: sessionId,
                    raw_path: rawPath,
                    tool_name: toolName,
                    op_count: 1,
                    last_active_ms: lastActiveMs,
                  })
                } else {
                  existingRow.op_count += 1
                  if (lastActiveMs > existingRow.last_active_ms) {
                    existingRow.last_active_ms = lastActiveMs
                  }
                }
              }
            }
          }
          return [...groupedRows.values()]
        },
        get: () => undefined,
      }
    }
    if (sql.includes("AS child_count")) {
      // v0.29.0 GET /api/session-lineage（B6）：一行一会话的 lineage 抽取，
      // 含父指针、display 列、tokens 三列合计与直接子会话数。**必须**放在
      // 宽泛的 `FROM session_v2` 分支之前（同 A4/B5 分支位置），否则会被它
      // 截走。语义权威在 test/session-lineage.test.ts 的真 SQLite 夹具。
      return {
        all: () => {
          const childCountByParentId = new Map<string, number>()
          for (const sessionRow of sessionRows) {
            const parentSessionId = sessionRow.parent_id
            if (typeof parentSessionId !== "string" || parentSessionId === "") continue
            childCountByParentId.set(
              parentSessionId,
              (childCountByParentId.get(parentSessionId) ?? 0) + 1,
            )
          }
          return sessionRows.map((sessionRow) => ({
            session_id: sessionRow.id,
            parent_id: sessionRow.parent_id ?? null,
            title: sessionRow.title,
            agent: sessionRow.agent,
            time_created: sessionRow.time_created,
            tokens:
              Number(sessionRow.tokens_input ?? 0) +
              Number(sessionRow.tokens_output ?? 0) +
              Number(sessionRow.tokens_cache_read ?? 0),
            child_count: childCountByParentId.get(String(sessionRow.id)) ?? 0,
          }))
        },
        get: () => undefined,
      }
    }
    // v0.28.1：跨会话搜索的扫描现在带 `session_id IN (SELECT id FROM session_v2)`
    // 锚定（B1），于是 SQL 同时含 "FROM session_message" 与 "FROM session_v2"。
    // 下面的 session_v2 分支很宽，会先把它截走，所以这里显式让路——搜索的
    // `type IN ('user', 'assistant')` 是全仓唯一签名，据此排除不会误伤其它查询。
    if (
      sql.includes("FROM session_v2") &&
      !sql.includes("type IN ('user', 'assistant')")
    ) {
      if (sql.includes("AS total_sessions")) {
        // v0.21.0 GET /api/child-share 的整体归总：COUNT + 父子分桶 +
        // tokens 三列合计。镜像 SQL 的 COALESCE(SUM(...)) 折叠与
        // parent_id 是否 NULL 的分桶。
        return {
          all: () => [],
          get: () => {
            let totalSessions = 0
            let childSessionCount = 0
            let rootSessionCount = 0
            let childTokens = 0
            let totalTokens = 0
            for (const sessionRow of sessionRows) {
              totalSessions += 1
              const rowTokens =
                Number(sessionRow.tokens_input ?? 0) +
                Number(sessionRow.tokens_output ?? 0) +
                Number(sessionRow.tokens_cache_read ?? 0)
              totalTokens += rowTokens
              if (sessionRow.parent_id === null || sessionRow.parent_id === undefined) {
                rootSessionCount += 1
              } else {
                childSessionCount += 1
                childTokens += rowTokens
              }
            }
            return {
              total_sessions: totalSessions,
              child_session_count: childSessionCount,
              root_session_count: rootSessionCount,
              child_tokens: childTokens,
              total_tokens: totalTokens,
            }
          },
        }
      }
      if (sql.includes("AS duration_ms")) {
        // v0.21.0 GET /api/duration-distribution：每会话墙钟时长（毫秒），
        // 只取 time_updated > time_created 的正值会话（镜像 SQL WHERE）。
        return {
          all: () =>
            sessionRows
              .filter(
                (sessionRow) =>
                  Number(sessionRow.time_updated) > Number(sessionRow.time_created),
              )
              .map((sessionRow) => ({
                duration_ms:
                  Number(sessionRow.time_updated) - Number(sessionRow.time_created),
              })),
          get: () => undefined,
        }
      }
      if (sql.includes("ORDER BY child_tokens")) {
        // v0.21.0 topChildTrees：按直接子代 tokens 合计降序 top5（只做
        // 一层直接子代，与富化归总同口径）。ORDER 语义由 JS 排序镜像，
        // 真实 SQL 排序权责留在 session-list-sorting 那类真 SQLite 测试。
        const childAggregateByParentId = new Map<
          string,
          { childSessionCount: number; childTokens: number }
        >()
        for (const sessionRow of sessionRows) {
          const parentSessionId = sessionRow.parent_id
          if (typeof parentSessionId !== "string") continue
          const aggregate =
            childAggregateByParentId.get(parentSessionId) ??
            { childSessionCount: 0, childTokens: 0 }
          aggregate.childSessionCount += 1
          aggregate.childTokens +=
            Number(sessionRow.tokens_input ?? 0) +
            Number(sessionRow.tokens_output ?? 0) +
            Number(sessionRow.tokens_cache_read ?? 0)
          childAggregateByParentId.set(parentSessionId, aggregate)
        }
        const rankedChildTrees = [...childAggregateByParentId.entries()]
          .map(([parentSessionId, aggregate]) => ({
            session_id: parentSessionId,
            child_session_count: aggregate.childSessionCount,
            child_tokens: aggregate.childTokens,
          }))
          .sort(
            (leftRow, rightRow) =>
              rightRow.child_tokens - leftRow.child_tokens ||
              (leftRow.session_id < rightRow.session_id ? -1 : 1),
          )
          .slice(0, 5)
        return { all: () => rankedChildTrees, get: () => undefined }
      }
      if (sql.includes("SELECT id, title, agent")) {
        // v0.21.0 topChildTrees 的父会话 title / agent 点查（榜上每项补
        // 父会话自身展示字段）。
        return {
          all: (...parameters: unknown[]) => {
            const parentSessionIds = new Set(
              parameters.map((sessionId) => String(sessionId ?? "")),
            )
            return sessionRows
              .filter((sessionRow) => parentSessionIds.has(String(sessionRow.id)))
              .map((sessionRow) => ({
                id: sessionRow.id,
                title: sessionRow.title,
                agent: sessionRow.agent,
              }))
          },
          get: () => undefined,
        }
      }
      if (sql.includes("WHERE id = ?")) {
        // Direct by-id lookup (P2-2) — also serves the v0.20.0 ?session=
        // existence probe (SELECT 1 … WHERE id = ?): the row object (or
        // undefined) answers both.
        return {
          all: () => [],
          get: (...parameters: unknown[]) =>
            sessionRows.find((sessionRow) => sessionRow.id === String(parameters[0] ?? "")) ??
            undefined,
        }
      }
      if (sql.includes("tokens_reasoning")) {
        // v0.20.0 附加列点查（session-summary-enrichment）：按当页 id
        // 集服务 tokens_reasoning / tokens_cache_write / parent_id。
        return {
          all: (...parameters: unknown[]) => {
            const pageSessionIds = new Set(parameters.map((pageSessionId) => String(pageSessionId ?? "")))
            return sessionRows
              .filter((sessionRow) => pageSessionIds.has(String(sessionRow.id)))
              .map((sessionRow) => ({
                id: sessionRow.id,
                tokens_reasoning: sessionRow.tokens_reasoning,
                tokens_cache_write: sessionRow.tokens_cache_write,
                parent_id: sessionRow.parent_id,
              }))
          },
          get: () => undefined,
        }
      }
      if (sql.includes("parent_id IN (")) {
        // v0.20.0 直接子会话归总：COUNT + tokens 三列 COALESCE 合计，
        // 镜像 SQL 的 GROUP BY parent_id（只做一层直接子代）。
        return {
          all: (...parameters: unknown[]) => {
            const parentIds = new Set(parameters.map((parentId) => String(parentId ?? "")))
            const childAggregates = new Map<string, { count: number; tokensTotal: number }>()
            for (const sessionRow of sessionRows) {
              const parentSessionId = sessionRow.parent_id
              if (typeof parentSessionId !== "string" || !parentIds.has(parentSessionId)) continue
              const aggregate =
                childAggregates.get(parentSessionId) ?? { count: 0, tokensTotal: 0 }
              aggregate.count += 1
              aggregate.tokensTotal +=
                Number(sessionRow.tokens_input ?? 0) +
                Number(sessionRow.tokens_output ?? 0) +
                Number(sessionRow.tokens_cache_read ?? 0)
              childAggregates.set(parentSessionId, aggregate)
            }
            return [...childAggregates.entries()].map(([parentSessionId, aggregate]) => ({
              parent_id: parentSessionId,
              child_session_count: aggregate.count,
              child_tokens_total: aggregate.tokensTotal,
            }))
          },
          get: () => undefined,
        }
      }
      if (sql.includes("AS tokens_total")) {
        // v0.20.0 GET /api/session-distribution 的每会话 tokens 合计
        // 扫描：镜像 SQL 的三列 COALESCE 相加 + > 0 过滤（全 0 会话
        // 不进入分布）。
        return {
          all: () =>
            sessionRows
              .map((sessionRow) => ({
                tokens_total:
                  Number(sessionRow.tokens_input ?? 0) +
                  Number(sessionRow.tokens_output ?? 0) +
                  Number(sessionRow.tokens_cache_read ?? 0),
              }))
              .filter((sessionRow) => Number(sessionRow.tokens_total) > 0),
          get: () => undefined,
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
        // counting only assistant messages, and the token sums mirror
        // the v0.15.0 pre-aggregated join (each session contributes
        // its tokens once). Groups come back UNSORTED — the query's JS
        // comparator owns the wire ordering, and serving insertion
        // order here proves exactly that.
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
          {
            session_count: number
            step_count: number
            last_active_ms: number | null
            tokens_input_sum: number
            tokens_output_sum: number
            tokens_cache_read_sum: number
          }
        >()
        for (const sessionRow of sessionRows) {
          const directoryColumn = sessionRow.directory
          if (typeof directoryColumn !== "string" || directoryColumn === "") continue
          const statsRecord =
            statsByDirectoryName.get(directoryColumn) ?? {
              session_count: 0,
              step_count: 0,
              last_active_ms: null,
              tokens_input_sum: 0,
              tokens_output_sum: 0,
              tokens_cache_read_sum: 0,
            }
          statsRecord.session_count += 1
          statsRecord.step_count += assistantStepCountBySessionId.get(String(sessionRow.id)) ?? 0
          // Mirror the v0.15.0 token SUMs: each session contributes its
          // session_v2 summary columns exactly ONCE (the pre-aggregated
          // join shape — never multiplied by its step count).
          statsRecord.tokens_input_sum += Number(sessionRow.tokens_input ?? 0)
          statsRecord.tokens_output_sum += Number(sessionRow.tokens_output ?? 0)
          statsRecord.tokens_cache_read_sum += Number(sessionRow.tokens_cache_read ?? 0)
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
              tokens_input_sum: statsRecord.tokens_input_sum,
              tokens_output_sum: statsRecord.tokens_output_sum,
              tokens_cache_read_sum: statsRecord.tokens_cache_read_sum,
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
      // v0.21.0 GET /api/step-distribution：每会话 assistant 行数分布。
      // 与下方 stepCount 富化同口径（type='assistant' 纯行计数），但全表
      // 扫描、无 IN 下推——镜像 SQL 的 GROUP BY session_id 不按当页 id 过滤。
      if (
        sql.includes("COUNT(*) AS step_count") &&
        sql.includes("GROUP BY session_id") &&
        !sql.includes("session_id IN (")
      ) {
        return {
          all: () =>
            Object.entries(scenario.messagesBySessionId)
              .map(([sessionId, messageFixtures]) => ({
                session_id: sessionId,
                step_count: messageFixtures.filter(
                  (messageFixture) => messageFixture.type === "assistant",
                ).length,
              }))
              .filter((row) => row.step_count > 0),
          get: () => undefined,
        }
      }
      // v0.20.0 step 级轻计数（session-summary-enrichment 的 stepCount
      // 来源）：纯行计数镜像——只统计 type='assistant'（无 json 谓词，
      // 与真实轻查询同口径），IN 绑定参数即当页会话 id 集。
      if (sql.includes("COUNT(*) AS step_count") && sql.includes("GROUP BY session_id")) {
        return {
          all: (...parameters: unknown[]) => {
            const pageSessionIds = new Set(parameters.map((pageSessionId) => String(pageSessionId ?? "")))
            const stepCountBySessionId = new Map<string, number>()
            for (const [sessionId, messageFixtures] of Object.entries(scenario.messagesBySessionId)) {
              if (!pageSessionIds.has(sessionId)) continue
              const assistantCount = messageFixtures.filter(
                (messageFixture) => messageFixture.type === "assistant",
              ).length
              if (assistantCount > 0) stepCountBySessionId.set(sessionId, assistantCount)
            }
            return [...stepCountBySessionId.entries()].map(([sessionId, assistantCount]) => ({
              session_id: sessionId,
              step_count: assistantCount,
            }))
          },
          get: () => undefined,
        }
      }
      // v0.19.0 step 级模型聚合（querySessionList / querySessionSummaryById
      // 的 modelIds 来源）：镜像 SQL 的 (session_id, $.model.id) GROUP BY——
      // 只统计 assistant 且 data 为 JSON 对象的消息（与下方 assistant-step
      // 镜像同一判定）；model.id 缺失/非对象按 SQL NULL 服务（查询层跳过），
      // 空串原样服务（查询层归一 "unknown"，镜像真实 json_extract）。
      // v0.19.1 P2-4 IN 下推：富化只扫给定 id 集——session_id IN (?, ...)
      // 的绑定参数即当页（或单查）会话 id，镜像同一过滤。
      if (sql.includes("GROUP BY session_id, model_id")) {
        const isPageScopedAggregate = sql.includes("session_id IN (")
        return {
          all: (...parameters: unknown[]) => {
            const pageScopedSessionIds = isPageScopedAggregate
              ? new Set(parameters.map((pageSessionId) => String(pageSessionId ?? "")))
              : null
            const aggregatedRows: Array<{ session_id: string; model_id: unknown }> = []
            for (const [sessionId, messageFixtures] of Object.entries(scenario.messagesBySessionId)) {
              if (pageScopedSessionIds !== null && !pageScopedSessionIds.has(sessionId)) continue
              for (const messageFixture of messageFixtures) {
                if (messageFixture.type !== "assistant") continue
                if (
                  typeof messageFixture.data !== "object" ||
                  messageFixture.data === null ||
                  Array.isArray(messageFixture.data)
                ) continue
                const modelRecord = (messageFixture.data as Record<string, unknown>)["model"]
                const modelId =
                  typeof modelRecord === "object" && modelRecord !== null && !Array.isArray(modelRecord)
                    ? (modelRecord as Record<string, unknown>)["id"]
                    : undefined
                aggregatedRows.push({ session_id: sessionId, model_id: modelId ?? null })
              }
            }
            return aggregatedRows
          },
          get: () => undefined,
        }
      }
      // v0.24.0 GET /api/search 全量扫描：type IN ('user','assistant')。
      // 返回这两类消息行（data 保持 JSON.stringify 的 wire 形状，搜索侧
      // 自己 JSON.parse），供 queryCrossSessionSearch 构建可搜索文本。
      if (sql.includes("type IN ('user', 'assistant')")) {
        return {
          all: () =>
            Object.entries(scenario.messagesBySessionId)
              .flatMap(([sessionId, messageFixtures]) =>
                messageFixtures
                  .filter(
                    (messageFixture) =>
                      messageFixture.type === "user" || messageFixture.type === "assistant",
                  )
                  .map((messageFixture, messageIndex) => ({
                    id: messageFixture.id ?? `search_msg_${messageIndex}`,
                    session_id: sessionId,
                    type: messageFixture.type,
                    seq: messageFixture.seq ?? messageIndex,
                    data: JSON.stringify(messageFixture.data),
                  })),
              ),
          get: () => undefined,
        }
      }
      const isPerSessionQuery = sql.includes("session_id = ?")
      const hasTimeFloor = sql.includes("time_created >= ?")
      return {
        all: (...parameters: unknown[]) => {
          const messageFixtures = isPerSessionQuery
            ? scenario.messagesBySessionId[String(parameters[0] ?? "")] ?? []
            : // The assistant-step scan (queryAssistantStepRows) asks for
              // every assistant message with no session filter; the SQL
              // itself selects type = 'assistant'.
              Object.values(scenario.messagesBySessionId)
                .flat()
                .filter((messageFixture) => messageFixture.type === "assistant")
          const messageRows = messageFixtures.map((messageFixture, messageIndex) => ({
            id: messageFixture.id ?? `msg_${messageIndex}`,
            session_id: isPerSessionQuery ? String(parameters[0] ?? "") : "ses_step_scan",
            type: messageFixture.type,
            seq: messageFixture.seq ?? messageIndex,
            time_created: messageFixture.timeCreated ?? DEFAULT_MESSAGE_TIMESTAMP,
            time_updated: messageFixture.timeCreated ?? DEFAULT_MESSAGE_TIMESTAMP,
            data: JSON.stringify(messageFixture.data),
          }))
          // The assistant-step scan may carry a time_created >= ? floor.
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
    // v0.19.0：类型必填；fake 的 session_v2 行由 toSessionV2Row 重新派生，
    // 真正回给查询层的 modelIds 走 session_message 聚合分支，此字段仅满足类型。
    modelIds: ["glm-5.3"],
    agent: "fixer",
    directory: "",
    timeCreated: new Date(2026, 9, 5, 15, 30).getTime(),
    timeUpdated: new Date(2026, 9, 5, 16, 15).getTime(),
    // 默认 fixture 的 timeUpdated > timeCreated（差 45 分钟），duration 为正。
    durationMilliseconds: new Date(2026, 9, 5, 16, 15).getTime() - new Date(2026, 9, 5, 15, 30).getTime(),
    tokens: 123456,
    tokensInput: 100000,
    tokensOutput: 20000,
    tokensCacheRead: 3456,
    cost: 0,
    // v0.20.0 附加字段默认值：查询层的 enrichSessionSummaries 会按
    // 夹具消息 / session_v2 附加列覆盖，这里只给「无富化」的缺省。
    tokensReasoning: 0,
    tokensCacheWrite: 0,
    stepCount: 0,
    parentSessionId: null,
    childSessionCount: 0,
    childTokensTotal: 0,
    ...overrides,
  }
}

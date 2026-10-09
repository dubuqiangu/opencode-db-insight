/**
 * Shared types of the db read layer (DESIGN.md §4).
 *
 * Wire field names coming out of opencode.db (`data`, `type`, `tokens`,
 * `session_id`, ...) keep their original names; derived fields use
 * descriptive names.
 */

/**
 * Minimal structural type for a prepared statement of node:sqlite.
 * Declared locally so the module does not depend on a specific
 * @types/node version for the experimental `node:sqlite` binding.
 */
export interface SqliteStatement {
  all(...parameters: unknown[]): unknown[]
  get(...parameters: unknown[]): unknown
}

/** Minimal structural type for a read-only node:sqlite connection. */
export interface SqliteReadConnection {
  prepare(sql: string): SqliteStatement
  close(): void
}

/**
 * Token usage of one assistant message, flattened from the wire shape
 * `data.tokens = {input, output, reasoning, cache: {read, write}}`.
 */
export interface TokenUsage {
  input: number
  output: number
  reasoning: number
  cacheRead: number
  cacheWrite: number
}

/**
 * One assistant message from `session_message`, lightly structured for the
 * stats layer. A "step" is one assistant message; messages without a
 * `tokens` block keep zeroed tokens but still count as steps.
 */
export interface AssistantStepRow {
  messageId: string
  sessionId: string
  timeCreated: number
  modelId: string
  providerId: string
  agent: string
  tokens: TokenUsage
  /** Name of every tool call part contained in this message. */
  toolNames: string[]
}

/** KPI payload for GET /api/overview (DESIGN.md §5/§6). */
export interface OverviewStats {
  /** Σ tokens(input+output+cache.read) of today's assistant messages. */
  todayTokens: number
  /** Σ tokens(input+output+cache.read) over all assistant messages. */
  totalTokens: number
  /** Today's cache hit rate, usage-meter compatible (DESIGN §5). */
  todayHitRate: number
  sessionCount: number
  stepCount: number
  /** Σ session_v2.cost — DB actual value, often 0 (UI shows 🟡 estimate otherwise). */
  totalCost: number
}

/** One session row of the session list (session_v2). */
export interface SessionSummary {
  id: string
  title: string
  modelId: string
  agent: string
  directory: string
  timeCreated: number
  timeUpdated: number
  /**
   * Σ tokens_input+tokens_output+tokens_cache_read from the session_v2
   * summary columns (the list is the only place they are used,
   * DESIGN §2.2). session_v2 KEEPS the message-level history that
   * compaction prunes, so the message-level aggregate UNDERCOUNTS
   * compacted sessions against it; live-db probe: v2 is never below
   * the message-level sum (844 sessions, 0 lagging / 69 ahead, and
   * 28/28 compacted sessions ahead). Cross-panel caveat: v2 and the
   * message-level 口径 still differ by ~0.36% systematically.
   */
  tokens: number
  /** session_v2.tokens_input, coerced value-by-value (v0.13.0). */
  tokensInput: number
  /** session_v2.tokens_output, coerced value-by-value (v0.13.0). */
  tokensOutput: number
  /** session_v2.tokens_cache_read, coerced value-by-value (v0.13.0). */
  tokensCacheRead: number
  cost: number
}

/**
 * One message of a single session, for the replay view. `data` keeps the
 * parsed original JSON structure (wire field).
 */
export interface SessionMessageRecord {
  id: string
  sessionId: string
  /** Wire message type: user | assistant | system | idle | synthetic | model-switched | compaction. */
  type: string
  seq: number
  timeCreated: number
  timeUpdated: number
  data: unknown
}

/** Todo counters for GET /api/overview style widgets (DESIGN §5). */
export interface TodoStats {
  total: number
  completed: number
  pending: number
  inProgress: number
}

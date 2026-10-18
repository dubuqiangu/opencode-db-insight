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
   * 会话墙钟时长（毫秒，v0.21.0）= time_updated - time_created。单位与
   * timeCreated / timeUpdated 一致（都是 epoch 毫秒），前端用 formatDuration
   * 转人类可读。time_updated <= time_created（时钟回拨 / 0 / 缺列）→ null，
   * 前端渲染 "—"。属于「基础形状」字段：由 parseSessionSummaryRow 直接
   * 派生，不随 includeStepModelIds 富化开关关闭（CSV / TUI 直调也带）。
   */
  durationMilliseconds: number | null
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
  /**
   * 模型下钻口径（v0.19.0 修复「点模型行 → 会话列表空」）：该会话内
   * 出现过的模型 id 集合 = step 级 `session_message.data` 的
   * `$.model.id`（与模型排行榜同源，空 id 与排行榜一致归一为
   * "unknown"）∪ 会话启动模型 session_v2.model 的 .id（"unknown"
   * 占位不计入——那是缺数据，不是真用过）。两条产出路径
   * （querySessionList / querySessionSummaryById）都填充且口径相同，
   * 所以同一会话从任意路径取出的形状一致（P2-2 的 by-id 逐字段
   * 锁继续成立）。无 step 且启动模型未知的会话为空数组（诚实：
   * 没有任何已知模型出现过）。前端据此做模型行下钻的行过滤，
   * 旧宿主 wire 缺字段时组件回退 modelId 精确匹配。
   */
  modelIds: string[]
  /**
   * session_v2.tokens_reasoning（v0.20.0 载荷富化）：旧库缺列时降级
   * 为 0，旧前端忽略新字段——additive，不破坏既有消费者。
   */
  tokensReasoning: number
  /** session_v2.tokens_cache_write（v0.20.0）；旧库缺列降级为 0。 */
  tokensCacheWrite: number
  /**
   * 该会话的 assistant 消息数（v0.20.0）。计数走独立轻查询：仅
   * type = 'assistant' 谓词 + IN 下推，不做任何 JSON 解析（无
   * json 谓词，纯行计数），因此与 includeStepModelIds 开关无关——
   * 开关只关 modelIds 的 JSON 富化，不关计数。无 step 行的会话
   * 为 0。
   *
   * 口径注：这里数的是 type='assistant' 的原始行，不含共享
   * ASSISTANT_OBJECT_DATA_PREDICATE 的 JSON 有效性判定——契约明示
   * 用轻查询换性能；含畸形 data 行的库上与 overview 的 stepCount
   * （step 口径 = assistant + JSON 对象）存在细微差异，真实库中
   * 畸形行几乎不存在。
   */
  stepCount: number
  /**
   * session_v2.parent_id（v0.20.0）：无父会话或旧库缺列为 null。
   */
  parentSessionId: string | null
  /**
   * 直接子会话数（v0.20.0）：按 parent_id 自连接归总，只做一层
   * 直接子代，不做递归树——递归展开留给前端按需处理或后续版本。
   */
  childSessionCount: number
  /**
   * 直接子会话的 tokens 三列合计（input+output+cache_read，与列表
   * Tokens 列同口径）；无子会话为 0。
   */
  childTokensTotal: number
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

/** 子会话占比 / 顶层子代树的载荷（v0.21.0 GET /api/child-share）。 */
export interface ChildShareStats {
  /** session_v2 全部会话数。 */
  totalSessions: number
  /** parent_id IS NOT NULL 的会话数。 */
  childSessionCount: number
  /** parent_id IS NULL 的会话数。 */
  rootSessionCount: number
  /** 子会话的 tokens 三列合计（input+output+cache_read，COALESCE 兜底）。 */
  childTokens: number
  /** 根会话的 tokens 三列合计 = totalTokens - childTokens。 */
  rootTokens: number
  /** 全部会话的 tokens 三列合计。 */
  totalTokens: number
  /** childTokens / totalTokens；totalTokens 为 0 时为 0。 */
  childShare: number
  /**
   * 按「某会话直接子代 tokens 合计」降序的 top5 会话：tokens /
   * childSessionCount 都是该父会话的直接子代归总，title / agent 取父会话
   * 自身。凡有直接子代的会话均可入榜（不限定 root）。
   */
  topChildTrees: Array<{
    sessionId: string
    title: string
    agent: string
    tokens: number
    childSessionCount: number
  }>
}

/** Todo counters for GET /api/overview style widgets (DESIGN §5). */
export interface TodoStats {
  total: number
  completed: number
  pending: number
  inProgress: number
}

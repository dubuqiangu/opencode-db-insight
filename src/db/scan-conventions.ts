/**
 * Shared scan conventions for the SQL-side aggregation queries
 * (aggregate-queries.ts, behavior-queries.ts).
 *
 * Single source of truth for the assistant-step predicate and the
 * days-pushdown scan floor. Both query files must filter the exact same
 * rows and use the same window slack — cross-route conservation
 * (heatmap Σsteps === trend Σsteps for the same days) depends on it,
 * so drift here is a correctness bug, not a style issue.
 */

/** One day in milliseconds; only used for scan-window floors. */
export const DAY_MS = 24 * 60 * 60 * 1000

/**
 * Shared SQL predicate selecting exactly the rows the old JS pipeline
 * accepted as steps: assistant messages whose `data` is a valid JSON
 * object. Rows failing it were skipped by parseAssistantStepRow, so every
 * aggregate applying it stays comparable with the pre-SQL era (0.1.2
 * parity discipline).
 */
export const ASSISTANT_OBJECT_DATA_PREDICATE =
  "type = 'assistant' AND json_valid(data) AND json_type(data) = 'object'"

/**
 * SQL-side scan floor for a bounded day window (days pushdown): one
 * extra day of slack so the floor is always below the window start even
 * across DST transitions. The slack rows it lets through are dropped
 * JS-side by local-time window enforcement (the trend's date-key map,
 * the heatmap's window lower bound, compaction's recentDaily key map).
 *
 * nowMs is injectable so a caller computing several windows (current +
 * previous) reads the clock ONCE and threads the same instant in — two
 * internal Date.now() reads can straddle local midnight and put the two
 * windows on different days. Omitted → Date.now() (behavior unchanged).
 */
export function buildScanFloorEpochMs(
  boundedDays: number,
  nowMs: number = Date.now(),
): number {
  return nowMs - (boundedDays + 1) * DAY_MS
}

/**
 * Local midnight of the oldest day inside a bounded day window — the
 * JS-side window lower bound, the same construction bucketDailyTrend
 * uses to generate its consecutive local date keys. Together with
 * buildScanFloorEpochMs it forms the pushdown + reclaim pair.
 *
 * nowMs is injectable (see buildScanFloorEpochMs): one clock read shared
 * by every window a caller computes. Omitted → Date.now() (unchanged).
 */
export function buildWindowStartEpochMs(
  boundedDays: number,
  nowMs: number = Date.now(),
): number {
  const todayLocalMidnight = new Date(nowMs)
  todayLocalMidnight.setHours(0, 0, 0, 0)
  const windowStartDate = new Date(todayLocalMidnight.getTime())
  windowStartDate.setDate(windowStartDate.getDate() - (boundedDays - 1))
  return windowStartDate.getTime()
}

/**
 * v0.20.0 ?session= 会话过滤的 SQL 片段集（单点纪律）：所有接受
 * ?session= 的聚合查询都从这一个构造器取过滤文本，端点实现里不允许
 * 出现手写的副本——谓词文本漂移在这里是正确性 bug，和上面共享
 * step 谓词同一约束。
 *
 * 三个片段对应三类落点：
 * - step 级聚合（session_message 出发）前置 `session_id = ? AND `：
 *   谓词置于 json 函数谓词之前，SQLite 的 AND 按书写序短路——单会话
 *   扫描先被等值条件收窄到目标会话的行，47k 级全表的逐行 JSON 解析
 *   缩到只解析一个会话的行（与 modelIds 富化的 IN 下推同一性能纪律）；
 * - 会话级聚合（session_v2 出发）追加 ` WHERE id = ?`（todo 表按
 *   session_id 列过滤，契约指定）；
 * - 已有 WHERE 的会话级查询（directories）追加 ` AND id = ?`——
 *   该查询的 LEFT JOIN 子查询只暴露 session_id/step_count 两列，
 *   不限定的 id 无歧义地解析到外层 s.id；未来子查询若引入同名列
 *   会以 "ambiguous column" 响亮失败，不会静默漂移。
 *
 * null / undefined / 空串 = 缺省不过滤：片段全部为空串，绑定值为
 * null，产出的 SQL 字节与现行全量口径逐字节一致（缺省逐字节不变
 * 契约）。绑定值每条语句至多一个，由调用方按片段在 SQL 中的位置
 * 压入参数表。
 */
export interface SessionFilterSqlFragments {
  /** 过滤的会话 id；null 表示缺省不过滤。 */
  sessionFilterId: string | null
  /** step 级（session_message）WHERE 前缀："" 或 "session_id = ? AND "。 */
  stepPredicatePrefixSql: string
  /** 会话级（session_v2）独立 WHERE："" 或 " WHERE id = ?"。 */
  sessionRowWhereSql: string
  /** 会话级（session_v2）已有 WHERE 的追加条件："" 或 " AND id = ?"。 */
  sessionRowAndConditionSql: string
  /** todo 表过滤（session_id 列）："" 或 " WHERE session_id = ?"。 */
  todoSessionWhereSql: string
}

/** 归一化 ?session= 参数：null/undefined/空串统一为缺省（不过滤）。 */
function normalizeSessionFilterId(
  sessionFilterId: string | null | undefined,
): string | null {
  if (sessionFilterId === null || sessionFilterId === undefined) return null
  if (sessionFilterId === "") return null
  return sessionFilterId
}

/**
 * 构造 ?session= 过滤片段集（单点）。见 SessionFilterSqlFragments 的
 * 口径说明；缺省调用（null）产出全空片段，保证现行 SQL 字节不变。
 */
export function buildSessionFilterSqlFragments(
  sessionFilterId: string | null | undefined,
): SessionFilterSqlFragments {
  const normalizedFilterId = normalizeSessionFilterId(sessionFilterId)
  if (normalizedFilterId === null) {
    return {
      sessionFilterId: null,
      stepPredicatePrefixSql: "",
      sessionRowWhereSql: "",
      sessionRowAndConditionSql: "",
      todoSessionWhereSql: "",
    }
  }
  return {
    sessionFilterId: normalizedFilterId,
    stepPredicatePrefixSql: "session_id = ? AND ",
    sessionRowWhereSql: " WHERE id = ?",
    sessionRowAndConditionSql: " AND id = ?",
    todoSessionWhereSql: " WHERE session_id = ?",
  }
}

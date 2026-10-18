/**
 * Pure aggregation for GET /api/session-outcomes (v0.22.0 B 档). Zero IO:
 * the SQL layer hands over the already-grouped counters (session counts,
 * session-level terminal error-type counts, the recent interrupted sessions)
 * and this module assembles the payload, computes the derived ratios and pins
 * the deterministic ordering.
 *
 * 口径（🟡 推断，契约定稿）：以错误收尾的会话 = 该会话最后一条 assistant
 * 消息携带 `$.error`。无 assistant 消息的会话不进入占比分母 ——
 * interruptedShare = interruptedSessions / sessionsWithSteps（分母 0 时为
 * 0）。byErrorType 为会话级计数：每个收尾会话只按其终局错误类型贡献一次，
 * 故 Σ byErrorType.count == interruptedSessions（终局错误缺 type 的会话
 * 除外）。
 *
 * 派生量（如「干净收尾」= sessionsWithSteps - interruptedSessions）由消费者
 * 自算，不再预计算进载荷 —— 没有 UI 消费的派生字段是死载荷。
 */

/** One error-type bucket of byErrorType (session-level count). */
export interface SessionOutcomeErrorType {
  type: string
  count: number
}

/** One row of recentInterrupted (title from session_v2). */
export interface RecentInterruptedSession {
  sessionId: string
  title: string
  errorType: string
  errorMessage: string
  /**
   * session_v2.time_updated（毫秒），前端按格式化相对时间展示。
   */
  timeUpdated: number
}

/** Payload of GET /api/session-outcomes. */
export interface SessionOutcomeStats {
  totalSessions: number
  sessionsWithSteps: number
  interruptedSessions: number
  /** interruptedSessions / sessionsWithSteps; 0 when there are no step sessions. */
  interruptedShare: number
  /** Error-type buckets: count descending, type ascending tie-break. */
  byErrorType: SessionOutcomeErrorType[]
  recentInterrupted: RecentInterruptedSession[]
}

/**
 * Rank error-type buckets by count descending, type ascending as the
 * tie-break — a deterministic order regardless of the SQL GROUP BY emission
 * order (the frontend bars and any consumer rely on it being total).
 */
export function rankErrorTypes(
  errorTypeCounts: SessionOutcomeErrorType[],
): SessionOutcomeErrorType[] {
  return [...errorTypeCounts].sort(
    (leftErrorType, rightErrorType) =>
      rightErrorType.count - leftErrorType.count ||
      (leftErrorType.type < rightErrorType.type
        ? -1
        : leftErrorType.type > rightErrorType.type
          ? 1
          : 0),
  )
}

/**
 * Assemble the session-outcome payload from the SQL-derived counters.
 * sessionsWithSteps is the share denominator (clamped share at a zero
 * denominator); interruptedSessions is a subset of it by construction.
 */
export function buildSessionOutcomeStats(input: {
  totalSessions: number
  sessionsWithSteps: number
  interruptedSessions: number
  errorTypeCounts: SessionOutcomeErrorType[]
  recentInterrupted: RecentInterruptedSession[]
}): SessionOutcomeStats {
  return {
    totalSessions: input.totalSessions,
    sessionsWithSteps: input.sessionsWithSteps,
    interruptedSessions: input.interruptedSessions,
    interruptedShare:
      input.sessionsWithSteps > 0 ? input.interruptedSessions / input.sessionsWithSteps : 0,
    byErrorType: rankErrorTypes(input.errorTypeCounts),
    recentInterrupted: input.recentInterrupted,
  }
}

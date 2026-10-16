/**
 * 会话列表 / 单查的 step 级与 v2 附加列富化（v0.19.0 modelIds +
 * v0.20.0 stepCount / tokensReasoning / tokensCacheWrite /
 * parentSessionId / childSessionCount / childTokensTotal）。
 *
 * 从 queries.ts 拆出的原因（代码组织纪律）：富化是独立职责——一组
 * 「当页 id 集驱动的 IN 下推小查询 + 结果归并」，与主列表 SQL 的
 * 分页 / 排序 / 过滤互不依赖；拆开后 queries.ts 只做行级 SQL 与
 * 装配，本文件只做装饰。行为零变化：modelIds 口径与 v0.19.1 的
 * IN 下推实现逐字节相同（该实现整体搬入本文件）。
 *
 * 降级纪律（与 queryStepModelIdsBySessionId 的既有 catch 宽度一致）：
 * 「no such table」（只有 session_v2 的库）与「no such column」
 * （旧 opencode.db 缺 v0.20.0 新列）是已知合法场景，静默降级；
 * 其余任何错误先 console.error 再降级，防无痕复发。降级语义：
 * 对应字段保持默认值（0 / null），富化失败不得牵连列表主查询。
 */

import type { SessionSummary, SqliteReadConnection } from "./types.ts"
import { asRecord, coerceNumber, coerceText, UNKNOWN_MODEL_ID } from "./rows.ts"
import { ASSISTANT_OBJECT_DATA_PREDICATE } from "./scan-conventions.ts"

/**
 * 组装单个 summary 的 modelIds：step 集合 ∪ 启动模型（"unknown" 占位
 * 不计入——缺数据不是「用过」）。无 step 且启动模型未知 → 空数组。
 */
export function buildSessionModelIds(
  modelId: string,
  stepModelIdSet: Set<string> | undefined,
): string[] {
  const modelIds = new Set<string>(stepModelIdSet ?? [])
  if (modelId !== UNKNOWN_MODEL_ID) modelIds.add(modelId)
  return [...modelIds]
}

/**
 * Step 级模型 id 聚合（v0.19.0 模型下钻口径修复）：每对
 * (session_id, $.model.id) 一行。为什么需要它——模型排行榜的行来自
 * step 级 `$.model.id`，而会话的 `modelId` 只是 session_v2.model 声明的
 * 启动模型；实测 top 榜模型（glm-5.3-flash / claude-opus-5 …）从不作为
 * 启动模型出现，按启动模型过滤必然点出行列表空。会话列表因此改按
 * 「会话内 step 级出现过」过滤，本查询就是那个集合的 SQL 侧来源。
 *
 * `sessionIds` 是本次富化要覆盖的会话 id 集（by-id 单查路径传单个
 * id；列表路径传当页整页 id 集——P2-4 IN 下推：谓词置于 json 函数
 * 谓词之前，SQLite 的 AND 按书写序短路，47k 行逐行 JSON 解析缩到
 * 只解析当页会话的行，真库实测 ~2.6s/次 → ~531ms/页）。两条路径复用
 * 同一口径，保证产出的 SessionSummary 形状一致（sql-aggregation-parity
 * 的 by-id 逐字段锁依赖这一点）。谓词复用聚合统计的共享
 * ASSISTANT_OBJECT_DATA_PREDICATE：与排行榜扫描同一批行，空 model.id
 * 由 JS 侧归一为 "unknown"（镜像 parseAssistantStepRow / queryModelMetrics
 * 的归一，保证点排行榜的 "unknown" 行下钻也能命中）。
 */
function queryStepModelIdsBySessionId(
  db: SqliteReadConnection,
  sessionIds: string[],
): Map<string, Set<string>> {
  // 空 id 集不发 SQL：IN () 不是合法语句，且没有会话就没有富化可做。
  if (sessionIds.length === 0) return new Map()
  const sessionFilterSql = `session_id IN (${sessionIds.map(() => "?").join(", ")})`
  let rawRows: unknown[]
  try {
    rawRows = db
      .prepare(
        `SELECT session_id, json_extract(data, '$.model.id') AS model_id
         FROM session_message
         WHERE ${sessionFilterSql} AND ${ASSISTANT_OBJECT_DATA_PREDICATE}
         GROUP BY session_id, model_id`,
      )
      .all(...sessionIds)
  } catch (error) {
    // R-D（v0.19.1 catch 宽度加固）：「no such table」是已知且合法的
    // 降级场景——只有 session_v2 的库（CSV 导出测试夹具即此形态）没有
    // session_message 表，静默降级即可；其余任何错误（真实 SQL 错误、
    // 库损坏）必须先 console.error 再降级，防无痕复发 v0.19.0 修过的
    // bug。降级语义不变：step 集合整体置空，summary 的 modelIds 只含
    // 启动模型；富化失败不得牵连列表/导出主查询（后者依赖 session_v2
    // 单表，语义上就不需要 step 数据）。
    const failureMessage = error instanceof Error ? error.message : String(error)
    if (!/no such table/i.test(failureMessage)) {
      console.error("opencode-db-insight: step model id aggregation failed", error)
    }
    return new Map()
  }

  const stepModelIdsBySessionId = new Map<string, Set<string>>()
  for (const rawRow of rawRows) {
    const rowRecord = asRecord(rawRow)
    if (rowRecord === null) continue
    const stepSessionId = coerceText(rowRecord["session_id"])
    // json_extract 对缺失/JSON null 的 $.model.id 返回 NULL——那是
    // 「没有模型可下钻」的行，不是 "unknown" 桶；只有显式空串才归一
    // 为 "unknown"（与排行榜 JS 侧 rawModelId === "" 的判定一致）。
    const rawModelId = rowRecord["model_id"]
    if (rawModelId === null || rawModelId === undefined) continue
    const stepModelId = coerceText(rawModelId)
    const normalizedModelId = stepModelId === "" ? UNKNOWN_MODEL_ID : stepModelId
    const modelIdSet = stepModelIdsBySessionId.get(stepSessionId) ?? new Set<string>()
    modelIdSet.add(normalizedModelId)
    stepModelIdsBySessionId.set(stepSessionId, modelIdSet)
  }
  return stepModelIdsBySessionId
}

/**
 * Step 级轻计数（v0.20.0 stepCount）：每会话一行 assistant 消息数。
 * 与 modelIds 的 JSON 扫描不同，这条只做 type 等值判定 + IN 下推，
 * 纯行计数、零 JSON 解析——因此不受 includeStepModelIds 开关控制
 * （契约：开关只关 JSON 富化、不关计数；CSV 导出 / TUI 选单传 false
 * 只为跳过 JSON 解析，stepCount 仍要有值）。口径见 SessionSummary.
 * stepCount 的注释：数的是 type='assistant' 原始行，不含 JSON 有效性
 * 判定。
 */
function queryStepCountsBySessionId(
  db: SqliteReadConnection,
  sessionIds: string[],
): Map<string, number> {
  if (sessionIds.length === 0) return new Map()
  const sessionFilterSql = `session_id IN (${sessionIds.map(() => "?").join(", ")})`
  let rawRows: unknown[]
  try {
    rawRows = db
      .prepare(
        `SELECT session_id, COUNT(*) AS step_count
         FROM session_message
         WHERE ${sessionFilterSql} AND type = 'assistant'
         GROUP BY session_id`,
      )
      .all(...sessionIds)
  } catch (error) {
    const failureMessage = error instanceof Error ? error.message : String(error)
    if (!/no such table/i.test(failureMessage)) {
      console.error("opencode-db-insight: step count aggregation failed", error)
    }
    return new Map()
  }

  const stepCountBySessionId = new Map<string, number>()
  for (const rawRow of rawRows) {
    const rowRecord = asRecord(rawRow)
    if (rowRecord === null) continue
    stepCountBySessionId.set(
      coerceText(rowRecord["session_id"]),
      coerceNumber(rowRecord["step_count"]),
    )
  }
  return stepCountBySessionId
}

/** session_v2 附加列（v0.20.0）按 id 的点查结果。 */
interface SessionV2AddonColumns {
  tokensReasoning: number
  tokensCacheWrite: number
  parentSessionId: string | null
}

/**
 * session_v2 附加列富化（v0.20.0）：tokens_reasoning /
 * tokens_cache_write / parent_id 按当页 id 集点查。不做进主列表
 * SELECT 的原因：主列表 SQL 被三条字节锁测试（目录/范围/排序）钉死，
 * 独立点查让旧库（缺列）以一次 catch 整页降级，而不是让主查询带着
 * 两套 SELECT 形状。旧库缺列 → 全页保持默认值（0 / null）。
 */
function querySessionV2AddonsBySessionId(
  db: SqliteReadConnection,
  sessionIds: string[],
): Map<string, SessionV2AddonColumns> {
  if (sessionIds.length === 0) return new Map()
  const idFilterSql = `id IN (${sessionIds.map(() => "?").join(", ")})`
  let rawRows: unknown[]
  try {
    rawRows = db
      .prepare(
        `SELECT id, tokens_reasoning, tokens_cache_write, parent_id
         FROM session_v2
         WHERE ${idFilterSql}`,
      )
      .all(...sessionIds)
  } catch (error) {
    const failureMessage = error instanceof Error ? error.message : String(error)
    if (!/no such column/i.test(failureMessage)) {
      console.error("opencode-db-insight: session v2 addon lookup failed", error)
    }
    return new Map()
  }

  const addonColumnsBySessionId = new Map<string, SessionV2AddonColumns>()
  for (const rawRow of rawRows) {
    const rowRecord = asRecord(rawRow)
    if (rowRecord === null) continue
    const rawParentId = rowRecord["parent_id"]
    addonColumnsBySessionId.set(coerceText(rowRecord["id"]), {
      tokensReasoning: coerceNumber(rowRecord["tokens_reasoning"]),
      tokensCacheWrite: coerceNumber(rowRecord["tokens_cache_write"]),
      // SQL NULL（无父会话）保持 null；其余形状按文本归一。
      parentSessionId:
        rawParentId === null || rawParentId === undefined
          ? null
          : coerceText(rawParentId),
    })
  }
  return addonColumnsBySessionId
}

/** 直接子会话归总（v0.20.0）：计数 + tokens 三列合计（列表 Tokens 同口径）。 */
interface ChildSessionAggregate {
  childSessionCount: number
  childTokensTotal: number
}

/**
 * 按 parent_id 自连接归总直接子会话（v0.20.0）。只做一层直接子代，
 * 不做递归树——递归展开留给前端按需处理或后续版本。
 *
 * tokens 合计用 COALESCE 按列兜底 NULL 再相加：与列表 `tokens` 列的
 * 折叠口径一致（coerceNumber 对 NULL 归 0 后逐值相加），一行任何一列
 * 缺值都不会让整行从合计里消失。SQL 侧 SUM 这些结构列是既有纪律
 * （directory-queries：opencode writer 恒写数值；勿复制到 message
 * JSON 数据上）。
 */
function queryChildSessionAggregatesByParentId(
  db: SqliteReadConnection,
  parentSessionIds: string[],
): Map<string, ChildSessionAggregate> {
  if (parentSessionIds.length === 0) return new Map()
  const parentFilterSql = `parent_id IN (${parentSessionIds.map(() => "?").join(", ")})`
  let rawRows: unknown[]
  try {
    rawRows = db
      .prepare(
        `SELECT parent_id,
                COUNT(*) AS child_session_count,
                COALESCE(SUM(COALESCE(tokens_input, 0) + COALESCE(tokens_output, 0)
                             + COALESCE(tokens_cache_read, 0)), 0) AS child_tokens_total
         FROM session_v2
         WHERE ${parentFilterSql}
         GROUP BY parent_id`,
      )
      .all(...parentSessionIds)
  } catch (error) {
    const failureMessage = error instanceof Error ? error.message : String(error)
    if (!/no such column/i.test(failureMessage)) {
      console.error("opencode-db-insight: child session aggregation failed", error)
    }
    return new Map()
  }

  const childAggregatesByParentId = new Map<string, ChildSessionAggregate>()
  for (const rawRow of rawRows) {
    const rowRecord = asRecord(rawRow)
    if (rowRecord === null) continue
    childAggregatesByParentId.set(coerceText(rowRecord["parent_id"]), {
      childSessionCount: coerceNumber(rowRecord["child_session_count"]),
      childTokensTotal: coerceNumber(rowRecord["child_tokens_total"]),
    })
  }
  return childAggregatesByParentId
}

/**
 * 对一页（或单个）SessionSummary 做全部富化（v0.19.0 modelIds +
 * v0.20.0 附加字段），原地写回。调用前提：summary 已带默认值——
 * parseSessionSummaryRow 里 modelIds 由启动模型兜底，v0.20.0 字段
 * 初始为 0 / null，本函数只做覆盖。
 *
 * `includeStepModelIds` 只控制 modelIds 的 JSON 富化扫描（P2-4：
 * 不消费 modelIds 的调用点——CSV 导出循环、TUI 导出选单——传 false
 * 跳过逐行 JSON 解析）；stepCount 轻计数与 v2 附加列点查不受开关
 * 影响，两条路径（列表 / by-id）产出的形状保持逐字段一致。
 */
export function enrichSessionSummaries(
  db: SqliteReadConnection,
  sessionSummaries: SessionSummary[],
  includeStepModelIds: boolean,
): void {
  // 空页不做任何富化查询：没有任何 summary 需要装饰（也让既有
  // 「捕获空结果连接」的 SQL 字节锁测试继续只捕获列表语句本身）。
  if (sessionSummaries.length === 0) return
  const sessionIds = sessionSummaries.map((sessionSummary) => sessionSummary.id)

  if (includeStepModelIds) {
    const stepModelIdsBySessionId = queryStepModelIdsBySessionId(db, sessionIds)
    for (const sessionSummary of sessionSummaries) {
      sessionSummary.modelIds = buildSessionModelIds(
        sessionSummary.modelId,
        stepModelIdsBySessionId.get(sessionSummary.id),
      )
    }
  }

  const stepCountBySessionId = queryStepCountsBySessionId(db, sessionIds)
  const addonColumnsBySessionId = querySessionV2AddonsBySessionId(db, sessionIds)
  const childAggregatesByParentId = queryChildSessionAggregatesByParentId(db, sessionIds)
  for (const sessionSummary of sessionSummaries) {
    const stepCount = stepCountBySessionId.get(sessionSummary.id)
    sessionSummary.stepCount = stepCount === undefined ? 0 : stepCount
    const addonColumns = addonColumnsBySessionId.get(sessionSummary.id)
    if (addonColumns !== undefined) {
      sessionSummary.tokensReasoning = addonColumns.tokensReasoning
      sessionSummary.tokensCacheWrite = addonColumns.tokensCacheWrite
      sessionSummary.parentSessionId = addonColumns.parentSessionId
    }
    const childAggregate = childAggregatesByParentId.get(sessionSummary.id)
    if (childAggregate !== undefined) {
      sessionSummary.childSessionCount = childAggregate.childSessionCount
      sessionSummary.childTokensTotal = childAggregate.childTokensTotal
    }
  }
}

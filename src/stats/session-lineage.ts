/**
 * Agent 血缘图（B6）for GET /api/session-lineage. Pure functions, zero IO;
 * style mirrors token-ledger.ts / file-activity.ts.
 *
 * 口径（冻结，合同 §5.2 点 3、§5.6）：
 * - **只做 `parent_id` 血缘**（fork 维度丢弃，真库 fork_session_id /
 *   fork_boundary 全 NULL）。
 * - 输入是查询层抽出的「一行一会话」样本；本函数负责规范化父指针、环检测、
 *   深度、节点预算与聚焦，产出确定性分层树的 { nodes, edges, stats }。
 * - 父指针规范化（逐条按 sessionId asc 处理，确定性）：
 *     selfParentCount  —— parent_id === 自身 id → 强制为根；
 *     orphanParentCount —— parent_id 指向不存在的会话 → 保留节点、丢边、作根。
 * - 环检测：沿规范化后的父指针上行，遇本路径已见节点即**断开该边**并计入
 *   cycleCount（每环只记一次：断边后不再复访）。
 * - 根排序 = 子树大小 desc, sessionId asc；子节点同序。节点选取是一趟
 *   **BFS**：种子为按上述顺序排列的根，逐个出队即选中，再把其子节点入队，
 *   直到 LINEAGE_NODE_BUDGET；超出计入 omittedNodeCount。
 * - **聚焦模式**（focusSessionId 非空且存在）：候选集 = 该节点 + 全部祖先 +
 *   全部后代；BFS 被候选集过滤，故祖先链与后代都保留（仍受预算约束）。
 *   候选集中未入选的同样计入 omittedNodeCount。
 * - stats 是**全表结构性统计**（rootCount/childCount/maxDepth 覆盖全部会话），
 *   graphSessions 是本次视图里实际入选的节点数。
 * - 后端只返回原始数字，不做四舍五入 / 格式化（精度标签在前端）。
 */

/** 默认节点预算（合同 §5.6 ≈ 400）。 */
export const LINEAGE_NODE_BUDGET = 400

/** 预算上限（保护响应体；路由层 limit 走 boundedIntParamKey 先夹后 key）。 */
export const MAX_LINEAGE_NODE_BUDGET = 1000

/** 一条「一行一会话」的 lineage 样本（查询层原样抽出）。 */
export interface SessionLineageSample {
  sessionId: string
  /** 原始 parent_id（规范化前）；null = 无父。 */
  parentSessionId: string | null
  title: string
  agent: string
  /** tokens_input + tokens_output + tokens_cache_read（v2 汇总口径）。 */
  tokens: number
  timeCreated: number
  /** 直接子会话数（查询层 COUNT）。 */
  childCount: number
}

/** 输出图中的一个节点. */
export interface SessionLineageNode {
  sessionId: string
  /** 规范化后的父指针（根 / 自父 / 孤儿 / 断环 → null），与 edges 自洽。 */
  parentSessionId: string | null
  title: string
  agent: string
  tokens: number
  timeCreated: number
  childCount: number
}

/** 输出图中的一条父子边. */
export interface SessionLineageEdge {
  parentSessionId: string
  childSessionId: string
}

/** 全表结构性统计（不随视图截断）。 */
export interface SessionLineageGraphStats {
  /** session_v2 会话总数。 */
  totalSessions: number
  /** 本次视图入选的节点数（= nodes.length）。 */
  graphSessions: number
  /** 全表根节点数（规范化后无父）。 */
  rootCount: number
  /** 全表有父节点数（rootCount + childCount === totalSessions）。 */
  childCount: number
  /** parent_id 指向不存在会话的节点数（丢边、作根）。 */
  orphanParentCount: number
  /** parent_id === 自身的节点数（强制为根）。 */
  selfParentCount: number
  /** 检出的环数（每个环断一条边，只记一次）。 */
  cycleCount: number
  /** 全表最大深度（根 = 0）。 */
  maxDepth: number
}

/** Payload for GET /api/session-lineage[?session=][&limit=]. */
export interface SessionLineageGraph {
  /** 实际生效的聚焦会话 id（无效 / 缺省 → null）。 */
  focusSessionId: string | null
  nodes: SessionLineageNode[]
  edges: SessionLineageEdge[]
  stats: SessionLineageGraphStats
  /** 候选集中因预算未入选的节点数。 */
  omittedNodeCount: number
}

/** computeSessionLineage 的可选参数. */
export interface SessionLineageOptions {
  /** 聚焦会话 id（?session=）；无效 / null → 全量视图。 */
  focusSessionId?: string | null
  /** 节点预算（缺省 LINEAGE_NODE_BUDGET，至少 1）。 */
  nodeBudget?: number
}

/**
 * 把「一行一会话」样本聚合成确定性血缘图（纯函数、确定性）。
 * 空输入 → 全零 stats、空 nodes / edges、omitted 0、focus null。
 */
export function computeSessionLineage(
  samples: SessionLineageSample[],
  options: SessionLineageOptions = {},
): SessionLineageGraph {
  const nodeBudget = Math.max(1, Math.trunc(options.nodeBudget ?? LINEAGE_NODE_BUDGET))
  const requestedFocusSessionId = options.focusSessionId ?? null

  const sampleById = new Map<string, SessionLineageSample>()
  for (const sample of samples) {
    if (sample.sessionId === "") continue
    sampleById.set(sample.sessionId, sample)
  }
  // 逐条处理一律按 sessionId asc，保证规范化 / 环检测的确定性。
  const orderedSessionIds = [...sampleById.keys()].sort()

  // --- 父指针规范化：自父 / 孤儿 ---
  let selfParentCount = 0
  let orphanParentCount = 0
  const effectiveParentById = new Map<string, string | null>()
  for (const sessionId of orderedSessionIds) {
    let parentSessionId = sampleById.get(sessionId)!.parentSessionId
    if (parentSessionId !== null && parentSessionId === sessionId) {
      selfParentCount += 1
      parentSessionId = null
    } else if (parentSessionId !== null && !sampleById.has(parentSessionId)) {
      orphanParentCount += 1
      parentSessionId = null
    }
    effectiveParentById.set(sessionId, parentSessionId)
  }

  // --- 环检测：沿父指针上行，遇本路径已见节点即断边 ---
  let cycleCount = 0
  for (const sessionId of orderedSessionIds) {
    const seenOnPath = new Set<string>([sessionId])
    let currentSessionId = sessionId
    for (;;) {
      const parentSessionId = effectiveParentById.get(currentSessionId) ?? null
      if (parentSessionId === null) break
      if (seenOnPath.has(parentSessionId)) {
        effectiveParentById.set(currentSessionId, null)
        cycleCount += 1
        break
      }
      seenOnPath.add(parentSessionId)
      currentSessionId = parentSessionId
    }
  }

  // --- 子指针索引 ---
  const childIdsByParent = new Map<string, string[]>()
  for (const sessionId of orderedSessionIds) {
    const parentSessionId = effectiveParentById.get(sessionId) ?? null
    if (parentSessionId === null) continue
    const childIds = childIdsByParent.get(parentSessionId)
    if (childIds === undefined) childIdsByParent.set(parentSessionId, [sessionId])
    else childIds.push(sessionId)
  }
  const childIdsOf = (sessionId: string): string[] => childIdsByParent.get(sessionId) ?? []

  const rootSessionIds = orderedSessionIds.filter(
    (sessionId) => (effectiveParentById.get(sessionId) ?? null) === null,
  )

  // --- 子树大小（含自身），迭代后序，避免递归深度风险 ---
  const subtreeSizeById = new Map<string, number>()
  for (const rootSessionId of rootSessionIds) {
    const stack: Array<{ sessionId: string; childIndex: number }> = [
      { sessionId: rootSessionId, childIndex: 0 },
    ]
    while (stack.length > 0) {
      const frame = stack[stack.length - 1]
      const childIds = childIdsOf(frame.sessionId)
      if (frame.childIndex < childIds.length) {
        const childSessionId = childIds[frame.childIndex]
        frame.childIndex += 1
        stack.push({ sessionId: childSessionId, childIndex: 0 })
      } else {
        let subtreeSize = 1
        for (const childSessionId of childIds) {
          subtreeSize += subtreeSizeById.get(childSessionId) ?? 0
        }
        subtreeSizeById.set(frame.sessionId, subtreeSize)
        stack.pop()
      }
    }
  }

  /** 确定性顺序：子树大小 desc，再 sessionId asc。 */
  const compareBySubtreeThenId = (leftSessionId: string, rightSessionId: string): number => {
    const leftSubtreeSize = subtreeSizeById.get(leftSessionId) ?? 1
    const rightSubtreeSize = subtreeSizeById.get(rightSessionId) ?? 1
    if (leftSubtreeSize !== rightSubtreeSize) return rightSubtreeSize - leftSubtreeSize
    return leftSessionId < rightSessionId ? -1 : leftSessionId > rightSessionId ? 1 : 0
  }
  const sortedRootSessionIds = [...rootSessionIds].sort(compareBySubtreeThenId)

  // --- 深度（全表，BFS）---
  const depthBySessionId = new Map<string, number>()
  const breadthQueue = [...rootSessionIds]
  for (const rootSessionId of rootSessionIds) depthBySessionId.set(rootSessionId, 0)
  for (let queueIndex = 0; queueIndex < breadthQueue.length; queueIndex += 1) {
    const sessionId = breadthQueue[queueIndex]
    const depth = depthBySessionId.get(sessionId) ?? 0
    for (const childSessionId of childIdsOf(sessionId)) {
      depthBySessionId.set(childSessionId, depth + 1)
      breadthQueue.push(childSessionId)
    }
  }
  let maxDepth = 0
  for (const depth of depthBySessionId.values()) if (depth > maxDepth) maxDepth = depth

  // --- 聚焦候选集（该节点 + 祖先 + 后代）；null = 全量 ---
  let focusSessionId: string | null = null
  let candidateSessionIds: Set<string> | null = null
  if (requestedFocusSessionId !== null && sampleById.has(requestedFocusSessionId)) {
    focusSessionId = requestedFocusSessionId
    candidateSessionIds = new Set<string>()
    let ancestorSessionId: string | null = requestedFocusSessionId
    while (ancestorSessionId !== null) {
      candidateSessionIds.add(ancestorSessionId)
      ancestorSessionId = effectiveParentById.get(ancestorSessionId) ?? null
    }
    const descendantQueue = [requestedFocusSessionId]
    for (let queueIndex = 0; queueIndex < descendantQueue.length; queueIndex += 1) {
      for (const childSessionId of childIdsOf(descendantQueue[queueIndex])) {
        candidateSessionIds.add(childSessionId)
        descendantQueue.push(childSessionId)
      }
    }
  }

  // --- 节点选取：一趟 BFS（种子 = 有序根，子节点同序），受候选集过滤与预算 ---
  const selectedSessionIds: string[] = []
  const selectionQueue = [...sortedRootSessionIds]
  for (
    let queueIndex = 0;
    queueIndex < selectionQueue.length && selectedSessionIds.length < nodeBudget;
    queueIndex += 1
  ) {
    const sessionId = selectionQueue[queueIndex]
    if (candidateSessionIds !== null && !candidateSessionIds.has(sessionId)) continue
    selectedSessionIds.push(sessionId)
    const childIds = [...childIdsOf(sessionId)].sort(compareBySubtreeThenId)
    for (const childSessionId of childIds) selectionQueue.push(childSessionId)
  }

  const selectedSessionIdSet = new Set(selectedSessionIds)
  const nodes: SessionLineageNode[] = selectedSessionIds.map((sessionId) => {
    const sample = sampleById.get(sessionId)!
    return {
      sessionId,
      parentSessionId: effectiveParentById.get(sessionId) ?? null,
      title: sample.title,
      agent: sample.agent,
      tokens: sample.tokens,
      timeCreated: sample.timeCreated,
      childCount: sample.childCount,
    }
  })

  const edges: SessionLineageEdge[] = []
  for (const sessionId of selectedSessionIds) {
    const parentSessionId = effectiveParentById.get(sessionId) ?? null
    if (parentSessionId !== null && selectedSessionIdSet.has(parentSessionId)) {
      edges.push({ parentSessionId, childSessionId: sessionId })
    }
  }
  edges.sort((leftEdge, rightEdge) => {
    if (leftEdge.parentSessionId !== rightEdge.parentSessionId) {
      return leftEdge.parentSessionId < rightEdge.parentSessionId ? -1 : 1
    }
    return leftEdge.childSessionId < rightEdge.childSessionId ? -1 : 1
  })

  const candidateCount = candidateSessionIds === null ? sampleById.size : candidateSessionIds.size

  return {
    focusSessionId,
    nodes,
    edges,
    stats: {
      totalSessions: sampleById.size,
      graphSessions: selectedSessionIds.length,
      rootCount: rootSessionIds.length,
      childCount: sampleById.size - rootSessionIds.length,
      orphanParentCount,
      selfParentCount,
      cycleCount,
      maxDepth,
    },
    omittedNodeCount: candidateCount - selectedSessionIds.length,
  }
}

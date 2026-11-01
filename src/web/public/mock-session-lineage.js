/**
 * Wave 2B mock 生产者（v0.29.0）：B6 会话血缘。
 *
 * 单独成文件（不改 mock-data.js）：形状严格对齐合同 §5.6 的冻结响应体，
 * 供 data-source.js 的 USE_MOCK 分支消费，离线预览能看到确定性分层树、
 * 折叠「+N 更多」节点、聚焦模式与节点预算截断。
 *
 *   getMockSessionLineage(sessionScopeId, limit) →
 *     GET /api/session-lineage?limit=N[&session=]
 *       { focusSessionId, nodes, edges, stats, omittedNodeCount }
 *
 * 语义对齐后端（src/stats/session-lineage.ts 的 computeSessionLineage）：
 *   - `limit` 是**节点预算**（后端 LINEAGE_NODE_BUDGET=400 /
 *     MAX_LINEAGE_NODE_BUDGET=1000），先夹到 [1, MAX]；
 *   - 选点走一趟 BFS：种子 = 根（子树大小 desc、sessionId asc），子节点同序，
 *     逐一出队即入选，直到预算；
 *   - `sessionScopeId` 命中图内节点 = 聚焦模式：候选集 = 该节点 + 全部祖先 +
 *     全部后代，BFS 被候选集过滤（仍受预算约束）；
 *   - `omittedNodeCount` = 候选集大小 − 入选节点数（后端口径）；stats 是
 *     全表结构性统计，graphSessions 是本次入选数。
 *
 * mock 只物化少量节点当「真库切片」：MOCK_TOTAL_SESSIONS 用真库量级
 * （合同 §5.1 取证值 1213），而入选数受物化规模与节点预算共同约束，故
 * omittedNodeCount 默认即 > 0，让「省略节点」徽标默认可见。
 *
 * 造的数据刻意覆盖：两层主树 + 一个 15 子的宽父（> 组件 MAX_VISIBLE_CHILDREN=12
 * → 组件折叠「+3 更多」）、缺 agent 的节点。全部 id / 标题 / agent 均为中性
 * 假数据，不含真实机器信息。
 */

/** 与后端同一族：节点预算缺省 / 上限（LINEAGE_NODE_BUDGET / MAX_...）。 */
export const MOCK_SESSION_LINEAGE_DEFAULT_LIMIT = 400;
export const MOCK_SESSION_LINEAGE_MAX_LIMIT = 1000;

/** 模拟真库会话总量（合同 §5.1 取证值 1213）；mock 只物化下面这撮节点。 */
const MOCK_TOTAL_SESSIONS = 1_213;

/** 组件侧折叠阈值（MAX_VISIBLE_CHILDREN=12）——这里造一个刚好超过它的宽父。 */
const WIDE_PARENT_CHILD_COUNT = 15;

/**
 * 森林节点规格（id / 父 id / 标题 / agent / tokens / 创建时刻）。
 * childCount 由边反推，避免手写与结构漂移。agent 留空串的那个节点用来
 * 验证「(未知 agent)」占位。
 */
const MOCK_NODE_SPECS = [
  { id: "ses_mock_root_main", parentId: null, title: "主工作区会话", agent: "opencode", tokens: 980_000, timeCreated: 1_762_000_000_000 },
  { id: "ses_mock_api", parentId: "ses_mock_root_main", title: "重构 API 路由", agent: "opencode", tokens: 420_000, timeCreated: 1_762_000_600_000 },
  { id: "ses_mock_docs", parentId: "ses_mock_root_main", title: "补文档", agent: "", tokens: 12_000, timeCreated: 1_762_001_200_000 },
  { id: "ses_mock_build", parentId: "ses_mock_root_main", title: "构建脚本", agent: "build", tokens: 30_000, timeCreated: 1_762_001_800_000 },
  { id: "ses_mock_router_split", parentId: "ses_mock_api", title: "router.ts 拆分", agent: "opencode", tokens: 210_000, timeCreated: 1_762_002_400_000 },
  { id: "ses_mock_router_tests", parentId: "ses_mock_api", title: "router 测试", agent: "opencode", tokens: 150_000, timeCreated: 1_762_003_000_000 },
  { id: "ses_mock_root_scratch", parentId: null, title: "临时探测", agent: "plan", tokens: 66_000, timeCreated: 1_761_900_000_000 },
];

/** 宽父（ses_mock_root_scratch）的 15 个子节点：tokens 递减，便于验证 top-N 截取。 */
function buildWideChildrenSpecs() {
  const wideChildren = [];
  for (let index = 1; index <= WIDE_PARENT_CHILD_COUNT; index += 1) {
    wideChildren.push({
      id: `ses_mock_scratch_${String(index).padStart(2, "0")}`,
      parentId: "ses_mock_root_scratch",
      title: `探测 ${index}`,
      agent: "plan",
      tokens: 1_000 * (WIDE_PARENT_CHILD_COUNT + 1 - index),
      timeCreated: 1_761_900_000_000 + index * 1_000,
    });
  }
  return wideChildren;
}

/** 把所有规格组装成节点 + 边（childCount 由边反推）。 */
function buildForest() {
  const specs = [...MOCK_NODE_SPECS, ...buildWideChildrenSpecs()];
  const edges = [];
  const childCountById = new Map();
  for (const spec of specs) {
    if (spec.parentId === null) continue;
    edges.push({ parentSessionId: spec.parentId, childSessionId: spec.id });
    childCountById.set(spec.parentId, (childCountById.get(spec.parentId) ?? 0) + 1);
  }
  const nodes = specs.map((spec) => ({
    sessionId: spec.id,
    parentSessionId: spec.parentId,
    title: spec.title,
    agent: spec.agent,
    tokens: spec.tokens,
    timeCreated: spec.timeCreated,
    childCount: childCountById.get(spec.id) ?? 0,
  }));
  return { nodes, edges };
}

/** 节点 id → 节点；边 → parentId → 孩子 id 列表。 */
function indexForest(nodes, edges) {
  const nodeById = new Map(nodes.map((node) => [node.sessionId, node]));
  const childIdsByParentId = new Map();
  for (const edge of edges) {
    if (!childIdsByParentId.has(edge.parentSessionId)) childIdsByParentId.set(edge.parentSessionId, []);
    childIdsByParentId.get(edge.parentSessionId).push(edge.childSessionId);
  }
  return { nodeById, childIdsByParentId };
}

/** 无父的节点 id（mock 是干净森林：无自环 / 孤儿）。 */
function rootSessionIds(nodes) {
  return nodes.filter((node) => node.parentSessionId === null).map((node) => node.sessionId);
}

/** 每棵子树的大小（含自身）；后序递归，mock 深度很小。 */
function subtreeSizeById(childIdsByParentId, rootIds) {
  const sizeById = new Map();
  const visit = (sessionId) => {
    if (sizeById.has(sessionId)) return sizeById.get(sessionId);
    let size = 1;
    for (const childSessionId of childIdsByParentId.get(sessionId) ?? []) size += visit(childSessionId);
    sizeById.set(sessionId, size);
    return size;
  };
  for (const rootId of rootIds) visit(rootId);
  return sizeById;
}

/** 与后端同序：子树大小 desc，sessionId asc。 */
function compareBySubtreeThenSessionId(sizeById) {
  return (leftSessionId, rightSessionId) => {
    const sizeDelta = (sizeById.get(rightSessionId) ?? 1) - (sizeById.get(leftSessionId) ?? 1);
    if (sizeDelta !== 0) return sizeDelta;
    return leftSessionId < rightSessionId ? -1 : leftSessionId > rightSessionId ? 1 : 0;
  };
}

/** limit 先夹到 [1, MAX]（同后端 boundedIntParamKey 的夹取口径）。 */
function clampLimit(limit) {
  const numericLimit = Number(limit);
  if (!Number.isFinite(numericLimit) || numericLimit <= 0) return MOCK_SESSION_LINEAGE_DEFAULT_LIMIT;
  return Math.min(Math.floor(numericLimit), MOCK_SESSION_LINEAGE_MAX_LIMIT);
}

/**
 * 一趟 BFS 选点（种子 = 有序根，子节点同序），受可选候选集过滤与节点预算：
 * 高保真复刻后端 computeSessionLineage 的选取循环。
 */
function selectSessionIdsByBudget(nodes, edges, candidateSessionIds, nodeBudget) {
  const { childIdsByParentId } = indexForest(nodes, edges);
  const compare = compareBySubtreeThenSessionId(subtreeSizeById(childIdsByParentId, rootSessionIds(nodes)));
  const selectionQueue = [...rootSessionIds(nodes)].sort(compare);
  const selectedSessionIds = [];
  for (let queueIndex = 0; queueIndex < selectionQueue.length && selectedSessionIds.length < nodeBudget; queueIndex += 1) {
    const sessionId = selectionQueue[queueIndex];
    if (candidateSessionIds !== null && !candidateSessionIds.has(sessionId)) continue;
    selectedSessionIds.push(sessionId);
    for (const childSessionId of [...(childIdsByParentId.get(sessionId) ?? [])].sort(compare)) {
      selectionQueue.push(childSessionId);
    }
  }
  return selectedSessionIds;
}

/** 聚焦候选集 = 该节点 + 全部祖先 + 全部后代。 */
function focusCandidateSessionIds(nodes, edges, focusSessionId) {
  const { nodeById, childIdsByParentId } = indexForest(nodes, edges);
  const candidateSessionIds = new Set([focusSessionId]);
  let ancestorSessionId = nodeById.get(focusSessionId).parentSessionId;
  while (ancestorSessionId !== null && nodeById.has(ancestorSessionId) && !candidateSessionIds.has(ancestorSessionId)) {
    candidateSessionIds.add(ancestorSessionId);
    ancestorSessionId = nodeById.get(ancestorSessionId).parentSessionId;
  }
  const descendantQueue = [focusSessionId];
  for (let queueIndex = 0; queueIndex < descendantQueue.length; queueIndex += 1) {
    for (const childSessionId of childIdsByParentId.get(descendantQueue[queueIndex]) ?? []) {
      if (!candidateSessionIds.has(childSessionId)) {
        candidateSessionIds.add(childSessionId);
        descendantQueue.push(childSessionId);
      }
    }
  }
  return candidateSessionIds;
}

/** 由入选 id 物化 { nodes, edges }；边按 parentId asc、childId asc（同后端）。 */
function materializeSelection(nodeById, selectedSessionIds) {
  const selectedIdSet = new Set(selectedSessionIds);
  const nodes = selectedSessionIds.map((sessionId) => nodeById.get(sessionId));
  const edges = [];
  for (const sessionId of selectedSessionIds) {
    const parentSessionId = nodeById.get(sessionId).parentSessionId;
    if (parentSessionId !== null && selectedIdSet.has(parentSessionId)) {
      edges.push({ parentSessionId, childSessionId: sessionId });
    }
  }
  edges.sort((leftEdge, rightEdge) => {
    if (leftEdge.parentSessionId !== rightEdge.parentSessionId) {
      return leftEdge.parentSessionId < rightEdge.parentSessionId ? -1 : 1;
    }
    return leftEdge.childSessionId < rightEdge.childSessionId ? -1 : 1;
  });
  return { nodes, edges };
}

/**
 * stats = 全表结构性统计（totalSessions 取真库量级；rootCount / maxDepth 由
 * 物化切片近似），graphSessions 是本次入选数（= nodes.length）。
 */
function summarize(allNodes, allEdges, graphSessionCount) {
  const { childIdsByParentId } = indexForest(allNodes, allEdges);
  const roots = rootSessionIds(allNodes);
  let maxDepth = 0;
  const pending = roots.map((sessionId) => ({ sessionId, depth: 0 }));
  for (let index = 0; index < pending.length; index += 1) {
    const { sessionId, depth } = pending[index];
    maxDepth = Math.max(maxDepth, depth);
    for (const childSessionId of childIdsByParentId.get(sessionId) ?? []) {
      pending.push({ sessionId: childSessionId, depth: depth + 1 });
    }
  }
  return {
    totalSessions: MOCK_TOTAL_SESSIONS,
    graphSessions: graphSessionCount,
    rootCount: roots.length,
    childCount: MOCK_TOTAL_SESSIONS - roots.length,
    orphanParentCount: 0,
    selfParentCount: 0,
    cycleCount: 0,
    maxDepth,
  };
}

/**
 * GET /api/session-lineage 的 mock 响应体。sessionScopeId 命中图内节点时返回
 * 聚焦子图并回填 focusSessionId；否则整片森林按节点预算截取，统计
 * omittedNodeCount（候选集大小 − 入选数，后端口径）。
 */
export function getMockSessionLineage(sessionScopeId = null, limit = MOCK_SESSION_LINEAGE_DEFAULT_LIMIT) {
  const forest = buildForest();
  const { nodeById } = indexForest(forest.nodes, forest.edges);
  const nodeBudget = clampLimit(limit);
  const isFocused = typeof sessionScopeId === "string"
    && sessionScopeId !== ""
    && nodeById.has(sessionScopeId);

  const candidateSessionIds = isFocused
    ? focusCandidateSessionIds(forest.nodes, forest.edges, sessionScopeId)
    : null;
  const selectedSessionIds = selectSessionIdsByBudget(forest.nodes, forest.edges, candidateSessionIds, nodeBudget);
  const { nodes, edges } = materializeSelection(nodeById, selectedSessionIds);

  // 候选集大小：非聚焦 = 全表（MOCK_TOTAL_SESSIONS）；聚焦 = 该节点的祖先+后代闭包。
  const candidateCount = candidateSessionIds === null ? MOCK_TOTAL_SESSIONS : candidateSessionIds.size;

  return {
    focusSessionId: isFocused ? sessionScopeId : null,
    nodes,
    edges,
    stats: summarize(forest.nodes, forest.edges, nodes.length),
    omittedNodeCount: candidateCount - nodes.length,
  };
}

/**
 * 会话血缘图（v0.29.0，Wave 2B / B6）。
 *
 * 数据 = GET /api/session-lineage?limit=N[&session=]（合同 §5.6 冻结响应体）：
 *   {
 *     focusSessionId: string | null,
 *     nodes: [{ sessionId, parentSessionId, title, agent, tokens,
 *               timeCreated, childCount }],
 *     edges: [{ parentSessionId, childSessionId }],
 *     stats: { totalSessions, graphSessions, rootCount, childCount,
 *              orphanParentCount, selfParentCount, cycleCount, maxDepth },
 *     omittedNodeCount: number,
 *   }
 *
 * 纯渲染函数：不 fetch、不碰全局 state；数据与回调由接线 lane（app.js）传入。
 * options = { onFocusSession(parentSessionId), onExitFocus() } 均可选。
 *
 * 布局：手写 SVG **确定性分层树**（父上子下，零依赖，非力导向）。节点盒
 * NODE_WIDTH×NODE_HEIGHT，逐层按 ROW_GAP 纵向留间距；每个父的孩子按
 * tokens desc、sessionId asc 排序，叶子按先序依次占列，父居中于其首尾
 * 孩子之上——同一载荷必然得到同一张图（无随机、无计时器）。
 *
 * 单父可见子节点上限 MAX_VISIBLE_CHILDREN：超出时只画 tokens 最大的前
 * MAX_VISIBLE_CHILDREN 个，尾部补一个「+N 更多」节点；点它进入该父的
 * 聚焦模式（onFocusSession 回调交给 app.js 重新取数）。
 *
 * 颜色一律经 cssVar() 读**既有 CSS 变量**并内联到 SVG 属性：浏览器不会
 * 自动重着色内联属性，故接手方必须在 onSchemeChange 里按缓存重渲（参考
 * hour-heatmap 与 app.js 的 KPI 行）。
 *
 * 节点点击走既有 replay 路由 #/session/:id（用 <a> 包裹，sessionId 走
 * encodeURIComponent）；所有外部字符串过 escapeHtml。
 */

import { escapeHtml, formatCount, formatTokens, shortenSessionId } from "../format.js";
import { renderMissingValue, MISSING_REASON } from "../precision.js";
import { cssVar } from "../theme.js";
import { renderEmpty } from "./state-views.js";

/** 节点盒与间距（确定性分层树的布局常量）。 */
const NODE_WIDTH = 140;
const NODE_HEIGHT = 36;
const COLUMN_GAP = 22;
const ROW_GAP = 34;
const CANVAS_PADDING = 16;
const NODE_PADDING_X = 9;
/** 单父可见子节点上限；超出部分折叠进一个「+N 更多」节点。 */
const MAX_VISIBLE_CHILDREN = 12;
/** 节点盒里标题的截断字数（完整标题走 <title> 与 aria-label）。 */
const TITLE_MAX_CHARS = 12;
const UNKNOWN_AGENT_LABEL = "(未知 agent)";
const UNTITLED_SESSION_LABEL = "（无标题会话）";

/**
 * 渲染会话血缘图。
 * @param {HTMLElement} container #session-lineage 挂载点
 * @param {object|null} payload 契约对象（见文件头）
 * @param {{ onFocusSession?: (parentSessionId: string) => void, onExitFocus?: () => void }} [options]
 * @returns {() => void} cleanup：移除容器上的事件委托
 */
export function renderSessionLineageGraph(container, payload, options = {}) {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    renderEmpty(container, "还没有血缘数据", "数据库里没有可展示的会话父子关系");
    return buildNoopCleanup();
  }

  const nodeById = new Map();
  for (const node of readNodes(payload.nodes)) nodeById.set(node.sessionId, node);
  const edges = readEdges(payload.edges, nodeById);

  // 合同：空（无任何父子边）→ renderEmpty（单节点无父子关系同样落这里）。
  if (nodeById.size === 0 || edges.length === 0) {
    renderEmpty(container, "还没有父子血缘", "这段范围内没有会话父子关系（parent_id 全空）");
    return buildNoopCleanup();
  }

  const layout = buildLayout(nodeById, edges);
  const palette = readPalette();
  const focusSessionId = readFocusSessionId(payload.focusSessionId);

  container.innerHTML = `
    <div class="session-lineage">
      ${buildHeadHtml(payload.stats, payload.omittedNodeCount)}
      ${focusSessionId === null ? "" : buildFocusBarHtml(focusSessionId)}
      <div class="session-lineage-scroll">
        ${buildSvgHtml(layout, palette)}
      </div>
      <p class="session-lineage-note">父子血缘按 parent_id 推导（无 fork 维度）· 点节点进入该会话回放 · 点「+N 更多」聚焦该父会话</p>
    </div>`;

  return bindLineageInteractions(container, options);
}

/* ---------------- 数据整形 ---------------- */

/** 节点清洗：sessionId 非空串才收；parentSessionId 归一为字符串或 null。 */
function readNodes(rawNodes) {
  const cleanedNodes = [];
  for (const rawNode of Array.isArray(rawNodes) ? rawNodes : []) {
    if (rawNode === null || typeof rawNode !== "object") continue;
    const sessionId = typeof rawNode.sessionId === "string" ? rawNode.sessionId : "";
    if (sessionId === "") continue;
    cleanedNodes.push({
      sessionId,
      parentSessionId: typeof rawNode.parentSessionId === "string" && rawNode.parentSessionId !== ""
        ? rawNode.parentSessionId
        : null,
      title: typeof rawNode.title === "string" ? rawNode.title : "",
      agent: typeof rawNode.agent === "string" ? rawNode.agent : "",
      tokens: nonNegativeNumber(rawNode.tokens),
      timeCreated: nonNegativeNumber(rawNode.timeCreated),
      childCount: nonNegativeNumber(rawNode.childCount),
    });
  }
  return cleanedNodes;
}

/**
 * 边清洗：两端都必须在节点集里（悬空边丢弃）、不许自环。自环 / 悬空边由
 * 后端统计进 selfParentCount / orphanParentCount，这里只保证渲染不出现
 * 画不出的连线。
 */
function readEdges(rawEdges, nodeById) {
  const cleanedEdges = [];
  for (const rawEdge of Array.isArray(rawEdges) ? rawEdges : []) {
    if (rawEdge === null || typeof rawEdge !== "object") continue;
    const parentSessionId = typeof rawEdge.parentSessionId === "string" ? rawEdge.parentSessionId : "";
    const childSessionId = typeof rawEdge.childSessionId === "string" ? rawEdge.childSessionId : "";
    if (parentSessionId === "" || childSessionId === "") continue;
    if (parentSessionId === childSessionId) continue;
    if (!nodeById.has(parentSessionId) || !nodeById.has(childSessionId)) continue;
    cleanedEdges.push({ parentSessionId, childSessionId });
  }
  return cleanedEdges;
}

function readFocusSessionId(rawFocusSessionId) {
  return typeof rawFocusSessionId === "string" && rawFocusSessionId !== "" ? rawFocusSessionId : null;
}

function nonNegativeNumber(value) {
  const numericValue = Number(value);
  return Number.isFinite(numericValue) && numericValue > 0 ? numericValue : 0;
}

/** 孩子 / 根的确定性排序：tokens desc，并列按 sessionId asc。 */
function compareByTokensThenSessionId(leftNode, rightNode) {
  return rightNode.tokens - leftNode.tokens
    || (leftNode.sessionId < rightNode.sessionId ? -1 : leftNode.sessionId > rightNode.sessionId ? 1 : 0);
}

/* ---------------- 布局（确定性分层树） ---------------- */

/**
 * 计算分层布局：返回落位的 entry 列表（会话节点 + 折叠节点）与画布尺寸。
 * 每个 entry 带 depth / column；父的 column = 其首尾可见孩子 column 的中点。
 */
function buildLayout(nodeById, edges) {
  const childIds = new Set();
  const childrenByParentId = new Map();
  for (const { parentSessionId, childSessionId } of edges) {
    childIds.add(childSessionId);
    if (!childrenByParentId.has(parentSessionId)) childrenByParentId.set(parentSessionId, []);
    childrenByParentId.get(parentSessionId).push(nodeById.get(childSessionId));
  }
  for (const children of childrenByParentId.values()) children.sort(compareByTokensThenSessionId);

  const rootNodes = [...nodeById.values()]
    .filter((node) => !childIds.has(node.sessionId))
    .sort(compareByTokensThenSessionId);

  // 一个父的可见孩子 entry：前 MAX_VISIBLE_CHILDREN 个真节点 + 可选折叠节点。
  const visibleChildEntries = (parentKey) => {
    const allChildren = childrenByParentId.get(parentKey) ?? [];
    const entries = allChildren
      .slice(0, MAX_VISIBLE_CHILDREN)
      .map((node) => ({ key: node.sessionId, kind: "session", node }));
    const omittedCount = allChildren.length - entries.length;
    if (omittedCount > 0) {
      entries.push({ key: `more:${parentKey}`, kind: "more", parentId: parentKey, omittedCount, node: null });
    }
    return entries;
  };

  const entries = [];
  const entryByKey = new Map();
  let nextLeafColumn = 0;

  const placeEntry = (entry, depth) => {
    const placed = {
      key: entry.key,
      kind: entry.kind,
      node: entry.node ?? null,
      parentId: entry.parentId ?? null,
      omittedCount: entry.omittedCount ?? 0,
      depth,
      column: 0,
    };
    entryByKey.set(entry.key, placed);
    entries.push(placed);

    const childEntries = entry.kind === "session" ? visibleChildEntries(entry.key) : [];
    const unplacedChildren = childEntries.filter((child) => !entryByKey.has(child.key));
    if (unplacedChildren.length === 0) {
      placed.column = nextLeafColumn;
      nextLeafColumn += 1;
      return placed.column;
    }
    const childColumns = unplacedChildren.map((child) => placeEntry(child, depth + 1));
    placed.column = (childColumns[0] + childColumns[childColumns.length - 1]) / 2;
    return placed.column;
  };

  for (const rootNode of rootNodes) {
    if (entryByKey.has(rootNode.sessionId)) continue;
    placeEntry({ key: rootNode.sessionId, kind: "session", node: rootNode }, 0);
  }

  // 从根沿**完整**孩子表可达的节点（不按 MAX_VISIBLE_CHILDREN 截断）。折叠掉的
  // 孩子仍在可达集里——它们是被有意隐藏的，不该被下面的兜底循环重新捞成根。
  const reachableSessionIds = new Set();
  const reachPending = rootNodes.map((node) => node.sessionId);
  while (reachPending.length > 0) {
    const sessionId = reachPending.shift();
    if (reachableSessionIds.has(sessionId)) continue;
    reachableSessionIds.add(sessionId);
    for (const child of childrenByParentId.get(sessionId) ?? []) reachPending.push(child.sessionId);
  }

  // 防御：环等「从任何根都走不到」的节点各自当根补画（真库由后端保证无环，
  // 这里只为「绝不无限递归、绝不丢节点」兜底）。可达但被折叠的节点不在此列
  // ——它们由父节点的「+N 更多」代表，保持隐藏。
  for (const node of nodeById.values()) {
    if (!entryByKey.has(node.sessionId) && !reachableSessionIds.has(node.sessionId)) {
      placeEntry({ key: node.sessionId, kind: "session", node }, 0);
    }
  }

  const maxDepth = entries.reduce((max, entry) => Math.max(max, entry.depth), 0);
  const maxColumn = entries.reduce((max, entry) => Math.max(max, entry.column), 0);
  return { entries, entryByKey, maxDepth, maxColumn };
}

/** column → 节点左上角 x；depth → 节点左上角 y。 */
function columnToX(column) {
  return CANVAS_PADDING + column * (NODE_WIDTH + COLUMN_GAP);
}
function depthToY(depth) {
  return CANVAS_PADDING + depth * (NODE_HEIGHT + ROW_GAP);
}
function roundTo2(value) {
  return Math.round(value * 100) / 100;
}

/* ---------------- SVG 组装 ---------------- */

/** 按当前主题读既有 CSS 变量（内联到 SVG；onSchemeChange 时由接手方重渲）。 */
function readPalette() {
  return {
    nodeFill: cssVar("--panel-2"),
    nodeStroke: cssVar("--border"),
    rootStroke: cssVar("--accent"),
    moreStroke: cssVar("--amber"),
    edge: cssVar("--grid-line"),
    title: cssVar("--text"),
    meta: cssVar("--text-dim"),
  };
}

function buildSvgHtml(layout, palette) {
  const { entries, entryByKey, maxDepth, maxColumn } = layout;
  const svgWidth = CANVAS_PADDING * 2 + (maxColumn + 1) * NODE_WIDTH + maxColumn * COLUMN_GAP;
  const svgHeight = CANVAS_PADDING * 2 + (maxDepth + 1) * NODE_HEIGHT + maxDepth * ROW_GAP;

  const edgeHtml = [];
  const nodeHtml = [];
  for (const entry of entries) {
    if (entry.kind === "session") {
      nodeHtml.push(buildSessionNodeHtml(entry, palette));
      const parentEntry = entry.node.parentSessionId === null
        ? undefined
        : entryByKey.get(entry.node.parentSessionId);
      if (parentEntry !== undefined && parentEntry.kind === "session") {
        edgeHtml.push(buildEdgeHtml(parentEntry, entry, palette.edge));
      }
    } else {
      nodeHtml.push(buildMoreNodeHtml(entry, palette));
    }
  }

  return `
    <svg class="session-lineage-svg" viewBox="0 0 ${roundTo2(svgWidth)} ${roundTo2(svgHeight)}" role="img"
         aria-label="会话血缘分层树：父上子下，共 ${layout.entries.filter((entry) => entry.kind === "session").length} 个节点">
      <g class="session-lineage-edges">${edgeHtml.join("")}</g>
      <g class="session-lineage-nodes">${nodeHtml.join("")}</g>
    </svg>`;
}

/** 父盒底中点 → 孩子盒顶中点的正交折线。 */
function buildEdgeHtml(parentEntry, childEntry, edgeColor) {
  const parentX = columnToX(parentEntry.column) + NODE_WIDTH / 2;
  const parentY = depthToY(parentEntry.depth) + NODE_HEIGHT;
  const childX = columnToX(childEntry.column) + NODE_WIDTH / 2;
  const childY = depthToY(childEntry.depth);
  const midY = (parentY + childY) / 2;
  return `<path class="lineage-edge" d="M${roundTo2(parentX)},${roundTo2(parentY)} V${roundTo2(midY)} H${roundTo2(childX)} V${roundTo2(childY)}" fill="none" stroke="${edgeColor}" stroke-width="1"/>`;
}

/** 会话节点：<a> 包整盒 → #/session/:id；标题截断、完整值进 <title> 与 aria-label。 */
function buildSessionNodeHtml(entry, palette) {
  const node = entry.node;
  const x = columnToX(entry.column);
  const y = depthToY(entry.depth);
  const isRoot = node.parentSessionId === null;
  const agentText = agentLabel(node.agent);
  const fullTitle = node.title === "" ? UNTITLED_SESSION_LABEL : node.title;
  const metaText = `${agentText} · ${formatTokens(node.tokens)}`;
  const description = `${fullTitle} · ${agentText} · ${formatTokens(node.tokens)} tokens`;

  return `
      <a class="lineage-node" href="#/session/${encodeURIComponent(node.sessionId)}" aria-label="${escapeHtml(description)}">
        <title>${escapeHtml(description)}</title>
        <rect class="lineage-node-box${isRoot ? " lineage-node-box-root" : ""}" x="${roundTo2(x)}" y="${roundTo2(y)}" width="${NODE_WIDTH}" height="${NODE_HEIGHT}" rx="8" fill="${palette.nodeFill}" stroke="${isRoot ? palette.rootStroke : palette.nodeStroke}" stroke-width="${isRoot ? 1.6 : 1}"/>
        <text class="lineage-node-title" x="${roundTo2(x + NODE_PADDING_X)}" y="${roundTo2(y + 15)}" fill="${palette.title}" font-size="10.5">${escapeHtml(truncateTitle(fullTitle))}</text>
        <text class="lineage-node-meta" x="${roundTo2(x + NODE_PADDING_X)}" y="${roundTo2(y + 29)}" fill="${palette.meta}" font-size="9">${escapeHtml(metaText)}</text>
      </a>`;
}

/** 「+N 更多」折叠节点：虚框，点击进入该父的聚焦模式。 */
function buildMoreNodeHtml(entry, palette) {
  const x = columnToX(entry.column);
  const y = depthToY(entry.depth);
  const omittedLabel = `+${formatCount(entry.omittedCount)} 更多`;
  return `
      <g class="lineage-more" data-focus-session-id="${escapeHtml(entry.parentId)}" role="button" tabindex="0" aria-label="聚焦该父会话：还有 ${entry.omittedCount} 个子节点未显示">
        <rect class="lineage-node-box lineage-node-box-more" x="${roundTo2(x)}" y="${roundTo2(y)}" width="${NODE_WIDTH}" height="${NODE_HEIGHT}" rx="8" fill="${palette.nodeFill}" stroke="${palette.moreStroke}" stroke-width="1" stroke-dasharray="4 3"/>
        <text class="lineage-node-more-label" x="${roundTo2(x + NODE_WIDTH / 2)}" y="${roundTo2(y + NODE_HEIGHT / 2 + 4)}" text-anchor="middle" fill="${palette.moreStroke}" font-size="11">${escapeHtml(omittedLabel)}</text>
      </g>`;
}

/* ---------------- 顶部小字 / 聚焦条 ---------------- */

function buildHeadHtml(stats, rawOmittedNodeCount) {
  const rawStats = stats !== null && typeof stats === "object" ? stats : {};
  const omittedNodeCount = nonNegativeNumber(rawOmittedNodeCount);
  return `
      <div class="session-lineage-head">
        <span>共 <b class="num">${countHtml(rawStats.totalSessions)}</b> 会话 · 图中 <b class="num">${countHtml(rawStats.graphSessions)}</b> 节点 · 最大深度 <b class="num">${countHtml(rawStats.maxDepth)}</b> 层 · 根 <b class="num">${countHtml(rawStats.rootCount)}</b></span>
        <span class="session-lineage-badges">${buildBadges(rawStats, omittedNodeCount)}</span>
      </div>`;
}

/** 只把「非零」的异常 / 截断计数做成徽标，零值不占位。 */
function buildBadges(rawStats, omittedNodeCount) {
  const badges = [];
  const pushBadge = (count, label, title) => {
    const numericCount = nonNegativeNumber(count);
    if (numericCount > 0) {
      badges.push(`<span class="session-lineage-badge" title="${escapeHtml(title)}">${label} ${formatCount(numericCount)}</span>`);
    }
  };
  pushBadge(omittedNodeCount, "省略节点", "超出后端节点预算，图上未全部绘制");
  pushBadge(rawStats.cycleCount, "断环", "检测到父子环，已在首个重复访问处断开");
  pushBadge(rawStats.selfParentCount, "自父", "会话的 parent_id 指向自身，已强制为根");
  pushBadge(rawStats.orphanParentCount, "孤儿", "parent_id 指向不存在的会话，已保留节点丢弃边");
  return badges.join("");
}

function buildFocusBarHtml(focusSessionId) {
  return `
      <div class="session-lineage-focus">
        <span class="session-lineage-focus-chip" title="${escapeHtml(focusSessionId)}">聚焦模式 · <span class="num">${escapeHtml(shortenSessionId(focusSessionId))}</span></span>
        <button type="button" class="session-lineage-exit" data-lineage-exit-focus>退出聚焦</button>
      </div>`;
}

function countHtml(value) {
  const numericValue = Number(value);
  return Number.isFinite(numericValue) && numericValue >= 0
    ? formatCount(numericValue)
    : renderMissingValue(MISSING_REASON.notRecorded);
}

/* ---------------- 文案 / 工具 ---------------- */

/** 缺 agent（真库 38 个 NULL / 空）→ 中性占位。 */
function agentLabel(agent) {
  return typeof agent === "string" && agent.trim() !== "" ? agent : UNKNOWN_AGENT_LABEL;
}

/** 标题截断到 TITLE_MAX_CHARS 字（先截断原始串再转义，避免截断转义实体）。 */
function truncateTitle(title) {
  return title.length > TITLE_MAX_CHARS ? title.slice(0, TITLE_MAX_CHARS - 1) + "…" : title;
}

/* ---------------- 事件委托 + cleanup ---------------- */

/**
 * 容器级事件委托：点「+N 更多」→ onFocusSession(父 id)；点「退出聚焦」→
 * onExitFocus()。会话节点走 <a href> 原生跳转，不需要 JS 监听。返回 cleanup
 * 精确摘掉这两个监听。
 */
function bindLineageInteractions(container, options) {
  const activateFocusElement = (focusElement) => {
    const parentSessionId = focusElement.getAttribute("data-focus-session-id");
    if (parentSessionId !== null && parentSessionId !== "" && typeof options.onFocusSession === "function") {
      options.onFocusSession(parentSessionId);
    }
  };

  const handleClick = (event) => {
    const target = event.target;
    if (target === null || typeof target.closest !== "function") return;
    const focusElement = target.closest("[data-focus-session-id]");
    if (focusElement !== null) {
      activateFocusElement(focusElement);
      return;
    }
    if (target.closest("[data-lineage-exit-focus]") !== null && typeof options.onExitFocus === "function") {
      options.onExitFocus();
    }
  };

  const handleKeydown = (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    const target = event.target;
    if (target === null || typeof target.closest !== "function") return;
    const focusElement = target.closest("[data-focus-session-id]");
    if (focusElement === null) return;
    event.preventDefault?.();
    activateFocusElement(focusElement);
  };

  container.addEventListener("click", handleClick);
  container.addEventListener("keydown", handleKeydown);
  return () => {
    container.removeEventListener("click", handleClick);
    container.removeEventListener("keydown", handleKeydown);
  };
}

function buildNoopCleanup() {
  return () => {};
}

/**
 * 会话内搜索（v0.10.0）：回放时间线的页内查找栏。
 *
 * 触发时机：**输入即搜 + 防抖**（默认 200ms，可注入便于测试）。数据全量
 * 在内存（fetchSessionMessages 一次性返回），逐键搜索只做预计算 haystack
 * 的 includes，无需回车也不发请求；防抖合并连续击键，避免每个字符都
 * 触发一次全量扫描 + DOM 高亮重排。
 *
 * 命中模型（契约钉死为**节点级**）：命中单位 = 消息节点（一节点一处），
 * 高亮 = replay-node.replay-hit（所有命中）+ .replay-hit-current（当前
 * 导航位，更醒目），不做正文文本级 <mark>——正文一律 textContent 写入，
 * 文本级要重写渲染管线、自担转义风险，超出本里程碑。
 *
 * 分页区命中：计数与导航基于 buildReplaySearchIndex 的全量视图（独立于
 * 可见区，>200 条外的命中也计数）；导航到未渲染区的命中时驱动
 * paginationController.appendNextChunk() 连续追加到目标条再定位。
 * 「加载更多」手动追加后经 syncAfterAppend() 给新节点补高亮。
 *
 * 搜索范围 = 渲染口径（user 正文 / assistant text / reasoning / tool
 * name / tool input / tool output），文本视图与渲染提取共用 replay-message-text.js
 * 单点——搜得到的必然渲染得出来。
 *
 * 退出即复原：空串/空白输入（或 Escape）清全部高亮、隐计数。搜索态全部
 * 存在本闭包——每次 renderSessionReplay 重建本组件，切换会话/退出回放
 * 自然清零（renderSequence 守卫下无残留）。
 */

import { buildReplaySearchIndex } from "./replay-message-text.js";

export const REPLAY_SEARCH_DEBOUNCE_MS = 200;

/**
 * 构建搜索栏。依赖注入：
 * - paginationController：renderTimeline 的返回值（需要 renderedCount /
 *   nodeAt / appendNextChunk / hasMore —— v0.10.0 扩展）。
 * - messageRecords：与 renderTimeline 完全相同的消息数组（index 对齐的
 *   前提，见 replay-message-text.js 对齐不变量）。
 * - debounceMs：输入防抖，默认生产值 200ms；测试注入小值。
 * 返回 { element, syncAfterAppend }：
 * - element：搜索栏 DOM（input + 上一处/计数/下一处），挂到时间线
 *   panel-head。
 * - syncAfterAppend()：加载更多追加后调用，给新渲染节点补 .replay-hit。
 */
export function buildReplaySearchBar({
  paginationController,
  messageRecords,
  debounceMs = REPLAY_SEARCH_DEBOUNCE_MS,
}) {
  const searchIndex = buildReplaySearchIndex(messageRecords);
  let activeNeedle = "";
  let hitIndexes = [];
  let currentHitPosition = -1;
  let highlightedNodeIndexes = [];
  let currentHighlightedNodeIndex = -1;
  let debounceTimer = null;

  const searchBar = document.createElement("div");
  searchBar.className = "replay-search-bar";
  searchBar.role = "search";

  const searchInput = document.createElement("input");
  searchInput.type = "search";
  searchInput.className = "replay-search-input";
  searchInput.placeholder = "在会话中搜索…（不区分大小写）";
  searchInput.ariaLabel = "搜索会话消息";
  searchInput.title = "搜索范围：正文 / 思考过程 / 工具名、入参与输出 · Enter 下一处 · Shift+Enter 上一处 · Esc 退出";

  const previousHitButton = buildNavButton("‹", "上一处（Shift+Enter）", -1);
  const nextHitButton = buildNavButton("›", "下一处（Enter）", 1);
  const hitCountLabel = document.createElement("span");
  hitCountLabel.className = "replay-search-count num";
  hitCountLabel.textContent = "";

  searchBar.appendChild(searchInput);
  searchBar.appendChild(previousHitButton);
  searchBar.appendChild(hitCountLabel);
  searchBar.appendChild(nextHitButton);

  function buildNavButton(buttonLabel, buttonTitle, stepDelta) {
    const navButton = document.createElement("button");
    navButton.type = "button";
    navButton.className = "replay-search-nav";
    navButton.textContent = buttonLabel;
    navButton.title = buttonTitle;
    navButton.addEventListener("click", () => {
      stepCurrentHit(stepDelta);
    });
    return navButton;
  }

  searchInput.addEventListener("input", () => {
    if (debounceTimer !== null) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      runSearch(searchInput.value);
    }, debounceMs);
  });
  searchInput.addEventListener("keydown", (keyEvent) => {
    if (keyEvent === null || keyEvent === undefined) return;
    if (keyEvent.key === "Enter") stepCurrentHit(keyEvent.shiftKey ? -1 : 1);
    else if (keyEvent.key === "Escape") {
      searchInput.value = "";
      runSearch("");
    }
  });

  /** 清掉此前挂过类的节点（只记 rendered 的，节点不回收、索引稳定）。 */
  function clearRenderedHighlights() {
    for (const nodeIndex of highlightedNodeIndexes) {
      const nodeElement = paginationController.nodeAt(nodeIndex);
      if (nodeElement !== null) nodeElement.classList.remove("replay-hit", "replay-hit-current");
    }
    highlightedNodeIndexes = [];
    currentHighlightedNodeIndex = -1;
  }

  /** 给已渲染区间内的全部命中节点挂 .replay-hit（记索引便于精确清除）。 */
  function paintRenderedHitNodes() {
    highlightedNodeIndexes = [];
    for (const hitIndex of hitIndexes) {
      if (hitIndex >= paginationController.renderedCount) break;
      const nodeElement = paginationController.nodeAt(hitIndex);
      if (nodeElement !== null) {
        nodeElement.classList.add("replay-hit");
        highlightedNodeIndexes.push(hitIndex);
      }
    }
  }

  /** 当前导航位换标：摘旧挂新（新节点可能刚由导航追加渲染出来）。 */
  function setCurrentHitMarker() {
    if (currentHighlightedNodeIndex !== -1) {
      const previousNode = paginationController.nodeAt(currentHighlightedNodeIndex);
      if (previousNode !== null) previousNode.classList.remove("replay-hit-current");
      currentHighlightedNodeIndex = -1;
    }
    if (currentHitPosition === -1) return;
    const targetIndex = hitIndexes[currentHitPosition];
    const targetNode = paginationController.nodeAt(targetIndex);
    if (targetNode !== null) {
      // 当前位本身就是一个命中：导航把目标从分页区追加渲染出来时，
      // 它没机会经过 paintRenderedHitNodes，两类高亮在此一并补齐。
      targetNode.classList.add("replay-hit", "replay-hit-current");
      if (!highlightedNodeIndexes.includes(targetIndex)) highlightedNodeIndexes.push(targetIndex);
      currentHighlightedNodeIndex = targetIndex;
    }
  }

  /** 定位到当前命中：未渲染区连续 appendNextChunk 到目标条，再滚动。 */
  function navigateToCurrentHit() {
    const targetIndex = hitIndexes[currentHitPosition];
    const neededAppend = paginationController.hasMore && paginationController.renderedCount <= targetIndex;
    while (paginationController.hasMore && paginationController.renderedCount <= targetIndex) {
      paginationController.appendNextChunk();
    }
    // 导航驱动追加的新区间里，其余命中也一并挂 .replay-hit（与「加载更多」
    // 的 syncAfterAppend 同语义——高亮不因到达路径不同而不同）。
    if (neededAppend) syncAfterAppend();
    setCurrentHitMarker();
    const targetNode = paginationController.nodeAt(targetIndex);
    if (targetNode !== null && typeof targetNode.scrollIntoView === "function") {
      targetNode.scrollIntoView({ block: "center" });
    }
  }

  function updateHitCountLabel() {
    if (activeNeedle === "") {
      hitCountLabel.textContent = "";
      return;
    }
    hitCountLabel.textContent = hitIndexes.length === 0
      ? "无命中"
      : `${hitIndexes.length} 处命中 · 第 ${currentHitPosition + 1} 处`;
  }

  function runSearch(rawQuery) {
    clearRenderedHighlights();
    const trimmedQuery = String(rawQuery ?? "").trim();
    if (trimmedQuery === "") {
      activeNeedle = "";
      hitIndexes = [];
      currentHitPosition = -1;
      updateHitCountLabel();
      return;
    }
    activeNeedle = trimmedQuery.toLowerCase();
    hitIndexes = [];
    for (let recordIndex = 0; recordIndex < searchIndex.length; recordIndex += 1) {
      if (searchIndex[recordIndex].haystack.includes(activeNeedle)) hitIndexes.push(recordIndex);
    }
    currentHitPosition = hitIndexes.length > 0 ? 0 : -1;
    paintRenderedHitNodes();
    if (currentHitPosition >= 0) navigateToCurrentHit();
    updateHitCountLabel();
  }

  function stepCurrentHit(stepDelta) {
    if (hitIndexes.length === 0) return;
    const hitTotal = hitIndexes.length;
    currentHitPosition = (currentHitPosition + stepDelta + hitTotal) % hitTotal;
    navigateToCurrentHit();
    updateHitCountLabel();
  }

  /**
   * 「加载更多」追加后调用：给新渲染的命中节点补 .replay-hit（计数基于
   * 全量索引，追加不改变它）；当前位标记已在的节点上，无需重挂。
   */
  function syncAfterAppend() {
    if (activeNeedle === "") return;
    for (const hitIndex of hitIndexes) {
      if (hitIndex < paginationController.renderedCount
        && !highlightedNodeIndexes.includes(hitIndex)) {
        const nodeElement = paginationController.nodeAt(hitIndex);
        if (nodeElement !== null) {
          nodeElement.classList.add("replay-hit");
          highlightedNodeIndexes.push(hitIndex);
        }
      }
    }
  }

  return { element: searchBar, syncAfterAppend };
}

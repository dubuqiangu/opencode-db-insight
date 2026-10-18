/**
 * 子代理开销占比卡（v0.21.0）：一张双段占比条 + 大号百分比 + 一句话
 * 概括（多少会话是子代理、子代消耗了多少 tokens）+ 直接子代消耗
 * TOP5 父会话清单（仅汇总各父会话的直接子代，不含孙代）。
 *
 * 数据 = 接线 lane 传入的 payload：
 *   {
 *     totalSessions, childSessionCount, rootSessionCount,
 *     childTokens, rootTokens, totalTokens, childShare,   // childShare ∈ [0,1]
 *     topChildTrees: [{ sessionId, title, agent, tokens, childSessionCount }]
 *   }
 * 纯渲染：不 fetch、不碰全局 state；payload === null → 「数据不可达」降级块
 * （同 distribution-card 的 renderUnreachableState 语言）。
 *
 * 双主题零新增硬编码色值：子代段 = --accent（叙事主角），根段 = --blue。
 * topChildTrees 每行标题与「→ 回放」都是 <a href="#/session/:id">，走既有
 * 回放路由，接线 lane 无需额外逻辑。sessionId / title / agent 均为外部数据，
 * 进 href 前 encodeURIComponent、进文本前 escapeHtml。
 */

import { formatTokens, formatCount, formatPercent, escapeHtml } from "../format.js";
import { renderEmpty } from "./state-views.js";

const TOP_TREE_LIMIT = 5;

/**
 * 渲染子代理开销占比卡。
 * @param {HTMLElement} container 挂载点
 * @param {object|null} payload 契约对象（见文件头）或 null（接口不可达）
 * @returns {() => void} cleanup：静态 HTML，无持久资源
 */
export function renderChildShareCard(container, payload) {
  if (payload === null) {
    renderUnreachableState(container);
    return buildCleanup();
  }

  const totalSessions = Number(payload.totalSessions);
  if (!Number.isFinite(totalSessions) || totalSessions <= 0) {
    renderEmpty(container, "还没有子代理占比数据", "数据库里没有可统计的会话");
    return buildCleanup();
  }

  const childSessionCount = Number(payload.childSessionCount);
  const childTokens = Number(payload.childTokens);
  const childShare = Number(payload.childShare);
  const usableChildShare = Number.isFinite(childShare)
    ? Math.min(Math.max(childShare, 0), 1)
    : 0;

  const topTrees = (Array.isArray(payload.topChildTrees) ? payload.topChildTrees : [])
    .slice(0, TOP_TREE_LIMIT)
    .map((tree) => ({
      sessionId: String(tree?.sessionId ?? ""),
      title: String(tree?.title ?? "（无标题会话）"),
      agent: String(tree?.agent ?? ""),
      tokens: Number(tree?.tokens) || 0,
      childSessionCount: Number(tree?.childSessionCount) || 0,
    }))
    .filter((tree) => tree.sessionId !== "");

  const childSegmentWidth = (usableChildShare * 100).toFixed(1);

  container.innerHTML = `
    <div class="child-share-layout">
      <div class="child-share-overview">
        <div class="child-share-hero">
          <div class="child-share-rate num">${formatPercent(usableChildShare)}</div>
          <div class="child-share-caption">子代 tokens 占比</div>
        </div>
        <div class="child-share-dual-bar" role="img" aria-label="子代理占 ${formatPercent(usableChildShare)}，根会话占 ${formatPercent(1 - usableChildShare)} 的 token 用量">
          <span class="child-share-seg seg-child" style="width:${childSegmentWidth}%"></span>
          <span class="child-share-seg seg-root"></span>
        </div>
        <div class="child-share-meta">
          <span class="num">${formatCount(childSessionCount)}</span> / <span class="num">${formatCount(totalSessions)}</span>
          会话是子代理 · 子代消耗 <span class="num">${formatTokens(childTokens)}</span>
        </div>
      </div>
      <div class="child-share-ranking">
        <p class="distribution-caption">直接子代消耗 TOP${TOP_TREE_LIMIT} · 按父会话汇总，不含孙代</p>
        ${buildTopTreeHtml(topTrees)}
      </div>
    </div>`;

  return buildCleanup();
}

/* ---------------- 状态块 ---------------- */

/** 接口不可达降级：distribution-card renderUnreachableState 的同款语言。 */
function renderUnreachableState(container) {
  container.innerHTML = `
    <div class="state-view error">
      <strong>这块数据没加载出来</strong>
      <div class="state-hint">子代理占比数据不可达，下一次自动刷新会再试一次</div>
    </div>`;
}

/** 静态 HTML 无持久资源，cleanup 为空操作。 */
function buildCleanup() {
  return () => {};
}

/* ---------------- 直接子代消耗 TOP 父会话清单 ---------------- */

function buildTopTreeHtml(topTrees) {
  if (topTrees.length === 0) {
    return `<p class="distribution-caption">没有可展示的直接子代消耗记录</p>`;
  }
  return `<ol class="child-tree-list">` + topTrees.map((tree) => `
      <li class="child-tree-row">
        <a class="child-tree-title" href="#/session/${encodeURIComponent(tree.sessionId)}"
           title="${escapeHtml(tree.title)}${tree.agent !== "" ? ` · ${escapeHtml(tree.agent)}` : ""}">${escapeHtml(tree.title)}</a>
        <span class="child-tree-count num" title="${tree.childSessionCount} 个直接子代理">+${formatCount(tree.childSessionCount)} 子代</span>
        <span class="child-tree-tokens num">${formatTokens(tree.tokens)}</span>
        <a class="child-tree-replay" href="#/session/${encodeURIComponent(tree.sessionId)}" title="进入会话回放">→ 回放</a>
      </li>`).join("") + `</ol>`;
}

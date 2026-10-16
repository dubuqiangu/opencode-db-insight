/**
 * 顶栏会话作用域 chip（v0.20.0「只看此会话」）：#session-scope-chip
 * （.topbar-chip-slot，index.html 常驻节点）的填充器。
 *
 * 本模块只管 DOM：激活态渲染 chip（含完整 title 悬浮 + 自绑 ✕ click）、
 * 退出态清空并落回 hidden、会话被删后的自动退出轻提示。进入/退出作用
 *域的**状态与数据面**（state.sessionScopeId、缓存重置、全量重载）归
 * app.js，本模块通过回调上抛。
 *
 * 显隐必须走 hidden **属性**（setAttribute/removeAttribute）：视觉 lane
 * 的容器选择器是 .topbar-chip-slot:not([hidden])——UA 的 [hidden] 语义
 * 由属性承载，走 class 或 property 之外的任何通道都会与该选择器错位。
 */

import { escapeHtml } from "../format.js";

/**
 * 渲染顶栏作用域 chip。
 * @param {HTMLElement} containerElement #session-scope-chip 常驻容器
 * @param {{sessionId: string, sessionTitle: string}|null} sessionScopeState
 *   null = 退出态（清空 + 落回 hidden）
 * @param {() => void} onExitSessionScope ✕ 点击回调（app 层退出作用域）
 */
export function renderSessionScopeChip(containerElement, sessionScopeState, onExitSessionScope) {
  if (sessionScopeState === null) {
    containerElement.innerHTML = "";
    containerElement.setAttribute("hidden", "");
    return;
  }

  const sessionTitle = sessionScopeState.sessionTitle === ""
    ? sessionScopeState.sessionId
    : sessionScopeState.sessionTitle;
  const chipHoverTitle =
    `只看此会话：${sessionTitle}（${sessionScopeState.sessionId}）· 看板各统计只统计这一个会话`;

  containerElement.innerHTML = `
    <span class="scope-chip" title="${escapeHtml(chipHoverTitle)}">
      <span class="scope-chip-label">只看</span>
      <span class="scope-chip-title">${escapeHtml(sessionTitle)}</span>
      <button type="button" class="scope-chip-clear" title="退出会话作用域，恢复全部会话" aria-label="退出会话作用域">✕</button>
    </span>`;
  containerElement.removeAttribute("hidden");

  const clearButton = containerElement.querySelector("button.scope-chip-clear");
  if (clearButton !== null) {
    clearButton.addEventListener("click", () => {
      onExitSessionScope();
    });
  }
}

/**
 * 404 自动退出后的轻提示（不弹错误卡）：在 chip 位置闪一条小字，短暂
 * 停留后自动消失。没有全局 toast 体系，chip 槽位就是用户正在看的位置
 * ——提示长在动作发生的地方，不再引入新的提示语言。
 *
 * 限时恢复前先探测真实 chip 是否已入场（提示期间用户可能立刻又进了
 * 另一个会话的作用域）：在场就不动，避免闪掉刚渲染的 chip。
 */
export function flashSessionScopeVanishedNotice(containerElement, visibleDurationMilliseconds = 4000) {
  containerElement.innerHTML = `
    <span class="scope-chip" title="该会话已不在数据库中（可能已被删除），已自动恢复全部会话视图">
      <span class="scope-chip-label">已退出</span>
      <span class="scope-chip-title">该会话已不存在，恢复全部会话</span>
    </span>`;
  containerElement.removeAttribute("hidden");

  window.setTimeout(() => {
    if (containerElement.querySelector("button.scope-chip-clear") !== null) return;
    containerElement.innerHTML = "";
    containerElement.setAttribute("hidden", "");
  }, visibleDurationMilliseconds);
}

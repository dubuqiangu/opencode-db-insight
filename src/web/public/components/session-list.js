/**
 * 会话列表：标题 / 模型 / agent / 创建时间 / tokens。
 * 行 hover 高亮，点击跳 #/session/:id（M4 回放页，暂为占位路由）。
 * 支持按模型过滤（模型排行榜行下钻）。
 */

import { formatTokens, formatDateTime, formatRelative, escapeHtml } from "../format.js";
import { modelPalette } from "../theme.js";
import { renderEmpty, renderLoading } from "./state-views.js";

const VISIBLE_ROWS = 15;

/**
 * 渲染会话列表。
 * sessionPayload = { total, sessions: SessionSummary[] } 或 null。
 * modelFilter：非 null 时只显示该模型的会话。
 */
export function renderSessionList(container, sessionPayload, modelFilter) {
  if (sessionPayload === null) {
    renderLoading(container, 4);
    return;
  }

  const allSessions = sessionPayload.sessions ?? [];
  const sessions = modelFilter === null
    ? allSessions
    : allSessions.filter((session) => session.modelId === modelFilter);

  if (sessions.length === 0) {
    renderEmpty(
      container,
      modelFilter === null ? "没有会话记录" : `没有 ${modelFilter} 的会话`,
      modelFilter === null ? "数据库里还没有 session_v2 记录" : "这个模型在最近的会话里没出现过，试试取消过滤",
    );
    return;
  }

  const palette = modelPalette();
  const modelNames = [...new Set(allSessions.map((session) => session.modelId))];
  const modelColor = new Map(
    modelNames.map((modelName, rank) => [modelName, palette[rank % palette.length]]),
  );

  const now = Date.now();
  const rowsHtml = sessions.slice(0, VISIBLE_ROWS).map((session) => `
    <tr class="session-row" data-session-id="${escapeHtml(session.id)}" title="查看会话回放（M4）">
      <td class="primary"><span class="session-title-cell" title="${escapeHtml(session.title)}">${escapeHtml(session.title)}</span></td>
      <td><span class="model-cell"><span class="dot" style="background:${modelColor.get(session.modelId) ?? "transparent"}"></span><span class="name">${escapeHtml(session.modelId)}</span></span></td>
      <td><span class="badge">${escapeHtml(session.agent)}</span></td>
      <td class="num" title="${formatDateTime(session.timeCreated)}">${formatRelative(session.timeCreated, now)}</td>
      <td class="num primary">${formatTokens(session.tokens)}</td>
    </tr>`).join("");

  const hiddenAfterFilterCount = allSessions.length - sessions.length;
  const remainingCount = Math.max(0, sessions.length - VISIBLE_ROWS);
  const footNoteParts = [];
  if (modelFilter !== null) footNoteParts.push(`已过滤掉 ${hiddenAfterFilterCount} 条非 ${modelFilter} 会话`);
  if (remainingCount > 0) footNoteParts.push(`还有 ${remainingCount} 条更早的会话未展示`);
  footNoteParts.push(`全库共 <b class="num">${sessionPayload.total.toLocaleString("en-US")}</b> 个会话`);

  container.innerHTML = `
    <table class="data-table" aria-label="会话列表">
      <thead><tr>
        <th>标题</th><th>模型</th><th>Agent</th>
        <th class="num">创建时间</th><th class="num">Tokens</th>
      </tr></thead>
      <tbody>${rowsHtml}</tbody>
    </table>
    <div class="heatmap-meta">
      <span>${footNoteParts.join(" · ")}</span>
    </div>`;

  for (const row of container.querySelectorAll("tr.session-row")) {
    row.addEventListener("click", () => {
      window.location.hash = `/session/${row.dataset.sessionId}`;
    });
  }
}

/**
 * Agent 排行榜明细表（数据 = GET /api/agents 的 AgentStat[]，按 tokens 降序）。
 * 列：Agent / Sessions / Tokens / Top Tools（toolFingerprint 调用次数前 3，
 * 小字 chip）。表格样式语言完全复用 model-table 的 .data-table（num 右对齐
 * tabular-nums、primary 提亮、行 hover），不另起样式体系。
 *
 * agentStats 为 null/undefined 时渲染加载骨架；空数组渲染友好空态。
 */

import { formatTokens, formatCount, escapeHtml } from "../format.js";
import { MISSING_REASON, renderMissingValue } from "../precision.js";
import { renderEmpty, renderLoading } from "./state-views.js";

/** 每行展示的偏好工具数（toolFingerprint 按调用次数降序取前 N）。 */
const TOP_TOOLS_SHOWN = 3;

/**
 * toolFingerprint → [toolName, callCount] 调用次数降序前 N。
 * 防御：字段缺失/非对象按空处理；次数非有限数按 0 计（不渲染 NaN）。
 */
function topToolEntries(toolFingerprint, limit = TOP_TOOLS_SHOWN) {
  if (toolFingerprint === null || typeof toolFingerprint !== "object" || Array.isArray(toolFingerprint)) {
    return [];
  }
  return Object.entries(toolFingerprint)
    .map(([toolName, callCount]) => [toolName, Number.isFinite(callCount) ? callCount : 0])
    .sort((left, right) => right[1] - left[1])
    .slice(0, limit);
}

/** 偏好工具单元格：前 3 个小字 chip（名称 + 次数）；没有工具调用记录时显示带原因的 "—"。 */
function topToolsCell(toolFingerprint) {
  const entries = topToolEntries(toolFingerprint);
  if (entries.length === 0) {
    return `<span class="agent-tool-list">${renderMissingValue(MISSING_REASON.noToolCalls)}</span>`;
  }
  const chips = entries.map(([toolName, callCount]) =>
    `<span class="agent-tool-chip">${escapeHtml(toolName)} <b>${formatCount(callCount)}</b></span>`);
  return `<span class="agent-tool-list">${chips.join("")}</span>`;
}

/**
 * 渲染 Agent 排行榜。agentStats 为 AgentStat[] 或 null（null = 骨架）。
 * wire 已按 tokens 降序，这里仍防御性重排（脏值按 0 计，稳定排序）。
 */
export function renderAgentTable(container, agentStats) {
  if (agentStats === null || agentStats === undefined) {
    renderLoading(container, 4);
    return;
  }
  if (agentStats.length === 0) {
    renderEmpty(container, "No agent records yet", "数据库里还没有可归属到 agent 的 assistant 消息");
    return;
  }

  const sortedAgents = [...agentStats].sort(
    (left, right) => (right.tokens ?? 0) - (left.tokens ?? 0),
  );

  const rowsHtml = sortedAgents.map((agentStat) => `
    <tr>
      <td class="primary"><span class="agent-name">${escapeHtml(agentStat.agent ?? "unknown")}</span></td>
      <td class="num">${formatCount(agentStat.sessions)}</td>
      <td class="num primary">${formatTokens(agentStat.tokens)}</td>
      <td>${topToolsCell(agentStat.toolFingerprint)}</td>
    </tr>`).join("");

  container.innerHTML = `
    <table class="data-table agent-table" aria-label="Agent Leaderboard">
      <colgroup>
        <col style="width:160px"><col style="width:76px">
        <col style="width:96px"><col style="width:160px">
      </colgroup>
      <thead><tr>
        <th>Agent</th>
        <th class="num">Sessions</th>
        <th class="num">Tokens</th>
        <th>Top Tools</th>
      </tr></thead>
      <tbody>${rowsHtml}</tbody>
    </table>`;
}

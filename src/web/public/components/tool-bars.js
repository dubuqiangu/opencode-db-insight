/**
 * 工具调用横向条形图（TOP10，手写 SVG）。
 * 数据 = data-source.fetchAgents() 的 AgentStat[]，跨 agent 合计
 * toolFingerprint 后取前 10。hover 高亮行并显示占比。
 */

import { formatCount, escapeHtml } from "../format.js";
import { cssVar } from "../theme.js";
import { bindHoverTooltip } from "../tooltip.js";
import { renderEmpty } from "./state-views.js";

const NAME_COLUMN_WIDTH = 116;
const VALUE_COLUMN_WIDTH = 58;
const BAR_MAX_WIDTH = 460 - NAME_COLUMN_WIDTH - VALUE_COLUMN_WIDTH - 12;
const ROW_HEIGHT = 32;
const VIEWBOX_WIDTH = 460;

/** 跨 agent 合计每个工具的调用次数，降序取前 N。 */
function aggregateTopTools(agentStats, limit = 10) {
  const totalCounts = new Map();
  for (const agentStat of agentStats) {
    for (const [toolName, callCount] of Object.entries(agentStat.toolFingerprint ?? {})) {
      totalCounts.set(toolName, (totalCounts.get(toolName) ?? 0) + callCount);
    }
  }
  return [...totalCounts.entries()]
    .sort((left, right) => right[1] - left[1])
    .slice(0, limit);
}

/** 长工具名截断（SVG 文本没有自动省略）。 */
function clipToolName(name) {
  return name.length > 13 ? name.slice(0, 12) + "…" : name;
}

/**
 * 渲染 TOP10 工具条形图。agentStats 为 AgentStat[] 或 null。
 */
export function renderToolBars(container, agentStats) {
  const topTools = agentStats === null ? [] : aggregateTopTools(agentStats, 10);
  if (topTools.length === 0) {
    renderEmpty(container, "没有工具调用记录", "数据库里还没有带 tool part 的 assistant 消息");
    return;
  }

  const maxCount = topTools[0][1];
  const totalCount = topTools.reduce((sum, [, count]) => sum + count, 0);
  const svgHeight = topTools.length * ROW_HEIGHT;
  const accentColor = cssVar("--accent");
  const barColor = cssVar("--blue");
  const textColor = cssVar("--text-dim");
  const trackColor = cssVar("--border");

  const rowParts = topTools.map(([toolName, callCount], rowIndex) => {
    const barWidth = Math.max(2, Math.round((callCount / maxCount) * BAR_MAX_WIDTH));
    const yCenter = rowIndex * ROW_HEIGHT + ROW_HEIGHT / 2;
    const barY = yCenter - 7;
    const sharePercent = ((callCount / totalCount) * 100).toFixed(1);
    return `
      <g class="toolbar-row" data-tool="${escapeHtml(toolName)}" data-count="${callCount}" data-share="${sharePercent}">
        <text x="0" y="${yCenter + 4}" font-size="11" fill="${textColor}" font-family="ui-monospace, Consolas, monospace">${escapeHtml(clipToolName(toolName))}</text>
        <rect class="toolbar-track" x="${NAME_COLUMN_WIDTH}" y="${barY}" width="${BAR_MAX_WIDTH}" height="14" rx="4" fill="${trackColor}" opacity="0.35"/>
        <rect x="${NAME_COLUMN_WIDTH}" y="${barY}" width="${barWidth}" height="14" rx="4" fill="${rowIndex === 0 ? accentColor : barColor}"/>
        <text x="${VIEWBOX_WIDTH - 2}" y="${yCenter + 4}" font-size="11" fill="${rowIndex === 0 ? accentColor : textColor}" font-family="ui-monospace, Consolas, monospace" text-anchor="end">${formatCount(callCount)}</text>
      </g>`;
  });

  container.innerHTML = `
    <svg class="toolbars-svg" viewBox="0 0 ${VIEWBOX_WIDTH} ${svgHeight}" role="img" aria-label="工具调用次数 TOP10">${rowParts.join("")}</svg>`;

  for (const row of container.querySelectorAll(".toolbar-row")) {
    const toolName = row.dataset.tool;
    bindHoverTooltip(row, () => ({
      title: toolName,
      rows: [{ label: "调用次数", value: formatCount(Number(row.dataset.count)) }, { label: "TOP10 占比", value: row.dataset.share + "%" }],
    }));
  }
}

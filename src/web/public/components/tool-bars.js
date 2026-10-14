/**
 * 工具调用横向条形图（TOP10，手写 SVG）。
 * 数据 = data-source.fetchAgents() 的 AgentStat[]，跨 agent 合计
 * toolFingerprint 后取前 10。hover 高亮行并显示占比。
 *
 * 第三参 toolHealthStats（GET /api/tool-health 的 ToolHealthStat[]，可选）：
 * 每根条叠加一段错误色带（宽度 = 条宽 × errorRate），数值列下方补一行
 * 小字错误率（err N%）。两级警示语言沿用既有色板：errorRate ≥ 10% 用
 * --red（一眼可见），< 10% 用 --amber 提示。health 缺失/为空 → 不渲染
 * 色带与标注，条形图保持原样（安静降级，不炸区块）。
 */

import { formatCount, formatPercent, escapeHtml } from "../format.js";
import { cssVar } from "../theme.js";
import { bindHoverTooltip } from "../tooltip.js";
import { renderEmpty } from "./state-views.js";

const NAME_COLUMN_WIDTH = 116;
const VALUE_COLUMN_WIDTH = 58;
const BAR_MAX_WIDTH = 460 - NAME_COLUMN_WIDTH - VALUE_COLUMN_WIDTH - 12;
const ROW_HEIGHT = 32;
const VIEWBOX_WIDTH = 460;
/** errorRate 达到该值时错误色带/文字升级为 --red（否则 --amber 弱提示）。 */
const HIGH_ERROR_RATE = 0.1;

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

/** ToolHealthStat[] → Map<tool, stat>；null/非数组/脏行防御性跳过。 */
function toolHealthIndex(toolHealthStats) {
  const healthByTool = new Map();
  for (const healthStat of Array.isArray(toolHealthStats) ? toolHealthStats : []) {
    if (healthStat !== null && typeof healthStat === "object" && typeof healthStat.tool === "string") {
      healthByTool.set(healthStat.tool, healthStat);
    }
  }
  return healthByTool;
}

/** 长工具名截断（SVG 文本没有自动省略）。 */
function clipToolName(name) {
  return name.length > 13 ? name.slice(0, 12) + "…" : name;
}

/**
 * 渲染 TOP10 工具条形图。agentStats 为 AgentStat[] 或 null；
 * toolHealthStats 为 ToolHealthStat[] / null（可选，null = 无健康度数据）。
 */
export function renderToolBars(container, agentStats, toolHealthStats = null) {
  const topTools = agentStats === null ? [] : aggregateTopTools(agentStats, 10);
  if (topTools.length === 0) {
    renderEmpty(container, "没有工具调用记录", "数据库里还没有带 tool part 的 assistant 消息");
    return;
  }

  const healthByTool = toolHealthIndex(toolHealthStats);
  const maxCount = topTools[0][1];
  const totalCount = topTools.reduce((sum, [, count]) => sum + count, 0);
  const svgHeight = topTools.length * ROW_HEIGHT;
  const accentColor = cssVar("--accent");
  const barColor = cssVar("--blue");
  const textColor = cssVar("--text-dim");
  const faintColor = cssVar("--text-faint");
  const trackColor = cssVar("--border");
  const highErrorColor = cssVar("--red");
  const lowErrorColor = cssVar("--amber");
  const monoFont = "ui-monospace, Consolas, monospace";

  const rowParts = topTools.map(([toolName, callCount], rowIndex) => {
    const barWidth = Math.max(2, Math.round((callCount / maxCount) * BAR_MAX_WIDTH));
    const yCenter = rowIndex * ROW_HEIGHT + ROW_HEIGHT / 2;
    const barY = yCenter - 7;
    const sharePercent = ((callCount / totalCount) * 100).toFixed(1);

    // 错误标注（tool-health 提供）：error > 0 才有内容；脏值按无数据处理。
    const healthStat = healthByTool.get(toolName) ?? null;
    const errorCount = healthStat !== null && Number.isFinite(healthStat.error) ? healthStat.error : 0;
    const errorRate = healthStat !== null && Number.isFinite(healthStat.errorRate) ? healthStat.errorRate : null;
    const hasErrors = errorCount > 0 && errorRate !== null && errorRate > 0;
    const isHighError = hasErrors && errorRate >= HIGH_ERROR_RATE;
    const errorSegmentWidth = hasErrors && barWidth > 6
      ? Math.min(barWidth - 2, Math.max(2, Math.round(barWidth * errorRate)))
      : 0;
    const errorSegmentX = NAME_COLUMN_WIDTH + barWidth - errorSegmentWidth;
    const errorTextColor = isHighError ? highErrorColor : faintColor;

    return `
      <g class="toolbar-row" data-tool="${escapeHtml(toolName)}" data-count="${callCount}" data-share="${sharePercent}"${hasErrors ? ` data-error="${errorCount}" data-error-rate="${errorRate}"` : ""}>
        <text x="0" y="${yCenter + 4}" font-size="11" fill="${textColor}" font-family="${monoFont}">${escapeHtml(clipToolName(toolName))}</text>
        <rect class="toolbar-track" x="${NAME_COLUMN_WIDTH}" y="${barY}" width="${BAR_MAX_WIDTH}" height="14" rx="4" fill="${trackColor}" opacity="0.35"/>
        <rect x="${NAME_COLUMN_WIDTH}" y="${barY}" width="${barWidth}" height="14" rx="4" fill="${rowIndex === 0 ? accentColor : barColor}"/>
        ${errorSegmentWidth > 0 ? `<rect x="${errorSegmentX}" y="${barY}" width="${errorSegmentWidth}" height="14" rx="2" fill="${isHighError ? highErrorColor : lowErrorColor}"/>` : ""}
        <text x="${VIEWBOX_WIDTH - 2}" y="${yCenter + 4}" font-size="11" fill="${rowIndex === 0 ? accentColor : textColor}" font-family="${monoFont}" text-anchor="end">${formatCount(callCount)}</text>
        ${hasErrors ? `<text x="${VIEWBOX_WIDTH - 2}" y="${yCenter + 15}" font-size="9" fill="${errorTextColor}" font-family="${monoFont}" text-anchor="end">err ${formatPercent(errorRate, 1)}</text>` : ""}
      </g>`;
  });

  container.innerHTML = `
    <svg class="toolbars-svg" viewBox="0 0 ${VIEWBOX_WIDTH} ${svgHeight}" role="img" aria-label="工具调用次数 TOP10">${rowParts.join("")}</svg>`;

  for (const row of container.querySelectorAll(".toolbar-row")) {
    const toolName = row.dataset.tool;
    const tooltipRows = [
      { label: "调用次数", value: formatCount(Number(row.dataset.count)) },
      { label: "TOP10 占比", value: row.dataset.share + "%" },
    ];
    if (row.dataset.error !== undefined) {
      tooltipRows.push(
        { label: "Errors", value: formatCount(Number(row.dataset.error)) },
        { label: "Error rate", value: formatPercent(Number(row.dataset.errorRate), 1) },
      );
    }
    bindHoverTooltip(row, () => ({
      title: toolName,
      rows: tooltipRows,
    }));
  }
}

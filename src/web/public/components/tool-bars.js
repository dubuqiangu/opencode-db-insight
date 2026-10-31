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
 *
 * 第四参 toolTokenStats（GET /api/tool-tokens 的 ToolTokenStat[]，可选）：
 * 在调用次数榜之下追加一块「按 token 消耗」榜（TOP10，--purple 条形）。
 * 这是**自包含分词估算归因**（见 DESIGN §5）——🟡 估算，非 DB 字段，故块头带
 * 估算徽标。token 缺失/为空/全零 → 不渲染该块，调用次数榜保持原样。
 * 既有调用次数行的 data-*（data-tool / data-count / data-share /
 * data-error）逐字保留；token 行用独立 class 与 data-* 命名，互不污染。
 */

import { formatCount, formatPercent, formatTokens, escapeHtml } from "../format.js";
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
/** token 榜行高（略矮于调用次数榜，弱化主次）。 */
const TOKEN_ROW_HEIGHT = 26;
/** token 榜最多展示的工具数。 */
const TOKEN_TOOL_LIMIT = 10;
/** 「无工具」桶（零工具步的 token）在榜上的显示名。 */
const NO_TOOL_LABEL = "（无工具）";


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
 * 取 token 榜 TOP-N：过滤脏行、丢弃 tokens ≤ 0 与非有限值（空态不发空图），
 * 按 tokens 降序、工具名升序稳定排序。返回每行 {tool, tokens, share, steps}。
 */
function topTokenTools(toolTokenStats, limit = TOKEN_TOOL_LIMIT) {
  const tokenRows = [];
  for (const tokenStat of Array.isArray(toolTokenStats) ? toolTokenStats : []) {
    if (tokenStat === null || typeof tokenStat !== "object") continue;
    if (typeof tokenStat.tool !== "string") continue;
    if (!Number.isFinite(tokenStat.tokens) || tokenStat.tokens <= 0) continue;
    tokenRows.push(tokenStat);
  }
  tokenRows.sort(
    (left, right) =>
      right.tokens - left.tokens ||
      (left.tool < right.tool ? -1 : left.tool > right.tool ? 1 : 0),
  );
  return tokenRows.slice(0, limit);
}

/** token 榜的显示名：空工具名映射到「（无工具）」桶。 */
function tokenToolLabel(toolName) {
  return toolName === "" ? NO_TOOL_LABEL : toolName;
}

/**
 * 构建「按 token 消耗」块（块头 + 一张 TOP10 token 条形 SVG）。无有效行
 * 返回 ""（不渲染空图；调用次数榜照常）。token 色用 --purple，与调用
 * 次数榜的 --blue/--accent 明确区分。
 */
function buildToolTokenBlock(toolTokenStats) {
  const tokenRows = topTokenTools(toolTokenStats);
  if (tokenRows.length === 0) return "";

  const maxTokens = tokenRows[0].tokens;
  const tokenColor = cssVar("--purple");
  const textColor = cssVar("--text-dim");
  const trackColor = cssVar("--border");
  const monoFont = "ui-monospace, Consolas, monospace";
  const svgHeight = tokenRows.length * TOKEN_ROW_HEIGHT;

  const tokenRowParts = tokenRows.map((tokenStat, rowIndex) => {
    const yCenter = rowIndex * TOKEN_ROW_HEIGHT + TOKEN_ROW_HEIGHT / 2;
    const barY = yCenter - 6;
    const barWidth = Math.max(2, Math.round((tokenStat.tokens / maxTokens) * BAR_MAX_WIDTH));
    const sharePercent = Number.isFinite(tokenStat.share)
      ? (tokenStat.share * 100).toFixed(1)
      : "";
    return `
      <g class="tooltoken-row" data-tool="${escapeHtml(tokenStat.tool)}" data-tokens="${tokenStat.tokens}" data-share="${sharePercent}" data-steps="${Number.isFinite(tokenStat.steps) ? tokenStat.steps : 0}">
        <text x="0" y="${yCenter + 4}" font-size="11" fill="${textColor}" font-family="${monoFont}">${escapeHtml(clipToolName(tokenToolLabel(tokenStat.tool)))}</text>
        <rect class="toolbar-track" x="${NAME_COLUMN_WIDTH}" y="${barY}" width="${BAR_MAX_WIDTH}" height="12" rx="4" fill="${trackColor}" opacity="0.35"/>
        <rect x="${NAME_COLUMN_WIDTH}" y="${barY}" width="${barWidth}" height="12" rx="4" fill="${rowIndex === 0 ? cssVar("--accent") : tokenColor}"/>
        <text x="${VIEWBOX_WIDTH - 2}" y="${yCenter + 4}" font-size="11" fill="${rowIndex === 0 ? cssVar("--accent") : textColor}" font-family="${monoFont}" text-anchor="end">${formatTokens(tokenStat.tokens)}</text>
      </g>`;
  });

  return `
    <div class="tooltoken-block">
      <div class="tooltoken-head">
        <span class="tooltoken-title">按 token 消耗</span>
        <span class="tooltoken-estimate" title="按每 part 的 state.input/state.output 分词估算归因，非 DB 字段">🟡 估算</span>
      </div>
      <svg class="toolbars-svg tooltoken-svg" viewBox="0 0 ${VIEWBOX_WIDTH} ${svgHeight}" role="img" aria-label="工具 token 消耗 TOP10（分词估算）">${tokenRowParts.join("")}</svg>
    </div>`;
}

/**
 * 渲染 TOP10 工具条形图。agentStats 为 AgentStat[] 或 null；
 * toolHealthStats 为 ToolHealthStat[] / null（可选，null = 无健康度数据）；
 * toolTokenStats 为 ToolTokenStat[] / null（可选，null = 无 token 归因数据）。
 */
export function renderToolBars(container, agentStats, toolHealthStats = null, toolTokenStats = null) {
  const topTools = agentStats === null ? [] : aggregateTopTools(agentStats, 10);
  // token 块先独立构建：后端对「有 token、无工具调用」的步会发一条 tool:""
  // 的归因桶，因此零调用次数不代表零 token。两个来源各自决定是否出内容。
  const toolTokenBlockHtml = buildToolTokenBlock(toolTokenStats);
  if (topTools.length === 0 && toolTokenBlockHtml === "") {
    renderEmpty(container, "没有工具调用记录", "数据库里还没有带 tool part 的 assistant 消息");
    return;
  }

  if (topTools.length === 0) {
    // 只有 token 归因、没有调用次数：跳过次数榜，直接渲染 token 块。
    container.innerHTML = toolTokenBlockHtml;
  } else {
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
      <svg class="toolbars-svg" viewBox="0 0 ${VIEWBOX_WIDTH} ${svgHeight}" role="img" aria-label="工具调用次数 TOP10">${rowParts.join("")}</svg>${toolTokenBlockHtml}`;

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

  for (const row of container.querySelectorAll(".tooltoken-row")) {
    const toolName = tokenToolLabel(row.dataset.tool);
    bindHoverTooltip(row, () => ({
      title: toolName,
      rows: [
        { label: "token 消耗（🟡 估算）", value: formatTokens(Number(row.dataset.tokens)) },
        { label: "占比", value: row.dataset.share + "%" },
        { label: "出现步数", value: formatCount(Number(row.dataset.steps)) },
      ],
    }));
  }
}

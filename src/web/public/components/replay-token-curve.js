/**
 * 回放页消耗曲线（v0.20.0）：累计 (output + reasoning) 折线 + 峰值上下文
 * 徽标行 + 全部会话分位落点徽标。
 *
 * 数据契约（接线 lane 组装后传入）：
 *   {
 *     steps: [{ index, timeCreated,
 *               tokensOutput, tokensReasoning,
 *               tokensInput, tokensCacheRead, tokensCacheWrite }],
 *     distributionPercentiles: { p50, p90, p99 } | null,
 *   }
 *
 * 纯渲染函数：不 fetch、不碰全局 state。steps 为空数组 → 不渲染返回
 * null（接线层不挂）；distributionPercentiles 为 null → 分位徽标整行
 * 不渲染。组件自带面板标题与 sub，容器是接线 lane 在回放页插入的裸 div。
 */

import { formatTokens, formatDateTime } from "../format.js";
import { cssVar } from "../theme.js";
import { bindHoverTooltip, hideTooltip } from "../tooltip.js";

const VIEWBOX_WIDTH = 760;
const VIEWBOX_HEIGHT = 200;
const PLOT_LEFT = 48;
const PLOT_RIGHT = 56; // 右侧留白：终点数值标在曲线右方（累计曲线单调不降，右侧恒空）
const PLOT_TOP = 12;
const X_AXIS_Y = VIEWBOX_HEIGHT - 24;
const MAX_X_TICKS = 6;

/**
 * 渲染 Token 消耗曲线面板。
 * @param {HTMLElement} container 接线 lane 插入回放页的容器 div
 * @param {object} stepTokens 契约对象（见文件头）
 * @returns {(() => void)|null} cleanup；steps 为空时不渲染返回 null
 */
export function renderReplayTokenCurve(container, stepTokens) {
  const stepPoints = buildStepPoints(stepTokens);
  if (stepPoints === null) return null;

  const cumulativeTotal = stepPoints[stepPoints.length - 1].cumulative;
  const peakContextTokens = stepPoints.reduce((largest, point) => Math.max(largest, point.contextTokens), 0);
  const sessionTotalTokens = stepPoints.reduce((sum, point) => sum + point.sessionTotalContribution, 0);

  container.innerHTML = `
    <article class="panel replay-curve-panel">
      <header class="panel-head">
        <div>
          <h2>Token 消耗曲线</h2>
          <p class="panel-sub">逐步累计 · output + reasoning</p>
        </div>
      </header>
      <div class="panel-body">
        <div class="replay-curve-stats">
          <p class="replay-curve-peak" title="各步 (input + cache.read + cache.write) 的最大值，即本会话最重的单步上下文供给">峰值上下文 <b class="num">${formatTokens(peakContextTokens)}</b> tokens</p>
          ${buildQuantileBadgeHtml(stepTokens?.distributionPercentiles, sessionTotalTokens)}
        </div>
        ${buildCurveSvgHtml(stepPoints, cumulativeTotal)}
      </div>
    </article>`;

  bindStepTooltips(container, stepPoints);

  return () => hideTooltip();
}

/* ---------------- 数据整形 ---------------- */

/**
 * steps → 绘图点（按 index 升序）。每点四组量：
 *   cumulative              累计 output + reasoning（曲线 y 值）
 *   stepIncrement           本步 output + reasoning（曲线增量）
 *   contextTokens           本步 input + cache.read + cache.write（峰值上下文取 max）
 *   sessionTotalContribution 本步 input + output + cache.read
 *                           （分位比对总量口径 = 会话列表 Tokens 列「入+出+cache.read」，
 *                             与分布端点/分位样本一致，不含 reasoning）
 * 空/全脏 → null。
 */
function buildStepPoints(stepTokens) {
  const rawSteps = Array.isArray(stepTokens?.steps) ? stepTokens.steps : [];
  const stepPoints = rawSteps.map((rawStep, position) => {
    const tokensOutput = nonNegativeTokens(rawStep?.tokensOutput);
    const tokensReasoning = nonNegativeTokens(rawStep?.tokensReasoning);
    const tokensInput = nonNegativeTokens(rawStep?.tokensInput);
    const tokensCacheRead = nonNegativeTokens(rawStep?.tokensCacheRead);
    const tokensCacheWrite = nonNegativeTokens(rawStep?.tokensCacheWrite);
    const stepIndex = Number.isFinite(Number(rawStep?.index)) ? Number(rawStep.index) : position;
    return {
      index: stepIndex,
      timeCreated: Number(rawStep?.timeCreated),
      cumulative: 0,
      stepIncrement: tokensOutput + tokensReasoning,
      stepOutput: tokensOutput,
      stepReasoning: tokensReasoning,
      contextTokens: tokensInput + tokensCacheRead + tokensCacheWrite,
      sessionTotalContribution: tokensInput + tokensOutput + tokensCacheRead,
    };
  });
  if (stepPoints.length === 0) return null;

  stepPoints.sort((left, right) => left.index - right.index);
  let runningTotal = 0;
  for (const stepPoint of stepPoints) {
    runningTotal += stepPoint.stepIncrement;
    stepPoint.cumulative = runningTotal;
  }
  return stepPoints;
}

/** wire 上缺 key / 负值一律按 0 计。 */
function nonNegativeTokens(value) {
  const numericValue = Number(value);
  return Number.isFinite(numericValue) && numericValue > 0 ? numericValue : 0;
}

/* ---------------- 徽标行 ---------------- */

/** 分位落点徽标一句化：tier 配色对齐 .precision / badge.no-cache 的
 * 描边小徽标语言。percentiles 为 null → 整行不渲染（返回空串）。 */
function buildQuantileBadgeHtml(distributionPercentiles, sessionTotalTokens) {
  const percentileValues = readPercentiles(distributionPercentiles);
  if (percentileValues === null) return "";

  const { p50, p90, p99 } = percentileValues;
  const quantileTier =
    sessionTotalTokens >= p99 ? { className: "over-p99", label: "超过 p99" }
    : sessionTotalTokens >= p90 ? { className: "over-p90", label: "超过 p90" }
    : sessionTotalTokens >= p50 ? { className: "over-p50", label: "超过 p50" }
    : { className: "under-p50", label: "低于 p50" };

  return `
    <p class="replay-curve-quantile-line">
      <span class="badge replay-quantile ${quantileTier.className}"
        title="本会话 ${formatTokens(sessionTotalTokens)} tokens · 全部会话分布：p50 ${formatTokens(p50)} / p90 ${formatTokens(p90)} / p99 ${formatTokens(p99)}">${quantileTier.label}</span>
    </p>`;
}

/** percentiles 三值齐全且有限才启用徽标；否则视为无分布数据。 */
function readPercentiles(rawPercentiles) {
  if (rawPercentiles === null || typeof rawPercentiles !== "object") return null;
  const percentileValues = {};
  for (const quantileKey of ["p50", "p90", "p99"]) {
    const quantileValue = Number(rawPercentiles[quantileKey]);
    if (!Number.isFinite(quantileValue) || quantileValue < 0) return null;
    percentileValues[quantileKey] = quantileValue;
  }
  return percentileValues;
}

/* ---------------- 曲线 SVG ---------------- */

function buildCurveSvgHtml(stepPoints, cumulativeTotal) {
  const firstIndex = stepPoints[0].index;
  const lastIndex = stepPoints[stepPoints.length - 1].index;
  const indexSpan = Math.max(1, lastIndex - firstIndex);
  const yTickStep = niceTokenStep(cumulativeTotal);
  const yMax = Math.max(yTickStep, Math.ceil(cumulativeTotal / yTickStep) * yTickStep);
  const plotWidth = VIEWBOX_WIDTH - PLOT_LEFT - PLOT_RIGHT;

  const indexToX = (stepIndex) => PLOT_LEFT + ((stepIndex - firstIndex) / indexSpan) * plotWidth;
  const valueToY = (tokenValue) => X_AXIS_Y - (tokenValue / yMax) * (X_AXIS_Y - PLOT_TOP);

  const curvePath = stepPoints
    .map((point, pointPosition) => `${pointPosition === 0 ? "M" : "L"}${indexToX(point.index).toFixed(1)},${valueToY(point.cumulative).toFixed(1)}`)
    .join(" ");
  const areaPath = `${curvePath} L${indexToX(lastIndex).toFixed(1)},${X_AXIS_Y} L${indexToX(firstIndex).toFixed(1)},${X_AXIS_Y} Z`;

  const lastPoint = stepPoints[stepPoints.length - 1];
  const lastPointX = indexToX(lastIndex);
  const lastPointY = valueToY(lastPoint.cumulative);

  const svgParts = [];
  // y 轴：基线 + 好数刻度网格
  svgParts.push(`<line x1="${PLOT_LEFT}" y1="${X_AXIS_Y}" x2="${VIEWBOX_WIDTH - PLOT_RIGHT}" y2="${X_AXIS_Y}" stroke="${cssVar("--grid-line")}"/>`);
  for (let tickValue = yTickStep; tickValue <= yMax; tickValue += yTickStep) {
    const tickY = valueToY(tickValue);
    svgParts.push(`<line x1="${PLOT_LEFT}" y1="${tickY.toFixed(1)}" x2="${VIEWBOX_WIDTH - PLOT_RIGHT}" y2="${tickY.toFixed(1)}" stroke="${cssVar("--grid-line")}"/>`);
    svgParts.push(`<text x="${PLOT_LEFT - 8}" y="${(tickY + 3.5).toFixed(1)}" text-anchor="end" font-size="10" fill="${cssVar("--text-faint")}" font-family="ui-monospace, Consolas, monospace">${formatTokens(tickValue)}</text>`);
  }
  // x 轴：步 index 刻度（含首尾）
  const xTickStride = Math.max(1, Math.ceil(stepPoints.length / (MAX_X_TICKS - 1)));
  const xTickIndices = new Set();
  for (let pointPosition = 0; pointPosition < stepPoints.length; pointPosition += xTickStride) {
    xTickIndices.add(pointPosition);
  }
  xTickIndices.add(stepPoints.length - 1);
  for (const pointPosition of xTickIndices) {
    const point = stepPoints[pointPosition];
    const textAnchor = pointPosition === stepPoints.length - 1 ? "end" : "middle";
    svgParts.push(`<text x="${indexToX(point.index).toFixed(1)}" y="${VIEWBOX_HEIGHT - 6}" text-anchor="${textAnchor}" font-size="10" fill="${cssVar("--text-faint")}" font-family="ui-monospace, Consolas, monospace">${point.index}</text>`);
  }
  // 面积 + 曲线 + 终点
  svgParts.push(`<path class="replay-curve-area" d="${areaPath}" fill="${cssVar("--accent-soft")}"/>`);
  svgParts.push(`<path class="replay-curve-line" d="${curvePath}" fill="none" stroke="${cssVar("--accent")}" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round"/>`);
  svgParts.push(`<circle cx="${lastPointX.toFixed(1)}" cy="${lastPointY.toFixed(1)}" r="3" fill="${cssVar("--accent")}"/>`);
  svgParts.push(`<text x="${(lastPointX + 6).toFixed(1)}" y="${(lastPointY + 3.5).toFixed(1)}" font-size="11" font-weight="600" fill="${cssVar("--accent")}" font-family="ui-monospace, Consolas, monospace">${formatTokens(lastPoint.cumulative)}</text>`);

  // 步级悬浮热区：透明圆挂在数据点上（fill="transparent" 吃指针事件），
  // tooltip 报累计与单步分项
  stepPoints.forEach((point, pointPosition) => {
    svgParts.push(`<circle class="replay-curve-hit" data-step-position="${pointPosition}" cx="${indexToX(point.index).toFixed(1)}" cy="${valueToY(point.cumulative).toFixed(1)}" r="7" fill="transparent"/>`);
  });

  return `<svg class="replay-curve-svg" viewBox="0 0 ${VIEWBOX_WIDTH} ${VIEWBOX_HEIGHT}" role="img" aria-label="本会话 token 逐步累计消耗曲线">${svgParts.join("")}</svg>`;
}

/* ---------------- 步级悬浮提示 ---------------- */

function bindStepTooltips(container, stepPoints) {
  for (const hitElement of container.querySelectorAll(".replay-curve-hit")) {
    const point = stepPoints[Number(hitElement.dataset.stepPosition)];
    bindHoverTooltip(hitElement, () => ({
      title: Number.isFinite(point.timeCreated)
        ? `步 ${point.index} · ${formatDateTime(point.timeCreated)}`
        : `步 ${point.index}`,
      rows: [
        { label: "累计", value: formatTokens(point.cumulative) },
        { label: "本步 output", value: formatTokens(point.stepOutput) },
        { label: "本步 reasoning", value: formatTokens(point.stepReasoning) },
        { label: "上下文供给", value: formatTokens(point.contextTokens) },
      ],
    }));
  }
}

/* ---------------- 小工具 ---------------- */

/** 1/2/5×10^k 步进中取 ≥ range/3 的最小者，保证 y 轴刻度是「好数」。 */
function niceTokenStep(range) {
  const rawStep = Math.max(1, range / 3);
  const magnitude = Math.pow(10, Math.floor(Math.log10(rawStep)));
  for (const multiplier of [1, 2, 5, 10]) {
    const candidateStep = multiplier * magnitude;
    if (candidateStep >= rawStep) return candidateStep;
  }
  return 10 * magnitude;
}

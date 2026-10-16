/**
 * 会话 token 分布卡（v0.20.0）：单会话 tokens 总量直方图 + p50/p90/p99
 * 分位竖标线，卡头两行小字报样本数与均值/最大值。
 *
 * 数据 = GET /api/session-sistribution（后端 fix-34 lane 实现中）：
 *   {
 *     totalSessions: number,  // 排除全零会话后的样本数
 *     buckets: [{ start: number, end: number, count: number }],
 *     percentiles: { p50: number, p90: number, p99: number },
 *     mean: number, max: number,
 *   }
 *
 * 纯渲染函数：不 fetch、不碰全局 state；数据由接线 lane 传入。
 * distribution === null → 渲染「数据不可达」降级块（renderError 的卡片级
 * 降级语言，但本卡无重试按钮——由自动刷新兜底）。
 */

import { formatTokens, formatCount, formatPercent, escapeHtml } from "../format.js";
import { cssVar } from "../theme.js";
import { bindHoverTooltip, hideTooltip } from "../tooltip.js";
import { renderEmpty } from "./state-views.js";

const VIEWBOX_WIDTH = 760;
const VIEWBOX_HEIGHT = 220;
const PLOT_LEFT = 48;
const PLOT_RIGHT = 12;
const PLOT_TOP = 8;
const X_AXIS_Y = VIEWBOX_HEIGHT - 24;
const MAX_X_TICKS = 7;

/** 三条分位标线的固定次序与颜色（severity 递进，双主题都有实值）。 */
const PERCENTILE_MARKS = [
  { key: "p50", colorVar: "--accent" },
  { key: "p90", colorVar: "--amber" },
  { key: "p99", colorVar: "--red" },
];

/**
 * 渲染会话 token 分布卡。
 * @param {HTMLElement} container #session-distribution 挂载点
 * @param {object|null} distribution 契约对象（见文件头）或 null（接口不可达）
 * @returns {() => void} cleanup：静态 SVG 无持久资源，只收起悬浮提示
 */
export function renderDistributionCard(container, distribution) {
  if (distribution === null) {
    renderUnreachableState(container);
    return buildCleanup();
  }

  const buckets = normalizeBuckets(distribution.buckets);
  const totalSessions = Number(distribution.totalSessions);
  if (buckets.length === 0 || !Number.isFinite(totalSessions) || totalSessions <= 0) {
    renderEmpty(container, "还没有会话分布数据", "窗口内没有非零消耗的会话可统计");
    return buildCleanup();
  }
  const maxCount = buckets.reduce((largest, bucket) => Math.max(largest, bucket.count), 0);
  if (maxCount <= 0) {
    renderEmpty(container, "还没有会话分布数据", "窗口内没有非零消耗的会话可统计");
    return buildCleanup();
  }

  const percentileEntries = readPercentiles(distribution.percentiles);
  const percentileValues = percentileEntries.map((entry) => entry.value);
  const valueMin = Math.max(0, Math.min(buckets[0].start, ...percentileValues));
  const valueMax = Math.max(buckets[buckets.length - 1].end, ...percentileValues);
  if (valueMax <= valueMin) {
    renderEmpty(container, "还没有会话分布数据", "分桶区间退化为一个点，无法绘制分布");
    return buildCleanup();
  }

  const plotWidth = VIEWBOX_WIDTH - PLOT_LEFT - PLOT_RIGHT;
  const valueToX = (value) => PLOT_LEFT + ((value - valueMin) / (valueMax - valueMin)) * plotWidth;
  const bucketBandWidth = plotWidth / buckets.length;
  const bucketGap = bucketBandWidth >= 8 ? 2 : 0;

  container.innerHTML = `
    ${buildCardMetaHtml(distribution, totalSessions)}
    ${buildLegendHtml(percentileEntries)}
    <svg class="distribution-histogram-svg" viewBox="0 0 ${VIEWBOX_WIDTH} ${VIEWBOX_HEIGHT}" role="img" aria-label="会话 token 总量分布直方图，含 p50/p90/p99 分位标线">
      ${buildYAxisHtml(maxCount)}
      ${buildBarsHtml(buckets, maxCount, valueToX, bucketGap)}
      ${buildPercentileLinesHtml(percentileEntries, valueToX, plotWidth)}
      ${buildXAxisHtml(buckets, valueToX, plotWidth)}
    </svg>`;

  bindBucketTooltips(container, totalSessions);

  return buildCleanup();
}

/* ---------------- 状态块 ---------------- */

/** 接口不可达降级：state-views renderError 的语言，去掉重试按钮。 */
function renderUnreachableState(container) {
  container.innerHTML = `
    <div class="state-view error">
      <strong>这块数据没加载出来</strong>
      <div class="state-hint">会话分布数据不可达，下一次自动刷新会再试一次</div>
    </div>`;
}

/** 静态 SVG 无持久资源（监听都挂在随 innerHTML 销毁的子节点上），
 * cleanup 只需收起可能正悬浮的 tooltip。 */
function buildCleanup() {
  return () => hideTooltip();
}

/* ---------------- 数据整形 ---------------- */

/** 脏行防御：start/end/count 数值化，剔除非有限行与负 count，按 start 升序。 */
function normalizeBuckets(rawBuckets) {
  const usableBuckets = [];
  for (const rawBucket of Array.isArray(rawBuckets) ? rawBuckets : []) {
    const start = Number(rawBucket?.start);
    const end = Number(rawBucket?.end);
    const count = Number(rawBucket?.count);
    if (!Number.isFinite(start) || !Number.isFinite(end) || !Number.isFinite(count)) continue;
    if (end <= start || count < 0) continue;
    usableBuckets.push({ start, end, count });
  }
  usableBuckets.sort((left, right) => left.start - right.start);
  return usableBuckets;
}

/** percentiles 数值化 → [{ mark, value }]：只收有限非负项，缺失的
 * 分位线/图例 chip 直接不渲染（键值成对，不靠数组下标对齐）。 */
function readPercentiles(rawPercentiles) {
  const percentileEntries = [];
  for (const mark of PERCENTILE_MARKS) {
    const value = Number(rawPercentiles?.[mark.key]);
    if (Number.isFinite(value) && value >= 0) percentileEntries.push({ mark, value });
  }
  return percentileEntries;
}

/* ---------------- 卡头两行小字 + 图例 ---------------- */

function buildCardMetaHtml(distribution, totalSessions) {
  const mean = Number(distribution.mean);
  const max = Number(distribution.max);
  return `
    <div class="distribution-card-meta">
      <span>样本 <b class="num">${formatCount(totalSessions)}</b> 个会话 · 已排除零消耗</span>
      <span>均值 <b class="num">${formatTokens(mean)}</b> · 最大 <b class="num">${formatTokens(max)}</b> tokens</span>
    </div>`;
}

/** 分位图例：趋势图 .legend-chip 的静态形态（swatch + 名称），chip 内直接报值。 */
function buildLegendHtml(percentileEntries) {
  const chipsHtml = percentileEntries.map(({ mark, value }) => {
    const markColor = cssVar(mark.colorVar);
    return `
      <span class="legend-chip" title="${mark.key} = ${formatTokens(value)} tokens（全部会话分布）">
        <span class="swatch" style="background:${markColor}"></span>
        <span class="chip-name">${mark.key} ${formatTokens(value)}</span>
      </span>`;
  }).join("");
  return `<div class="distribution-legend">${chipsHtml}</div>`;
}

/* ---------------- 直方图 SVG ---------------- */

/** y 轴：0..maxCount 的「好数」刻度（1/2/5×10^k 步进），格式化走 formatCount。 */
function buildYAxisHtml(maxCount) {
  const step = niceCountStep(maxCount);
  const parts = [`<line x1="${PLOT_LEFT}" y1="${X_AXIS_Y}" x2="${VIEWBOX_WIDTH - PLOT_RIGHT}" y2="${X_AXIS_Y}" stroke="${cssVar("--grid-line")}"/>`];
  for (let tickValue = step; tickValue <= maxCount; tickValue += step) {
    const tickY = X_AXIS_Y - (tickValue / maxCount) * (X_AXIS_Y - PLOT_TOP);
    parts.push(`<line x1="${PLOT_LEFT}" y1="${tickY}" x2="${VIEWBOX_WIDTH - PLOT_RIGHT}" y2="${tickY}" stroke="${cssVar("--grid-line")}"/>`);
    parts.push(`<text x="${PLOT_LEFT - 8}" y="${tickY + 3.5}" text-anchor="end" font-size="10" fill="${cssVar("--text-faint")}" font-family="ui-monospace, Consolas, monospace">${formatCount(tickValue)}</text>`);
  }
  return parts.join("");
}

/** 柱体：count 为高；榜首桶用 accent（工具条形图 top 行同语言），其余 blue。 */
function buildBarsHtml(buckets, maxCount, valueToX, bucketGap) {
  const accentColor = cssVar("--accent");
  const barColor = cssVar("--blue");
  const tallestBucketCount = maxCount;
  const parts = [];
  for (const bucket of buckets) {
    if (bucket.count <= 0) continue;
    const barX = valueToX(bucket.start) + bucketGap / 2;
    const barWidth = Math.max(1, valueToX(bucket.end) - valueToX(bucket.start) - bucketGap);
    const barHeight = Math.max(1.5, (bucket.count / tallestBucketCount) * (X_AXIS_Y - PLOT_TOP));
    const fillColor = bucket.count === tallestBucketCount ? accentColor : barColor;
    parts.push(`
      <rect class="distribution-histogram-bar" data-bucket-start="${bucket.start}" data-bucket-end="${bucket.end}" data-bucket-count="${bucket.count}"
        x="${barX.toFixed(1)}" y="${(X_AXIS_Y - barHeight).toFixed(1)}" width="${barWidth.toFixed(1)}" height="${barHeight.toFixed(1)}" rx="2.5" fill="${fillColor}"/>`);
  }
  return parts.join("");
}

/** p50/p90/p99 竖标线：虚线（趋势图命中率折线的 dash 语言），值越界夹回绘图区。 */
function buildPercentileLinesHtml(percentileEntries, valueToX, plotWidth) {
  const parts = [];
  for (const { mark, value } of percentileEntries) {
    const lineX = Math.min(PLOT_LEFT + plotWidth, Math.max(PLOT_LEFT, valueToX(value)));
    parts.push(`<line class="distribution-quantile-line" x1="${lineX.toFixed(1)}" y1="${PLOT_TOP}" x2="${lineX.toFixed(1)}" y2="${X_AXIS_Y}" stroke="${cssVar(mark.colorVar)}" stroke-width="1.5" stroke-dasharray="5 4"/>`);
  }
  return parts.join("");
}

/** x 轴：刻度吸附到桶边界，标签粒度由 formatTokens 按量级自适应。 */
function buildXAxisHtml(buckets, valueToX, plotWidth) {
  const boundaryValues = [...new Set([...buckets.map((bucket) => bucket.start), buckets[buckets.length - 1].end])]
    .sort((left, right) => left - right);
  const tickCount = Math.min(MAX_X_TICKS, boundaryValues.length);
  const seenTickValues = new Set();
  const parts = [];
  for (let tickIndex = 0; tickIndex < tickCount; tickIndex += 1) {
    const boundaryIndex = Math.round((boundaryValues.length - 1) * (tickIndex / (tickCount - 1)));
    const tickValue = boundaryValues[boundaryIndex];
    if (seenTickValues.has(tickValue)) continue;
    seenTickValues.add(tickValue);
    const tickX = valueToX(tickValue);
    // 首尾刻度改锚点，防止标签越出 viewBox
    const textAnchor = tickX < PLOT_LEFT + 14 ? "start" : tickX > PLOT_LEFT + plotWidth - 14 ? "end" : "middle";
    parts.push(`<text x="${tickX.toFixed(1)}" y="${VIEWBOX_HEIGHT - 6}" text-anchor="${textAnchor}" font-size="10" fill="${cssVar("--text-faint")}" font-family="ui-monospace, Consolas, monospace">${escapeHtml(formatTokens(tickValue))}</text>`);
  }
  return parts.join("");
}

/* ---------------- 柱体悬浮提示 ---------------- */

function bindBucketTooltips(container, totalSessions) {
  for (const barElement of container.querySelectorAll(".distribution-histogram-bar")) {
    const bucketStart = Number(barElement.dataset.bucketStart);
    const bucketEnd = Number(barElement.dataset.bucketEnd);
    const bucketCount = Number(barElement.dataset.bucketCount);
    const bucketShare = totalSessions > 0 ? bucketCount / totalSessions : 0;
    bindHoverTooltip(barElement, () => ({
      title: `${formatTokens(bucketStart)} – ${formatTokens(bucketEnd)}`,
      rows: [
        { label: "会话数", value: formatCount(bucketCount) },
        { label: "样本占比", value: formatPercent(bucketShare) },
      ],
    }));
  }
}

/* ---------------- 小工具 ---------------- */

/** 1/2/5×10^k 步进中取 ≥ range/3 的最小者，保证 y 轴刻度是「好数」。 */
function niceCountStep(range) {
  const rawStep = Math.max(1, range / 3);
  const magnitude = Math.pow(10, Math.floor(Math.log10(rawStep)));
  for (const multiplier of [1, 2, 5, 10]) {
    const candidateStep = multiplier * magnitude;
    if (candidateStep >= rawStep) return candidateStep;
  }
  return 10 * magnitude;
}

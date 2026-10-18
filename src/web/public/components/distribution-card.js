/**
 * 会话 token 分布卡（v0.20.0）+ 共享分布直方图渲染器（v0.21.0）。
 *
 * 数据 = GET /api/session-distribution：
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
 *
 * v0.21.0 泛化：共享渲染器 renderSharedDistributionCard，三个
 * 分布卡（token / step / duration）共用同一份对数半档直方图 + p50/p90/p99
 * 标线 + 双主题逻辑，只差：
 *   - 轴刻度格式（formatAxis 回调）：token=formatTokens；step=整数
 *     formatCount；duration=formatDurationMs（毫秒 → "Xh Ym"）；
 *   - 卡头小字（样本 · 均值单位）。
 * 本文件仍导出 renderDistributionCard（token 卡公开签名，接线 lane 兼容
 * 不动）；step/duration 卡是薄封装（见 step-distribution-card.js /
 * duration-distribution-card.js），复用 renderSharedDistributionCard。
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

/** token 分布卡的展示选项（默认值即 token 卡原样，兼容接线 lane）。 */
const TOKEN_CARD_OPTIONS = {
  formatAxis: formatTokens,
  sampleUnit: "tokens",
  rawUnit: "tokens",
  exclusionLabel: "已排除零 tokens 会话",
  emptyHint: "全部会话中没有正值 token 用量可统计",
  ariaLabel: "会话 token 总量分布直方图，含 p50/p90/p99 分位标线",
};

/**
 * 渲染会话 token 分布卡。
 * @param {HTMLElement} container #session-distribution 挂载点
 * @param {object|null} distribution 契约对象（见文件头）或 null（接口不可达）
 * @returns {() => void} cleanup：静态 SVG 无持久资源，只收起悬浮提示
 */
export function renderDistributionCard(container, distribution) {
  return renderSharedDistributionCard(container, distribution, TOKEN_CARD_OPTIONS);
}

/**
 * 共享分布直方图渲染器（v0.21.0）。token / step / duration 三个分布卡
 * 都走这里。options：
 *   {
 *     formatAxis: (value) => string,   // x 轴刻度 + 卡头最大 + 图例值
 *     formatMean?: (value) => string,  // 卡头均值，默认与轴相同
 *     sampleUnit: string,              // 卡头均值/最大数字后的单位词
 *     rawUnit: string,                 // 桶原始边界单位（明细与 tooltip）
 *     exclusionLabel: string, emptyHint: string,
 *     ariaLabel: string,               // 直方图 aria-label
 *   }
 * distribution 形状三卡一致（见文件头契约）。
 * @returns {() => void} cleanup
 */
export function renderSharedDistributionCard(container, distribution, options) {
  const formatAxis = options.formatAxis;
  const formatMean = options.formatMean ?? formatAxis;
  const sampleUnit = options.sampleUnit;
  const ariaLabel = options.ariaLabel;

  if (distribution === null) {
    renderUnreachableState(container);
    return buildCleanup();
  }

  const buckets = normalizeBuckets(distribution.buckets);
  const totalSessions = Number(distribution.totalSessions);
  if (buckets.length === 0 || !Number.isFinite(totalSessions) || totalSessions <= 0) {
    renderEmpty(container, "还没有会话分布数据", options.emptyHint);
    return buildCleanup();
  }
  const maxCount = buckets.reduce((largest, bucket) => Math.max(largest, bucket.count), 0);
  if (maxCount <= 0) {
    renderEmpty(container, "还没有会话分布数据", options.emptyHint);
    return buildCleanup();
  }

  const percentileEntries = readPercentiles(distribution.percentiles);
  const plotWidth = VIEWBOX_WIDTH - PLOT_LEFT - PLOT_RIGHT;
  const bucketBandWidth = plotWidth / buckets.length;
  const bucketGap = bucketBandWidth >= 8 ? 2 : 0;

  container.innerHTML = `
    ${buildCardMetaHtml(distribution, totalSessions, formatAxis, formatMean, sampleUnit, options.exclusionLabel)}
    ${buildLegendHtml(percentileEntries, formatAxis)}
    <div class="distribution-histogram-scroll" tabindex="0" role="region" aria-label="${escapeHtml(ariaLabel)}，可横向滚动">
      <svg class="distribution-histogram-svg" viewBox="0 0 ${VIEWBOX_WIDTH} ${VIEWBOX_HEIGHT}" role="img" aria-label="${escapeHtml(ariaLabel)}；每档等宽、非线性数值轴；各档精确范围和数量见图后明细">
        ${buildYAxisHtml(maxCount)}
        ${buildBarsHtml(buckets, maxCount, bucketBandWidth, bucketGap)}
        ${buildPercentileLinesHtml(percentileEntries, buckets, bucketBandWidth)}
        ${buildXAxisHtml(buckets, bucketBandWidth, formatAxis)}
      </svg>
    </div>
    <details class="distribution-data-details">
      <summary>查看各档会话数（每档等宽展示）</summary>
      <div class="distribution-data-scroll"><table class="distribution-data-table">
        <thead><tr><th scope="col">范围（左闭右开）</th><th scope="col">会话数</th><th scope="col">样本占比</th></tr></thead>
        <tbody>${buildBucketRowsHtml(buckets, totalSessions, formatAxis, options.rawUnit)}</tbody>
      </table></div>
    </details>`;

  bindBucketTooltips(container, totalSessions, formatAxis, options.rawUnit);

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

function buildCardMetaHtml(distribution, totalSessions, formatAxis, formatMean, sampleUnit, exclusionLabel) {
  const mean = Number(distribution.mean);
  const max = Number(distribution.max);
  return `
    <div class="distribution-card-meta">
       <span>样本 <b class="num">${formatCount(totalSessions)}</b> 个会话 · ${escapeHtml(exclusionLabel)}</span>
       <span>均值 <b class="num">${escapeHtml(formatMean(mean))}</b> ${sampleUnit} · 最大 <b class="num">${escapeHtml(formatAxis(max))}</b> ${sampleUnit}</span>
    </div>`;
}

/** 分位图例：趋势图 .legend-chip 的静态形态（swatch + 名称），chip 内直接报值。 */
function buildLegendHtml(percentileEntries, formatAxis) {
  const chipsHtml = percentileEntries.map(({ mark, value }) => {
    const markColor = cssVar(mark.colorVar);
    return `
      <span class="legend-chip" title="${mark.key} = ${formatAxis(value)}（全部会话分布）">
        <span class="swatch" style="background:${markColor}"></span>
        <span class="chip-name">${mark.key} ${formatAxis(value)}</span>
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
function buildBarsHtml(buckets, maxCount, bucketBandWidth, bucketGap) {
  const accentColor = cssVar("--accent");
  const barColor = cssVar("--blue");
  const tallestBucketCount = maxCount;
  const parts = [];
  for (const [bucketIndex, bucket] of buckets.entries()) {
    if (bucket.count <= 0) continue;
    const barX = PLOT_LEFT + bucketIndex * bucketBandWidth + bucketGap / 2;
    const barWidth = Math.max(1, bucketBandWidth - bucketGap);
    const barHeight = Math.max(1.5, (bucket.count / tallestBucketCount) * (X_AXIS_Y - PLOT_TOP));
    const fillColor = bucket.count === tallestBucketCount ? accentColor : barColor;
    parts.push(`
      <rect class="distribution-histogram-bar" data-bucket-start="${bucket.start}" data-bucket-end="${bucket.end}" data-bucket-count="${bucket.count}"
        x="${barX.toFixed(1)}" y="${(X_AXIS_Y - barHeight).toFixed(1)}" width="${barWidth.toFixed(1)}" height="${barHeight.toFixed(1)}" rx="2.5" fill="${fillColor}"/>`);
  }
  return parts.join("");
}

/** 等宽桶中按该桶真实边界插值；分位值不会漂到相邻桶。 */
function bucketValueToX(value, buckets, bucketBandWidth) {
  if (value <= buckets[0].start) return PLOT_LEFT;
  for (const [bucketIndex, bucket] of buckets.entries()) {
    if (value < bucket.end || bucketIndex === buckets.length - 1) {
      const fraction = Math.max(0, Math.min(1, (value - bucket.start) / (bucket.end - bucket.start)));
      return PLOT_LEFT + (bucketIndex + fraction) * bucketBandWidth;
    }
  }
  return PLOT_LEFT + buckets.length * bucketBandWidth;
}

/** p50/p90/p99 竖标线：虚线（趋势图命中率折线的 dash 语言）。 */
function buildPercentileLinesHtml(percentileEntries, buckets, bucketBandWidth) {
  const parts = [];
  for (const { mark, value } of percentileEntries) {
    const lineX = bucketValueToX(value, buckets, bucketBandWidth);
    parts.push(`<line class="distribution-quantile-line" x1="${lineX.toFixed(1)}" y1="${PLOT_TOP}" x2="${lineX.toFixed(1)}" y2="${X_AXIS_Y}" stroke="${cssVar(mark.colorVar)}" stroke-width="1.5" stroke-dasharray="5 4"/>`);
  }
  return parts.join("");
}

/** x 轴：按实际桶边界均匀选刻度，与等宽柱体一一对应。 */
function buildXAxisHtml(buckets, bucketBandWidth, formatAxis) {
  const tickCount = Math.min(MAX_X_TICKS, buckets.length + 1);
  const seenBoundaryIndices = new Set();
  const parts = [];
  for (let tickIndex = 0; tickIndex < tickCount; tickIndex += 1) {
    const boundaryIndex = Math.round(buckets.length * (tickIndex / Math.max(1, tickCount - 1)));
    if (seenBoundaryIndices.has(boundaryIndex)) continue;
    seenBoundaryIndices.add(boundaryIndex);
    const tickValue = boundaryIndex === buckets.length ? buckets[buckets.length - 1].end : buckets[boundaryIndex].start;
    const tickX = PLOT_LEFT + boundaryIndex * bucketBandWidth;
    // 首尾刻度改锚点，防止标签越出 viewBox
    const textAnchor = boundaryIndex === 0 ? "start" : boundaryIndex === buckets.length ? "end" : "middle";
    parts.push(`<text x="${tickX.toFixed(1)}" y="${VIEWBOX_HEIGHT - 6}" text-anchor="${textAnchor}" font-size="10" fill="${cssVar("--text-faint")}" font-family="ui-monospace, Consolas, monospace">${escapeHtml(formatAxis(tickValue))}</text>`);
  }
  return parts.join("");
}

/** 键盘/读屏可展开的精确分桶明细，包含零会话的桶。 */
function buildBucketRowsHtml(buckets, totalSessions, formatAxis, rawUnit) {
  return buckets.map((bucket) => `<tr>
    <th scope="row" title="原始边界：${bucket.start} – ${bucket.end} ${escapeHtml(rawUnit)}"><span aria-hidden="true">${escapeHtml(formatAxis(bucket.start))} – ${escapeHtml(formatAxis(bucket.end))}</span><span class="distribution-sr-only">${bucket.start} 至 ${bucket.end} ${escapeHtml(rawUnit)}</span></th>
    <td>${formatCount(bucket.count)}</td>
    <td>${formatPercent(bucket.count / totalSessions)}</td>
  </tr>`).join("");
}

/* ---------------- 柱体悬浮提示 ---------------- */

function bindBucketTooltips(container, totalSessions, formatAxis, rawUnit) {
  for (const barElement of container.querySelectorAll(".distribution-histogram-bar")) {
    const bucketStart = Number(barElement.dataset.bucketStart);
    const bucketEnd = Number(barElement.dataset.bucketEnd);
    const bucketCount = Number(barElement.dataset.bucketCount);
    const bucketShare = totalSessions > 0 ? bucketCount / totalSessions : 0;
    bindHoverTooltip(barElement, () => ({
      title: `${formatAxis(bucketStart)} – ${formatAxis(bucketEnd)}`,
      rows: [
        { label: "原始边界（左闭右开）", value: `${bucketStart} – ${bucketEnd} ${rawUnit}` },
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

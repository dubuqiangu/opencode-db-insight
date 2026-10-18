/** 工具错误逐日趋势：数据由调用方传入；图表/范围选择均不发请求。 */
import { dateKeyToEpoch, epochToDateKey, escapeHtml, formatCount, formatPercent } from "../format.js";
import { MAX_TREND_DAYS } from "../data-source.js";
import { cssVar } from "../theme.js";
import { showTooltip, hideTooltip } from "../tooltip.js";
import { renderEmpty } from "./state-views.js";

const CHART_HEIGHT = 340;
/** 跟随趋势图先例：跨主题切换、自动刷新、时间范围重渲保留用户开关。 */
let rateVisible = true;
/** 最近请求的范围；请求在途时也允许点回尚未重渲的旧范围。 */
let requestedDays = 30;
const RANGE_OPTIONS = [
  { days: 30, label: "30d" },
  { days: 90, label: "90d" },
  { days: MAX_TREND_DAYS, label: "全部" },
];

function rangeSelectorHtml(selectedDays) {
  const buttons = RANGE_OPTIONS.map(({ days, label }) =>
    `<button type="button" data-tool-error-days="${days}" class="${selectedDays === days ? "active" : ""}" aria-pressed="${selectedDays === days}">${label}</button>`,
  ).join("");
  return `<div class="range-switch tool-error-range" role="group" aria-label="工具错误趋势时间范围">${buttons}</div>`;
}

function renderUnreachable(container) {
  container.innerHTML = `<div class="state-view error"><strong>这块数据没加载出来</strong>
    <div class="state-hint">工具错误趋势数据不可达，下一次自动刷新会再试一次</div></div>`;
}

/** 刻度保持整数，最大值为 1 时也有 0 和 1 两个刻度。 */
function integerSplits(maximum) {
  const rawStep = Math.max(1, Math.ceil(maximum / 4));
  const magnitude = 10 ** Math.floor(Math.log10(rawStep));
  const step = [1, 2, 5, 10].map((multiple) => multiple * magnitude)
    .find((candidate) => candidate >= rawStep) ?? 10 * magnitude;
  const splits = [];
  for (let count = 0; count <= maximum; count += step) splits.push(count);
  if (splits.length === 1) splits.push(maximum);
  return splits;
}

/** 返回清理函数，包含 uPlot / ResizeObserver / tooltip 监听器。 */
export function renderToolErrorTrendCard(container, payload, options = {}) {
  if (payload === null) {
    renderUnreachable(container);
    return () => {};
  }

  const selectedDays = RANGE_OPTIONS.some((range) => range.days === Number(payload?.days))
    ? Number(payload.days) : 30;
  requestedDays = selectedDays;
  container.innerHTML = `<div class="tool-error-toolbar">
    <span class="tool-error-toolbar-label">统计范围</span>${rangeSelectorHtml(selectedDays)}
  </div><div class="tool-error-content"></div>`;
  for (const button of container.querySelectorAll("button[data-tool-error-days]")) {
    button.addEventListener("click", () => {
      const nextDays = Number(button.dataset.toolErrorDays);
      if (nextDays !== requestedDays) {
        requestedDays = nextDays;
        options.onDaysChange?.(nextDays);
      }
    });
  }

  const content = container.querySelector(".tool-error-content");
  const points = Array.isArray(payload?.points) ? payload.points : [];
  // 先验证本地日再进图表与统计；非法日期不能作为 NaN 送入 uPlot x 轴。
  const safePoints = points.flatMap((point) => {
    if (typeof point?.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(point.date)) return [];
    const timestamp = dateKeyToEpoch(point.date);
    if (!Number.isFinite(timestamp) || epochToDateKey(timestamp) !== point.date) return [];
    return [{
      date: point.date,
      timestamp,
      toolCalls: Number.isFinite(point.toolCalls) ? Math.max(0, point.toolCalls) : 0,
      errors: Number.isFinite(point.errors) ? Math.max(0, point.errors) : 0,
      errorRate: Number.isFinite(point.errorRate) ? Math.min(1, Math.max(0, point.errorRate)) : 0,
    }];
  });
  if (safePoints.length < 2 || safePoints.every((point) => point.errors <= 0)) {
    renderEmpty(content, "这段范围内没有工具错误趋势", "至少需要两个本地日，且有工具错误记录；可切换时间范围");
    return () => {};
  }

  const maximumErrors = Math.max(1, ...safePoints.map((point) => point.errors));
  const totalErrors = safePoints.reduce((sum, point) => sum + point.errors, 0);
  const totalCalls = safePoints.reduce((sum, point) => sum + point.toolCalls, 0);
  content.innerHTML = `<div class="tool-error-summary">
    <span><b class="num">${formatCount(totalErrors)}</b> 次错误 <span class="tool-error-summary-separator">/</span> ${formatCount(totalCalls)} 次调用</span>
    <span>窗口错误率 <b class="num">${totalCalls > 0 ? formatPercent(totalErrors / totalCalls) : "—"}</b></span>
  </div><div class="tool-error-legend">
    <span class="legend-chip"><span class="swatch tool-error-count-swatch"></span><span class="chip-name">错误数 · 左轴</span></span>
    <button type="button" class="legend-chip tool-error-rate-toggle${rateVisible ? "" : " off"}" aria-pressed="${rateVisible}" title="显示或隐藏错误率折线（右轴）">
      <span class="swatch tool-error-rate-swatch"></span><span class="chip-name">错误率 · 右轴</span>
    </button>
  </div><div class="tool-error-chart-scroll" tabindex="0" role="region" aria-label="工具错误数和错误率趋势图，可横向滚动">
    <div class="tool-error-plot" role="img" aria-label="工具错误数和错误率双轴图；每日精确数据见图下方明细"></div>
  </div><details class="distribution-data-details tool-error-details">
    <summary>查看每日错误与调用明细</summary>
    <div class="distribution-data-scroll"><table class="distribution-data-table">
      <thead><tr><th scope="col">本地日</th><th scope="col">调用数</th><th scope="col">错误数</th><th scope="col">错误率</th></tr></thead>
      <tbody>${safePoints.map((point) => `<tr><th scope="row">${escapeHtml(point.date)}</th><td>${formatCount(point.toolCalls)}</td><td>${formatCount(point.errors)}</td><td>${formatPercent(point.errorRate)}</td></tr>`).join("")}</tbody>
    </table></div>
  </details>`;

  const chartMount = content.querySelector(".tool-error-plot");
  const chartScroll = content.querySelector(".tool-error-chart-scroll");
  const rateToggle = content.querySelector(".tool-error-rate-toggle");
  const timestamps = safePoints.map((point) => point.timestamp / 1000);
  const errorCounts = safePoints.map((point) => point.errors);
  const errorPercentages = safePoints.map((point) => point.errorRate * 100);
  const gridColor = cssVar("--grid-line");
  const textColor = cssVar("--text-dim");
  const rateColor = cssVar("--red");

  const chart = new uPlot({
    width: Math.max(320, chartScroll.clientWidth),
    height: CHART_HEIGHT,
    legend: { show: false },
    cursor: { drag: { x: false, y: false } },
    scales: {
      y: { range: [0, maximumErrors] },
      errorRate: { range: [0, 100] },
    },
    axes: [
      {
        grid: { show: true, stroke: gridColor }, ticks: { show: false }, stroke: textColor,
        font: "10px ui-monospace, Consolas, monospace",
        values: (chartInstance, ticks) => ticks.map((seconds) => {
          const date = new Date(seconds * 1000);
          return `${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
        }),
      },
      {
        grid: { show: true, stroke: gridColor }, ticks: { show: false }, stroke: textColor,
        font: "10px ui-monospace, Consolas, monospace", size: 52,
        splits: () => integerSplits(maximumErrors),
        values: (chartInstance, ticks) => ticks.map((count) => formatCount(count)),
      },
      {
        side: 3, scale: "errorRate", grid: { show: false }, stroke: rateColor,
        font: "10px ui-monospace, Consolas, monospace", size: 44,
        values: (chartInstance, ticks) => ticks.map((percent) => `${percent.toFixed(0)}%`),
      },
    ],
    series: [
      {},
      { label: "错误数", stroke: cssVar("--amber"), fill: cssVar("--amber-soft"), width: 2 },
      { label: "错误率", scale: "errorRate", stroke: rateColor, width: 1.8, dash: [6, 4] },
    ],
    hooks: {
      setCursor: [(chartInstance) => {
        const pointIndex = chartInstance.cursor.idx;
        if (pointIndex === null || pointIndex === undefined || !safePoints[pointIndex]) {
          hideTooltip();
          return;
        }
        const point = safePoints[pointIndex];
        const bounds = chartMount.getBoundingClientRect();
        showTooltip({
          title: point.date,
          rows: [
            { label: "工具调用", value: formatCount(point.toolCalls) },
            { label: "错误数", swatch: cssVar("--amber"), value: formatCount(point.errors) },
            ...(rateVisible ? [{ label: "错误率", swatch: rateColor, value: formatPercent(point.errorRate) }] : []),
          ],
          clientX: bounds.left + chartInstance.cursor.left,
          clientY: bounds.top + chartInstance.cursor.top,
        });
      }],
    },
  }, [timestamps, errorCounts, errorPercentages], chartMount);
  if (!rateVisible) chart.setSeries(2, { show: false });

  const onToggleRate = () => {
    rateVisible = !rateVisible;
    chart.setSeries(2, { show: rateVisible });
    rateToggle.classList.toggle("off", !rateVisible);
    rateToggle.setAttribute("aria-pressed", String(rateVisible));
    hideTooltip();
  };
  rateToggle.addEventListener("click", onToggleRate);
  const onMouseLeave = () => hideTooltip();
  chartMount.addEventListener("mouseleave", onMouseLeave);
  const resizeObserver = new ResizeObserver(() => {
    chart.setSize({ width: Math.max(320, chartScroll.clientWidth), height: CHART_HEIGHT });
  });
  resizeObserver.observe(chartScroll);

  return () => {
    resizeObserver.disconnect();
    rateToggle.removeEventListener("click", onToggleRate);
    chartMount.removeEventListener("mouseleave", onMouseLeave);
    hideTooltip();
    chart.destroy();
  };
}

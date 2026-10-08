/**
 * 逐日消耗：uPlot 堆叠面积图（按模型分色，图例可开关）+ 命中率折线（右轴）。
 *
 * 堆叠实现：uPlot 无原生 stack，这里用「倒序累计 + 不透明面积」配方——
 * 每条 series 的值是该层及以上所有可见模型的累计值，绘制顺序从总量到
 * 最小层，后画的盖住先画的，留下的差值就是各模型的分层带。
 * 关闭某个模型 = 从可见集合剔除后整体重算累计并重建图表（保证缩放正确）。
 *
 * 数据形状 = data-source.fetchTrend()：{ points: DailyTrendPoint[],
 * byModel: [{ modelId, values }] }。
 */

import { formatTokens, formatPercent, escapeHtml, dateKeyToEpoch } from "../format.js";
import { cssVar, modelPalette } from "../theme.js";
import { showTooltip, moveTooltip, hideTooltip } from "../tooltip.js";
import { renderEmpty } from "./state-views.js";

const CHART_HEIGHT = 340;
const MAX_STACKED_MODELS = 7; // 超出的并入「其他」

/** 用户手动关掉的模型，跨时间范围切换保留。 */
const hiddenModelIds = new Set();
let hitRateVisible = true;

/**
 * 窗口内每个模型的总 token，降序取前 N；byModel 为空（v0.11.0 前旧 wire /
 * 透视后无模型数据时）降级为「总量」单层。
 * v0.11.0 起导出：这是堆叠图的 series 构建纯函数（无 canvas 依赖），
 * 是 trend-chart 唯一可离线测试的层——渲染整体依赖 uPlot 运行时，
 * 图表层回归靠真实路径探针兜底。
 */
export function rankModels(trendData) {
  const byModel = Array.isArray(trendData.byModel) ? trendData.byModel : [];
  if (byModel.length === 0) {
    return [{
      modelId: "总量",
      total: trendData.points.reduce((sum, point) => sum + point.input + point.read + point.output, 0),
      values: trendData.points.map((point) => point.input + point.read + point.output),
    }];
  }

  const windowSums = byModel.map((series) => ({
    modelId: series.modelId,
    total: series.values.reduce((sum, value) => sum + value, 0),
    values: series.values,
  }));
  windowSums.sort((left, right) => right.total - left.total);

  const named = windowSums.slice(0, MAX_STACKED_MODELS);
  const restTotal = windowSums.slice(MAX_STACKED_MODELS).reduce((sum, series) => sum + series.total, 0);

  const layers = named.map((series) => ({ ...series }));
  if (restTotal > 0) {
    // 「其他」= 当日总量 - 已命名层之和（避免四舍五入产生悬空）
    layers.push({
      modelId: "其他",
      total: restTotal,
      values: trendData.points.map((point, dayIndex) => {
        const dayTotal = point.input + point.read + point.output;
        const namedSum = named.reduce((sum, series) => sum + series.values[dayIndex], 0);
        return Math.max(0, dayTotal - namedSum);
      }),
    });
  }
  return layers;
}

/** 可见层（保持 token 降序），累计到层 k 为止的曲线。 */
function buildStackedData(layers, timestampsSeconds) {
  const visibleLayers = layers.filter((layer) => !hiddenModelIds.has(layer.modelId));
  const cumulativeSeries = visibleLayers.map((_, upToIndex) =>
    visibleLayers
      .slice(0, upToIndex + 1)
      .reduce((accumulator, layer) => accumulator.map((value, dayIndex) => value + layer.values[dayIndex]),
        new Array(timestampsSeconds.length).fill(0)),
  );
  return { visibleLayers, cumulativeSeries };
}

function renderLegend(legendContainer, layers, onToggle) {
  const palette = modelPalette();
  const chips = layers.map((layer, rank) => {
    const color = layer.modelId === "其他" ? cssVar("--m12") : palette[rank % palette.length];
    const isOff = hiddenModelIds.has(layer.modelId);
    return `
      <button type="button" class="legend-chip ${isOff ? "off" : ""}" data-model="${escapeHtml(layer.modelId)}" title="${escapeHtml(layer.modelId)} · 本窗口 ${formatTokens(layer.total)} tokens">
        <span class="swatch" style="background:${color}"></span>
        <span class="chip-name">${escapeHtml(layer.modelId)}</span>
      </button>`;
  });
  chips.push(`
    <button type="button" class="legend-chip ${hitRateVisible ? "" : "off"}" data-hitraterole="1" title="缓存命中率（右轴）">
      <span class="swatch" style="background:transparent; border:1.5px dashed ${cssVar("--accent")}; border-radius:6px"></span>
      <span class="chip-name">命中率</span>
    </button>`);
  legendContainer.innerHTML = chips.join("");

  legendContainer.querySelectorAll("button").forEach((chip) => {
    chip.addEventListener("click", () => {
      const modelName = chip.dataset.model;
      if (modelName !== undefined) {
        if (hiddenModelIds.has(modelName)) hiddenModelIds.delete(modelName);
        else hiddenModelIds.add(modelName);
      } else {
        hitRateVisible = !hitRateVisible;
      }
      onToggle();
    });
  });
}

/**
 * 渲染趋势图。返回 cleanup 函数（销毁 uPlot 实例与 ResizeObserver）。
 * trendData 为 null/points 不足时渲染空占位。
 */
export function renderTrendChart(container, legendContainer, trendData) {
  if (trendData === null || trendData.points.length < 2) {
    renderEmpty(container, "这段范围内没有逐日数据", "换个时间范围，或确认数据库里有 assistant 消息");
    if (legendContainer) legendContainer.innerHTML = "";
    return () => {};
  }

  const palette = modelPalette();
  const layers = rankModels(trendData);
  const timestampsSeconds = trendData.points.map((point) => dateKeyToEpoch(point.date) / 1000);
  const hitRateValues = trendData.points.map((point) => Math.round(point.hitRate * 1000) / 10);
  const textColor = cssVar("--text-dim");
  const gridColor = cssVar("--grid-line");
  const accentColor = cssVar("--accent");

  let cleanupPreviousPlot = null;

  const buildPlot = () => {
    if (cleanupPreviousPlot) cleanupPreviousPlot();
    container.innerHTML = "";

    const { visibleLayers, cumulativeSeries } = buildStackedData(layers, timestampsSeconds);
    if (visibleLayers.length === 0) {
      renderEmpty(container, "所有模型都被关掉了", "点上方图例芯片恢复显示");
      return;
    }

    // 绘制顺序：总量层最先画（被后画的逐层盖住），命中率折线最后画在最顶
    const seriesConfigs = [];
    for (let layerIndex = visibleLayers.length - 1; layerIndex >= 0; layerIndex -= 1) {
      const rank = layers.findIndex((layer) => layer.modelId === visibleLayers[layerIndex].modelId);
      const color = visibleLayers[layerIndex].modelId === "其他"
        ? cssVar("--m12")
        : palette[rank % palette.length];
      seriesConfigs.push({
        label: visibleLayers[layerIndex].modelId,
        stroke: "transparent",
        width: 0,
        fill: color,
        _rawValues: visibleLayers[layerIndex].values,
        _color: color,
      });
    }
    if (hitRateVisible) {
      seriesConfigs.push({
        label: "命中率",
        scale: "hit",
        stroke: accentColor,
        width: 1.6,
        dash: [6, 4],
        _rawValues: hitRateValues,
        _color: accentColor,
      });
    }

    const plotData = [timestampsSeconds, ...seriesConfigs.map((config) => config._rawValues)];

    const plot = new uPlot({
      width: Math.max(320, container.clientWidth),
      height: CHART_HEIGHT,
      legend: { show: false },
      cursor: { drag: { x: false, y: false } },
      scales: { hit: { range: [0, 100] } },
      axes: [
        {
          grid: { show: true, stroke: gridColor, width: 1 / devicePixelRatio },
          ticks: { show: false },
          stroke: textColor,
          font: '10px ui-monospace, Consolas, monospace',
          values: (self, tickValues) =>
            tickValues.map((tickSeconds) => {
              const date = new Date(tickSeconds * 1000);
              return `${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
            }),
        },
        {
          // 左轴：默认 "y" 刻度（堆叠面积的累计值都在默认刻度上）
          grid: { show: true, stroke: gridColor, width: 1 / devicePixelRatio },
          ticks: { show: false },
          stroke: textColor,
          font: '10px ui-monospace, Consolas, monospace',
          size: 52,
          values: (self, tickValues) => tickValues.map((value) => formatTokens(value)),
        },
        {
          side: 3,
          scale: "hit",
          grid: { show: false },
          stroke: accentColor,
          font: '10px ui-monospace, Consolas, monospace',
          size: 42,
          values: (self, tickValues) => tickValues.map((value) => value.toFixed(0) + "%"),
        },
      ],
      series: [{}, ...seriesConfigs],
      hooks: {
        setCursor: [
          (plotInstance) => {
            const hoverIndex = plotInstance.cursor.idx;
            if (hoverIndex === null || hoverIndex === undefined) return;
            const point = trendData.points[hoverIndex];
            const dayTotal = point.input + point.read + point.output;
            const rows = [{ label: "总量", value: formatTokens(dayTotal) + " tok" }];
            for (const config of seriesConfigs) {
              if (config.scale === "hit") {
                rows.push({ label: "命中率", swatch: config._color, value: formatPercent(point.hitRate) });
              } else {
                const rawValue = config._rawValues[hoverIndex];
                if (rawValue > 0) {
                  rows.push({ label: config.label, swatch: config._color, value: formatTokens(rawValue) });
                }
              }
            }
            const bounds = container.getBoundingClientRect();
            showTooltip({
              title: point.date,
              rows,
              clientX: bounds.left + plotInstance.cursor.left,
              clientY: bounds.top + plotInstance.cursor.top,
            });
          },
        ],
      },
    }, plotData, container);

    const resizeObserver = new ResizeObserver(() => {
      plot.setSize({ width: Math.max(320, container.clientWidth), height: CHART_HEIGHT });
    });
    resizeObserver.observe(container);

    const mouseLeaveHandler = () => hideTooltip();
    container.addEventListener("mouseleave", mouseLeaveHandler);

    cleanupPreviousPlot = () => {
      resizeObserver.disconnect();
      container.removeEventListener("mouseleave", mouseLeaveHandler);
      plot.destroy();
    };
  };

  if (legendContainer) {
    renderLegend(legendContainer, layers, rebuild);
  }
  buildPlot();

  function rebuild() {
    if (legendContainer) renderLegend(legendContainer, layers, rebuild);
    buildPlot();
  }

  return () => {
    if (cleanupPreviousPlot) cleanupPreviousPlot();
  };
}

/**
 * Token 漏斗：上下文供给 → 缓存命中 → 实付输入 → 输出（4 层梯形，手写 SVG）。
 * 层宽严格按数值比例（这就是叙事点：97% 命中意味着实付层几乎消失）。
 * 数据复用 trend 接口并在窗口内求和——保证与 KPI 卡口径一致。
 * 返回窗口汇总供 app.js 填充面板标题右侧的命中率说明。
 */

import { formatTokens, formatPercent, escapeHtml } from "../format.js";
import { cssVar } from "../theme.js";
import { bindHoverTooltip } from "../tooltip.js";
import { renderEmpty } from "./state-views.js";

const VIEWBOX_WIDTH = 640;
const LAYER_HEIGHT = 54;
const LAYER_GAP = 10;
const FUNNEL_CENTER_X = 210;
const FUNNEL_MAX_HALF_WIDTH = 200;
const LABEL_COLUMN_X = 442;

const LAYER_DEFS = [
  { key: "supply", label: "上下文供给", colorVar: "--blue",   describe: "input + cache.read（进入模型窗口的总量）" },
  { key: "cached", label: "缓存命中",   colorVar: "--accent", describe: "cache.read（免费续读的部分）" },
  { key: "paid",   label: "实付输入",   colorVar: "--amber",  describe: "input（真正按输入计费的部分）" },
  { key: "output", label: "输出",       colorVar: "--purple", describe: "output（含 reasoning）" },
];

/** 窗口内各层求和（口径：DESIGN §5）。 */
function summarizeWindow(trendPoints) {
  const summary = { supply: 0, cached: 0, paid: 0, output: 0 };
  for (const point of trendPoints) {
    summary.paid += point.input;
    summary.cached += point.read;
    summary.output += point.output;
  }
  summary.supply = summary.cached + summary.paid;
  return summary;
}

/**
 * 渲染漏斗。返回 { windowHitRate, ...summary }；trendData 为 null/全零时
 * 渲染空占位并返回 null。
 */
export function renderTokenFunnel(container, trendData) {
  const summary = trendData === null ? null : summarizeWindow(trendData.points);
  if (summary === null || summary.supply <= 0) {
    renderEmpty(container, "这段范围内没有 token 流水");
    return null;
  }

  const windowHitRate = summary.cached / summary.supply;
  const layerValues = {
    supply: summary.supply,
    cached: summary.cached,
    paid: summary.paid,
    output: summary.output,
  };
  const halfWidths = LAYER_DEFS.map((def) => Math.max(0.004, layerValues[def.key] / layerValues.supply) * FUNNEL_MAX_HALF_WIDTH);

  const svgHeight = LAYER_DEFS.length * (LAYER_HEIGHT + LAYER_GAP) - LAYER_GAP + 6;
  const layerParts = [];

  for (let layerIndex = 0; layerIndex < LAYER_DEFS.length; layerIndex += 1) {
    const def = LAYER_DEFS[layerIndex];
    const topHalfWidth = halfWidths[layerIndex];
    const bottomHalfWidth = halfWidths[Math.min(layerIndex + 1, LAYER_DEFS.length - 1)];
    const yTop = layerIndex * (LAYER_HEIGHT + LAYER_GAP) + 4;
    const yBottom = yTop + LAYER_HEIGHT;
    const color = cssVar(def.colorVar);
    const sharePercent = ((layerValues[def.key] / layerValues.supply) * 100).toFixed(1);

    const trapezoidPoints = [
      `${FUNNEL_CENTER_X - topHalfWidth},${yTop}`,
      `${FUNNEL_CENTER_X + topHalfWidth},${yTop}`,
      `${FUNNEL_CENTER_X + bottomHalfWidth},${yBottom}`,
      `${FUNNEL_CENTER_X - bottomHalfWidth},${yBottom}`,
    ].join(" ");

    const labelYCenter = yTop + LAYER_HEIGHT / 2;
    layerParts.push(`
      <g class="funnel-layer" data-layer="${def.key}" data-value="${layerValues[def.key]}" data-share="${sharePercent}" data-describe="${escapeHtml(def.describe)}">
        <polygon points="${trapezoidPoints}" fill="${color}" opacity="0.88" stroke="${color}" stroke-width="1"/>
        <text x="${LABEL_COLUMN_X}" y="${labelYCenter - 3}" font-size="12" fill="${cssVar("--text")}" font-weight="600">${def.label}</text>
        <text x="${LABEL_COLUMN_X}" y="${labelYCenter + 14}" font-size="11.5" fill="${color}" font-family="ui-monospace, Consolas, monospace">${formatTokens(layerValues[def.key])} · ${sharePercent}%</text>
      </g>`);
  }

  container.innerHTML = `
    <svg class="funnel-svg" viewBox="0 0 ${VIEWBOX_WIDTH} ${svgHeight}" role="img" aria-label="Token 漏斗：供给、命中、实付、输出">${layerParts.join("")}</svg>`;

  for (const layer of container.querySelectorAll(".funnel-layer")) {
    bindHoverTooltip(layer, () => ({
      title: LAYER_DEFS.find((def) => def.key === layer.dataset.layer).label,
      rows: [
        { label: "token 量", value: formatTokens(Number(layer.dataset.value)) },
        { label: "占供给", value: layer.dataset.share + "%" },
      ],
    }));
  }

  return { windowHitRate, ...summary };
}

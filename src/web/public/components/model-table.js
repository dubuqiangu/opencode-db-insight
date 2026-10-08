/**
 * 模型排行榜明细表（DESIGN §5 单点指标全列，列头点击排序）。
 * 行点击触发下钻回调（app.js 用它过滤会话列表）。
 * 通道不报缓存的模型命中率显示 "—" 并带说明徽标（DESIGN §10）。
 * v0.12.0：新增「token 占比」列（窗口内 token 份额，紧邻「总 token」）。
 */

import {
  formatTokens, formatCount, formatPercent, formatSeenRange, escapeHtml,
} from "../format.js";
import { modelPalette } from "../theme.js";
import { renderEmpty, renderLoading } from "./state-views.js";

/** 列定义：key 对应 ModelMetric 字段，numeric 决定排序与对齐。 */
const COLUMNS = [
  { key: "modelId", label: "模型", numeric: false },
  { key: "providerId", label: "Provider", numeric: false },
  { key: "steps", label: "步骤", numeric: true },
  { key: "tokens", label: "总 token", numeric: true },
  // v0.12.0 token 占比：0..1 原始分数（wire 契约，分母 0 时全 0）。
  // 紧邻「总 token」——占比是其派生读数，相邻便于逐行对照。显示 2 位
  // 小数：长尾模型份额常 <1%，1 位小数把活库 55/85 行渲染成 "0.0%"，
  // 列的信息量失效；2 位让 0.05%–1% 长尾可读。旧 wire（宿主更新窗口期
  // 字段缺失）与脏值（NaN/Infinity）降级 "—"——分母未知时显示 0.00% 是
  // 谎报；排序的 ?? 0 兜底由 compareMetric 数值路径既有逻辑覆盖，不炸。
  { key: "tokenShare", label: "token 占比", numeric: true },
  { key: "hitRate", label: "命中率", numeric: true },
  { key: "outputPerStep", label: "步均输出", numeric: true },
  { key: "contextMedian", label: "中位上下文", numeric: true },
  { key: "contextP95", label: "p95 上下文", numeric: true },
  { key: "reasoningShare", label: "推理占比", numeric: true },
  { key: "seenRange", label: "活跃区间", numeric: false },
];

/** 排序状态跨渲染保留：默认按总 token 降序。 */
let sortKey = "tokens";
let sortDirection = "desc";

function compareMetric(left, right, key) {
  if (key === "modelId" || key === "providerId") {
    return String(left[key]).localeCompare(String(right[key]));
  }
  if (key === "seenRange") {
    return left.lastSeen - right.lastSeen;
  }
  return (left[key] ?? 0) - (right[key] ?? 0);
}

function sortModels(modelMetrics) {
  // 比较器直接带方向，不 sort 后 reverse：reverse 会把并列项次序整个翻转
  // （并列项本应保持原始次序，即 token 排名序）。Array#sort 在 ES2019+ 稳定。
  const directionSign = sortDirection === "desc" ? -1 : 1;
  return [...modelMetrics].sort(
    (left, right) => compareMetric(left, right, sortKey) * directionSign,
  );
}

function hitRateCell(metric) {
  // 通道不报缓存：DESIGN §10 —— hitRate 为 0 视为 provider 侧不上报缓存
  if (metric.cacheSupported === false || (metric.hitRate === 0 && metric.tokens > 0)) {
    return `<span class="hit-pill low">—</span> <span class="badge no-cache" title="该通道不上报缓存用量，命中率不可得（DESIGN §10）">通道无缓存</span>`;
  }
  const isHigh = metric.hitRate >= 0.9;
  return `<span class="hit-pill ${isHigh ? "" : "low"}">${formatPercent(metric.hitRate, 1)}</span>`;
}

/**
 * 渲染模型排行榜。
 * onSelectModel(modelId | null)：行点击下钻；再次点击同一行取消。
 */
export function renderModelTable(container, modelMetrics, selectedModelId, onSelectModel) {
  if (modelMetrics === null) {
    renderLoading(container, 4);
    return;
  }
  if (modelMetrics.length === 0) {
    renderEmpty(container, "没有模型记录", "数据库里还没有 assistant 消息");
    return;
  }

  const palette = modelPalette();
  const tokenRankColor = new Map(
    [...modelMetrics]
      .sort((left, right) => right.tokens - left.tokens)
      .map((metric, rank) => [metric.modelId, palette[rank % palette.length]]),
  );

  const headCells = COLUMNS.map((column) => {
    const isSorted = column.key === sortKey;
    const arrow = isSorted ? `<span class="sort-arrow">${sortDirection === "asc" ? "▲" : "▼"}</span>` : "";
    return `
      <th class="sortable ${column.numeric ? "num" : ""} ${isSorted ? "sorted" : ""}" data-key="${column.key}" title="点击排序">
        ${column.label}${arrow}
      </th>`;
  }).join("");

  const rowsHtml = sortModels(modelMetrics).map((metric) => {
    const isSelected = metric.modelId === selectedModelId;
    const modelColor = tokenRankColor.get(metric.modelId) ?? "transparent";
    return `
      <tr data-model="${escapeHtml(metric.modelId)}" class="${isSelected ? "selected" : ""}" title="点击过滤下方会话列表">
        <td class="primary"><span class="model-cell"><span class="dot" style="background:${modelColor}"></span><span class="name">${escapeHtml(metric.modelId)}</span></span></td>
        <td>${escapeHtml(metric.providerId)}</td>
        <td class="num">${formatCount(metric.steps)}</td>
        <td class="num primary">${formatTokens(metric.tokens)}</td>
        <td class="num">${formatPercent(metric.tokenShare, 2)}</td>
        <td class="num">${hitRateCell(metric)}</td>
        <td class="num">${formatTokens(metric.outputPerStep)}</td>
        <td class="num">${formatTokens(metric.contextMedian)}</td>
        <td class="num">${formatTokens(metric.contextP95)}</td>
        <td class="num">${formatPercent(metric.reasoningShare, 0)}</td>
        <td class="num">${formatSeenRange(metric.firstSeen, metric.lastSeen)}</td>
      </tr>`;
  }).join("");

  container.innerHTML = `
    <table class="data-table" aria-label="模型排行榜">
      <thead><tr>${headCells}</tr></thead>
      <tbody>${rowsHtml}</tbody>
    </table>`;

  for (const headerCell of container.querySelectorAll("th.sortable")) {
    headerCell.addEventListener("click", () => {
      const clickedKey = headerCell.dataset.key;
      if (sortKey === clickedKey) {
        sortDirection = sortDirection === "asc" ? "desc" : "asc";
      } else {
        sortKey = clickedKey;
        sortDirection = "desc";
      }
      renderModelTable(container, modelMetrics, selectedModelId, onSelectModel);
    });
  }

  for (const row of container.querySelectorAll("tbody tr")) {
    row.classList.add("session-row");
    row.addEventListener("click", () => {
      const modelName = row.dataset.model;
      onSelectModel(modelName === selectedModelId ? null : modelName);
    });
  }
}

/**
 * 全局共享悬浮提示：SVG 图表（日历 / 条形 / 漏斗）hover 时使用。
 * 单例 DOM，随鼠标移动，自动防出屏。
 *
 * 安全：title / label / value 都可能携带外部数据（第三方 MCP 工具名、
 * modelId 等），进 innerHTML 前统一 escapeHtml，HTML 一律按文本呈现。
 */

import { escapeHtml } from "./format.js";

let tooltipElement = null;

function ensureTooltip() {
  if (tooltipElement === null) {
    tooltipElement = document.getElementById("tooltip");
  }
  return tooltipElement;
}

/**
 * swatch 颜色白名单：只接受 var(--标识符) 或 #hex（3/4/6/8 位）。
 * 现有调用方（replay-turn-bar / todo-card 传常量、trend-chart 传 cssVar 的
 * #hex 解析值）全部在白名单内；其他任何值不渲染色块——swatch 直接进
 * style 属性，白名单外的值一律视为不可信，静默降级而非转义。
 */
const SWATCH_COLOR_PATTERN = /^(?:var\(--[a-z0-9-]+\)|#[0-9a-f]{3,8})$/i;

function swatchHtml(swatch) {
  if (typeof swatch !== "string") return "";
  const normalizedSwatch = swatch.trim().replace(/;\s*$/, "");
  if (!SWATCH_COLOR_PATTERN.test(normalizedSwatch)) return "";
  // var(...) 形态统一补分号，保证 style 属性闭合；#hex 无需分号
  const colorValue = normalizedSwatch.startsWith("#") ? normalizedSwatch : normalizedSwatch + ";";
  return `<span class="swatch" style="background:${colorValue}"></span>`;
}

/**
 * 显示提示。rows: [{ swatch?, label, value }]，title 为小标题行。
 */
export function showTooltip({ title, rows, clientX, clientY }) {
  const tooltip = ensureTooltip();
  if (tooltip === null) return;

  const titleHtml = title
    ? `<div class="tooltip-title">${escapeHtml(title)}</div>`
    : "";
  const rowsHtml = rows
    .map((row) => {
      const swatch = swatchHtml(row.swatch);
      return `<div class="tooltip-row">${swatch}<span>${escapeHtml(row.label)}</span><span class="row-value num">${escapeHtml(row.value)}</span></div>`;
    })
    .join("");
  tooltip.innerHTML = titleHtml + rowsHtml;
  tooltip.hidden = false;
  moveTooltip(clientX, clientY);
}

export function moveTooltip(clientX, clientY) {
  const tooltip = ensureTooltip();
  if (tooltip === null || tooltip.hidden) return;

  const margin = 14;
  const bounds = tooltip.getBoundingClientRect();
  let left = clientX + margin;
  let top = clientY + margin;
  if (left + bounds.width > window.innerWidth - 8) {
    left = clientX - bounds.width - margin;
  }
  if (top + bounds.height > window.innerHeight - 8) {
    top = clientY - bounds.height - margin;
  }
  tooltip.style.left = left + "px";
  tooltip.style.top = top + "px";
}

export function hideTooltip() {
  const tooltip = ensureTooltip();
  if (tooltip !== null) tooltip.hidden = true;
}

/** 给 SVG 元素绑定 hover 提示。payloadBuilder: (event) => 提示内容。 */
export function bindHoverTooltip(element, payloadBuilder) {
  element.addEventListener("mouseenter", (event) => {
    const payload = payloadBuilder(event);
    if (payload !== null) showTooltip(payload);
  });
  element.addEventListener("mousemove", (event) => {
    const payload = payloadBuilder(event);
    if (payload !== null) moveTooltip(event.clientX, event.clientY);
  });
  element.addEventListener("mouseleave", hideTooltip);
}

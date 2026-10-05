/**
 * 全局共享悬浮提示：SVG 图表（日历 / 条形 / 漏斗）hover 时使用。
 * 单例 DOM，随鼠标移动，自动防出屏。
 */

let tooltipElement = null;

function ensureTooltip() {
  if (tooltipElement === null) {
    tooltipElement = document.getElementById("tooltip");
  }
  return tooltipElement;
}

/**
 * 显示提示。rows: [{ swatch?, label, value }]，title 为小标题行。
 */
export function showTooltip({ title, rows, clientX, clientY }) {
  const tooltip = ensureTooltip();
  if (tooltip === null) return;

  const titleHtml = title
    ? `<div class="tooltip-title">${title}</div>`
    : "";
  const rowsHtml = rows
    .map((row) => {
      const swatch = row.swatch
        ? `<span class="swatch" style="background:${row.swatch}"></span>`
        : "";
      return `<div class="tooltip-row">${swatch}<span>${row.label}</span><span class="row-value num">${row.value}</span></div>`;
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

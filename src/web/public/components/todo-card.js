/**
 * Todo 完成率卡片（A5）：完成数/总数 + 百分比 + 分段进度条。
 *
 * 数据 = GET /api/todo（src/db/queries.ts queryTodoStats 的返回）：
 *   { total, completed, pending, inProgress } —— 三个已知状态之外的状态
 *   （如 cancelled）只计入 total，这里归入「其他」段。
 * 后端 db 不可用时 body 为 null → 空占位。
 */

import { formatCount, formatPercent } from "../format.js";
import { bindHoverTooltip } from "../tooltip.js";
import { renderEmpty } from "./state-views.js";

/**
 * 渲染 todo 完成率卡片。todoStats 为契约对象或 null。
 * total 为 0 时渲染空占位（todo 表为空不算错误）。
 */
export function renderTodoCard(container, todoStats) {
  const totalCount = Number(todoStats?.total);
  if (todoStats === null || !Number.isFinite(totalCount) || totalCount <= 0) {
    renderEmpty(container, "还没有 todo 记录", "数据库 todo 表为空，或尚无 todo 写入");
    return;
  }

  const completedCount = nonNegativeCount(todoStats.completed);
  const pendingCount = nonNegativeCount(todoStats.pending);
  const inProgressCount = nonNegativeCount(todoStats.inProgress);
  const otherCount = Math.max(0, totalCount - completedCount - pendingCount - inProgressCount);

  const completionRate = totalCount > 0 ? completedCount / totalCount : 0;

  // 分段进度条：完成（绿）/ 进行中（琥珀）/ 待办（灰）/ 其他（紫）
  const segments = [
    { segmentClass: "seg-done",   label: "已完成", count: completedCount, swatch: "var(--accent)" },
    { segmentClass: "seg-active", label: "进行中", count: inProgressCount, swatch: "var(--amber)" },
    { segmentClass: "seg-pending", label: "待办",   count: pendingCount, swatch: "var(--border-strong)" },
    { segmentClass: "seg-other",  label: "其他",    count: otherCount, swatch: "var(--purple)" },
  ].filter((segment) => segment.count > 0);

  container.innerHTML = `
    <div class="todo-rate-row">
      <span class="todo-rate-value num">${formatPercent(completionRate)}</span>
      <span class="todo-rate-caption">完成率 · <span class="num">${formatCount(completedCount)}</span>/<span class="num">${formatCount(totalCount)}</span> 项</span>
    </div>
    <div class="todo-progress" aria-label="todo 完成进度"></div>
    <p class="todo-counts num">进行中 ${formatCount(inProgressCount)} · 待办 ${formatCount(pendingCount)}${otherCount > 0 ? ` · 其他 ${formatCount(otherCount)}` : ""}</p>`;

  const progressElement = container.querySelector(".todo-progress");
  for (const segment of segments) {
    const segmentElement = document.createElement("span");
    segmentElement.className = `todo-seg ${segment.segmentClass}`;
    segmentElement.style.width = `${((segment.count / totalCount) * 100).toFixed(2)}%`;
    bindHoverTooltip(segmentElement, () => ({
      title: segment.label,
      rows: [
        { label: "数量", value: formatCount(segment.count), swatch: segment.swatch },
        { label: "占比", value: formatPercent(segment.count / totalCount) },
      ],
    }));
    progressElement.appendChild(segmentElement);
  }
}

/** 字段缺失/负数一律按 0 计（wire 上可能缺 key）。 */
function nonNegativeCount(value) {
  const numericValue = Number(value);
  return Number.isFinite(numericValue) && numericValue > 0 ? numericValue : 0;
}

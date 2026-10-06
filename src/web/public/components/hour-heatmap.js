/**
 * 活动时段热力（7×24 网格，A1）：行 = 周几（0=周日..6=周六），列 = 小时。
 * 数据 = GET /api/hour-heatmap?days=90 的 168 项零填充数组
 * （{weekday, hour, steps}，weekday-major 顺序）。
 *
 * 分档配色复用 calendar-heatmap.js（0 + 非零 4 分位档，同一套 --heat 变量），
 * hover 走全局 tooltip（tooltip.js 内部单层转义，这里只传原始值）。
 */

import { formatCount } from "../format.js";
import { cssVar } from "../theme.js";
import { bindHoverTooltip } from "../tooltip.js";
import { renderEmpty } from "./state-views.js";
import { computeLevelThresholds, levelOfValue } from "./calendar-heatmap.js";

const WEEKDAY_ROW_LABELS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
const CELL_WIDTH = 38;
const CELL_HEIGHT = 26;
const CELL_GAP = 4;
const CELL_STEP_X = CELL_WIDTH + CELL_GAP;
const CELL_STEP_Y = CELL_HEIGHT + CELL_GAP;
const LABEL_GUTTER = 40;
const HOUR_LABEL_HEIGHT = 16;
const WEEKDAY_COUNT = 7;
const HOURS_PER_DAY = 24;
const CELL_COUNT = WEEKDAY_COUNT * HOURS_PER_DAY;
/** 小时刻度标签间隔：0/3/6/.../21 时。 */
const HOUR_LABEL_INTERVAL = 3;

/**
 * 把 wire 数组规整成定长 168 的步骤表（下标 = weekday * 24 + hour）。
 * 非法 weekday/hour 项跳过；缺项按零填充（契约本身零填充，这里兜底）。
 */
function toStepCountGrid(heatmapCells) {
  const stepCountGrid = new Array(CELL_COUNT).fill(0);
  for (const cell of heatmapCells) {
    const weekday = Number(cell?.weekday);
    const hour = Number(cell?.hour);
    if (!Number.isInteger(weekday) || weekday < 0 || weekday >= WEEKDAY_COUNT) continue;
    if (!Number.isInteger(hour) || hour < 0 || hour >= HOURS_PER_DAY) continue;
    const steps = Number(cell?.steps);
    stepCountGrid[weekday * HOURS_PER_DAY + hour] = Number.isFinite(steps) && steps > 0 ? steps : 0;
  }
  return stepCountGrid;
}

/**
 * 渲染 7×24 时段热力。heatmapCells 为 168 项 wire 数组或 null。
 * 全零数据渲染空占位（不是白块）。
 */
export function renderHourHeatmap(container, heatmapCells) {
  const stepCountGrid = Array.isArray(heatmapCells) ? toStepCountGrid(heatmapCells) : [];
  if (stepCountGrid.length === 0 || stepCountGrid.every((steps) => steps <= 0)) {
    renderEmpty(container, "没有活动时段数据", "数据库里还没有带时间戳的步骤记录");
    return;
  }

  const thresholds = computeLevelThresholds(stepCountGrid);
  const heatColors = [1, 2, 3, 4].map((level) => cssVar("--heat-" + level));
  const zeroColor = cssVar("--heat-0");
  const faintTextColor = cssVar("--text-faint");

  const totalSteps = stepCountGrid.reduce((sum, steps) => sum + steps, 0);
  const activeCellCount = stepCountGrid.filter((steps) => steps > 0).length;

  const svgWidth = LABEL_GUTTER + HOURS_PER_DAY * CELL_STEP_X - CELL_GAP + 2;
  const svgHeight = WEEKDAY_COUNT * CELL_STEP_Y - CELL_GAP + HOUR_LABEL_HEIGHT;

  const svgParts = [];

  // 左侧行标签：周日..周六
  for (let weekday = 0; weekday < WEEKDAY_COUNT; weekday += 1) {
    svgParts.push(
      `<text x="0" y="${weekday * CELL_STEP_Y + CELL_HEIGHT / 2 + 3}" fill="${faintTextColor}" font-size="10">${WEEKDAY_ROW_LABELS[weekday]}</text>`,
    );
  }

  // 主体格子 + 底部小时刻度
  for (let weekday = 0; weekday < WEEKDAY_COUNT; weekday += 1) {
    for (let hour = 0; hour < HOURS_PER_DAY; hour += 1) {
      const cellIndex = weekday * HOURS_PER_DAY + hour;
      const cellLevel = levelOfValue(stepCountGrid[cellIndex], thresholds);
      const fillColor = cellLevel === 0 ? zeroColor : heatColors[cellLevel - 1];
      const x = LABEL_GUTTER + hour * CELL_STEP_X;
      const y = weekday * CELL_STEP_Y;

      svgParts.push(
        `<rect class="hour-heatmap-cell" data-cell-index="${cellIndex}" x="${x}" y="${y}" width="${CELL_WIDTH}" height="${CELL_HEIGHT}" rx="4" fill="${fillColor}"/>`,
      );

      if (hour % HOUR_LABEL_INTERVAL === 0) {
        svgParts.push(
          `<text x="${x + CELL_WIDTH / 2}" y="${svgHeight - 4}" fill="${faintTextColor}" font-size="10" text-anchor="middle">${hour}</text>`,
        );
      }
    }
  }

  const scaleSwatches = [zeroColor, ...heatColors]
    .map((color) => `<span class="cell-sample" style="background:${color}"></span>`)
    .join("");

  container.innerHTML = `
    <svg class="hour-heatmap-svg" viewBox="0 0 ${svgWidth} ${svgHeight}" role="img" aria-label="按周几与小时的步骤分布热力图">${svgParts.join("")}</svg>
    <div class="heatmap-meta">
      <span>活跃时段 <b class="num">${formatCount(activeCellCount)}</b>/${CELL_COUNT} · 总计 <b class="num">${formatCount(totalSteps)}</b> 步</span>
      <span class="heatmap-scale">少 ${scaleSwatches} 多</span>
    </div>`;

  for (const cell of container.querySelectorAll(".hour-heatmap-cell")) {
    const cellIndex = Number(cell.dataset.cellIndex);
    const weekday = Math.floor(cellIndex / HOURS_PER_DAY);
    const hour = cellIndex % HOURS_PER_DAY;
    bindHoverTooltip(cell, () => ({
      title: `${WEEKDAY_ROW_LABELS[weekday]} ${hour} 时`,
      rows: [{ label: "步骤数", value: formatCount(stepCountGrid[cellIndex]) }],
    }));
  }
}

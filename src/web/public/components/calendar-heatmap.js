/**
 * 52 周日历热力图（GitHub 式，手写 SVG，周一为每周第一列）。
 * 按日 token 总量分 5 档着色（0 + 非零日分位的 4 档），hover 显示
 * 日期与数值。数据复用 trend 接口（日总量 = input + read + output）。
 */

import { formatTokens, formatCount, dateKeyToEpoch, epochToDateKey, escapeHtml } from "../format.js";
import { cssVar } from "../theme.js";
import { bindHoverTooltip } from "../tooltip.js";
import { renderEmpty } from "./state-views.js";

const CELL_SIZE = 12;
const CELL_GAP = 3;
const CELL_STEP = CELL_SIZE + CELL_GAP;
const LABEL_GUTTER = 30;
const MONTH_LABEL_HEIGHT = 18;

/**
 * 非零日的分位点 → 4 档着色阈值（少 → 多）。
 * 导出供 hour-heatmap.js 复用（同一套 --heat-0..4 分档语义）。
 */
export function computeLevelThresholds(dailyTotals) {
  const activeDayTotals = dailyTotals.filter((total) => total > 0).sort((left, right) => left - right);
  if (activeDayTotals.length === 0) return [];
  const quantileAt = (fraction) =>
    activeDayTotals[Math.min(activeDayTotals.length - 1, Math.floor(fraction * activeDayTotals.length))];
  return [quantileAt(0.25), quantileAt(0.5), quantileAt(0.75), quantileAt(0.9)];
}

/** 值 → 档位（0 = 零档；1..4 由阈值划分）。同样导出供 hour-heatmap 复用。 */
export function levelOfValue(value, thresholds) {
  if (value <= 0 || thresholds.length < 4) return 0;
  if (value <= thresholds[0]) return 1;
  if (value <= thresholds[1]) return 2;
  if (value <= thresholds[2]) return 3;
  return 4;
}

/** 'YYYY-MM-DD' → UTC 零点毫秒（仅用于计算两个日历日之间隔几天，DST 不影响 UTC）。 */
function dateKeyToUtcEpoch(dateKey) {
  const [year, month, dayOfMonth] = dateKey.split("-").map(Number);
  return Date.UTC(year, month - 1, dayOfMonth);
}

/**
 * 渲染日历热力图。trendData 为 { points } 或 null。
 * points 需覆盖约 53 周（app.js 用 fetchTrend(366)）。
 *
 * 步进口径：全部走「日历日」（Date#setDate 递进 / dateKey 匹配），
 * 不用 86_400_000 毫秒步进——DST 切换日一年有两天不是 24 小时，
 * 固定毫秒步进会让格子与日期错位（与 daily-buckets 的日期 key 口径对齐）。
 */
export function renderCalendarHeatmap(container, trendData) {
  if (trendData === null || trendData.points.length === 0) {
    renderEmpty(container, "没有历史日历数据", "数据库里还没有 assistant 消息记录");
    return;
  }

  const dayEntries = trendData.points.map((point) => ({
    date: point.date,
    total: point.input + point.read + point.output,
    steps: point.steps,
  }));
  const dayIndexByDateKey = new Map(dayEntries.map((entry, index) => [entry.date, index]));

  // 对齐到周一：第一列从首个日期所在周的周一开始，前面补空白
  const firstDate = new Date(dateKeyToEpoch(dayEntries[0].date));
  const firstMondayDate = new Date(firstDate);
  firstMondayDate.setDate(firstMondayDate.getDate() - (firstDate.getDay() + 6) % 7);
  const lastDateKey = dayEntries[dayEntries.length - 1].date;
  const totalWeeks = Math.ceil(
    (dateKeyToUtcEpoch(lastDateKey) - dateKeyToUtcEpoch(epochToDateKey(firstMondayDate.getTime()))) / (7 * 86_400_000),
  ) + 1;

  const dailyTotals = dayEntries.map((entry) => entry.total);
  const thresholds = computeLevelThresholds(dailyTotals);
  const activeDayCount = dailyTotals.filter((total) => total > 0).length;
  const yearTotal = dailyTotals.reduce((sum, total) => sum + total, 0);

  const svgWidth = LABEL_GUTTER + totalWeeks * CELL_STEP + 6;
  const svgHeight = MONTH_LABEL_HEIGHT + 7 * CELL_STEP + 4;

  const heatColors = [1, 2, 3, 4].map((level) => cssVar("--heat-" + level));
  const zeroColor = cssVar("--heat-0");

  const svgParts = [];
  const weekdayLabels = [["一", 0], ["三", 2], ["五", 4]];
  for (const [label, rowIndex] of weekdayLabels) {
    svgParts.push(`<text x="0" y="${MONTH_LABEL_HEIGHT + rowIndex * CELL_STEP + CELL_SIZE - 2}" fill="${cssVar("--text-faint")}" font-size="10">${label}</text>`);
  }

  // 月份标签：该月第一次出现在新的一列时标注
  let lastLabeledMonth = -1;
  const cellDate = new Date(firstMondayDate);
  for (let weekIndex = 0; weekIndex < totalWeeks; weekIndex += 1) {
    for (let dayOfWeek = 0; dayOfWeek < 7; dayOfWeek += 1) {
      const cellMonth = cellDate.getMonth();
      const cellDateKey = epochToDateKey(cellDate.getTime());
      cellDate.setDate(cellDate.getDate() + 1); // 日历日递进，DST 天数天然正确

      const dayIndex = dayIndexByDateKey.get(cellDateKey);
      if (dayIndex === undefined) continue; // 对齐补白（周一之前）或超出数据范围

      const entry = dayEntries[dayIndex];
      const cellLevel = levelOfValue(entry.total, thresholds);
      const fillColor = cellLevel === 0 ? zeroColor : heatColors[cellLevel - 1];
      const x = LABEL_GUTTER + weekIndex * CELL_STEP;
      const y = MONTH_LABEL_HEIGHT + dayOfWeek * CELL_STEP;

      svgParts.push(
        `<rect class="heatmap-cell" data-date-index="${dayIndex}" x="${x}" y="${y}" width="${CELL_SIZE}" height="${CELL_SIZE}" rx="2.5" fill="${fillColor}"/>`,
      );

      if (dayOfWeek === 0 && cellMonth !== lastLabeledMonth) {
        lastLabeledMonth = cellMonth;
        const monthLabel = `${cellMonth + 1}月`;
        svgParts.push(`<text x="${x}" y="11" fill="${cssVar("--text-faint")}" font-size="10">${monthLabel}</text>`);
      }
    }
  }

  const scaleSwatches = [zeroColor, ...heatColors]
    .map((color, index) => `<span class="cell-sample" style="background:${color}"></span>`)
    .join("");

  container.innerHTML = `
    <svg class="heatmap-svg" viewBox="0 0 ${svgWidth} ${svgHeight}" width="${svgWidth}" height="${svgHeight}" role="img" aria-label="过去一年每日 token 总量热力图">${svgParts.join("")}</svg>
    <div class="heatmap-meta">
      <span>过去一年 <b class="num">${formatTokens(yearTotal)}</b> tokens · 活跃 <b class="num">${formatCount(activeDayCount)}</b> 天</span>
      <span class="heatmap-scale">少 ${scaleSwatches} 多</span>
    </div>`;

  for (const cell of container.querySelectorAll(".heatmap-cell")) {
    const dayIndex = Number(cell.dataset.dateIndex);
    const entry = dayEntries[dayIndex];
    bindHoverTooltip(cell, () => ({
      title: entry.date,
      rows: [{ label: "token 总量", value: formatTokens(entry.total) }, { label: "步骤数", value: String(entry.steps) }],
    }));
  }
}

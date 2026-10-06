/**
 * 会话存活卡片（A2）：中位存活时长（人类可读）、短命占比（<5 分钟）、
 * idle 结局分布（横向小条）。
 *
 * 数据 = GET /api/session-survival：
 *   { totalSessions, medianDurationSeconds, shortLivedShare, idleOutcomeCounts }
 * idleOutcomeCounts 的 key 是外部数据，渲染前一律 escapeHtml。
 */

import { formatCount, formatDuration, formatPercent, escapeHtml } from "../format.js";
import { renderEmpty } from "./state-views.js";

/** 中位存活时长 < 1 秒视为无效数据。 */
const MINIMUM_MEDIAN_SECONDS = 1;

/**
 * 渲染会话存活卡片。survival 为契约对象或 null（null/无会话 → 空占位）。
 */
export function renderSessionSurvivalCard(container, survival) {
  const totalSessions = Number(survival?.totalSessions);
  const medianDurationSeconds = Number(survival?.medianDurationSeconds);
  if (survival === null || !Number.isFinite(totalSessions) || totalSessions <= 0) {
    renderEmpty(container, "还没有会话存活数据", "数据库里没有可统计的会话起止记录");
    return;
  }
  const hasMedian = Number.isFinite(medianDurationSeconds) && medianDurationSeconds >= MINIMUM_MEDIAN_SECONDS;
  const shortLivedShare = Number(survival.shortLivedShare);

  const outcomeEntries = Object.entries(survival.idleOutcomeCounts ?? {})
    .map(([outcomeName, outcomeCount]) => [outcomeName, Number(outcomeCount)])
    .filter(([outcomeName, outcomeCount]) => outcomeName !== "" && Number.isFinite(outcomeCount))
    .sort((left, right) => right[1] - left[1]);
  const maxOutcomeCount = outcomeEntries.length > 0 ? outcomeEntries[0][1] : 0;
  const outcomeRowsHtml = outcomeEntries.length === 0
    ? `<p class="distribution-caption">该窗口内没有 idle 结局记录</p>`
    : outcomeEntries.map(([outcomeName, outcomeCount]) => `
        <div class="distribution-row">
          <span class="distribution-name" title="${escapeHtml(outcomeName)}">${escapeHtml(outcomeName)}</span>
          <span class="distribution-track"><span class="distribution-bar" style="width:${outcomeCount <= 0 ? 0 : Math.max(2, (outcomeCount / maxOutcomeCount) * 100).toFixed(1)}%"></span></span>
          <span class="distribution-count num">${formatCount(outcomeCount)}</span>
        </div>`).join("");

  container.innerHTML = `
    <div class="survival-grid">
      <div class="survival-metric">
        <span class="metric-label">中位存活时长</span>
        <span class="metric-value num">${hasMedian ? escapeHtml(formatDuration(medianDurationSeconds)) : "—"}</span>
        <span class="metric-hint">会话首条 → 末条消息</span>
      </div>
      <div class="survival-metric">
        <span class="metric-label">短命会话占比</span>
        <span class="metric-value num">${formatPercent(shortLivedShare)}</span>
        <div class="mini-progress" aria-hidden="true"><span style="width:${clampPercent(shortLivedShare)}%"></span></div>
        <span class="metric-hint">存活不足 5 分钟 · 共 <span class="num">${formatCount(totalSessions)}</span> 个会话</span>
      </div>
    </div>
    <p class="distribution-caption">idle 结局分布</p>
    <div class="distribution-list">${outcomeRowsHtml}</div>`;
}

/** 分数夹到 0..100，非数显 0（进度条宽度用）。 */
function clampPercent(fraction) {
  if (!Number.isFinite(fraction) || fraction < 0) return 0;
  return Math.min(fraction * 100, 100).toFixed(1);
}

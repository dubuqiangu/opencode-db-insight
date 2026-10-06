/**
 * 上下文压缩事件区块（A3）：总数、按 reason 分布、近 30 日迷你趋势条、
 * Top 会话列表（sessionId 短显前 8 字符，hover 看全名，点击进回放）。
 *
 * 数据 = GET /api/compaction：
 *   { total, byReason, recentDaily(30 天升序零填充), topSessions(前 10 降序) }
 * reason / sessionId 都是外部数据，渲染前一律 escapeHtml（tooltip 单层转义）。
 */

import { formatCount, escapeHtml } from "../format.js";
import { bindHoverTooltip } from "../tooltip.js";
import { renderEmpty } from "./state-views.js";

const RECENT_DAILY_BAR_COUNT = 30;
const SESSION_ID_SHORT_LENGTH = 8;
const TOP_SESSION_LIMIT = 10;
/** 迷你趋势条 viewBox：30 根柱 + 间隔，高度留足峰值。 */
const TREND_VIEWBOX_WIDTH = 300;
const TREND_VIEWBOX_HEIGHT = 56;
const TREND_BAR_WIDTH = 8;
const TREND_BAR_GAP = 2;
const TREND_BAR_STEP = TREND_BAR_WIDTH + TREND_BAR_GAP;
const TREND_MAX_BAR_HEIGHT = 46;

/**
 * 渲染压缩事件区块。compaction 为契约对象或 null。
 * total 为 0 时渲染空占位（优雅降级，不是白块）。
 */
export function renderCompactionPanel(container, compaction) {
  const totalCount = Number(compaction?.total);
  if (compaction === null || !Number.isFinite(totalCount) || totalCount <= 0) {
    renderEmpty(container, "还没有上下文压缩事件", "数据库里没有 compaction 消息记录");
    return;
  }

  const reasonEntries = Object.entries(compaction.byReason ?? {})
    .map(([reasonName, reasonCount]) => [reasonName, Number(reasonCount)])
    .filter(([reasonName, reasonCount]) => reasonName !== "" && Number.isFinite(reasonCount) && reasonCount > 0)
    .sort((left, right) => right[1] - left[1]);
  const maxReasonCount = reasonEntries.length > 0 ? reasonEntries[0][1] : 0;
  const reasonRowsHtml = reasonEntries.length === 0
    ? `<p class="distribution-caption">没有携带 reason 的压缩事件</p>`
    : reasonEntries.map(([reasonName, reasonCount]) => `
        <div class="distribution-row">
          <span class="distribution-name" title="${escapeHtml(reasonName)}">${escapeHtml(reasonName)}</span>
          <span class="distribution-track"><span class="distribution-bar" style="width:${Math.max(2, (reasonCount / maxReasonCount) * 100).toFixed(1)}%"></span></span>
          <span class="distribution-count num">${formatCount(reasonCount)}</span>
        </div>`).join("");

  const recentDaily = Array.isArray(compaction.recentDaily) ? compaction.recentDaily : [];
  const maxDailyCount = recentDaily.reduce((maximum, day) => Math.max(maximum, Number(day?.count) || 0), 0);
  const trendSvg = recentDaily.length === 0
    ? ""
    : buildRecentDailyTrendSvg(recentDaily, maxDailyCount);

  const topSessions = (Array.isArray(compaction.topSessions) ? compaction.topSessions : [])
    .slice(0, TOP_SESSION_LIMIT)
    .map((topSession) => ({
      sessionId: String(topSession?.sessionId ?? ""),
      count: Number(topSession?.count) || 0,
    }))
    .filter((topSession) => topSession.sessionId !== "");
  const topSessionRowsHtml = topSessions.length === 0
    ? `<p class="distribution-caption">没有可展示的压缩会话</p>`
    : `<ol class="compaction-session-list">` + topSessions.map((topSession) => `
        <li class="compaction-session-row" data-session-id="${escapeHtml(topSession.sessionId)}">
          <a href="#/session/${encodeURIComponent(topSession.sessionId)}" title="进入会话回放">
            <code>${escapeHtml(shortSessionId(topSession.sessionId))}</code>
          </a>
          <span class="compaction-session-count num">${formatCount(topSession.count)} 次</span>
        </li>`).join("") + `</ol>`;

  container.innerHTML = `
    <p class="compaction-total-line">共 <b class="num">${formatCount(totalCount)}</b> 次压缩</p>
    <p class="distribution-caption">按原因</p>
    <div class="distribution-list">${reasonRowsHtml}</div>
    <p class="distribution-caption compaction-subhead">近 30 日趋势</p>
    ${trendSvg}
    <p class="distribution-caption compaction-subhead">压缩最多的会话 TOP${TOP_SESSION_LIMIT}</p>
    ${topSessionRowsHtml}`;

  // 迷你趋势条：hover 显示日期与当日次数（原始值进 tooltip，其内部单层转义）
  const trendBars = container.querySelectorAll(".compaction-trend-bar");
  for (const barElement of trendBars) {
    const dayIndex = Number(barElement.dataset.dayIndex);
    const dayRecord = recentDaily[dayIndex];
    if (dayRecord === undefined) continue;
    bindHoverTooltip(barElement, () => ({
      title: String(dayRecord.dateKey ?? ""),
      rows: [{ label: "压缩次数", value: formatCount(Number(dayRecord.count) || 0) }],
    }));
  }

  // Top 会话行：hover 看全名
  for (const rowElement of container.querySelectorAll(".compaction-session-row")) {
    const fullSessionId = rowElement.dataset.sessionId;
    bindHoverTooltip(rowElement, () => ({
      title: fullSessionId,
      rows: [],
    }));
  }
}

/** sessionId 短显：前 8 字符 + 省略号（够长才省略）。 */
function shortSessionId(sessionId) {
  return sessionId.length <= SESSION_ID_SHORT_LENGTH
    ? sessionId
    : sessionId.slice(0, SESSION_ID_SHORT_LENGTH) + "…";
}

/** 近 30 日迷你竖条 SVG（零填充日画基线残柱）。 */
function buildRecentDailyTrendSvg(recentDaily, maxDailyCount) {
  const barParts = [];
  for (let dayIndex = 0; dayIndex < recentDaily.length && dayIndex < RECENT_DAILY_BAR_COUNT; dayIndex += 1) {
    const dayCount = Number(recentDaily[dayIndex]?.count) || 0;
    const barHeight = maxDailyCount <= 0
      ? 0
      : Math.max(dayCount <= 0 ? 2 : 4, Math.round((dayCount / maxDailyCount) * TREND_MAX_BAR_HEIGHT));
    const x = dayIndex * TREND_BAR_STEP;
    const y = TREND_VIEWBOX_HEIGHT - barHeight;
    barParts.push(
      `<rect class="compaction-trend-bar${dayCount <= 0 ? " zero" : ""}" data-day-index="${dayIndex}" x="${x}" y="${y}" width="${TREND_BAR_WIDTH}" height="${barHeight}" rx="2"/>`,
    );
  }
  return `
    <svg class="compaction-trend-svg" viewBox="0 0 ${TREND_VIEWBOX_WIDTH} ${TREND_VIEWBOX_HEIGHT}" preserveAspectRatio="none" aria-label="近 30 日每日压缩次数迷你趋势">${barParts.join("")}</svg>`;
}

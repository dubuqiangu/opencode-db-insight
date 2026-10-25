/** 会话失败与中断：仅最后一条 assistant 消息带 error 才视为错误收尾。 */
import { escapeHtml, formatCount, formatPercent, formatRelative, formatDateTime } from "../format.js";
import { MISSING_REASON, renderMissingValue } from "../precision.js";
import { renderEmpty } from "./state-views.js";

const MAX_RECENT_SESSIONS = 5;

function unreachableState(container) {
  container.innerHTML = `<div class="state-view error"><strong>这块数据没加载出来</strong>
    <div class="state-hint">会话结局数据不可达，下一次自动刷新会再试一次</div></div>`;
}

function errorTypeBars(byErrorType) {
  const errorTypes = (Array.isArray(byErrorType) ? byErrorType : [])
    .filter((entry) => entry !== null && typeof entry?.type === "string" && Number.isFinite(entry.count) && entry.count > 0);
  if (errorTypes.length === 0) return `<p class="distribution-caption">没有错误类型记录</p>`;
  const maximumCount = Math.max(...errorTypes.map((entry) => entry.count));
  return `<div class="distribution-list">${errorTypes.map((entry) => {
    const barWidth = ((entry.count / maximumCount) * 100).toFixed(1);
    return `<div class="distribution-row session-outcome-type-row">
      <span class="distribution-name" title="${escapeHtml(entry.type)}">${escapeHtml(entry.type)}</span>
      <span class="distribution-track" role="img" aria-label="${escapeHtml(entry.type)}：${formatCount(entry.count)} 个会话"><span class="distribution-bar" style="width:${barWidth}%"></span></span>
      <span class="distribution-count num">${formatCount(entry.count)}</span>
    </div>`;
  }).join("")}</div>`;
}

function recentSessionRows(recentInterrupted) {
  const sessions = (Array.isArray(recentInterrupted) ? recentInterrupted : [])
    .filter((entry) => entry !== null && String(entry?.sessionId ?? "") !== "")
    .slice(0, MAX_RECENT_SESSIONS);
  if (sessions.length === 0) return `<p class="distribution-caption">没有可回放的错误收尾会话</p>`;
  const renderTime = Date.now();
  return `<ol class="session-outcome-recent-list">${sessions.map((session) => {
    const title = String(session.title || "（无标题会话）");
    const errorType = String(session.errorType || "未分类错误");
    const errorMessage = String(session.errorMessage ?? "");
    const timeUpdated = typeof session.timeUpdated === "number" ? session.timeUpdated : NaN;
    const isoTime = Number.isFinite(timeUpdated) && !Number.isNaN(new Date(timeUpdated).getTime())
      ? new Date(timeUpdated).toISOString() : null;
    const timeLabel = formatRelative(timeUpdated, renderTime);
    return `<li class="session-outcome-recent-row">
      <a class="session-outcome-session-link" href="#/session/${encodeURIComponent(String(session.sessionId))}" title="${escapeHtml(title)} · ${escapeHtml(errorMessage)}">${escapeHtml(title)}</a>
      <span class="session-outcome-error-badge" title="${escapeHtml(errorMessage || errorType)}">${escapeHtml(errorType)}</span>
      <time class="session-outcome-time num"${isoTime === null ? "" : ` datetime="${isoTime}"`} title="${formatDateTime(timeUpdated)}">${timeLabel}</time>
    </li>`;
  }).join("")}</ol>`;
}

/** 纯渲染：payload 为空库时空态，接口不可达时错误态；返回统一清理函数。 */
export function renderSessionOutcomeCard(container, payload) {
  if (payload === null) {
    unreachableState(container);
    return () => {};
  }
  const totalSessions = Number(payload?.totalSessions);
  if (!Number.isFinite(totalSessions) || totalSessions <= 0) {
    renderEmpty(container, "还没有会话结局数据", "数据库里没有可统计的会话");
    return () => {};
  }

  const sessionsWithSteps = Number(payload.sessionsWithSteps);
  const interruptedSessions = Number(payload.interruptedSessions);
  const interruptedShare = Number(payload.interruptedShare);
  const hasStepSamples = Number.isFinite(sessionsWithSteps) && sessionsWithSteps > 0;
  // 载荷不自洽时不把人数截断后伪装成真实计数；人数与占比一起降级。
  const hasConsistentCount = hasStepSamples && Number.isFinite(interruptedSessions)
    && interruptedSessions >= 0 && interruptedSessions <= sessionsWithSteps;
  const validInterruptedCount = hasConsistentCount
    ? formatCount(interruptedSessions)
    : renderMissingValue(MISSING_REASON.inconsistentCount);
  const validShare = hasConsistentCount && Number.isFinite(interruptedShare)
    ? Math.min(1, Math.max(0, interruptedShare)) : null;
  const interruptedShareText = validShare === null
    ? renderMissingValue(MISSING_REASON.zeroDenominator)
    : formatPercent(validShare);

  container.innerHTML = `<div class="session-outcome-intro">
    <div class="session-outcome-hero">
      <div class="session-outcome-hero-number num">${validInterruptedCount}</div>
      <div class="session-outcome-hero-label">以错误收尾的会话</div>
    </div>
    <div class="session-outcome-share">
      <span class="session-outcome-share-value num">${interruptedShareText}</span>
      <span class="metric-hint">占有 assistant 步骤的 <span class="num">${hasStepSamples ? formatCount(sessionsWithSteps) : "0"}</span> 个会话</span>
    </div>
  </div>
  <p class="session-outcome-definition">🟡 推断口径：以错误收尾的会话（最后一条 assistant 消息带 error）。无 assistant 步骤的会话不进入占比分母。</p>
  <div class="session-outcome-columns">
    <section class="session-outcome-column" aria-label="错误类型分布">
      <h3>错误类型 <span class="session-outcome-heading-note">按会话数 · 条宽相对榜首</span></h3>
      ${errorTypeBars(payload.byErrorType)}
    </section>
    <section class="session-outcome-column" aria-label="最近错误收尾会话">
      <h3>最近错误收尾 <span class="session-outcome-heading-note">点击标题进入回放</span></h3>
      ${recentSessionRows(payload.recentInterrupted)}
    </section>
  </div>`;
  return () => {};
}

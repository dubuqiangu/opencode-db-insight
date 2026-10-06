/**
 * 单会话回放视图（M4）：#/session/:id 的真实页面。
 * 结构：返回链接 + 会话头部（标题/模型/agent/时间跨度/token 汇总）
 *      + 系统提示词折叠面板（默认收起）
 *      + 角色时间线（replay-timeline.js，>200 条分页加载）。
 *
 * 数据：fetchSessionMessages（404 → 旧表会话专门文案）、
 *      fetchSessionSystemPrompt（null → 省略面板）、
 *      fetchSessionSummaryById（尽力而为的标题，找不到降级显示 id）。
 */

import {
  fetchSessionMessages,
  fetchSessionSystemPrompt,
  fetchSessionSummaryById,
  SessionNotFoundError,
} from "../data-source.js";
import { formatTokens, formatCount, formatDateTime, formatPercent, escapeHtml } from "../format.js";
import { renderTimeline, summarizeReplayTokens, summarizeStrictHitRate } from "./replay-timeline.js";
import { renderLoading, renderError } from "./state-views.js";

const TIMELINE_PAGE_SIZE = 200;

/** 路由切换竞态守卫：只有最新一次渲染请求可以落 DOM。 */
let renderSequence = 0;

/** 2026-09-23 前的旧表会话 / 不存在的 id（DESIGN §10 T4.3）。 */
const LEGACY_SESSION_NOTICE =
  "该会话不在新表（2026-09-23 前的旧会话暂不支持回放）。统计口径以新表为准，避免双计。";

/**
 * 渲染整个回放视图（含加载/错误/404 状态）。container 为 #session-view。
 */
export async function renderSessionReplay(container, sessionId) {
  const renderToken = ++renderSequence;
  const isStale = () => renderToken !== renderSequence;

  container.innerHTML = "";
  renderLoading(container, 5);

  let messageRecords;
  try {
    messageRecords = await fetchSessionMessages(sessionId);
  } catch (error) {
    if (isStale()) return;
    container.innerHTML = "";
    if (error instanceof SessionNotFoundError) {
      renderLegacySessionView(container, sessionId);
    } else {
      renderError(container, error, () => {
        renderSessionReplay(container, sessionId);
      });
    }
    return;
  }

  // 系统提示词与标题都允许失败：面板省略 / 标题降级
  const [systemPrompt, sessionSummary] = await Promise.all([
    fetchSessionSystemPrompt(sessionId).catch(() => null),
    fetchSessionSummaryById(sessionId).catch(() => null),
  ]);
  if (isStale()) return;

  container.innerHTML = "";
  container.appendChild(buildBackLink());
  container.appendChild(buildHeaderElement(sessionId, messageRecords, sessionSummary));
  if (systemPrompt !== null) {
    container.appendChild(buildSystemPromptPanelElement(systemPrompt));
  }
  container.appendChild(buildTimelineSectionElement(messageRecords));
}

/* ---------------- 头部 ---------------- */

function buildBackLink() {
  const backLink = document.createElement("a");
  backLink.className = "back-link";
  backLink.href = "#/";
  backLink.textContent = "返回看板";
  return backLink;
}

function buildHeaderElement(sessionId, messageRecords, sessionSummary) {
  const headerPanel = document.createElement("article");
  headerPanel.className = "panel replay-header";

  const summary = summarizeReplayTokens(messageRecords);
  const strictHitRate = summarizeStrictHitRate(messageRecords);
  const timeSpan = computeTimeSpan(messageRecords);
  const latestAssistant = findLatestAssistantModel(messageRecords);
  const sessionTitle = sessionSummary !== null && sessionSummary.title !== ""
    ? sessionSummary.title
    : "会话回放";

  headerPanel.innerHTML = `
    <header class="panel-head">
      <div>
        <h2 class="replay-title">${escapeHtml(sessionTitle)}</h2>
        <p class="session-id-line">会话 ID：${escapeHtml(sessionId)}</p>
      </div>
      <div class="replay-header-stats num">
        <span title="Σ(input + output + cache.read)"><b>${formatTokens(summary.totalTokens)}</b> tokens</span>
        ${strictHitRate === null ? "" : `<span title="严格命中率 = cache.read / (cache.read + input + cache.write) · 与看板口径的差别：cache.write 计入分母"><b>${formatPercent(strictHitRate)}</b> 严格命中</span>`}
        <span title="assistant 消息数（步数）"><b>${formatCount(summary.assistantStepCount)}</b> 步</span>
        ${latestAssistant === null ? "" : `<span title="最后使用的模型"><b>${escapeHtml(latestAssistant)}</b></span>`}
        ${timeSpan === null ? "" : `<span title="首条 → 末条消息时间">${timeSpan}</span>`}
      </div>
    </header>`;

  const agentName = sessionSummary !== null ? sessionSummary.agent : null;
  const subLine = document.createElement("p");
  subLine.className = "panel-sub";
  subLine.textContent = agentName !== null && agentName !== ""
    ? `agent: ${agentName} · 角色时间线 + turn 级成本条`
    : "角色时间线 + turn 级成本条";
  headerPanel.appendChild(subLine);
  return headerPanel;
}

function computeTimeSpan(messageRecords) {
  const validTimes = (Array.isArray(messageRecords) ? messageRecords : [])
    .map((record) => record.timeCreated)
    .filter((time) => Number.isFinite(time) && time > 0);
  if (validTimes.length === 0) return null;
  // for 循环求 min/max：大会话几万条消息，spread 进 Math.min/max 会撑爆调用栈
  let firstTime = validTimes[0];
  let lastTime = validTimes[0];
  for (let index = 1; index < validTimes.length; index += 1) {
    const time = validTimes[index];
    if (time < firstTime) firstTime = time;
    if (time > lastTime) lastTime = time;
  }
  return `${formatDateTime(firstTime)} → ${formatDateTime(lastTime)}`;
}

function findLatestAssistantModel(messageRecords) {
  for (let index = messageRecords.length - 1; index >= 0; index -= 1) {
    const record = messageRecords[index];
    if (String(record.type ?? "") !== "assistant") continue;
    const dataRecord = typeof record.data === "object" && record.data !== null ? record.data : null;
    const modelRecord = dataRecord !== null && typeof dataRecord.model === "object" && dataRecord.model !== null
      ? dataRecord.model
      : null;
    const modelId = modelRecord === null ? "" : String(modelRecord.id ?? "");
    if (modelId !== "") return modelId;
  }
  return null;
}

/* ---------------- 系统提示词面板（默认收起） ---------------- */

function buildSystemPromptPanelElement(systemPrompt) {
  const promptPanel = document.createElement("article");
  promptPanel.className = "panel replay-prompt-panel";

  const detailsElement = document.createElement("details");
  detailsElement.className = "replay-prompt";
  detailsElement.open = false; // 默认收起（显式赋值，语义自明）
  const summaryElement = document.createElement("summary");
  const promptKeyCount = Object.keys(systemPrompt).length;
  summaryElement.textContent = `🧩 系统提示词（${promptKeyCount} 个指令块 · 默认收起）`;
  detailsElement.appendChild(summaryElement);

  for (const [instructionKey, promptText] of Object.entries(systemPrompt)) {
    const keyHead = document.createElement("div");
    keyHead.className = "replay-code-head";
    keyHead.textContent = instructionKey;
    const promptBlock = document.createElement("pre");
    promptBlock.className = "replay-code lang-text";
    promptBlock.textContent = typeof promptText === "string" ? promptText : "";
    detailsElement.appendChild(keyHead);
    detailsElement.appendChild(promptBlock);
  }

  promptPanel.appendChild(detailsElement);
  return promptPanel;
}

/* ---------------- 时间线区（分页） ---------------- */

function buildTimelineSectionElement(messageRecords) {
  const timelinePanel = document.createElement("article");
  const timelineMount = document.createElement("div");
  const paginationController = renderTimeline(timelineMount, messageRecords, TIMELINE_PAGE_SIZE);

  const timelineHeader = document.createElement("header");
  timelineHeader.className = "panel-head";
  const progressNote = document.createElement("span");
  progressNote.className = "panel-head-extra num";
  const updateProgressNote = () => {
    progressNote.textContent = paginationController.hasMore
      ? "已渲染 200 条 · 点击加载更多"
      : `全部 ${paginationController.visibleCount} 条已加载`;
  };
  updateProgressNote();
  timelineHeader.innerHTML = "<div><h2>角色时间线</h2></div>";
  timelineHeader.appendChild(progressNote);

  timelinePanel.appendChild(timelineHeader);
  timelinePanel.appendChild(timelineMount);

  if (paginationController.hasMore) {
    const loadMoreButton = document.createElement("button");
    loadMoreButton.type = "button";
    loadMoreButton.className = "load-more-button";
    loadMoreButton.textContent = "加载更多";
    loadMoreButton.addEventListener("click", () => {
      const stillHasMore = paginationController.appendNextChunk();
      updateProgressNote();
      if (!stillHasMore) loadMoreButton.remove();
    });
    timelinePanel.appendChild(loadMoreButton);
  }

  return timelinePanel;
}

/* ---------------- 404 / 旧表会话 ---------------- */

function renderLegacySessionView(container, sessionId) {
  const legacyView = document.createElement("div");
  legacyView.innerHTML = `
    <a class="back-link" href="#/">返回看板</a>
    <article class="panel">
      <div class="state-view error">
        <strong>回放不可用：旧表会话</strong>
        <div class="state-hint">${escapeHtml(LEGACY_SESSION_NOTICE)}</div>
        <div class="session-id-line">会话 ID：${escapeHtml(sessionId)}</div>
      </div>
    </article>`;
  container.appendChild(legacyView);
}

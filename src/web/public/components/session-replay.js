/**
 * 单会话回放视图（M4）：#/session/:id 的真实页面。
 * 结构：返回链接 + 会话头部（标题/模型/agent/时间跨度/token 汇总）
 *      + 系统提示词折叠面板（默认收起）
 *      + 角色时间线（replay-timeline.js，>200 条分页加载）
 *      + 会话内搜索（replay-search.js，v0.10.0：时间线头部的查找栏，
 *        输入即搜防抖、命中节点级高亮、分页区命中可导航）。
 *      + Token 消耗曲线（replay-token-curve.js，v0.20.0：头部开销行下
 *        方的逐步累计曲线；steps 由已加载消息组装，分位取
 *        /api/session-distribution，失败则省略分位徽标行）。
 *
 * 数据：fetchSessionMessages（404 → 旧表会话专门文案）、
 *      fetchSessionSystemPrompt（null → 省略面板）、
 *      fetchSessionSummaryById（尽力而为的标题，找不到降级显示 id）。
 */

import {
  fetchSessionMessages,
  fetchSessionSystemPrompt,
  fetchSessionSummaryById,
  fetchSessionDistribution,
  SessionNotFoundError,
} from "../data-source.js";
import { formatTokens, formatCount, formatDateTime, formatPercent, escapeHtml } from "../format.js";
import { renderTimeline, summarizeReplayTokens, summarizeStrictHitRate } from "./replay-timeline.js";
import { buildReplaySearchBar } from "./replay-search.js";
import { readDeepLinkMessageId, revealMessageNode } from "./replay-deep-link.js";
import { renderReplayTokenCurve } from "./replay-token-curve.js";
import { renderLoading, renderError } from "./state-views.js";

const TIMELINE_PAGE_SIZE = 200;

/** 路由切换竞态守卫：只有最新一次渲染请求可以落 DOM。 */
let renderSequence = 0;

/** 消耗曲线的 cleanup（收起悬浮 tooltip）：下一次渲染前调用并清零——
 * 回放页没有既有的 cleanup 链，这里补一条最小的。 */
let replayCurveCleanup = null;

/** 2026-09-23 前的旧表会话 / 不存在的 id（DESIGN §10 T4.3）。 */
const LEGACY_SESSION_NOTICE =
  "该会话不在新表（2026-09-23 前的旧会话暂不支持回放）。统计口径以新表为准，避免双计。";

/**
 * 渲染整个回放视图（含加载/错误/404 状态）。container 为 #session-view。
 */
export async function renderSessionReplay(container, sessionId) {
  const renderToken = ++renderSequence;
  const isStale = () => renderToken !== renderSequence;

  if (replayCurveCleanup !== null) {
    replayCurveCleanup();
    replayCurveCleanup = null;
  }
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

  // 系统提示词、标题与全库 token 分布都允许失败：面板省略 / 标题降级 /
  // 曲线省略分位徽标行。三者并行取，不互相等待。
  const [systemPrompt, sessionSummary, distributionStats] = await Promise.all([
    fetchSessionSystemPrompt(sessionId).catch(() => null),
    fetchSessionSummaryById(sessionId).catch(() => null),
    fetchSessionDistribution().catch(() => null),
  ]);
  if (isStale()) return;

  container.innerHTML = "";
  container.appendChild(buildBackLink());
  container.appendChild(buildHeaderElement(sessionId, messageRecords, sessionSummary));
  container.appendChild(buildReplayTokenCurveElement(messageRecords, distributionStats));
  if (systemPrompt !== null) {
    container.appendChild(buildSystemPromptPanelElement(systemPrompt));
  }
  container.appendChild(buildTimelineSectionElement(messageRecords));
}

/* ---------------- Token 消耗曲线（v0.20.0） ---------------- */

/**
 * 从回放已加载的消息序列组装曲线组件的 steps 契约：每个 assistant 消息
 * 一步，字段对齐 replay-token-curve 的消费面（tokensInput/tokensOutput/
 * tokensReasoning/tokensCacheRead/tokensCacheWrite + index + timeCreated）。
 * 字段缺失经 Number() 变 NaN，由组件侧 nonNegativeTokens 统一按 0 计。
 */
function buildReplayCurveSteps(messageRecords) {
  const curveSteps = [];
  for (const messageRecord of Array.isArray(messageRecords) ? messageRecords : []) {
    if (String(messageRecord.type ?? "") !== "assistant") continue;
    const dataRecord = typeof messageRecord.data === "object" && messageRecord.data !== null
      ? messageRecord.data
      : null;
    const tokensRecord = dataRecord !== null && typeof dataRecord.tokens === "object" && dataRecord.tokens !== null
      ? dataRecord.tokens
      : null;
    if (tokensRecord === null) continue;
    const cacheRecord = typeof tokensRecord.cache === "object" && tokensRecord.cache !== null
      ? tokensRecord.cache
      : {};
    curveSteps.push({
      index: curveSteps.length,
      timeCreated: Number(messageRecord.timeCreated),
      tokensInput: Number(tokensRecord.input),
      tokensOutput: Number(tokensRecord.output),
      tokensReasoning: Number(tokensRecord.reasoning),
      tokensCacheRead: Number(cacheRecord.read),
      tokensCacheWrite: Number(cacheRecord.write),
    });
  }
  return curveSteps;
}

/**
 * 曲线面板挂在会话头部（开销行：tokens/命中/步数统计）之后、系统提示词
 * 之前——「这一会话消耗了多少、落在全库分布的哪一档」紧贴头部总览读序。
 * 空 steps（无 assistant 消息）时组件约定返回 null：不挂载空面板。
 * distributionStats 取失败 → percentiles 传 null，组件自动省略分位行。
 */
function buildReplayTokenCurveElement(messageRecords, distributionStats) {
  const curveMountElement = document.createElement("div");
  const curveCleanup = renderReplayTokenCurve(curveMountElement, {
    steps: buildReplayCurveSteps(messageRecords),
    distributionPercentiles: distributionStats !== null
      && typeof distributionStats === "object"
      ? distributionStats.percentiles ?? null
      : null,
  });
  if (curveCleanup === null) {
    return document.createDocumentFragment();
  }
  replayCurveCleanup = curveCleanup;
  return curveMountElement;
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

/* ---------------- 时间线区（分页 + 会话内搜索） ---------------- */

function buildTimelineSectionElement(messageRecords) {
  const timelinePanel = document.createElement("article");
  const timelineMount = document.createElement("div");
  const paginationController = renderTimeline(timelineMount, messageRecords, TIMELINE_PAGE_SIZE);

  // v0.10.0 会话内搜索：搜索栏挂在时间线 panel-head（输入即搜防抖，
  // 命中节点级高亮，未渲染分页区的命中由导航驱动 appendNextChunk）。
  // 状态全在 buildReplaySearchBar 闭包内——本函数随每次回放重渲染重建，
  // 切换会话自然清零，无跨会话残留。
  const replaySearch = buildReplaySearchBar({ paginationController, messageRecords });

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
  timelineHeader.appendChild(replaySearch.element);
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
      // 手动追加的新节点也要吃到当前搜索的高亮（计数不变——它基于全量索引）
      replaySearch.syncAfterAppend();
      if (!stillHasMore) loadMoreButton.remove();
    });
    timelinePanel.appendChild(loadMoreButton);
  }

  // v0.24.0 消息深链：目标可能在未渲染分页区，revealMessageNode 会自己
  // 追加到目标再滚动。找不到就静默停在页首——深链坏了不该让回放页报错。
  const deepLinkMessageId = readDeepLinkMessageId(window.location.hash);
  if (deepLinkMessageId !== null) {
    const revealResult = revealMessageNode({
      paginationController,
      messageRecords,
      messageId: deepLinkMessageId,
    });
    updateProgressNote();
    replaySearch.syncAfterAppend();
    if (revealResult.status === "located" && !paginationController.hasMore) {
      const staleLoadMoreButton = timelinePanel.querySelector(".load-more-button");
      if (staleLoadMoreButton !== null) staleLoadMoreButton.remove();
    }
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

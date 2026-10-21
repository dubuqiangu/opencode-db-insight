/**
 * 应用装配：hash 路由 + 各区块数据获取与渲染 + 时间范围切换 + 后台定时刷新。
 * 每个区块独立加载/独立容错（API 挂了不白屏），数据统一走
 * data-source.js（当前 mock，M2 后切真实 API 只改那一处）。
 *
 * v0.20.0 会话作用域：state.sessionScopeId 非 null 时各聚合 fetch 追加
 * ?session=（只统计该会话）；顶栏 chip（session-scope-chip.js）承载
 * 进入/退出/404 自动退出轻提示；作用域期间口径错位的面板整体隐藏
 * （session-scope-visibility.js 的映射），退出即恢复。
 */

import {
  fetchOverview,
  fetchTrend,
  fetchModels,
  fetchAgents,
  fetchToolHealth,
  fetchSessions,
  fetchHealth,
  fetchHourHeatmap,
  fetchSessionSurvival,
  fetchCompaction,
  fetchTodo,
  fetchDirectoryStats,
  fetchSessionDistribution,
  fetchStepDistribution,
  fetchDurationDistribution,
  fetchChildShare,
  fetchToolErrorTrend,
  fetchSessionOutcomes,
  fetchRefresh,
  fetchSessionSummaryById,
  SessionScopeNotFoundError,
  MAX_TREND_DAYS,
} from "./data-source.js";
import { formatTokens, formatPercent, formatCount, escapeHtml } from "./format.js";
import { onSchemeChange } from "./theme.js";
import { renderKpiRow } from "./components/kpi-card.js";
import { renderTrendChart } from "./components/trend-chart.js";
import { renderCalendarHeatmap } from "./components/calendar-heatmap.js";
import { renderHourHeatmap } from "./components/hour-heatmap.js";
import { renderSessionSurvivalCard } from "./components/session-survival-card.js";
import { renderCompactionPanel } from "./components/compaction-panel.js";
import { renderTodoCard } from "./components/todo-card.js";
import { renderDirectoryPanel } from "./components/directory-panel.js";
import { renderToolBars } from "./components/tool-bars.js";
import { renderAgentTable } from "./components/agent-table.js";
import { renderTokenFunnel } from "./components/token-funnel.js";
import { renderModelTable } from "./components/model-table.js";
import { renderDistributionCard } from "./components/distribution-card.js";
import { renderStepDistributionCard } from "./components/step-distribution-card.js";
import { renderDurationDistributionCard } from "./components/duration-distribution-card.js";
import { renderChildShareCard } from "./components/child-share-card.js";
import { renderToolErrorTrendCard } from "./components/tool-error-trend-card.js";
import { renderSessionOutcomeCard } from "./components/session-outcome-card.js";
import {
  renderSessionScopeChip,
  flashSessionScopeVanishedNotice,
} from "./components/session-scope-chip.js";
import {
  SESSION_SCOPE_HIDDEN_SECTION_IDS,
  sessionScopeSectionHiddenById,
} from "./components/session-scope-visibility.js";
import { createSessionSortController } from "./components/session-sort-controller.js";
import { renderSessionReplay } from "./components/session-replay.js";
import { renderError } from "./components/state-views.js";

/** 日历热力图固定窗口 = 后端 MAX_TREND_DAYS（366 天 ≈ 52.3 周，缺的天按零渲染）。 */
const TREND_CALENDAR_WINDOW_DAYS = MAX_TREND_DAYS;

const state = {
  range: "30",
  modelFilter: null,
  directoryFilter: null,
  // 会话作用域（v0.20.0）：null = 全部会话（缺省）。非空 = 看板各聚合
  // 只统计该会话（?session= 透传），title 供顶栏 chip 展示。进入/退出
  // 都走 enterSessionScope / exitSessionScope（缓存重置 + 全量重载在那
  // 里统一发生），不许散落直改。
  sessionScopeId: null,
  sessionScopeTitle: null,
  // 模型排行榜窗口（data-model-range 值）：默认全部。缓存按窗口分桶，
  // state.cache.models 始终指向「当前窗口」的数据（主题切换/下钻重渲染用）。
  modelRange: "all",
  // 活动时段热力窗口（?days= 值）：默认 90（契约缺省）。All 用 366。
  heatmapDays: 90,
  // 工具错误逐日趋势窗口（?days= 值，v0.22.0）：默认 30（契约缺省）。
  // 范围芯片（30/90/全部）切换即改这里，缓存按窗口分桶。
  toolErrorDays: 30,
  healthStatus: "连接中…",
  // 后台定时刷新（v0.18.x）：间隔分钟数（0 = 关），持久化到 localStorage；
  // refreshInFlight 挡重入（上一轮没跑完时 tick 直接跳过）；
  // lastRefreshCompletedAt 供 visibilitychange 回前台时判断是否补刷。
  autoRefreshMinutes: 5,
  refreshInFlight: false,
  lastRefreshCompletedAt: 0,
  cache: {
    overview: undefined,
    calendarTrend: undefined,
    rangeTrend: {},
    models: undefined,
    modelsByRange: {},
    agents: undefined,
    hourHeatmap: undefined,
    hourHeatmapByDays: {},
    // 工具健康度（GET /api/tool-health）：条形图错误色带与标题旁摘要行共用，
    // 由独立的 loadToolHealthSection 填充；与 agents 缓存彼此独立容错。
    toolHealth: undefined,
    // 会话列表的排序状态/缓存归 session-sort-controller（P2-2 抽出），
    // 不再平铺在这里；本对象只保留其余区块。
    sessionSurvival: undefined,
    compaction: undefined,
    todo: undefined,
    directories: undefined,
    // 会话 token 分布（v0.20.0）：作用域激活时面板整体隐藏、不取数，
    // 缓存保持 undefined（onSchemeChange 的重渲守卫天然跳过）。
    distribution: undefined,
    // 步数 / 时长分布（v0.21.0）：同 distribution 口径（全部会话），作用域
    // 激活时面板整体隐藏、不取数，缓存保持 undefined。
    stepDistribution: undefined,
    durationDistribution: undefined,
    // 子代理开销占比（v0.21.0）：全部会话口径，作用域激活时同样整体隐藏。
    childShare: undefined,
    // 工具错误逐日趋势（v0.22.0）：全部会话口径，按窗口分桶缓存
    // （toolErrorTrendByDays），toolErrorTrend 始终指向当前窗口（主题重渲用）；
    // 作用域激活时面板整体隐藏、不取数，缓存保持 undefined。
    toolErrorTrend: undefined,
    toolErrorTrendByDays: {},
    // 会话结局（v0.22.0）：全部会话口径，作用域激活时面板整体隐藏、不取数。
    sessionOutcomes: undefined,
  },
  failedSections: new Set(),
  trendCleanup: () => {},
  // 分布卡 cleanup（renderDistributionCard 返回的收起 tooltip 闭包）。
  distributionCleanup: () => {},
  // 步数 / 时长 / 子代占比卡 cleanup（v0.21.0），同 distributionCleanup。
  stepDistributionCleanup: () => {},
  durationDistributionCleanup: () => {},
  childShareCleanup: () => {},
  // 工具错误趋势 / 会话结局卡 cleanup（v0.22.0）。
  toolErrorTrendCleanup: () => {},
  sessionOutcomesCleanup: () => {},
};

/* ---------- DOM 锚点 ---------- */
const dashboardElement = document.getElementById("dashboard");
const sessionViewElement = document.getElementById("session-view");
const kpiRowElement = document.getElementById("kpi-row");
const trendChartElement = document.getElementById("trend-chart");
const trendLegendElement = document.getElementById("trend-legend");
const calendarHeatmapElement = document.getElementById("calendar-heatmap");
const hourHeatmapElement = document.getElementById("hour-heatmap");
const compactionPanelElement = document.getElementById("compaction-panel");
const sessionSurvivalElement = document.getElementById("session-survival");
const todoCardElement = document.getElementById("todo-card");
const directoryPanelElement = document.getElementById("directory-panel");
const toolBarsElement = document.getElementById("tool-bars");
const toolHealthCaptionElement = document.getElementById("tool-health-caption");
const agentTableElement = document.getElementById("agent-table");
const tokenFunnelElement = document.getElementById("token-funnel");
const funnelCaptionElement = document.getElementById("funnel-caption");
const modelTableElement = document.getElementById("model-table");
const modelRangeSwitchElement = document.getElementById("model-range-switch");
const hourHeatmapSubElement = document.getElementById("hour-heatmap-sub");
const heatmapRangeSwitchElement = document.getElementById("heatmap-range-switch");
const tocNavElement = document.getElementById("toc-nav");
const sessionListElement = document.getElementById("session-list");
const sessionFilterChipElement = document.getElementById("session-filter-chip");
const sessionScopeChipElement = document.getElementById("session-scope-chip");
const distributionCardElement = document.getElementById("session-distribution");
const stepDistributionCardElement = document.getElementById("session-step-distribution");
const durationDistributionCardElement = document.getElementById("session-duration-distribution");
const childShareCardElement = document.getElementById("child-share");
const toolErrorTrendCardElement = document.getElementById("session-tool-error-trend");
const sessionOutcomesCardElement = document.getElementById("session-outcomes");
const rangeSwitchElement = document.getElementById("range-switch");
const statusDotElement = document.getElementById("status-dot");
const statusTextElement = document.getElementById("status-text");
const topStatusElement = document.getElementById("top-status");

/* ---------- 状态指示 ---------- */
function updateStatus() {
  if (state.failedSections.size > 0) {
    statusDotElement.className = "status-dot err";
    statusTextElement.textContent = `${state.failedSections.size} 个区块加载失败`;
  } else {
    statusDotElement.className = "status-dot ok";
    statusTextElement.textContent = state.healthStatus;
  }
}

/** 探活 /api/health：dbStatus 驱动顶栏文案（失败降级，不阻塞区块加载）。 */
async function loadHealthStatus() {
  try {
    const health = await fetchHealth();
    state.healthStatus = health.dbStatus === "ok"
      ? `已连接 opencode.db · v${health.version}`
      : "数据库不可用（503）";
  } catch {
    state.healthStatus = "API 不可达";
  }
  updateStatus();
}

function markSection(sectionName, didSucceed) {
  if (didSucceed) state.failedSections.delete(sectionName);
  else state.failedSections.add(sectionName);
  updateStatus();
}

/* ---------- 会话作用域（v0.20.0 ?session= 贯通） ---------- */

/**
 * 作用域激活时不再取数的区块名（与 SESSION_SCOPE_HIDDEN_SECTION_IDS
 * 对应面板的 loader 一一对应）。这些 loader 在 refreshAllSections /
 * startInitialLoad 里被跳过，失败计数也在进入作用域时清掉——隐藏区块
 * 的错误不该挂在顶栏吓人。
 */
const SESSION_SCOPE_SKIPPED_SECTION_MARK_NAMES = [
  "calendar",
  "hour-heatmap",
  "agents",
  "session-survival",
  "directories",
  "distribution",
  "step-distribution",
  "duration-distribution",
  "child-share",
  "tool-error-trend",
  "session-outcomes",
];

function isSessionScopeActive() {
  return state.sessionScopeId !== null;
}

// 即使先进入再退出回到 null，旧请求也不能落入已重置的全局缓存。
let sessionScopeVersion = 0;

/**
 * 作用域切换的面板/TOC 显隐同步：显隐走 hidden 属性（section 与 TOC
 * 按钮同 hidden 值，静态锚点 TOC 不另建状态）；隐藏区块的失败计数随
 * 面板一起摘除。TOC 按钮与 section 的对应关系经 data-toc-target 逐个
 * 查表（index.html 是视觉 lane 产物，不给按钮加 id）。
 */
function applySessionScopePanelVisibility() {
  const sectionHiddenById = sessionScopeSectionHiddenById(isSessionScopeActive());
  const tocButtonBySectionId = new Map();
  for (const tocButton of tocNavElement.querySelectorAll("button[data-toc-target]")) {
    tocButtonBySectionId.set(tocButton.dataset.tocTarget, tocButton);
  }
  for (const [sectionId, sectionHidden] of sectionHiddenById) {
    const sectionElement = document.getElementById(sectionId);
    if (sectionElement !== null) sectionElement.hidden = sectionHidden;
    const tocButton = tocButtonBySectionId.get(sectionId);
    if (tocButton !== undefined) tocButton.hidden = sectionHidden;
  }
  if (isSessionScopeActive()) {
    for (const sectionMarkName of SESSION_SCOPE_SKIPPED_SECTION_MARK_NAMES) {
      state.failedSections.delete(sectionMarkName);
    }
    updateStatus();
  }
}

/**
 * 作用域切换的缓存重置：state.cache 的各桶（按 range/days 分桶的 Map
 * 与单值槽）都持有「取数那一刻的作用域口径」的载荷——切换作用域后
 * 它们全部过期。单点重置（而非把 scope 编进每个桶键）：桶的数量与
 * 维度会继续增长，键污染面不如一次性清空来得可核。
 */
function resetSectionCachesForScopeSwitch() {
  state.cache.overview = undefined;
  state.cache.calendarTrend = undefined;
  state.cache.rangeTrend = {};
  state.cache.models = undefined;
  state.cache.modelsByRange = {};
  state.cache.agents = undefined;
  state.cache.hourHeatmap = undefined;
  state.cache.hourHeatmapByDays = {};
  state.cache.toolHealth = undefined;
  state.cache.sessionSurvival = undefined;
  state.cache.compaction = undefined;
  state.cache.todo = undefined;
  state.cache.directories = undefined;
  state.cache.distribution = undefined;
  state.cache.stepDistribution = undefined;
  state.cache.durationDistribution = undefined;
  state.cache.childShare = undefined;
  state.cache.toolErrorTrend = undefined;
  state.cache.toolErrorTrendByDays = {};
  state.cache.sessionOutcomes = undefined;
}

/**
 * 顶栏 chip 同步：激活写 innerHTML + 摘 hidden（组件内走属性），退出
 * 清空 + 落回 hidden。轻提示闪现期间被真实 chip 覆盖是预期行为。
 */
function renderTopbarSessionScopeChip() {
  renderSessionScopeChip(
    sessionScopeChipElement,
    isSessionScopeActive()
      ? { sessionId: state.sessionScopeId, sessionTitle: state.sessionScopeTitle ?? "" }
      : null,
    exitSessionScope,
  );
}

/** 进入会话作用域：行内「只看此会话」按钮的唯一入口。 */
function enterSessionScope(sessionId, sessionTitle) {
  if (sessionId === "" || sessionId === state.sessionScopeId) return;
  sessionScopeVersion += 1;
  state.sessionScopeId = sessionId;
  state.sessionScopeTitle = sessionTitle === "" ? sessionId : sessionTitle;
  // 模型/目录下钻与作用域正交但口径错位（下钻过滤会把锁定行滤没），
  // 进入即清零——模型表高亮、目录面板选中态、面板 chip 一并复位。
  state.modelFilter = null;
  state.directoryFilter = null;
  renderModelTable(modelTableElement, state.cache.models ?? [], null, onModelSelected);
  renderDirectoryPanel(directoryPanelElement, state.cache.directories ?? null, null, onDirectorySelected);
  renderSessionFilterChip();
  applySessionScopePanelVisibility();
  renderTopbarSessionScopeChip();
  resetSectionCachesForScopeSwitch();
  sessionSortController.changeSessionScope(sessionId);
  void refreshAllSections();
}

/** 退出会话作用域：chip ✕ 与 404 自动退出的共用入口。 */
function exitSessionScope() {
  if (state.sessionScopeId === null) return;
  sessionScopeVersion += 1;
  state.sessionScopeId = null;
  state.sessionScopeTitle = null;
  applySessionScopePanelVisibility();
  renderTopbarSessionScopeChip();
  resetSectionCachesForScopeSwitch();
  sessionSortController.changeSessionScope(null);
  void refreshAllSections();
}

/**
 * 会话已删时的自动退出 + 轻提示（不弹错误卡）：chip 位置闪一条小字。
 * 守卫保证并发多路 404 只退一次（已退出 → 直接吞掉）。
 */
function exitSessionScopeAfterVanish() {
  if (state.sessionScopeId === null) return;
  exitSessionScope();
  flashSessionScopeVanishedNotice(sessionScopeChipElement);
}

/**
 * 404 自动退出的统一哨兵：任一区块请求撞上 SessionScopeNotFoundError
 * 时由各 loader 的 catch 调用。返回 true = 该错误已被作用域退出消化，
 * loader 不再走错误态。
 */
function handleSessionScopeVanished(error) {
  if (!(error instanceof SessionScopeNotFoundError)) return false;
  exitSessionScopeAfterVanish();
  return true;
}

/* ---------- 各区块：加载 + 渲染 + 容错 ---------- */

/**
 * 简单区块加载器工厂（P1-4 样板归并）：七个同构区块
 * （overview / calendar / agents / survival / compaction / todo / directories）
 * 的 try{取数→渲染→markSection(true)} / catch{renderError→markSection(false)}
 * 样板收口到此。各区块只声明四要素：区块名 / 容器 / 取数闭包（含写缓存，
 * 与手写版的赋值顺序一致）/ 渲染闭包。重试闭包由 loadSection 自引用——
 * renderError 的重试按钮与手写版行为完全等价。
 * 不并入：带序列守卫的 trend / models / heatmap 与特化失败路径的
 * tool-health（保持手写，见下文）。
 */
function createSimpleSectionLoader(sectionName, container, fetchSectionData, renderSectionData) {
  async function loadSection() {
    try {
      renderSectionData(await fetchSectionData());
      markSection(sectionName, true);
    } catch (error) {
      // 作用域会话已删：自动退出 + 轻提示（见 handleSessionScopeVanished），
      // 不落区块错误卡——退出后的全量重载会按「全部会话」口径重取本区块。
      if (handleSessionScopeVanished(error)) return;
      renderError(container, error, loadSection);
      markSection(sectionName, false);
    }
  }
  return loadSection;
}

const loadOverviewSection = createSimpleSectionLoader(
  "overview",
  kpiRowElement,
  async () => (state.cache.overview = await fetchOverview(state.sessionScopeId)),
  (overviewStats) => renderKpiRow(kpiRowElement, overviewStats),
);

/**
 * 范围切换渲染序列守卫（同 session-replay 的 renderSequence 模式）：
 * 慢响应晚到不得覆盖当前 range——只有「最新一次请求 且 仍针对当前范围」
 * 的结果才允许落 DOM。结果仍按它自己的请求范围入缓存，晚到不浪费。
 */
let trendLoadSequence = 0;

async function loadTrendSection() {
  const requestToken = ++trendLoadSequence;
  const requestRange = state.range;
  try {
    state.trendCleanup();
    const rangeTrend = await fetchTrend(rangeToDays(requestRange), state.sessionScopeId);
    state.cache.rangeTrend[requestRange] = rangeTrend;
    if (requestToken !== trendLoadSequence || requestRange !== state.range) return;
    renderTrendSectionFromCache();
    markSection("trend", true);
  } catch (error) {
    if (handleSessionScopeVanished(error)) return;
    // 与成功路径对称：晚到的错误同样不得覆盖当前范围（例如挂起请求失败前
    // 用户已切到缓存命中的其他范围——此时它仍是最新 token，但范围已过期）
    if (requestToken !== trendLoadSequence || requestRange !== state.range) return;
    renderError(trendChartElement, error, loadTrendSection);
    trendLegendElement.innerHTML = "";
    renderError(tokenFunnelElement, error, loadTrendSection);
    markSection("trend", false);
  }
}

function renderTrendSectionFromCache() {
  const rangeTrend = state.cache.rangeTrend[state.range] ?? null;
  state.trendCleanup();
  state.trendCleanup = renderTrendChart(trendChartElement, trendLegendElement, rangeTrend);
  const funnelSummary = renderTokenFunnel(tokenFunnelElement, rangeTrend);
  funnelCaptionElement.innerHTML = funnelSummary === null
    ? ""
    : `窗口命中率 <b class="num">${formatPercent(funnelSummary.windowHitRate)}</b> · 供给 <span class="num">${formatTokens(funnelSummary.supply)}</span>`;
}

const loadCalendarSection = createSimpleSectionLoader(
  "calendar",
  calendarHeatmapElement,
  async () => (state.cache.calendarTrend = await fetchTrend(TREND_CALENDAR_WINDOW_DAYS, state.sessionScopeId)),
  (calendarTrend) => renderCalendarHeatmap(calendarHeatmapElement, calendarTrend),
);

async function loadToolsSection() {
  try {
    state.cache.agents = await fetchAgents(state.sessionScopeId);
    // toolHealth 可能先/后于 agents 到达：两侧各自到达后互刷（见下两节），
    // 任一侧缺失时条形图按无健康度渲染，不阻塞彼此。
    renderToolBars(toolBarsElement, state.cache.agents, state.cache.toolHealth ?? null);
    markSection("tools", true);
  } catch (error) {
    if (handleSessionScopeVanished(error)) return;
    renderError(toolBarsElement, error, loadToolsSection);
    markSection("tools", false);
  }
}

/** Agent 排行榜：同一 /api/agents 端点的独立加载/独立容错（与 tools 区块
 * 各自请求，服务端 60s TTL 下两次请求不双倍成本）。 */
const loadAgentSection = createSimpleSectionLoader(
  "agents",
  agentTableElement,
  async () => (state.cache.agents = await fetchAgents(state.sessionScopeId)),
  (agentStats) => renderAgentTable(agentTableElement, agentStats),
);

/** 工具标题旁的全局错误率摘要行：Global error rate = Σerror / Σtotal。 */
function renderToolHealthCaption(toolHealthStats) {
  let totalCalls = 0;
  let totalErrors = 0;
  for (const healthStat of Array.isArray(toolHealthStats) ? toolHealthStats : []) {
    if (Number.isFinite(healthStat?.total)) totalCalls += healthStat.total;
    if (Number.isFinite(healthStat?.error)) totalErrors += healthStat.error;
  }
  if (totalCalls === 0) {
    // 空数据：摘要行留空（条形图自身的空态由 tools 区块负责），不渲染 NaN。
    toolHealthCaptionElement.innerHTML = "";
    return;
  }
  const globalErrorRate = totalErrors / totalCalls;
  toolHealthCaptionElement.innerHTML =
    `Global error rate <b class="num">${formatPercent(globalErrorRate, 1)}</b> · <span class="num">${formatCount(totalErrors)}</span> / ${formatCount(totalCalls)} calls failed`;
}

/** 工具健康度：独立加载/独立容错。失败时只清空摘要行并计入顶栏失败数
 * ——条形图本体归 tools 区块管，保持既有渲染（无错误色带），不白屏。 */
async function loadToolHealthSection() {
  try {
    state.cache.toolHealth = await fetchToolHealth(state.sessionScopeId);
    renderToolHealthCaption(state.cache.toolHealth);
    if (state.cache.agents !== undefined) {
      renderToolBars(toolBarsElement, state.cache.agents, state.cache.toolHealth);
    }
    markSection("tool-health", true);
  } catch (error) {
    if (handleSessionScopeVanished(error)) return;
    toolHealthCaptionElement.innerHTML = "";
    markSection("tool-health", false);
  }
}

/**
 * 模型排行榜：窗口切换（7/30/90/All，默认 All）按窗口分桶缓存；
 * 序列守卫同 trendLoadSequence 模式——晚到的过期窗口响应不得覆盖当前
 * 选择。切换期间不闪骨架：命中缓存即时渲染，未命中保留旧表直到新数据
 * 到达（失败才落错误态 + 重试）。
 */
let modelsLoadSequence = 0;

/** data-model-range UI 值 → ?days= 参数值（"all" → null = 不带参数）。 */
function modelRangeDays(rangeValue) {
  return rangeValue === "all" ? null : Number(rangeValue);
}

async function loadModelsSection() {
  const requestToken = ++modelsLoadSequence;
  const requestRange = state.modelRange;
  try {
    const modelMetrics = await fetchModels(modelRangeDays(requestRange), state.sessionScopeId);
    state.cache.modelsByRange[requestRange] = modelMetrics;
    if (requestToken !== modelsLoadSequence || requestRange !== state.modelRange) return;
    state.cache.models = modelMetrics;
    renderModelTable(modelTableElement, modelMetrics, state.modelFilter, onModelSelected);
    markSection("models", true);
  } catch (error) {
    if (handleSessionScopeVanished(error)) return;
    if (requestToken !== modelsLoadSequence || requestRange !== state.modelRange) return;
    renderError(modelTableElement, error, loadModelsSection);
    markSection("models", false);
    // R1：失败回正指针——否则主题重渲会把旧窗口数据渲在当前窗口按钮
    // 高亮下（窗口错配）。null 让模型过滤/主题重渲走空数据而非错配数据。
    state.cache.models = null;
  }
}

function onModelRangeSelected(nextRange) {
  state.modelRange = nextRange;
  const cachedMetrics = state.cache.modelsByRange[nextRange];
  if (cachedMetrics !== undefined) {
    state.cache.models = cachedMetrics;
    renderModelTable(modelTableElement, cachedMetrics, state.modelFilter, onModelSelected);
    // R1：缓存命中同样记成功——否则先前窗口的失败计数残留顶栏，且
    // models 指针已指向完好的缓存数据，状态栏与数据面必须一致。
    markSection("models", true);
  } else {
    loadModelsSection();
  }
}

function bindModelRangeSwitch() {
  modelRangeSwitchElement.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-model-range]");
    if (button === null) return;
    const nextRange = button.dataset.modelRange;
    if (nextRange === state.modelRange) return;
    for (const rangeButton of modelRangeSwitchElement.querySelectorAll("button")) {
      rangeButton.classList.toggle("active", rangeButton === button);
    }
    onModelRangeSelected(nextRange);
  });
}

/* ---------- 会话列表：排序控制器装配（P2-2） ---------- */

/** 会话列表单页大小，与 session-list 的 VISIBLE_ROWS 一致。 */
const SESSION_LIST_PAGE_LIMIT = 15;

/**
 * 排序状态/缓存/序列守卫都在 session-sort-controller 里；这里只注入：
 * 单页请求闭包（limit/offset 钉死，见该模块头部 N-2 注释）、模型过滤
 * 只读访问器、顶栏失败计数回调。渲染时机（初始/列头/重置/过滤/范围/
 * 主题）全部转交控制器。v0.7.0：请求闭包透传 directory；v0.9.0：
 * 透传 range（两者空值在 fetchSessions 内归一为不携带参数）。
 * v0.20.0：闭包增透传 sessionScopeId——作用域激活时不走 ?sort= 分页
 * 请求，改为单会话载荷（fetchSessionSummaryById 的尽力而为查找，
 * 找不到 = 空行，退出作用域另有 chip/404 兜底）；行内「只看此会话」
 * 按钮与作用域消失上抛口也在此接线。
 */
const sessionSortController = createSessionSortController({
  containerElement: sessionListElement,
  fetchSessionsPage: (sortKey, sortOrder, directory, range, sessionScopeId) => {
    if (sessionScopeId !== null) return fetchScopedSessionListPage(sessionScopeId);
    return fetchSessions(SESSION_LIST_PAGE_LIMIT, 0, sortKey, sortOrder, directory, range);
  },
  getModelFilter: () => state.modelFilter,
  onSessionScopeChange: enterSessionScope,
  onSessionScopeVanished: exitSessionScopeAfterVanish,
  markSectionSucceeded: () => markSection("sessions", true),
  markSectionFailed: () => markSection("sessions", false),
});

/**
 * 作用域锁定视图的单会话载荷：/api/sessions 不吃 ?session=（后端契约），
 * 走 fetchSessionSummaryById 的尽力而为查找。排序/目录/范围参数对单行
 * 列表没有意义，闭包侧直接忽略（锁定视图的交互件也不渲染）。
 */
async function fetchScopedSessionListPage(sessionScopeId) {
  const scopedSessionSummary = await fetchSessionSummaryById(sessionScopeId);
  return { total: null, sessions: scopedSessionSummary === null ? [] : [scopedSessionSummary] };
}

/**
 * 活动时段热力：窗口切换（7/30/90/All，默认 90）。All 用 days=366
 * （后端 clamp 1..366，366 = 全史窗口）。缓存按窗口分桶，序列守卫与
 * 模型排行榜同模式；标题副文案随窗口动态更新（消除「永远像近一周」的
 * 静态误导）。7×24 渲染逻辑本身不动。
 */
let heatmapLoadSequence = 0;

function heatmapWindowLabel(days) {
  return days >= 366
    ? "Hourly steps across all history"
    : `Hourly steps over the last ${days} days`;
}

function renderHourHeatmapSub() {
  hourHeatmapSubElement.textContent =
    `${heatmapWindowLabel(state.heatmapDays)} · rows = weekday, columns = hour (local timezone)`;
}

async function loadHourHeatmapSection() {
  const requestToken = ++heatmapLoadSequence;
  const requestDays = state.heatmapDays;
  try {
    const heatmapCells = await fetchHourHeatmap(requestDays, state.sessionScopeId);
    state.cache.hourHeatmapByDays[requestDays] = heatmapCells;
    if (requestToken !== heatmapLoadSequence || requestDays !== state.heatmapDays) return;
    state.cache.hourHeatmap = heatmapCells;
    renderHourHeatmap(hourHeatmapElement, heatmapCells);
    markSection("hour-heatmap", true);
  } catch (error) {
    if (handleSessionScopeVanished(error)) return;
    if (requestToken !== heatmapLoadSequence || requestDays !== state.heatmapDays) return;
    renderError(hourHeatmapElement, error, loadHourHeatmapSection);
    markSection("hour-heatmap", false);
    // R1：失败回正指针，防主题重渲渲出窗口错配的旧格子（同 models）。
    state.cache.hourHeatmap = null;
  }
}

function onHeatmapRangeSelected(nextDays) {
  state.heatmapDays = nextDays;
  renderHourHeatmapSub();
  const cachedCells = state.cache.hourHeatmapByDays[nextDays];
  if (cachedCells !== undefined) {
    state.cache.hourHeatmap = cachedCells;
    renderHourHeatmap(hourHeatmapElement, cachedCells);
    // R1：缓存命中同样记成功（同 onModelRangeSelected 的理由）。
    markSection("hour-heatmap", true);
  } else {
    loadHourHeatmapSection();
  }
}

function bindHeatmapRangeSwitch() {
  heatmapRangeSwitchElement.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-heatmap-days]");
    if (button === null) return;
    const nextDays = Number(button.dataset.heatmapDays);
    if (nextDays === state.heatmapDays) return;
    for (const rangeButton of heatmapRangeSwitchElement.querySelectorAll("button")) {
      rangeButton.classList.toggle("active", rangeButton === button);
    }
    onHeatmapRangeSelected(nextDays);
  });
}

const loadSessionSurvivalSection = createSimpleSectionLoader(
  "session-survival",
  sessionSurvivalElement,
  async () => (state.cache.sessionSurvival = await fetchSessionSurvival(state.sessionScopeId)),
  (survivalStats) => renderSessionSurvivalCard(sessionSurvivalElement, survivalStats),
);

const loadCompactionSection = createSimpleSectionLoader(
  "compaction",
  compactionPanelElement,
  async () => (state.cache.compaction = await fetchCompaction(state.sessionScopeId)),
  (compactionStats) => renderCompactionPanel(compactionPanelElement, compactionStats),
);

const loadTodoSection = createSimpleSectionLoader(
  "todo",
  todoCardElement,
  async () => (state.cache.todo = await fetchTodo(state.sessionScopeId)),
  (todoStats) => renderTodoCard(todoCardElement, todoStats),
);

const loadDirectorySection = createSimpleSectionLoader(
  "directories",
  directoryPanelElement,
  async () => (state.cache.directories = await fetchDirectoryStats(10, state.sessionScopeId)),
  (directoryStats) =>
    renderDirectoryPanel(directoryPanelElement, directoryStats, state.directoryFilter, onDirectorySelected),
);

/**
 * 会话 token 分布卡（v0.20.0）：初载与每轮自动刷新取数；null/失败走
 * 组件自带的降级块（无重试按钮——自动刷新即兜底），不走 renderError。
 * 作用域激活时该面板整体隐藏（applySessionScopePanelVisibility），
 * refreshAllSections / startInitialLoad 会跳过本 loader。
 */
let distributionLoadSequence = 0;

async function loadDistributionSection() {
  if (isSessionScopeActive()) return;
  const requestScopeVersion = sessionScopeVersion;
  const requestSequence = ++distributionLoadSequence;
  try {
    const distribution = await fetchSessionDistribution();
    if (requestScopeVersion !== sessionScopeVersion || requestSequence !== distributionLoadSequence) return;
    state.distributionCleanup();
    state.cache.distribution = distribution;
    state.distributionCleanup = renderDistributionCard(distributionCardElement, state.cache.distribution);
    markSection("distribution", true);
  } catch (error) {
    if (requestScopeVersion !== sessionScopeVersion || requestSequence !== distributionLoadSequence) return;
    // 分布端点不吃 ?session=，不会撞上作用域 404；失败只做可达性降级
    //（组件自带「数据不可达」块，无重试按钮，自动刷新兜底）。
    state.distributionCleanup();
    state.distributionCleanup = renderDistributionCard(distributionCardElement, null);
    state.cache.distribution = null;
    markSection("distribution", false);
  }
}

/**
 * 会话步数分布卡（v0.21.0）：初载与每轮自动刷新取数；null/失败走组件
 * 自带的降级块，不走 renderError。作用域激活时该面板整体隐藏
 * （applySessionScopePanelVisibility），refreshAllSections /
 * startInitialLoad 会跳过本 loader。markSection 命名与分布卡同款
 * （step-distribution，进 SESSION_SCOPE_SKIPPED_SECTION_MARK_NAMES）。
 */
let stepDistributionLoadSequence = 0;

async function loadStepDistributionSection() {
  if (isSessionScopeActive()) return;
  const requestScopeVersion = sessionScopeVersion;
  const requestSequence = ++stepDistributionLoadSequence;
  try {
    const stepDistribution = await fetchStepDistribution();
    if (requestScopeVersion !== sessionScopeVersion || requestSequence !== stepDistributionLoadSequence) return;
    state.stepDistributionCleanup();
    state.cache.stepDistribution = stepDistribution;
    state.stepDistributionCleanup = renderStepDistributionCard(stepDistributionCardElement, state.cache.stepDistribution);
    markSection("step-distribution", true);
  } catch (error) {
    if (requestScopeVersion !== sessionScopeVersion || requestSequence !== stepDistributionLoadSequence) return;
    state.stepDistributionCleanup();
    state.stepDistributionCleanup = renderStepDistributionCard(stepDistributionCardElement, null);
    state.cache.stepDistribution = null;
    markSection("step-distribution", false);
  }
}

/**
 * 会话时长分布卡（v0.21.0）：每会话墙钟时长（毫秒）分布，初载与自动刷新
 * 取数；失败走组件降级块。作用域激活时整体隐藏、不取数。markSection 命名
 * duration-distribution（进 SESSION_SCOPE_SKIPPED_SECTION_MARK_NAMES）。
 */
let durationDistributionLoadSequence = 0;

async function loadDurationDistributionSection() {
  if (isSessionScopeActive()) return;
  const requestScopeVersion = sessionScopeVersion;
  const requestSequence = ++durationDistributionLoadSequence;
  try {
    const durationDistribution = await fetchDurationDistribution();
    if (requestScopeVersion !== sessionScopeVersion || requestSequence !== durationDistributionLoadSequence) return;
    state.durationDistributionCleanup();
    state.cache.durationDistribution = durationDistribution;
    state.durationDistributionCleanup = renderDurationDistributionCard(durationDistributionCardElement, state.cache.durationDistribution);
    markSection("duration-distribution", true);
  } catch (error) {
    if (requestScopeVersion !== sessionScopeVersion || requestSequence !== durationDistributionLoadSequence) return;
    state.durationDistributionCleanup();
    state.durationDistributionCleanup = renderDurationDistributionCard(durationDistributionCardElement, null);
    state.cache.durationDistribution = null;
    markSection("duration-distribution", false);
  }
}

/**
 * 子代理开销占比卡（v0.21.0）：全部会话口径，初载与自动刷新取数；失败走
 * 组件降级块。作用域激活时整体隐藏、不取数。markSection 命名 child-share
 * （进 SESSION_SCOPE_SKIPPED_SECTION_MARK_NAMES）。
 */
let childShareLoadSequence = 0;

async function loadChildShareSection() {
  if (isSessionScopeActive()) return;
  const requestScopeVersion = sessionScopeVersion;
  const requestSequence = ++childShareLoadSequence;
  try {
    const childShare = await fetchChildShare();
    if (requestScopeVersion !== sessionScopeVersion || requestSequence !== childShareLoadSequence) return;
    state.childShareCleanup();
    state.cache.childShare = childShare;
    state.childShareCleanup = renderChildShareCard(childShareCardElement, state.cache.childShare);
    markSection("child-share", true);
  } catch (error) {
    if (requestScopeVersion !== sessionScopeVersion || requestSequence !== childShareLoadSequence) return;
    state.childShareCleanup();
    state.childShareCleanup = renderChildShareCard(childShareCardElement, null);
    state.cache.childShare = null;
    markSection("child-share", false);
  }
}

/**
 * 工具错误逐日趋势卡（v0.22.0）：全部会话口径（端点不吃 ?session=）。
 * 初载 / 每轮自动刷新 / 卡内范围芯片（30/90/全部）都走本 loader。范围
 * 切换与模型榜 / 热力同款纪律：按窗口分桶缓存（toolErrorTrendByDays），
 * 未命中时保留旧图直到新数据到达（不闪骨架），晚到的过期响应由
 * 「作用域版本 + 请求序号 + 请求窗口」三重守卫弹掉。作用域激活时该
 * 面板整体隐藏（applySessionScopePanelVisibility），refreshAllSections /
 * startInitialLoad 跳过本 loader；markSection 命名 tool-error-trend
 * （进 SESSION_SCOPE_SKIPPED_SECTION_MARK_NAMES）。
 */
let toolErrorTrendLoadSequence = 0;

async function loadToolErrorTrendSection() {
  if (isSessionScopeActive()) return;
  const requestScopeVersion = sessionScopeVersion;
  const requestSequence = ++toolErrorTrendLoadSequence;
  const requestDays = state.toolErrorDays;
  try {
    const toolErrorTrend = await fetchToolErrorTrend(requestDays);
    if (requestScopeVersion !== sessionScopeVersion
      || requestSequence !== toolErrorTrendLoadSequence
      || requestDays !== state.toolErrorDays) return;
    // 过期（作用域已切 / 已有更新请求 / 窗口已换）结果连缓存都不写：
    // 作用域切换已把桶清空，晚到响应不得把它重新填上旧口径数据。
    state.cache.toolErrorTrendByDays[requestDays] = toolErrorTrend;
    state.toolErrorTrendCleanup();
    state.cache.toolErrorTrend = toolErrorTrend;
    state.toolErrorTrendCleanup = renderToolErrorTrendCard(
      toolErrorTrendCardElement,
      toolErrorTrend,
      { onDaysChange: onToolErrorTrendDaysChange },
    );
    markSection("tool-error-trend", true);
  } catch (error) {
    if (requestScopeVersion !== sessionScopeVersion
      || requestSequence !== toolErrorTrendLoadSequence
      || requestDays !== state.toolErrorDays) return;
    // 端点不吃 ?session=，不会撞上作用域 404；失败只做可达性降级
    //（组件自带「数据不可达」块，无重试按钮，自动刷新兜底）。
    state.toolErrorTrendCleanup();
    state.toolErrorTrendCleanup = renderToolErrorTrendCard(
      toolErrorTrendCardElement,
      null,
      { onDaysChange: onToolErrorTrendDaysChange },
    );
    state.cache.toolErrorTrend = null;
    markSection("tool-error-trend", false);
  }
}

/**
 * 只重绘卡内范围工具栏：把 data-tool-error-days 命中 nextDays 的按钮置
 * active + aria-pressed="true"，其余清掉。图表容器 / 图例 / 明细一律不动
 * ——未命中缓存时旧图保留到新数据到达（与热力图 / 模型榜同款「不闪骨架」
 * 纪律；差别只在热力图的切换器是 index.html 静态节点、本卡的由卡片组件
 * 渲染，故按组件写下的 data-tool-error-days 契约属性选择按钮）。
 */
function applyToolErrorTrendDaysSelection(selectedDays) {
  for (const rangeButton of toolErrorTrendCardElement.querySelectorAll("button[data-tool-error-days]")) {
    const isSelected = Number(rangeButton.dataset.toolErrorDays) === selectedDays;
    rangeButton.classList.toggle("active", isSelected);
    rangeButton.setAttribute("aria-pressed", String(isSelected));
  }
}

/**
 * 卡内范围芯片回调：命中缓存即时整卡重渲；未命中时**先**把工具栏按
 * nextDays 立即重绘（选中态 = 用户刚点的窗口，屏幕阅读器与视觉都不会
 * 停在过期窗口），再由 loader 取数，响应到达后按既有纪律整体重渲。
 * 命中判定前置：只有走 loader 的那条路需要先改工具栏。
 */
function onToolErrorTrendDaysChange(nextDays) {
  state.toolErrorDays = nextDays;
  const cachedTrend = state.cache.toolErrorTrendByDays[nextDays];
  if (cachedTrend !== undefined) {
    state.toolErrorTrendCleanup();
    state.cache.toolErrorTrend = cachedTrend;
    state.toolErrorTrendCleanup = renderToolErrorTrendCard(
      toolErrorTrendCardElement,
      cachedTrend,
      { onDaysChange: onToolErrorTrendDaysChange },
    );
    // 缓存命中同样记成功（同 onModelRangeSelected 的理由：指针已指向
    // 完好数据，先前的失败计数残留在顶栏会与数据面不一致）。
    markSection("tool-error-trend", true);
    return;
  }
  applyToolErrorTrendDaysSelection(nextDays);
  loadToolErrorTrendSection();
}

/**
 * 会话结局卡（v0.22.0）：全部会话口径，初载与每轮自动刷新取数；null/失败
 * 走组件自带的降级块（无重试按钮——自动刷新即兜底），不走 renderError。
 * 作用域激活时该面板整体隐藏，refreshAllSections / startInitialLoad 会
 * 跳过本 loader；markSection 命名 session-outcomes（进
 * SESSION_SCOPE_SKIPPED_SECTION_MARK_NAMES）。
 */
let sessionOutcomesLoadSequence = 0;

async function loadSessionOutcomesSection() {
  if (isSessionScopeActive()) return;
  const requestScopeVersion = sessionScopeVersion;
  const requestSequence = ++sessionOutcomesLoadSequence;
  try {
    const sessionOutcomes = await fetchSessionOutcomes();
    if (requestScopeVersion !== sessionScopeVersion || requestSequence !== sessionOutcomesLoadSequence) return;
    state.sessionOutcomesCleanup();
    state.cache.sessionOutcomes = sessionOutcomes;
    state.sessionOutcomesCleanup = renderSessionOutcomeCard(sessionOutcomesCardElement, state.cache.sessionOutcomes);
    markSection("session-outcomes", true);
  } catch (error) {
    if (requestScopeVersion !== sessionScopeVersion || requestSequence !== sessionOutcomesLoadSequence) return;
    state.sessionOutcomesCleanup();
    state.sessionOutcomesCleanup = renderSessionOutcomeCard(sessionOutcomesCardElement, null);
    state.cache.sessionOutcomes = null;
    markSection("session-outcomes", false);
  }
}

/* ---------- 模型 / 目录下钻过滤 ---------- */
function onModelSelected(modelId) {
  state.modelFilter = modelId;
  renderModelTable(modelTableElement, state.cache.models ?? [], state.modelFilter, onModelSelected);
  sessionSortController.renderCurrent();
  renderSessionFilterChip();
}

/**
 * 目录下钻（v0.7.0）：点目录面板行 → 会话列表按该目录过滤（服务端
 * ?directory= 精确匹配），toggle 语义同模型排行榜（点选中行 → null）。
 * 与模型过滤正交可叠加：目录走服务端参数（控制器缓存键扩维），模型
 * 走客户端行过滤（renderCurrent 即时生效）。
 */
function onDirectorySelected(directoryPath) {
  state.directoryFilter = directoryPath;
  renderDirectoryPanel(directoryPanelElement, state.cache.directories ?? null, state.directoryFilter, onDirectorySelected);
  sessionSortController.changeDirectory(directoryPath);
  renderSessionFilterChip();
}

/**
 * 会话面板头部的过滤态可视化：目录与模型各一枚 filter-chip，各带独立
 * 清除 ✕（形态与既有模型 chip 完全一致，v0.7.0 只是把它扩成枚举）。
 */
function renderSessionFilterChip() {
  const chipParts = [];
  if (state.directoryFilter !== null) {
    chipParts.push(`
      <span class="filter-chip">目录：${escapeHtml(state.directoryFilter)}
        <button type="button" data-clear-filter="directory" title="取消目录过滤" aria-label="取消目录过滤">✕</button>
      </span>`);
  }
  if (state.modelFilter !== null) {
    chipParts.push(`
      <span class="filter-chip">模型：${escapeHtml(state.modelFilter)}
        <button type="button" data-clear-filter="model" title="取消过滤" aria-label="取消模型过滤">✕</button>
      </span>`);
  }
  sessionFilterChipElement.innerHTML = chipParts.join("");
  for (const clearButton of sessionFilterChipElement.querySelectorAll("button[data-clear-filter]")) {
    clearButton.addEventListener("click", () => {
      if (clearButton.dataset.clearFilter === "directory") {
        onDirectorySelected(null);
      } else {
        onModelSelected(null);
      }
    });
  }
}

/* ---------- 时间范围 ---------- */
function rangeToDays(range) {
  return range === "all" ? TREND_CALENDAR_WINDOW_DAYS : Number(range);
}

function bindRangeSwitch() {
  rangeSwitchElement.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-range]");
    if (button === null) return;
    const nextRange = button.dataset.range;
    if (nextRange === state.range) return;
    state.range = nextRange;
    for (const rangeButton of rangeSwitchElement.querySelectorAll("button")) {
      rangeButton.classList.toggle("active", rangeButton === button);
    }
    if (state.cache.rangeTrend[state.range] !== undefined) {
      renderTrendSectionFromCache();
      // R1：缓存命中同样记成功——先前窗口的失败计数不得残留顶栏。
      markSection("trend", true);
    } else {
      loadTrendSection();
    }
  });
}

/* ---------- 目录导航（区块跳转 chip 行） ---------- */

/**
 * TOC 点击：平滑滚动到目标区块 + 短暂高亮（描边一闪，~1.2s 后淡出）。
 * 不做 scrollspy（刻意保持简单）；高亮动画用 remove→reflow→add 的
 * 重放套路，重复点击同一区块也能再次闪起。
 */
function bindTocNavigation() {
  tocNavElement.addEventListener("click", (event) => {
    const tocButton = event.target.closest("button[data-toc-target]");
    if (tocButton === null) return;
    const targetElement = document.getElementById(tocButton.dataset.tocTarget);
    if (targetElement === null) return;
    targetElement.scrollIntoView({ behavior: "smooth", block: "start" });
    targetElement.classList.remove("toc-flash");
    void targetElement.offsetWidth; // 强制重排，确保同区块重复点击也能重放动画
    targetElement.classList.add("toc-flash");
    window.setTimeout(() => targetElement.classList.remove("toc-flash"), 1300);
  });
}

/* ---------- hash 路由 ---------- */
/**
 * #/session/:id 的 id 段解码（写入端 session-list.js 用 encodeURIComponent）。
 * 手输/损坏的非法 % 序列降级为原文传下去，不让路由抛错。
 */
function decodeSessionIdFromHash(encodedSessionId) {
  try {
    return decodeURIComponent(encodedSessionId);
  } catch {
    return encodedSessionId;
  }
}

/** `#/session/<id>?msg=<messageID>` 的会话段：查询串由 replay-deep-link.js 解析。 */
function routeByHash() {
  // v0.24.0：会话路由允许带 `?msg=` 深链参数。会话 id 段必须在 `?` 处截止，
  // 否则 `ses_x?msg=msg_y` 会被当成整个 id 去查库（查不到，误报旧表会话）。
  const sessionMatch = /^#\/session\/([^?]+)(\?.*)?$/.exec(window.location.hash);
  if (sessionMatch !== null) {
    dashboardElement.hidden = true;
    sessionViewElement.hidden = false;
    renderSessionReplay(sessionViewElement, decodeSessionIdFromHash(sessionMatch[1]));
    return;
  }
  dashboardElement.hidden = false;
  sessionViewElement.hidden = true;
}

/* ---------- 后台定时自动刷新（v0.18.x） ---------- */

/** localStorage 键：见名知意——插件专属前缀 + 语义单位（分钟）。 */
const AUTO_REFRESH_STORAGE_KEY = "insight-auto-refresh-minutes";
/** 合法取值：0 = 关，其余为分钟数。非法/损坏的存量值一律回退默认。 */
const AUTO_REFRESH_CHOICES = [0, 1, 5, 15];
const AUTO_REFRESH_DEFAULT_MINUTES = 5;
/** 下拉项文案（键 = 分钟数，与 AUTO_REFRESH_CHOICES 一一对应）。 */
const AUTO_REFRESH_OPTION_LABELS = new Map([
  [0, "自动刷新: 关"],
  [1, "自动刷新: 1m"],
  [5, "自动刷新: 5m"],
  [15, "自动刷新: 15m"],
]);

let autoRefreshTimerId = null;

/**
 * 读取持久化的刷新间隔。注意先判 null 再 Number()：getItem 缺省返回
 * null，Number(null) === 0 会把「从未设置」误读成「关闭」——首次访问
 * 应落默认 5m 而不是静默关闭。
 * P2-1（v0.19.1）：整个读取包 try/catch——localStorage 本身不可用
 * （隐私模式/存储被策略禁用会抛 SecurityError）时回退默认 5m，
 * 读侧失败不得拖垮 init 造成白屏。正常环境行为零变化。
 */
function readStoredAutoRefreshMinutes() {
  try {
    const storedValue = window.localStorage.getItem(AUTO_REFRESH_STORAGE_KEY);
    if (storedValue === null) return AUTO_REFRESH_DEFAULT_MINUTES;
    const storedMinutes = Number(storedValue);
    return AUTO_REFRESH_CHOICES.includes(storedMinutes)
      ? storedMinutes
      : AUTO_REFRESH_DEFAULT_MINUTES;
  } catch {
    return AUTO_REFRESH_DEFAULT_MINUTES;
  }
}

/**
 * 全量刷新一轮：以当前 state 各维度（range/modelRange/heatmapDays/
 * 过滤器）原样重取全部区块——等于用户当前视图的强制重拉，不改变任何
 * 交互状态。各 loader 自带序列守卫与独立容错：并发时晚到的旧响应会被
 * 弹掉，失败的区块走既有 renderError + markSection(false)，顶栏失败
 * 计数如实反映。可重入保护：上一轮未收尾时本次直接跳过（连续 tick
 * 不会堆叠请求）。健康探活一并刷新，让顶栏连接文案跟数据同步更新。
 */
async function refreshAllSections() {
  if (state.refreshInFlight) return;
  state.refreshInFlight = true;
  const roundSessionScopeId = state.sessionScopeId;
  try {
    await Promise.allSettled([
      loadHealthStatus(),
      loadOverviewSection(),
      loadTrendSection(),
      loadToolsSection(),
      loadToolHealthSection(),
      loadModelsSection(),
      sessionSortController.refreshCurrentView(),
      loadCompactionSection(),
      loadTodoSection(),
      // 作用域激活时以下面板整体隐藏（applySessionScopePanelVisibility），
      // 跳过取数——隐藏面板的请求是纯浪费，失败计数也会误导顶栏。
      ...(roundSessionScopeId === null ? [
        loadCalendarSection(),
        loadHourHeatmapSection(),
        loadAgentSection(),
        loadDirectorySection(),
        loadSessionSurvivalSection(),
        loadDistributionSection(),
        loadStepDistributionSection(),
        loadDurationDistributionSection(),
        loadChildShareSection(),
        loadToolErrorTrendSection(),
        loadSessionOutcomesSection(),
      ] : []),
    ]);
  } finally {
    // allSettled 后必然到达：无论个别区块成败都收尾并记时间戳——
    // 补刷判定用它防「回前台瞬间连环重刷刚失败过的区块」。
    state.refreshInFlight = false;
    state.lastRefreshCompletedAt = Date.now();
    // 轮内作用域被切换（进入/退出/404 自动退）：本轮各请求带的是旧口径，
    // 立刻按新口径补一轮。enter/exitSessionScope 直接调本函数会被上面的
    // refreshInFlight 守卫挡掉，靠这里追平。
    if (roundSessionScopeId !== state.sessionScopeId) {
      void refreshAllSections();
    }
  }
}

/** 定时 tick：隐藏时跳过（无人看着的后台刷新是纯浪费——服务端每请求现查）。 */
function onAutoRefreshTick() {
  // P2-6（v0.19.1）：回放页（dashboard 隐藏）同样跳过——回放数据不消费
  // 看板区块，回放期间刷看板是纯浪费；切回看板后由 onVisibilityChange
  // 的补刷判定追平。
  if (document.hidden || dashboardElement.hidden) return;
  void refreshAllSections();
}

/**
 * visibilitychange 补刷：隐藏期间被跳过的 tick 不再等下一个整周期——
 * 回到可见且距上一轮收尾已超过当前间隔时立即补一次；间隔内则等
 * 既有定时器自然触发。自动刷新关闭（interval = 0）时不补。
 */
function onVisibilityChange() {
  // P2-6（v0.19.1）：从回放页切回看板（document 可见但 dashboard 仍
  // 隐藏）不触发补刷；dashboard 可见时才按间隔判定补。
  if (document.hidden || dashboardElement.hidden || state.autoRefreshMinutes === 0) return;
  const intervalMilliseconds = state.autoRefreshMinutes * 60000;
  if (Date.now() - state.lastRefreshCompletedAt >= intervalMilliseconds) {
    void refreshAllSections();
  }
}

/** 应用间隔：先清旧定时器再按需建新（变更即重置，避免双定时器叠加）。 */
function applyAutoRefreshInterval(refreshMinutes) {
  if (autoRefreshTimerId !== null) {
    window.clearInterval(autoRefreshTimerId);
    autoRefreshTimerId = null;
  }
  if (refreshMinutes > 0) {
    autoRefreshTimerId = window.setInterval(onAutoRefreshTick, refreshMinutes * 60000);
  }
}

/**
 * 注入自动刷新下拉控件（全部 JS 创建，不改 index.html）：挂在顶栏
 * #top-status 右侧，与 trend 的 .range-switch 同一行——容器复用
 * .range-switch 胶囊描边；styles.css 无原生 select 样式，select 本体
 * 用最小内联样式对齐 .range-switch button 的字号/配色语言。
 */
function mountAutoRefreshControl() {
  const controlNavElement = document.createElement("nav");
  controlNavElement.className = "range-switch";
  controlNavElement.setAttribute("aria-label", "后台自动刷新间隔");

  const intervalSelectElement = document.createElement("select");
  intervalSelectElement.setAttribute("aria-label", "自动刷新间隔");
  intervalSelectElement.title = "后台定时刷新全部区块";
  // 复用容器胶囊内的按钮语言：无描边（描边归容器）、同字号、同灰阶。
  intervalSelectElement.style.border = "none";
  intervalSelectElement.style.background = "transparent";
  intervalSelectElement.style.color = "var(--text-dim)";
  intervalSelectElement.style.fontSize = "12.5px";
  intervalSelectElement.style.padding = "4px 10px";

  for (const refreshMinutes of AUTO_REFRESH_CHOICES) {
    const optionElement = document.createElement("option");
    optionElement.value = String(refreshMinutes);
    optionElement.textContent = AUTO_REFRESH_OPTION_LABELS.get(refreshMinutes);
    intervalSelectElement.appendChild(optionElement);
  }
  intervalSelectElement.value = String(state.autoRefreshMinutes);

  intervalSelectElement.addEventListener("change", () => {
    const nextMinutes = Number(intervalSelectElement.value);
    if (!AUTO_REFRESH_CHOICES.includes(nextMinutes)) return;
    state.autoRefreshMinutes = nextMinutes;
    // P2-1（v0.19.1）：写侧包 try/catch——持久化失败只影响下次访问的
    // 初值；且无论 setItem 成败都应用间隔，否则下拉显示新值而定时器
    // 还是旧间隔（UI 值与定时器错位）。
    try {
      window.localStorage.setItem(AUTO_REFRESH_STORAGE_KEY, String(nextMinutes));
    } catch {
      /* 隐私模式/存储禁用：本次会话照常生效，仅不跨会话记忆 */
    }
    applyAutoRefreshInterval(nextMinutes);
  });

  controlNavElement.appendChild(intervalSelectElement);
  topStatusElement.insertAdjacentElement("afterend", controlNavElement);
}

/* ---------- 启动 ---------- */
async function startInitialLoad() {
  renderKpiRow(kpiRowElement, null);
  // 载入即强清服务端 60s TTL 缓存：F5 保证全新数据。清缓存失败不阻塞
  // 面板（退化为最多滞后 60 秒），各区块自身的容错照常工作。
  try {
    await fetchRefresh();
  } catch {
    /* /api/refresh 不可达 → 沿用 TTL 过期语义 */
  }
  loadHealthStatus();
  loadOverviewSection();
  loadTrendSection();
  loadToolsSection();
  loadToolHealthSection();
  loadModelsSection();
  sessionSortController.load();
  loadCompactionSection();
  loadTodoSection();
  // 作用域缺省为 null，正常全量初载；若初载前用户已点行内按钮进入作用域
  //（竞态窗口极小），isSessionScopeActive 的守卫与 refreshAllSections 的
  // 补一轮机制会追平，这里不必重复判定。
  if (!isSessionScopeActive()) {
    loadCalendarSection();
    loadHourHeatmapSection();
    loadAgentSection();
    loadDirectorySection();
    loadSessionSurvivalSection();
    loadDistributionSection();
    loadStepDistributionSection();
    loadDurationDistributionSection();
    loadChildShareSection();
    loadToolErrorTrendSection();
    loadSessionOutcomesSection();
  }
}

function init() {
  bindRangeSwitch();
  bindModelRangeSwitch();
  bindHeatmapRangeSwitch();
  bindTocNavigation();
  renderHourHeatmapSub();
  // 后台定时刷新：读持久化间隔 → 注入下拉控件 → 启动定时器；首次加载
  // 视为一次完整刷新，作为补刷判定的时间基准。
  state.autoRefreshMinutes = readStoredAutoRefreshMinutes();
  mountAutoRefreshControl();
  applyAutoRefreshInterval(state.autoRefreshMinutes);
  document.addEventListener("visibilitychange", onVisibilityChange);
  state.lastRefreshCompletedAt = Date.now();
  window.addEventListener("hashchange", routeByHash);
  // 系统深浅色切换时，图表配色从 CSS 变量重读一遍
  onSchemeChange(() => {
    if (state.cache.overview !== undefined) renderKpiRow(kpiRowElement, state.cache.overview);
    if (state.cache.rangeTrend[state.range] !== undefined) renderTrendSectionFromCache();
    if (state.cache.calendarTrend !== undefined) renderCalendarHeatmap(calendarHeatmapElement, state.cache.calendarTrend);
    // 时段热力 / 压缩迷你趋势用 cssVar 内联着色，主题切换后重读配色
    if (state.cache.hourHeatmap !== undefined) renderHourHeatmap(hourHeatmapElement, state.cache.hourHeatmap);
    if (state.cache.compaction !== undefined) renderCompactionPanel(compactionPanelElement, state.cache.compaction);
    if (state.cache.sessionSurvival !== undefined) renderSessionSurvivalCard(sessionSurvivalElement, state.cache.sessionSurvival);
    if (state.cache.todo !== undefined) renderTodoCard(todoCardElement, state.cache.todo);
    if (state.cache.directories !== undefined) renderDirectoryPanel(directoryPanelElement, state.cache.directories, state.directoryFilter, onDirectorySelected);
    // 分布卡直方图配色经 cssVar 内联，主题切换后按缓存重读配色
    if (state.cache.distribution !== undefined && !isSessionScopeActive()) {
      state.distributionCleanup();
      state.distributionCleanup = renderDistributionCard(distributionCardElement, state.cache.distribution);
    }
    // 步数 / 时长分布卡共用同一共享直方图渲染器（cssVar 内联配色），
    // 主题切换后同样按缓存重读配色。
    if (state.cache.stepDistribution !== undefined && !isSessionScopeActive()) {
      state.stepDistributionCleanup();
      state.stepDistributionCleanup = renderStepDistributionCard(stepDistributionCardElement, state.cache.stepDistribution);
    }
    if (state.cache.durationDistribution !== undefined && !isSessionScopeActive()) {
      state.durationDistributionCleanup();
      state.durationDistributionCleanup = renderDurationDistributionCard(durationDistributionCardElement, state.cache.durationDistribution);
    }
    // 工具错误趋势卡（uPlot 内联配色）/ 会话结局卡（纯 DOM，无配色依赖），
    // 主题切换后按缓存重渲；作用域激活时面板隐藏，跳过。
    if (state.cache.toolErrorTrend !== undefined && !isSessionScopeActive()) {
      state.toolErrorTrendCleanup();
      state.toolErrorTrendCleanup = renderToolErrorTrendCard(
        toolErrorTrendCardElement,
        state.cache.toolErrorTrend,
        { onDaysChange: onToolErrorTrendDaysChange },
      );
    }
    if (state.cache.sessionOutcomes !== undefined && !isSessionScopeActive()) {
      state.sessionOutcomesCleanup();
      state.sessionOutcomesCleanup = renderSessionOutcomeCard(sessionOutcomesCardElement, state.cache.sessionOutcomes);
    }
    if (state.cache.agents !== undefined) renderToolBars(toolBarsElement, state.cache.agents, state.cache.toolHealth ?? null);
    if (state.cache.models !== undefined) renderModelTable(modelTableElement, state.cache.models, state.modelFilter, onModelSelected);
    sessionSortController.renderCurrentIfLoaded();
  });

  routeByHash();
  startInitialLoad();
}

init();

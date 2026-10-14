/**
 * 应用装配：hash 路由 + 各区块数据获取与渲染 + 时间范围切换。
 * 每个区块独立加载/独立容错（API 挂了不白屏），数据统一走
 * data-source.js（当前 mock，M2 后切真实 API 只改那一处）。
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
  fetchRefresh,
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
import { createSessionSortController } from "./components/session-sort-controller.js";
import { renderSessionReplay } from "./components/session-replay.js";
import { renderError } from "./components/state-views.js";

/** 日历热力图固定窗口 = 后端 MAX_TREND_DAYS（366 天 ≈ 52.3 周，缺的天按零渲染）。 */
const TREND_CALENDAR_WINDOW_DAYS = MAX_TREND_DAYS;

const state = {
  range: "30",
  modelFilter: null,
  directoryFilter: null,
  // 模型排行榜窗口（data-model-range 值）：默认全部。缓存按窗口分桶，
  // state.cache.models 始终指向「当前窗口」的数据（主题切换/下钻重渲染用）。
  modelRange: "all",
  // 活动时段热力窗口（?days= 值）：默认 90（契约缺省）。All 用 366。
  heatmapDays: 90,
  healthStatus: "连接中…",
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
  },
  failedSections: new Set(),
  trendCleanup: () => {},
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
const rangeSwitchElement = document.getElementById("range-switch");
const statusDotElement = document.getElementById("status-dot");
const statusTextElement = document.getElementById("status-text");

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
      renderError(container, error, loadSection);
      markSection(sectionName, false);
    }
  }
  return loadSection;
}

const loadOverviewSection = createSimpleSectionLoader(
  "overview",
  kpiRowElement,
  async () => (state.cache.overview = await fetchOverview()),
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
    const rangeTrend = await fetchTrend(rangeToDays(requestRange));
    state.cache.rangeTrend[requestRange] = rangeTrend;
    if (requestToken !== trendLoadSequence || requestRange !== state.range) return;
    renderTrendSectionFromCache();
    markSection("trend", true);
  } catch (error) {
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
  async () => (state.cache.calendarTrend = await fetchTrend(TREND_CALENDAR_WINDOW_DAYS)),
  (calendarTrend) => renderCalendarHeatmap(calendarHeatmapElement, calendarTrend),
);

async function loadToolsSection() {
  try {
    state.cache.agents = await fetchAgents();
    // toolHealth 可能先/后于 agents 到达：两侧各自到达后互刷（见下两节），
    // 任一侧缺失时条形图按无健康度渲染，不阻塞彼此。
    renderToolBars(toolBarsElement, state.cache.agents, state.cache.toolHealth ?? null);
    markSection("tools", true);
  } catch (error) {
    renderError(toolBarsElement, error, loadToolsSection);
    markSection("tools", false);
  }
}

/** Agent 排行榜：同一 /api/agents 端点的独立加载/独立容错（与 tools 区块
 * 各自请求，服务端 60s TTL 下两次请求不双倍成本）。 */
const loadAgentSection = createSimpleSectionLoader(
  "agents",
  agentTableElement,
  async () => (state.cache.agents = await fetchAgents()),
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
    state.cache.toolHealth = await fetchToolHealth();
    renderToolHealthCaption(state.cache.toolHealth);
    if (state.cache.agents !== undefined) {
      renderToolBars(toolBarsElement, state.cache.agents, state.cache.toolHealth);
    }
    markSection("tool-health", true);
  } catch (error) {
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
    const modelMetrics = await fetchModels(modelRangeDays(requestRange));
    state.cache.modelsByRange[requestRange] = modelMetrics;
    if (requestToken !== modelsLoadSequence || requestRange !== state.modelRange) return;
    state.cache.models = modelMetrics;
    renderModelTable(modelTableElement, modelMetrics, state.modelFilter, onModelSelected);
    markSection("models", true);
  } catch (error) {
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
 */
const sessionSortController = createSessionSortController({
  containerElement: sessionListElement,
  fetchSessionsPage: (sortKey, sortOrder, directory, range) =>
    fetchSessions(SESSION_LIST_PAGE_LIMIT, 0, sortKey, sortOrder, directory, range),
  getModelFilter: () => state.modelFilter,
  markSectionSucceeded: () => markSection("sessions", true),
  markSectionFailed: () => markSection("sessions", false),
});

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
    const heatmapCells = await fetchHourHeatmap(requestDays);
    state.cache.hourHeatmapByDays[requestDays] = heatmapCells;
    if (requestToken !== heatmapLoadSequence || requestDays !== state.heatmapDays) return;
    state.cache.hourHeatmap = heatmapCells;
    renderHourHeatmap(hourHeatmapElement, heatmapCells);
    markSection("hour-heatmap", true);
  } catch (error) {
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
  async () => (state.cache.sessionSurvival = await fetchSessionSurvival()),
  (survivalStats) => renderSessionSurvivalCard(sessionSurvivalElement, survivalStats),
);

const loadCompactionSection = createSimpleSectionLoader(
  "compaction",
  compactionPanelElement,
  async () => (state.cache.compaction = await fetchCompaction()),
  (compactionStats) => renderCompactionPanel(compactionPanelElement, compactionStats),
);

const loadTodoSection = createSimpleSectionLoader(
  "todo",
  todoCardElement,
  async () => (state.cache.todo = await fetchTodo()),
  (todoStats) => renderTodoCard(todoCardElement, todoStats),
);

const loadDirectorySection = createSimpleSectionLoader(
  "directories",
  directoryPanelElement,
  async () => (state.cache.directories = await fetchDirectoryStats(10)),
  (directoryStats) =>
    renderDirectoryPanel(directoryPanelElement, directoryStats, state.directoryFilter, onDirectorySelected),
);

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

function routeByHash() {
  const sessionMatch = /^#\/session\/(.+)$/.exec(window.location.hash);
  if (sessionMatch !== null) {
    dashboardElement.hidden = true;
    sessionViewElement.hidden = false;
    renderSessionReplay(sessionViewElement, decodeSessionIdFromHash(sessionMatch[1]));
    return;
  }
  dashboardElement.hidden = false;
  sessionViewElement.hidden = true;
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
  loadCalendarSection();
  loadHourHeatmapSection();
  loadToolsSection();
  loadToolHealthSection();
  loadAgentSection();
  loadModelsSection();
  sessionSortController.load();
  loadCompactionSection();
  loadSessionSurvivalSection();
  loadTodoSection();
  loadDirectorySection();
}

function init() {
  bindRangeSwitch();
  bindModelRangeSwitch();
  bindHeatmapRangeSwitch();
  bindTocNavigation();
  renderHourHeatmapSub();
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
    if (state.cache.agents !== undefined) renderToolBars(toolBarsElement, state.cache.agents, state.cache.toolHealth ?? null);
    if (state.cache.models !== undefined) renderModelTable(modelTableElement, state.cache.models, state.modelFilter, onModelSelected);
    sessionSortController.renderCurrentIfLoaded();
  });

  routeByHash();
  startInitialLoad();
}

init();

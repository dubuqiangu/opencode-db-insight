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
  fetchSessions,
  fetchHealth,
  fetchHourHeatmap,
  fetchSessionSurvival,
  fetchCompaction,
  fetchTodo,
  fetchDirectoryStats,
  MAX_TREND_DAYS,
} from "./data-source.js";
import { formatTokens, formatPercent, escapeHtml } from "./format.js";
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
import { renderTokenFunnel } from "./components/token-funnel.js";
import { renderModelTable } from "./components/model-table.js";
import { renderSessionList } from "./components/session-list.js";
import { renderSessionReplay } from "./components/session-replay.js";
import { renderError } from "./components/state-views.js";

/** 日历热力图固定窗口 = 后端 MAX_TREND_DAYS（366 天 ≈ 52.3 周，缺的天按零渲染）。 */
const TREND_CALENDAR_WINDOW_DAYS = MAX_TREND_DAYS;

const state = {
  range: "30",
  modelFilter: null,
  healthStatus: "连接中…",
  cache: {
    overview: undefined,
    calendarTrend: undefined,
    rangeTrend: {},
    models: undefined,
    agents: undefined,
    sessions: undefined,
    hourHeatmap: undefined,
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
const tokenFunnelElement = document.getElementById("token-funnel");
const funnelCaptionElement = document.getElementById("funnel-caption");
const modelTableElement = document.getElementById("model-table");
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
async function loadOverviewSection() {
  try {
    state.cache.overview = await fetchOverview();
    renderKpiRow(kpiRowElement, state.cache.overview);
    markSection("overview", true);
  } catch (error) {
    renderError(kpiRowElement, error, loadOverviewSection);
    markSection("overview", false);
  }
}

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

async function loadCalendarSection() {
  try {
    state.cache.calendarTrend = await fetchTrend(TREND_CALENDAR_WINDOW_DAYS);
    renderCalendarHeatmap(calendarHeatmapElement, state.cache.calendarTrend);
    markSection("calendar", true);
  } catch (error) {
    renderError(calendarHeatmapElement, error, loadCalendarSection);
    markSection("calendar", false);
  }
}

async function loadToolsSection() {
  try {
    state.cache.agents = await fetchAgents();
    renderToolBars(toolBarsElement, state.cache.agents);
    markSection("tools", true);
  } catch (error) {
    renderError(toolBarsElement, error, loadToolsSection);
    markSection("tools", false);
  }
}

async function loadModelsSection() {
  try {
    state.cache.models = await fetchModels();
    renderModelTable(modelTableElement, state.cache.models, state.modelFilter, onModelSelected);
    markSection("models", true);
  } catch (error) {
    renderError(modelTableElement, error, loadModelsSection);
    markSection("models", false);
  }
}

async function loadSessionsSection() {
  try {
    state.cache.sessions = await fetchSessions();
    renderSessionList(sessionListElement, state.cache.sessions, state.modelFilter);
    markSection("sessions", true);
  } catch (error) {
    renderError(sessionListElement, error, loadSessionsSection);
    markSection("sessions", false);
  }
}

async function loadHourHeatmapSection() {
  try {
    state.cache.hourHeatmap = await fetchHourHeatmap();
    renderHourHeatmap(hourHeatmapElement, state.cache.hourHeatmap);
    markSection("hour-heatmap", true);
  } catch (error) {
    renderError(hourHeatmapElement, error, loadHourHeatmapSection);
    markSection("hour-heatmap", false);
  }
}

async function loadSessionSurvivalSection() {
  try {
    state.cache.sessionSurvival = await fetchSessionSurvival();
    renderSessionSurvivalCard(sessionSurvivalElement, state.cache.sessionSurvival);
    markSection("session-survival", true);
  } catch (error) {
    renderError(sessionSurvivalElement, error, loadSessionSurvivalSection);
    markSection("session-survival", false);
  }
}

async function loadCompactionSection() {
  try {
    state.cache.compaction = await fetchCompaction();
    renderCompactionPanel(compactionPanelElement, state.cache.compaction);
    markSection("compaction", true);
  } catch (error) {
    renderError(compactionPanelElement, error, loadCompactionSection);
    markSection("compaction", false);
  }
}

async function loadTodoSection() {
  try {
    state.cache.todo = await fetchTodo();
    renderTodoCard(todoCardElement, state.cache.todo);
    markSection("todo", true);
  } catch (error) {
    renderError(todoCardElement, error, loadTodoSection);
    markSection("todo", false);
  }
}

async function loadDirectorySection() {
  try {
    state.cache.directories = await fetchDirectoryStats(10);
    renderDirectoryPanel(directoryPanelElement, state.cache.directories);
    markSection("directories", true);
  } catch (error) {
    renderError(directoryPanelElement, error, loadDirectorySection);
    markSection("directories", false);
  }
}

/* ---------- 模型下钻过滤 ---------- */
function onModelSelected(modelId) {
  state.modelFilter = modelId;
  renderModelTable(modelTableElement, state.cache.models ?? [], state.modelFilter, onModelSelected);
  renderSessionList(sessionListElement, state.cache.sessions ?? null, state.modelFilter);
  renderSessionFilterChip();
}

function renderSessionFilterChip() {
  if (state.modelFilter === null) {
    sessionFilterChipElement.innerHTML = "";
    return;
  }
  sessionFilterChipElement.innerHTML = `
    <span class="filter-chip">模型：${escapeHtml(state.modelFilter)}
      <button type="button" title="取消过滤" aria-label="取消模型过滤">✕</button>
    </span>`;
  sessionFilterChipElement.querySelector("button").addEventListener("click", () => {
    state.modelFilter = null;
    onModelSelected(null);
  });
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
    } else {
      loadTrendSection();
    }
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
function startInitialLoad() {
  renderKpiRow(kpiRowElement, null);
  loadHealthStatus();
  loadOverviewSection();
  loadTrendSection();
  loadCalendarSection();
  loadHourHeatmapSection();
  loadToolsSection();
  loadModelsSection();
  loadSessionsSection();
  loadCompactionSection();
  loadSessionSurvivalSection();
  loadTodoSection();
  loadDirectorySection();
}

function init() {
  bindRangeSwitch();
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
    if (state.cache.directories !== undefined) renderDirectoryPanel(directoryPanelElement, state.cache.directories);
    if (state.cache.agents !== undefined) renderToolBars(toolBarsElement, state.cache.agents);
    if (state.cache.models !== undefined) renderModelTable(modelTableElement, state.cache.models, state.modelFilter, onModelSelected);
    if (state.cache.sessions !== undefined) renderSessionList(sessionListElement, state.cache.sessions, state.modelFilter);
  });

  routeByHash();
  startInitialLoad();
}

init();

/**
 * 应用装配：hash 路由 + 各区块数据获取与渲染 + 时间范围切换。
 * 每个区块独立加载/独立容错（API 挂了不白屏），数据统一走
 * data-source.js（当前 mock，M2 后切真实 API 只改那一处）。
 */

import { fetchOverview, fetchTrend, fetchModels, fetchAgents, fetchSessions } from "./data-source.js";
import { formatTokens, formatPercent, escapeHtml } from "./format.js";
import { onSchemeChange } from "./theme.js";
import { renderKpiRow } from "./components/kpi-card.js";
import { renderTrendChart } from "./components/trend-chart.js";
import { renderCalendarHeatmap } from "./components/calendar-heatmap.js";
import { renderToolBars } from "./components/tool-bars.js";
import { renderTokenFunnel } from "./components/token-funnel.js";
import { renderModelTable } from "./components/model-table.js";
import { renderSessionList } from "./components/session-list.js";
import { renderError } from "./components/state-views.js";

/** 日历热力图固定窗口：53 周。 */
const TREND_CALENDAR_WINDOW_DAYS = 371;

const state = {
  range: "30",
  modelFilter: null,
  cache: {
    overview: undefined,
    calendarTrend: undefined,
    rangeTrend: {},
    models: undefined,
    agents: undefined,
    sessions: undefined,
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
    statusTextElement.textContent = "数据源：mock（M2 后切真实 API）";
  }
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

async function loadTrendSection() {
  try {
    state.trendCleanup();
    const rangeTrend = await fetchTrend(rangeToDays(state.range));
    state.cache.rangeTrend[state.range] = rangeTrend;
    renderTrendSectionFromCache();
    markSection("trend", true);
  } catch (error) {
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
function routeByHash() {
  const sessionMatch = /^#\/session\/(.+)$/.exec(window.location.hash);
  if (sessionMatch !== null) {
    renderSessionPlaceholder(sessionMatch[1]);
    return;
  }
  dashboardElement.hidden = false;
  sessionViewElement.hidden = true;
}

/** M4 回放页占位：保持路由可达，避免白屏或 404 感。 */
function renderSessionPlaceholder(sessionId) {
  dashboardElement.hidden = true;
  sessionViewElement.hidden = false;
  sessionViewElement.innerHTML = `
    <a class="back-link" href="#/">返回看板</a>
    <article class="panel">
      <header class="panel-head">
        <div>
          <h2>会话回放</h2>
          <p class="panel-sub">角色时间线 + 系统提示词 + turn 级成本条 —— M4 里程碑交付</p>
        </div>
      </header>
      <div class="panel-body">
        <div class="state-view">
          <svg class="state-icon" width="34" height="34" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M8 5.5v13l10-6.5z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>
            <path d="M3 21h18" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>
          </svg>
          <div>回放视图还在施工中（M4）</div>
          <div class="session-id-line">目标会话 ID：${escapeHtml(sessionId)}</div>
        </div>
      </div>
    </article>`;
}

/* ---------- 启动 ---------- */
function startInitialLoad() {
  renderKpiRow(kpiRowElement, null);
  loadOverviewSection();
  loadTrendSection();
  loadCalendarSection();
  loadToolsSection();
  loadModelsSection();
  loadSessionsSection();
}

function init() {
  bindRangeSwitch();
  window.addEventListener("hashchange", routeByHash);
  // 系统深浅色切换时，图表配色从 CSS 变量重读一遍
  onSchemeChange(() => {
    if (state.cache.overview !== undefined) renderKpiRow(kpiRowElement, state.cache.overview);
    if (state.cache.rangeTrend[state.range] !== undefined) renderTrendSectionFromCache();
    if (state.cache.calendarTrend !== undefined) renderCalendarHeatmap(calendarHeatmapElement, state.cache.calendarTrend);
    if (state.cache.agents !== undefined) renderToolBars(toolBarsElement, state.cache.agents);
    if (state.cache.models !== undefined) renderModelTable(modelTableElement, state.cache.models, state.modelFilter, onModelSelected);
    if (state.cache.sessions !== undefined) renderSessionList(sessionListElement, state.cache.sessions, state.modelFilter);
  });

  routeByHash();
  startInitialLoad();
}

init();

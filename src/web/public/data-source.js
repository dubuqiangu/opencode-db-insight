/**
 * 数据源统一入口：组件只 import 这里的函数，不感知 mock 还是真实 API。
 *
 * 联调状态（T3.7）：USE_MOCK = false，走真实 HTTP（DESIGN §6 路由，
 * 形状对照 src/web/api.ts）：
 *   GET /api/overview            → types.ts OverviewStats（今日 in/out 分列、
 *                                  环比、sparkline 在前端由 /api/trend 推导）
 *   GET /api/trend?days=N        → DailyTrendPoint[]（裸数组，无 byModel —
 *                                  后端未提供按模型拆分；趋势图降级为总量层）
 *   GET /api/models              → ModelMetric[]
 *   GET /api/agents              → AgentStat[]
 *   GET /api/sessions?limit&off  → SessionSummary[]（裸数组，无 total 包络；
 *                                  v0.4.0 起支持 ?sort=/?order= 服务端排序：
 *                                  sort ∈ time_updated(默认)|time_created|
 *                                  tokens|cost|title，order ∈ desc(默认)|asc，
 *                                  非法值后端回退默认不发 400；响应体零变化；
 *                                  v0.7.0 起支持 ?directory=<项目目录> 精确
 *                                  匹配过滤——缺省/空=不过滤，匹配不到=空数组
 *                                  200（过滤语义，合法结果））
 *   GET /api/session/:id/messages        → SessionMessageRecord[]
 *   GET /api/session/:id/system-prompt   → Record<instructionKey, text> | 404
 *   GET /api/hour-heatmap?days=90        → 168 项 {weekday,hour,steps}（零填充）
 *   GET /api/session-survival            → {totalSessions, medianDurationSeconds,
 *                                          shortLivedShare, idleOutcomeCounts}
 *   GET /api/compaction                  → {total, byReason, recentDaily,
 *                                          topSessions}
 *   GET /api/todo                        → queryTodoStats（db 不可用统一 503）
 *   GET /api/directories?limit=10        → {totalDirectories, totalSessions,
 *                                          directories[{directory, name,
 *                                          sessions, steps, lastActiveMs}]}
 *   GET /api/health              → { status, version, port, dbStatus, dbPath }
 *
 * 真实/裸形状 → 组件所需形状的适配函数（normalizeTrendPayload 等）单独导出，
 * 供离线冒烟测试直接喂数验证。mock 分支保留用于离线演示。
 */

import {
  getMockOverview,
  getMockTrend,
  getMockModelMetrics,
  getMockAgentStats,
  getMockSessions,
  getMockHourHeatmap,
  getMockSessionSurvival,
  getMockCompaction,
  getMockTodoStats,
  getMockDirectoryStats,
} from "./mock-data.js";
import { getMockSessionMessages, getMockSessionSystemPrompt } from "./mock-replay-data.js";

const USE_MOCK = false;
const API_BASE = "/api";

/** 与后端 MAX_TREND_DAYS（stats/daily-buckets.ts）一致；日历窗口请求此值。 */
export const MAX_TREND_DAYS = 366;
/**
 * 会话列表服务端排序默认值，与后端 DEFAULT_SESSION_SORT_KEY / ORDER
 * （db/queries.ts，v0.2-B 契约）一致。session-list / app 从这里取默认，
 * 不各自复制——前端只有一个"契约默认"出处。
 */
export const DEFAULT_SESSION_SORT_KEY = "time_updated";
export const DEFAULT_SESSION_SORT_ORDER = "desc";
/** KPI sparkline / 今日环比所需的最小趋势窗口。 */
const OVERVIEW_TREND_WINDOW_DAYS = 15;
const SESSION_LOOKUP_PAGE_SIZE = 500;
const SESSION_LOOKUP_MAX_PAGES = 4;

/**
 * 会话不在当前表（2026-09-23 前旧表或 id 不存在）。
 * 回放视图捕获它渲染专门的 404 文案，而不是通用错误。
 */
export class SessionNotFoundError extends Error {
  constructor(message = "session not found in current tables") {
    super(message);
    this.name = "SessionNotFoundError";
  }
}

/* ---------------- 通用请求 ---------------- */

/** mock 模拟一点网络延迟，让骨架屏状态真实可见。 */
function resolveWithLatency(payload) {
  return new Promise((resolve) => {
    setTimeout(() => resolve(payload), 120 + Math.random() * 260);
  });
}

/** 单请求超时：15 秒（比任何正常本地查询都宽裕，只兜底挂死场景）。 */
const REQUEST_TIMEOUT_MILLISECONDS = 15_000;

/**
 * 超时信号（特性探测）：AbortSignal.timeout 在旧浏览器不可用时
 * 降级为不超时——宁可慢，也不因 API 缺失直接炸掉所有区块。
 */
function buildTimeoutSignal() {
  return typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function"
    ? AbortSignal.timeout(REQUEST_TIMEOUT_MILLISECONDS)
    : undefined;
}

/**
 * 带超时的 fetch。超时抛带路径说明的 Error，走各区块现有的错误态
 * （重试按钮），不给用户一个干巴巴的 "signal timed out"。
 */
async function fetchWithTimeout(path) {
  try {
    return await fetch(API_BASE + path, { signal: buildTimeoutSignal() });
  } catch (error) {
    if (error !== null && typeof error === "object" && error.name === "TimeoutError") {
      throw new Error(`API ${path} 请求超时（${REQUEST_TIMEOUT_MILLISECONDS / 1000} 秒），请重试`);
    }
    throw error;
  }
}

async function fetchJson(path) {
  const response = await fetchWithTimeout(path);
  if (!response.ok) {
    throw new Error(`API ${path} 返回 ${response.status}`);
  }
  return response.json();
}

/** 拿到原始 Response（需要区分 404 语义时用），非 2xx 抛错。 */
async function fetchResponse(path) {
  const response = await fetchWithTimeout(path);
  if (!response.ok && response.status !== 404) {
    throw new Error(`API ${path} 返回 ${response.status}`);
  }
  return response;
}

/* ---------------- 形状适配（真实 → 组件） ---------------- */

/**
 * /api/trend 返回裸 DailyTrendPoint[]；组件需要 { points, byModel }。
 * 后端暂无按模型拆分 → byModel 为空数组，趋势图自动降级为「总量」单层。
 */
export function normalizeTrendPayload(trendPoints) {
  const points = Array.isArray(trendPoints) ? trendPoints : [];
  return { points, byModel: [] };
}

/** /api/sessions 返回裸 SessionSummary[]；total 未知 → null（列表脚注降级）。 */
export function normalizeSessionPage(sessionPage) {
  return { sessions: Array.isArray(sessionPage) ? sessionPage : [], total: null };
}

/**
 * /api/overview 只有原始 OverviewStats；KPI 卡需要的今日 in/out 分列、
 * 昨日环比、14 天 sparkline 全部由趋势序列（同一批 step rows 分桶而来，
 * 口径一致）推导。trendPoints 为 null 时这些字段优雅缺失（卡显示 —）。
 */
export function deriveOverviewExtension(overviewBody, trendPoints) {
  const points = Array.isArray(trendPoints) ? trendPoints : [];
  const lastPoint = points.length > 0 ? points[points.length - 1] : null;
  const previousPoint = points.length > 1 ? points[points.length - 2] : null;
  const sparklineWindow = points.slice(-14);

  return {
    todayTokens: overviewBody.todayTokens,
    todayInput: lastPoint === null ? undefined : lastPoint.input,
    todayOutput: lastPoint === null ? undefined : lastPoint.output,
    todayHitRate: overviewBody.todayHitRate,
    yesterdayHitRate: previousPoint === null ? undefined : previousPoint.hitRate,
    todaySteps: lastPoint === null ? undefined : lastPoint.steps,
    yesterdaySteps: previousPoint === null ? undefined : previousPoint.steps,
    totalTokens: overviewBody.totalTokens,
    totalCost: overviewBody.totalCost,
    sessionCount: overviewBody.sessionCount,
    stepCount: overviewBody.stepCount,
    // 🟡 估算：由 token 量按公开单价粗算，仅量级参考（DESIGN §5）
    todayCostEstimateUsd: Math.round((overviewBody.todayTokens / 1e6) * 0.13 * 100) / 100,
    sparklineTokens: sparklineWindow.map((point) => point.input + point.read + point.output),
    sparklineHitRate: sparklineWindow.map((point) => point.hitRate),
    sparklineSteps: sparklineWindow.map((point) => point.steps),
    sparklineSessions: undefined, // 真实源没有逐日会话数；卡片降级为「全历史累计」
  };
}

/** 趋势窗口夹紧到后端上限（366）。 */
function clampTrendDays(days) {
  const requestedDays = Number(days);
  if (!Number.isFinite(requestedDays) || requestedDays < 1) return 1;
  return Math.min(Math.floor(requestedDays), MAX_TREND_DAYS);
}

/* ---------------- 看板数据 ---------------- */

/** GET /api/overview —— KPI 卡。 */
export async function fetchOverview() {
  if (USE_MOCK) return resolveWithLatency(getMockOverview());
  const overviewBody = await fetchJson("/overview");
  if (overviewBody === null || typeof overviewBody !== "object") {
    throw new Error("/api/overview 返回空数据");
  }
  const trendPoints = await fetchJson(`/trend?days=${OVERVIEW_TREND_WINDOW_DAYS}`).catch(() => null);
  return deriveOverviewExtension(overviewBody, trendPoints);
}

/** GET /api/trend?days=N —— 逐日序列（+ mock 的 byModel）。 */
export async function fetchTrend(days) {
  if (USE_MOCK) return resolveWithLatency(getMockTrend(days));
  return normalizeTrendPayload(await fetchJson(`/trend?days=${clampTrendDays(days)}`));
}

/** GET /api/models —— 模型排行榜。 */
export async function fetchModels() {
  if (USE_MOCK) return resolveWithLatency(getMockModelMetrics());
  const modelMetrics = await fetchJson("/models");
  return Array.isArray(modelMetrics) ? modelMetrics : [];
}

/** GET /api/agents —— agent 用量 + 工具指纹。 */
export async function fetchAgents() {
  if (USE_MOCK) return resolveWithLatency(getMockAgentStats());
  const agentStats = await fetchJson("/agents");
  return Array.isArray(agentStats) ? agentStats : [];
}

/**
 * GET /api/sessions?limit&offset&sort&order&directory —— 会话列表（真实源
 * total 未知）。directory 为 null/"" 时不携带该参数：默认请求路径与 0.6.1
 * 逐字节一致（后端对缺省与空串同为「不过滤」，两端归一）。
 */
export async function fetchSessions(
  limit = 15,
  offset = 0,
  sortKey = DEFAULT_SESSION_SORT_KEY,
  sortOrder = DEFAULT_SESSION_SORT_ORDER,
  directory = null,
) {
  if (USE_MOCK) return resolveWithLatency(getMockSessions(sortKey, sortOrder, directory));
  // 默认组合不携带 sort/order 参数：默认请求路径与 0.4.1 逐字节一致
  // （后端对缺省与显式默认解析结果相同，省参数还少一次字符串拼接）。
  let requestPath = `/sessions?limit=${limit}&offset=${offset}`;
  if (sortKey !== DEFAULT_SESSION_SORT_KEY) requestPath += `&sort=${encodeURIComponent(sortKey)}`;
  if (sortOrder !== DEFAULT_SESSION_SORT_ORDER) requestPath += `&order=${encodeURIComponent(sortOrder)}`;
  if (directory !== null && directory !== "") requestPath += `&directory=${encodeURIComponent(directory)}`;
  const sessionPage = await fetchJson(requestPath);
  return normalizeSessionPage(sessionPage);
}

/* ---------------- 看板数据（v0.2-A 新区块） ---------------- */

/** 时段热力固定窗口 = 契约默认值（90 天）。 */
export const HOUR_HEATMAP_WINDOW_DAYS = 90;

/** GET /api/hour-heatmap?days=90 —— 7×24 步骤分布（168 项零填充裸数组）。 */
export async function fetchHourHeatmap(days = HOUR_HEATMAP_WINDOW_DAYS) {
  if (USE_MOCK) return resolveWithLatency(getMockHourHeatmap(days));
  const heatmapCells = await fetchJson(`/hour-heatmap?days=${clampTrendDays(days)}`);
  return Array.isArray(heatmapCells) ? heatmapCells : [];
}

/** GET /api/session-survival —— 会话存活统计（形状不符按区块错误态降级）。 */
export async function fetchSessionSurvival() {
  if (USE_MOCK) return resolveWithLatency(getMockSessionSurvival());
  const survivalStats = await fetchJson("/session-survival");
  if (survivalStats === null || typeof survivalStats !== "object" || Array.isArray(survivalStats)) {
    throw new Error("/api/session-survival 返回空数据");
  }
  return survivalStats;
}

/** GET /api/compaction —— 压缩事件统计（形状不符按区块错误态降级）。 */
export async function fetchCompaction() {
  if (USE_MOCK) return resolveWithLatency(getMockCompaction());
  const compactionStats = await fetchJson("/compaction");
  if (compactionStats === null || typeof compactionStats !== "object" || Array.isArray(compactionStats)) {
    throw new Error("/api/compaction 返回空数据");
  }
  return compactionStats;
}

/**
 * GET /api/todo —— queryTodoStats 的返回（{total, completed, pending, inProgress}）。
 * db 不可用时与所有数据路由一样返回 503 → 走区块错误态（含重试），
 * 不存在 200 + null 的契约；total 为 0（todo 表为空）由卡片渲染空占位。
 */
export async function fetchTodo() {
  if (USE_MOCK) return resolveWithLatency(getMockTodoStats());
  const todoStats = await fetchJson("/todo");
  if (todoStats === null || typeof todoStats !== "object" || Array.isArray(todoStats)) {
    throw new Error("/api/todo 返回空数据");
  }
  return todoStats;
}

/**
 * GET /api/directories?limit=10 —— 项目目录用量聚合（长尾排行）。
 * db 不可用统一 503 → 错误态；非对象 body 视为契约破坏，同样走错误态。
 */
export async function fetchDirectoryStats(limit = 10) {
  if (USE_MOCK) return resolveWithLatency(getMockDirectoryStats(limit));
  const directoryStats = await fetchJson(`/directories?limit=${limit}`);
  if (directoryStats === null || typeof directoryStats !== "object" || Array.isArray(directoryStats)) {
    throw new Error("/api/directories 返回空数据");
  }
  return directoryStats;
}

/* ---------------- 会话回放数据 ---------------- */

/**
 * GET /api/session/:id/messages。
 * 旧表会话/不存在 → SessionNotFoundError（真实源 404，mock 源 legacy_ 前缀）。
 */
export async function fetchSessionMessages(sessionId) {
  if (USE_MOCK) {
    const messageRecords = getMockSessionMessages(sessionId);
    if (messageRecords === null) throw new SessionNotFoundError();
    return messageRecords;
  }
  const response = await fetchResponse(`/session/${encodeURIComponent(sessionId)}/messages`);
  if (response.status === 404) throw new SessionNotFoundError();
  const messageRecords = await response.json();
  if (!Array.isArray(messageRecords) || messageRecords.length === 0) {
    throw new SessionNotFoundError();
  }
  return messageRecords;
}

/**
 * GET /api/session/:id/system-prompt —— instruction key → 提示词文本。
 * 会话没有 instruction state 时返回 null（回放页省略该面板，不算错误）。
 */
export async function fetchSessionSystemPrompt(sessionId) {
  if (USE_MOCK) return resolveWithLatency(getMockSessionSystemPrompt(sessionId));
  const response = await fetchResponse(`/session/${encodeURIComponent(sessionId)}/system-prompt`);
  if (response.status === 404) return null;
  const systemPrompt = await response.json();
  if (systemPrompt === null || typeof systemPrompt !== "object" || Array.isArray(systemPrompt)) {
    return null;
  }
  return systemPrompt;
}

/**
 * 尽力而为的会话标题查找：分页扫 /api/sessions（后端导出路由同款做法），
 * 最多 SESSION_LOOKUP_MAX_PAGES 页。找不到返回 null，回放页降级显示 id。
 */
export async function fetchSessionSummaryById(sessionId) {
  if (USE_MOCK) {
    const sessionPayload = getMockSessions();
    return sessionPayload.sessions.find((session) => session.id === sessionId) ?? null;
  }
  for (let pageOffset = 0; pageOffset < SESSION_LOOKUP_PAGE_SIZE * SESSION_LOOKUP_MAX_PAGES; pageOffset += SESSION_LOOKUP_PAGE_SIZE) {
    const sessionPage = await fetchJson(`/sessions?limit=${SESSION_LOOKUP_PAGE_SIZE}&offset=${pageOffset}`)
      .catch(() => null);
    if (!Array.isArray(sessionPage)) return null;
    const foundSession = sessionPage.find((session) => session.id === sessionId);
    if (foundSession !== undefined) return foundSession;
    if (sessionPage.length < SESSION_LOOKUP_PAGE_SIZE) return null;
  }
  return null;
}

/** GET /api/health —— 探活（顶栏状态指示）。失败抛错由调用方降级。 */
export async function fetchHealth() {
  if (USE_MOCK) return resolveWithLatency({ dbStatus: "mock", version: "mock", port: 0, dbPath: "mock" });
  return fetchJson("/health");
}

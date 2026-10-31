/**
 * 数据源统一入口：组件只 import 这里的函数，不感知 mock 还是真实 API。
 *
 * 联调状态（T3.7）：USE_MOCK = false，走真实 HTTP（DESIGN §6 路由，
 * 形状对照 src/web/api.ts）：
 *   GET /api/overview            → types.ts OverviewStats（今日 in/out 分列、
 *                                  环比、sparkline 在前端由 /api/trend 推导）
 *   GET /api/trend?days=N        → 裸数组 DailyTrendPoint[]（v0.11.0 起每点
 *                                  增补点级 byModel：Record<模型id, 该模型
 *                                  当日 tokens>，键序确定=全窗总量 desc +
 *                                  modelId asc 字典序决胜，窗口内观察到的
 *                                  模型每日稠密出现、无活动日为零；
 *                                  旧版裸数组（无 byModel）仍兼容 →
 *                                  normalize 后 byModel [] 降级为总量单层图）
 *   GET /api/models[?days=N]      → ModelMetric[]（?days= 窗口过滤，
 *                                  N=7/30/90；缺省/非法 = 全量——与后端
 *                                  归一一致：前端只发合法值或干脆不带参数）
 *   GET /api/agents              → AgentStat[]
 *   GET /api/tool-health          → ToolHealthStat[]（{tool, completed,
 *                                  error, running, total, errorRate}，total
 *                                  降序；errorRate 为 raw 0..1 分数）
 *   GET /api/sessions?limit&off  → SessionSummary[]（裸数组，无 total 包络；
 *                                  v0.4.0 起支持 ?sort=/?order= 服务端排序：
 *                                  sort ∈ time_updated(默认)|time_created|
 *                                  tokens|cost|title，order ∈ desc(默认)|asc，
 *                                  非法值后端回退默认不发 400；响应体零变化；
 *                                  v0.7.0 起支持 ?directory=<项目目录> 精确
 *                                  匹配过滤——缺省/空=不过滤，匹配不到=空数组
 *                                  200（过滤语义，合法结果）；v0.9.0 起支持
 *                                  ?range=7d|30d|90d——过滤 timeUpdated
 *                                  （最近 N 天内更新），缺省/空=全量，
 *                                  未知非空值后端 400 防御）
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
 *   GET /api/session-distribution       → {totalSessions, buckets[{start,
 *                                          end, count}], percentiles{p50,
 *                                          p90, p99}, mean, max}（v0.20.0，
 *                                          「全部会话」口径，不吃 ?session=）
 *   GET /api/tool-error-trend?days=N    → {days, points[{date, toolCalls,
 *                                          errors, errorRate}]}（v0.22.0，
 *                                          缺省 30 / clamp [1,366]，
 *                                          「全部会话」口径，不吃 ?session=）
 *   GET /api/session-outcomes           → {totalSessions, sessionsWithSteps,
 *                                          interruptedSessions,
 *                                          interruptedShare, byErrorType[],
 *                                          recentInterrupted[]}（v0.22.0，
 *                                          「全部会话」口径，不吃 ?session=）
 *   GET /api/health              → { status, version, port, dbStatus, dbPath }
 *   GET /api/export/sessions.csv → CSV 附件下载（v0.8.0）：九列
 *                                  id,title,modelId,agent,directory,
 *                                  timeCreated,timeUpdated,tokens,cost；
 *                                  RFC 4180 转义 + CRLF + UTF-8 BOM；
 *                                  ?directory= 过滤与 /api/sessions 同语义
 *                                  （精确匹配、缺省/空=全量、miss=仅表头）；
 *                                  v0.9.0 起 ?range= 与 /api/sessions 同
 *                                  契约（7d|30d|90d，timeUpdated 口径）
 *
 *   v0.20.0 ?session=<id>（可选会话作用域）：十类聚合端点（overview/
 *   trend/models/tool-health/agents/todo/hour-heatmap/session-survival/
 *   compaction/directories）都接受——对应 fetch 函数末位可选参
 *   sessionScopeId 非空时 URL 追加该参数，统计只算该会话；未知 id 后端
 *   统一 404 {error:"session not found"}，本模块翻译成
 *   SessionScopeNotFoundError 交 app 层自动退出作用域。/api/sessions、
 *   会话路径路由与导出路由不吃该参数（后端契约）。
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
  getMockToolErrorTrend,
  getMockSessionOutcomes,
  getMockToolTokens,
  getMockSearchResults,
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

/**
 * 会话面板时间范围词表（v0.9.0 契约）：rangeValue 即 ?range= 合法值，
 * 一个都不许改（是 /api/sessions 与 CSV 导出的 ?range= 契约）。
 * "" = 全量：缺省/空同为「不过滤」（与 directory 的归一逻辑一致）；
 * 词表外的非空值后端 400 防御，前端 UI 只从这张表产生值。
 * 过滤口径 = timeUpdated（「最近 N 天内有更新」）。
 * label 统一规格（v0.19.0）：与 index.html 三处静态切换器一致取
 * 7d / 30d / 90d / All，All（空 rangeValue）排最后。
 */
export const SESSION_RANGE_OPTIONS = [
  { rangeValue: "7d", label: "7d" },
  { rangeValue: "30d", label: "30d" },
  { rangeValue: "90d", label: "90d" },
  { rangeValue: "", label: "All" },
];
export const DEFAULT_SESSION_RANGE = "";

/** 词表查展示 label；非词表值回退 null（调用方自行降级文案）。 */
export function sessionRangeLabel(rangeValue) {
  const matchedRangeOption = SESSION_RANGE_OPTIONS.find((rangeOption) => rangeOption.rangeValue === rangeValue);
  return matchedRangeOption === undefined ? null : matchedRangeOption.label;
}

/**
 * ?range= 参数段（不含 ?/& 前缀）；null / 空串 → ""。
 * 与 directoryQueryParam 同为参数编码单点（词表值本无特殊字符，
 * encodeURIComponent 只作纵深）。
 */
function rangeQueryParam(range) {
  return range === null || range === "" ? "" : `range=${encodeURIComponent(range)}`;
}

/**
 * ?session= 参数段（v0.20.0 会话作用域，不含 ?/& 前缀）；null / 空串 → ""
 * （缺省 = 全部会话，与 directory / range 的两端归一一致）。与后端
 * SESSION_FILTER_CONSUMING_ROUTE_NAMES 的十类聚合端点一一对应；这里是
 * 该参数编码的唯一出处，fetch 侧不许再手拼 session=。
 */
function sessionScopeQueryParam(sessionScopeId) {
  return sessionScopeId === null || sessionScopeId === ""
    ? ""
    : `session=${encodeURIComponent(sessionScopeId)}`;
}

/** 把参数段拼进请求路径：已有 query 用 & 接续，否则用 ? 开头。 */
function appendQuerySegment(requestPath, querySegment) {
  if (querySegment === "") return requestPath;
  return requestPath.includes("?") ? `${requestPath}&${querySegment}` : `${requestPath}?${querySegment}`;
}

/**
 * 作用域感知的 JSON 请求（v0.20.0）：scope 非空时 URL 追加 session 参数；
 * 404 且 body 带 SESSION_FILTER_NOT_FOUND_MESSAGE 时抛
 * SessionScopeNotFoundError（会话已删，app 层自动退出作用域），其余
 * 非 2xx 维持既有通用错误语义。scope 为空时请求路径与旧版逐字节一致。
 */
async function fetchSessionScopedJson(requestPath, sessionScopeId = null) {
  const scopeSegment = sessionScopeQueryParam(sessionScopeId);
  const scopedPath = appendQuerySegment(requestPath, scopeSegment);
  const response = await fetchWithTimeout(scopedPath);
  if (!response.ok) {
    // 只在「本请求确实带了 session 参数」时把 404 翻译成作用域错误：
    // 无参数的 404 是路由层面的问题，不能冒充「会话已删」。
    if (response.status === 404 && scopeSegment !== "") {
      const errorBody = await response.json().catch(() => null);
      if (
        errorBody !== null && typeof errorBody === "object"
        && errorBody.error === SESSION_FILTER_NOT_FOUND_MESSAGE
      ) {
        throw new SessionScopeNotFoundError();
      }
    }
    throw new Error(`API ${scopedPath} 返回 ${response.status}`);
  }
  return response.json();
}

/**
 * ?directory= 参数段（不含 ?/& 前缀）；null / 空串 → ""。
 * 后端契约：缺省与空串同为「不过滤/全量」，两端归一。这是 directory
 * 参数编码的**唯一出处**——fetchSessions 与 CSV 导出地址共用，杜绝
 * 两处 encodeURIComponent 各自漂移（v0.8.0 单点要求）。
 */
function directoryQueryParam(directory) {
  return directory === null || directory === "" ? "" : `directory=${encodeURIComponent(directory)}`;
}

/**
 * ?day= 参数段（Milestone A，不含 ?/& 前缀）；null / "" → ""。
 * 后端契约：GET /api/sessions?day=YYYY-MM-DD 按本地日过滤会话（精确
 * 匹配 timeUpdated 所在日历日）；缺省/空 = 不过滤。与 directoryQueryParam
 * 同为参数编码单点——fetchSessions 与 CSV 导出地址共用，杜绝两处
 * encodeURIComponent 各自漂移。
 */
function dayQueryParam(day) {
  return day === null || day === "" ? "" : `day=${encodeURIComponent(day)}`;
}

/**
 * GET /api/export/sessions.csv 的下载地址（v0.8.0 起；v0.9.0 增 range）。
 * 多参数拼接单点在此：directory / range 两段统一拼成一个 query string，
 * 调用方绝不自行拼 ? 和 &。
 */
export function sessionsExportCsvPath(directory = null, range = DEFAULT_SESSION_RANGE, day = null) {
  const exportParamSegments = [directoryQueryParam(directory), rangeQueryParam(range), dayQueryParam(day)]
    .filter((paramSegment) => paramSegment !== "");
  const queryString = exportParamSegments.join("&");
  const csvExportPath = `${API_BASE}/export/sessions.csv`;
  return queryString === "" ? csvExportPath : `${csvExportPath}?${queryString}`;
}

/**
 * CSV 导出入口是否可用（v0.8.0）。mock 预览模式隐藏入口：dev 预览没有
 * 真实路由 /api/export/sessions.csv，点了只会 404。可用性是渲染期常量
 * ——入口在初始渲染时就按模式决定，不存在"先显示再藏"的闪现。
 */
export const SESSIONS_CSV_EXPORT_AVAILABLE = !USE_MOCK;
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

/**
 * ?session= 作用域指向的会话已不存在（v0.20.0）：后端所有消费该参数的
 * 聚合端点统一答 404 { error: "session not found" }（常量
 * SESSION_FILTER_NOT_FOUND_MESSAGE，src/web/api.ts）。与上面路径路由的
 * SessionNotFoundError（旧表语义）刻意分开——这个错误的前端处置是
 * 「自动退出作用域 + 轻提示」，不弹区块错误卡。
 */
export const SESSION_FILTER_NOT_FOUND_MESSAGE = "session not found";

export class SessionScopeNotFoundError extends Error {
  constructor(message = SESSION_FILTER_NOT_FOUND_MESSAGE) {
    super(message);
    this.name = "SessionScopeNotFoundError";
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

/**
 * 清掉服务端 60s TTL 查询缓存（/api/refresh 只动内存缓存、不碰数据库，
 * 毫秒级）。页面每次载入先调它，浏览器 F5 才保证拉到全新数据；
 * 失败不阻塞面板加载（退化为最多滞后 60 秒的 TTL 语义）。
 *
 * path 是相对 `API_BASE`（"/api"）的段：`fetchWithTimeout` 自己拼接前缀，
 * 这里再写一遍 "/api" 会请求到 `/api/api/refresh`。此前真实浏览器里
 * 每次都出现两个 404，正是因为这里写成了绝对路径——手动刷新缓存整条链
 * 静默失效，页面回退到 TTL 语义，F5 看到的数据可能是 60 秒前的。
 */
export async function fetchRefresh() {
  return fetchJson("/refresh");
}

/* ---------------- 形状适配（真实 → 组件） ---------------- */

/**
 * /api/trend 返回体 → 组件所需 { points, byModel }（trend-chart 消费面）。
 *
 * v0.11.0 真实 wire 是裸数组 DailyTrendPoint[]，每点携带**点级** byModel
 * Record<模型id, 该模型当日 tokens>（口径 = input+read+output）。这里把它
 * **透视**成 trend-chart 消费的每模型序列 [{ modelId, values }]：
 * - values 按点序对位（长度 === points 长度），模型清单 = 全窗 Record
 *   键并集，某日缺键按 0 补齐；
 * - 透视顺序确定：全窗总量 desc + modelId asc 字典序决胜——镜像后端
 *   daily-buckets.ts 的钉序（trend-chart.rankModels 消费前仍会按同口径
 *   自重排，此处钉序是双保险）；
 * - 全部点无 byModel → byModel 置 []（v0.11.0 前的旧裸数组 wire），
 *   趋势图降级为「总量」单层。
 *
 * 防御性归一（trend-chart 按 dayIndex 逐日对位消费，错位层会 NaN）：
 * - 非数组载荷 → 空数据（图表走空态）；
 * - 点级 byModel 缺失/非对象/是数组 → 该点视为无模型数据；
 * - 键为空字符串不成层（后端已把缺失模型 id 归一为 "unknown"，空键
 *   只可能来自契约破坏）；值非有限数按 0 计。
 */
export function normalizeTrendPayload(trendPayload) {
  const points = Array.isArray(trendPayload) ? trendPayload : [];

  // Pass 1：逐点清洗点级 byModel Record（Map 存当日键值，杜绝 __proto__
  // 之类键名经对象字面量落到原型链上），同时累计全窗总量。
  const dayModelTokens = []; // 每点的 Map<modelId, 当日 tokens>；无模型数据的点为 null
  const windowTotalByModelId = new Map();
  let hasAnyModelData = false;
  for (const trendPoint of points) {
    const rawByModel = trendPoint !== null && typeof trendPoint === "object"
      && trendPoint.byModel !== null && typeof trendPoint.byModel === "object"
      && !Array.isArray(trendPoint.byModel)
      ? trendPoint.byModel
      : null;
    if (rawByModel === null) {
      dayModelTokens.push(null);
      continue;
    }
    const dayRecord = new Map();
    for (const [modelId, dayTokens] of Object.entries(rawByModel)) {
      if (modelId === "") continue;
      const safeDayTokens = typeof dayTokens === "number" && Number.isFinite(dayTokens) ? dayTokens : 0;
      dayRecord.set(modelId, safeDayTokens);
      windowTotalByModelId.set(modelId, (windowTotalByModelId.get(modelId) ?? 0) + safeDayTokens);
    }
    if (dayRecord.size === 0) {
      dayModelTokens.push(null);
      continue;
    }
    dayModelTokens.push(dayRecord);
    hasAnyModelData = true;
  }

  if (!hasAnyModelData) {
    return { points, byModel: [] };
  }

  // Pass 2：键并集 → 钉序模型清单 → 按点序对位透视。
  const orderedModelIds = [...windowTotalByModelId.keys()].sort(
    (leftModelId, rightModelId) => {
      const totalDifference =
        (windowTotalByModelId.get(rightModelId) ?? 0) -
        (windowTotalByModelId.get(leftModelId) ?? 0);
      if (totalDifference !== 0) return totalDifference;
      return leftModelId < rightModelId ? -1 : leftModelId > rightModelId ? 1 : 0;
    },
  );
  const byModel = orderedModelIds.map((modelId) => ({
    modelId,
    values: dayModelTokens.map((dayRecord) => dayRecord?.get(modelId) ?? 0),
  }));
  return { points, byModel };
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

/** GET /api/overview —— KPI 卡。sessionScopeId 非空时 overview 与内部
 * trend 请求都带 ?session=（两个都是消费该参数的端点）。 */
export async function fetchOverview(sessionScopeId = null) {
  if (USE_MOCK) return resolveWithLatency(getMockOverview());
  const overviewBody = await fetchSessionScopedJson("/overview", sessionScopeId);
  if (overviewBody === null || typeof overviewBody !== "object") {
    throw new Error("/api/overview 返回空数据");
  }
  // v0.11.0 起 /trend 是裸数组 + 点级 byModel Record（旧版为无 byModel 的
  // 裸数组）——KPI 推导只吃 points，统一走 normalizeTrendPayload 拆包，
  // 两种 wire 都安全。
  const trendBody = await fetchSessionScopedJson(
    `/trend?days=${OVERVIEW_TREND_WINDOW_DAYS}`,
    sessionScopeId,
  ).catch(() => null);
  const trendPoints = trendBody === null ? null : normalizeTrendPayload(trendBody).points;
  return deriveOverviewExtension(overviewBody, trendPoints);
}

/**
 * GET /api/trend?days=N —— 逐日序列 + 点级 byModel。
 * mock 分支与真实分支共用 normalizeTrendPayload：mock 的职责是镜像
 * 真实 wire（裸数组 + 点级 Record），透视适配对两条路径同构。
 */
export async function fetchTrend(days, sessionScopeId = null) {
  if (USE_MOCK) return resolveWithLatency(normalizeTrendPayload(getMockTrend(days)));
  return normalizeTrendPayload(
    await fetchSessionScopedJson(`/trend?days=${clampTrendDays(days)}`, sessionScopeId),
  );
}

/**
 * GET /api/models —— 模型排行榜。days ∈ {7, 30, 90} 为窗口过滤（?days=N）；
 * null = 全部（不带参数，默认请求路径与旧版逐字节一致）。前端只发合法值，
 * 非法值由调用方归一为 null（后端对非法/缺省同样归一为全量）。
 */
export async function fetchModels(days = null, sessionScopeId = null) {
  if (USE_MOCK) return resolveWithLatency(getMockModelMetrics());
  const requestPath = days === null ? "/models" : `/models?days=${days}`;
  const modelMetrics = await fetchSessionScopedJson(requestPath, sessionScopeId);
  return Array.isArray(modelMetrics) ? modelMetrics : [];
}

/** GET /api/agents —— agent 用量 + 工具指纹（v0.20.0 支持会话作用域）。 */
export async function fetchAgents(sessionScopeId = null) {
  if (USE_MOCK) return resolveWithLatency(getMockAgentStats());
  const agentStats = await fetchSessionScopedJson("/agents", sessionScopeId);
  return Array.isArray(agentStats) ? agentStats : [];
}

/**
 * GET /api/tool-health —— 工具调用健康度（ToolHealthStat[]，total 降序）。
 * mock 预览没有这条路由（由真实后端 lane 提供）：USE_MOCK 时返回空数组
 * ——条形图不渲染错误色带、摘要行留空，走区块自身的空态语义而不是把
 * 工具区块炸成错误占位（离线演示不受影响）。
 */
export async function fetchToolHealth(sessionScopeId = null) {
  if (USE_MOCK) return resolveWithLatency([]);
  const toolHealthStats = await fetchSessionScopedJson("/tool-health", sessionScopeId);
  return Array.isArray(toolHealthStats) ? toolHealthStats : [];
}

/**
 * GET /api/tool-tokens —— 每工具 token 归因（ToolTokenStat[]，tokens 降序；
 * 🟡 估算，自包含分词估算权重见 DESIGN §5）。会话感知（吃 ?session=，镜像
 * tool-health）。USE_MOCK 走 getMockToolTokens 缝（同 getMock* 纪律）；
 * 真实响应非数组也归 []，让条形图的 token 块安静降级而不是炸区块。
 */
export async function fetchToolTokens(sessionScopeId = null) {
  if (USE_MOCK) return resolveWithLatency(getMockToolTokens());
  const toolTokenStats = await fetchSessionScopedJson("/tool-tokens", sessionScopeId);
  return Array.isArray(toolTokenStats) ? toolTokenStats : [];
}

/**
 * GET /api/sessions?limit&offset&sort&order&directory&range&day —— 会话列表
 * （真实源 total 未知）。directory 为 null/"" 时不携带该参数：默认请求
 * 路径与 0.6.1 逐字节一致（后端对缺省与空串同为「不过滤」，两端归一）。
 * range（v0.9.0）同语义：""/null = 全量，过滤口径 timeUpdated。
 * day（Milestone A）同语义：null/"" = 不过滤，非空时按本地日精确过滤
 * timeUpdated 所在日历日。
 */
export async function fetchSessions(
  limit = 15,
  offset = 0,
  sortKey = DEFAULT_SESSION_SORT_KEY,
  sortOrder = DEFAULT_SESSION_SORT_ORDER,
  directory = null,
  range = DEFAULT_SESSION_RANGE,
  day = null,
) {
  if (USE_MOCK) return resolveWithLatency(getMockSessions(sortKey, sortOrder, directory, range, day));
  // 默认组合不携带 sort/order 参数：默认请求路径与 0.4.1 逐字节一致
  // （后端对缺省与显式默认解析结果相同，省参数还少一次字符串拼接）。
  let requestPath = `/sessions?limit=${limit}&offset=${offset}`;
  if (sortKey !== DEFAULT_SESSION_SORT_KEY) requestPath += `&sort=${encodeURIComponent(sortKey)}`;
  if (sortOrder !== DEFAULT_SESSION_SORT_ORDER) requestPath += `&order=${encodeURIComponent(sortOrder)}`;
  const directoryParam = directoryQueryParam(directory);
  if (directoryParam !== "") requestPath += `&${directoryParam}`;
  const rangeParam = rangeQueryParam(range);
  if (rangeParam !== "") requestPath += `&${rangeParam}`;
  const dayParam = dayQueryParam(day);
  if (dayParam !== "") requestPath += `&${dayParam}`;
  const sessionPage = await fetchJson(requestPath);
  return normalizeSessionPage(sessionPage);
}

/**
 * GET /api/search?q=<query>&mode=<mode>（Milestone A 全文搜索）——跨全部
 * 会话搜索消息正文 / 工具入出参 / 思考过程。mode ∈ substring|regex（与
 * search-panel.SEARCH_MODE_OPTIONS 词表一一对应）。
 *
 * 返回形状（后端契约）：{ query, mode, hits: [{ sessionId, sessionTitle,
 * messageId, messageType, snippet, hitCount }], total }。snippet 是后端
 * 已转义并把命中词包进 <mark> 的安全富文本（search-panel 按契约原样透传）。
 *
 * 搜索是**全局**的（GET /api/search 跨全部会话，后端不支持也不会有
 * ?session= 作用域）——因此这里不接收、也不转发任何会话作用域参数，
 * 请求路径里绝不会出现误导性的 ?session=。
 *
 * USE_MOCK 走 mock-data.js 的 getMockSearchResults 缝（同 getMock* 纪律）：
 * 离线预览能看到多命中 / 多模式 / 空结果的完整面板路径。
 */
export async function fetchSearch(query, mode = "substring") {
  if (USE_MOCK) return resolveWithLatency(getMockSearchResults(query, mode));
  const requestPath = `/search?q=${encodeURIComponent(query)}&mode=${encodeURIComponent(mode)}`;
  const searchPayload = await fetchSessionScopedJson(requestPath, null);
  if (searchPayload === null || typeof searchPayload !== "object" || Array.isArray(searchPayload)) {
    throw new Error("/api/search 返回空数据");
  }
  // 形状校验：hits 必须存在且为数组（缺失/非数组 = 契约破坏，走错误态），
  // 其余字段（query/mode/total）search-panel 有缺省兜底。
  if (!Array.isArray(searchPayload.hits)) {
    throw new Error("/api/search 返回形状不符");
  }
  return searchPayload;
}

/* ---------------- 看板数据（v0.2-A 新区块） ---------------- */

/** 时段热力固定窗口 = 契约默认值（90 天）。 */
export const HOUR_HEATMAP_WINDOW_DAYS = 90;

/** GET /api/hour-heatmap?days=90 —— 7×24 步骤分布（168 项零填充裸数组）。 */
export async function fetchHourHeatmap(days = HOUR_HEATMAP_WINDOW_DAYS, sessionScopeId = null) {
  if (USE_MOCK) return resolveWithLatency(getMockHourHeatmap(days));
  const heatmapCells = await fetchSessionScopedJson(
    `/hour-heatmap?days=${clampTrendDays(days)}`,
    sessionScopeId,
  );
  return Array.isArray(heatmapCells) ? heatmapCells : [];
}

/** GET /api/session-survival —— 会话存活统计（形状不符按区块错误态降级）。 */
export async function fetchSessionSurvival(sessionScopeId = null) {
  if (USE_MOCK) return resolveWithLatency(getMockSessionSurvival());
  const survivalStats = await fetchSessionScopedJson("/session-survival", sessionScopeId);
  if (survivalStats === null || typeof survivalStats !== "object" || Array.isArray(survivalStats)) {
    throw new Error("/api/session-survival 返回空数据");
  }
  return survivalStats;
}

/** GET /api/compaction —— 压缩事件统计（形状不符按区块错误态降级）。 */
export async function fetchCompaction(sessionScopeId = null) {
  if (USE_MOCK) return resolveWithLatency(getMockCompaction());
  const compactionStats = await fetchSessionScopedJson("/compaction", sessionScopeId);
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
export async function fetchTodo(sessionScopeId = null) {
  if (USE_MOCK) return resolveWithLatency(getMockTodoStats());
  const todoStats = await fetchSessionScopedJson("/todo", sessionScopeId);
  if (todoStats === null || typeof todoStats !== "object" || Array.isArray(todoStats)) {
    throw new Error("/api/todo 返回空数据");
  }
  return todoStats;
}

/**
 * GET /api/directories?limit=10 —— 项目目录用量聚合（长尾排行）。
 * db 不可用统一 503 → 错误态；非对象 body 视为契约破坏，同样走错误态。
 */
export async function fetchDirectoryStats(limit = 10, sessionScopeId = null) {
  if (USE_MOCK) return resolveWithLatency(getMockDirectoryStats(limit));
  const directoryStats = await fetchSessionScopedJson(`/directories?limit=${limit}`, sessionScopeId);
  if (directoryStats === null || typeof directoryStats !== "object" || Array.isArray(directoryStats)) {
    throw new Error("/api/directories 返回空数据");
  }
  return directoryStats;
}

/**
 * GET /api/session-distribution（v0.20.0）：每会话 tokens 总量的
 * 「全部会话」分布（对数半档桶 + p50/p90/p99 分位 + mean/max，载荷形状
 * 见 stats/session-distribution.ts TokenDistributionStats）。端点不吃
 * ?session=——作用域激活时由 app 层直接隐藏整个面板、不发请求，因此
 * 这里没有 scope 参数。
 */
export async function fetchSessionDistribution() {
  if (USE_MOCK) {
    return resolveWithLatency({ totalSessions: 0, buckets: [], percentiles: { p50: 0, p90: 0, p99: 0 }, mean: 0, max: 0 });
  }
  const distributionStats = await fetchJson("/session-distribution");
  if (distributionStats === null || typeof distributionStats !== "object" || Array.isArray(distributionStats)) {
    throw new Error("/api/session-distribution 返回空数据");
  }
  return distributionStats;
}

/**
 * GET /api/step-distribution（v0.21.0）：每会话步数（assistant 消息数）的
 * 「全部会话」分布，载荷形状同 session-distribution（buckets +
 * p50/p90/p99 + mean + max）。端点不吃 ?session=——作用域激活时由 app
 * 层直接隐藏整个面板、不发请求，因此这里没有 scope 参数。
 */
export async function fetchStepDistribution() {
  if (USE_MOCK) {
    return resolveWithLatency({ totalSessions: 0, buckets: [], percentiles: { p50: 0, p90: 0, p99: 0 }, mean: 0, max: 0 });
  }
  const distributionStats = await fetchJson("/step-distribution");
  if (distributionStats === null || typeof distributionStats !== "object" || Array.isArray(distributionStats)) {
    throw new Error("/api/step-distribution 返回空数据");
  }
  return distributionStats;
}

/**
 * GET /api/duration-distribution（v0.21.0）：每会话墙钟时长（毫秒）的
 * 「全部会话」分布，载荷形状同 session-distribution，值域毫秒（前端用
 * formatDurationMs 显示）。端点不吃 ?session=——作用域激活时由 app 层
 * 直接隐藏整个面板、不发请求。
 */
export async function fetchDurationDistribution() {
  if (USE_MOCK) {
    return resolveWithLatency({ totalSessions: 0, buckets: [], percentiles: { p50: 0, p90: 0, p99: 0 }, mean: 0, max: 0 });
  }
  const distributionStats = await fetchJson("/duration-distribution");
  if (distributionStats === null || typeof distributionStats !== "object" || Array.isArray(distributionStats)) {
    throw new Error("/api/duration-distribution 返回空数据");
  }
  return distributionStats;
}

/**
 * GET /api/child-share（v0.21.0）：全部会话口径的子代理开销占比统计
 * （child 会话占比 / 子代 token 占比 / top 子树）。载荷是对象契约而非
 * 分布形状，故校验独立。端点不吃 ?session=——作用域激活时由 app 层
 * 直接隐藏整个面板、不发请求。
 */
export async function fetchChildShare() {
  if (USE_MOCK) {
    return resolveWithLatency({ totalSessions: 0, childSessionCount: 0, rootSessionCount: 0, childTokens: 0, rootTokens: 0, totalTokens: 0, childShare: 0, topChildTrees: [] });
  }
  const childShare = await fetchJson("/child-share");
  if (childShare === null || typeof childShare !== "object" || Array.isArray(childShare)) {
    throw new Error("/api/child-share 返回空数据");
  }
  return childShare;
}

/** 工具错误逐日趋势的契约缺省窗口（天），与后端一致。 */
export const TOOL_ERROR_TREND_DEFAULT_DAYS = 30;

/**
 * GET /api/tool-error-trend?days=N（v0.22.0）：按本地日的工具调用/错误数
 * 与错误率的「全部会话」逐日趋势。days 缺省 30，前端与后端一样 clamp 到
 * [1, 366]（复用 clampTrendDays）。载荷形状
 * { days, points: [{ date, toolCalls, errors, errorRate }] }。端点不吃
 * ?session=——作用域激活时由 app 层直接隐藏整个面板、不发请求，因此这里
 * 没有 scope 参数。非对象 body 视为契约破坏（走区块错误态）。
 * USE_MOCK 走 mock-data.js 的 getMockToolErrorTrend 缝（同 getMock* 纪律）：
 * 离线预览能看到多日 / 峰谷 / 零值日的完整图表路径。
 */
export async function fetchToolErrorTrend(days = TOOL_ERROR_TREND_DEFAULT_DAYS) {
  if (USE_MOCK) return resolveWithLatency(getMockToolErrorTrend(days));
  const toolErrorTrend = await fetchJson(`/tool-error-trend?days=${clampTrendDays(days)}`);
  if (toolErrorTrend === null || typeof toolErrorTrend !== "object" || Array.isArray(toolErrorTrend)) {
    throw new Error("/api/tool-error-trend 返回空数据");
  }
  return toolErrorTrend;
}

/**
 * GET /api/session-outcomes（v0.22.0）：会话结局（以错误收尾 / 干净收尾 /
 * 错误类型分布 / 最近错误收尾会话）的「全部会话」统计。载荷形状见契约：
 * { totalSessions, sessionsWithSteps, interruptedSessions,
 *   interruptedShare, byErrorType: [{type,count}], recentInterrupted: [...] }。
 * 端点不吃 ?session=——作用域激活时由 app 层直接隐藏整个面板、不发请求。
 * 非对象 body 视为契约破坏（走区块错误态）。
 * USE_MOCK 走 mock-data.js 的 getMockSessionOutcomes 缝（与其它列表 / 表格
 * 卡同款）：离线预览能看到宽值域与 multi-type / 多行 DOM 路径，而不是恒空态。
 */
export async function fetchSessionOutcomes() {
  if (USE_MOCK) return resolveWithLatency(getMockSessionOutcomes());
  const sessionOutcomes = await fetchJson("/session-outcomes");
  if (sessionOutcomes === null || typeof sessionOutcomes !== "object" || Array.isArray(sessionOutcomes)) {
    throw new Error("/api/session-outcomes 返回空数据");
  }
  return sessionOutcomes;
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

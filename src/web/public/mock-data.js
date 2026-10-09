/**
 * Mock 数据源（M3 阶段）。
 *
 * 形状严格对齐 DESIGN.md §6 与后端类型（src/db/types.ts、src/stats/*.ts）：
 *   GET /api/overview  → buildOverview()（types.ts OverviewStats + 前端卡片
 *                        所需的今日 in/out 分列、环比、sparkline、成本估算）
 *   GET /api/trend     → buildTrend(days)（stats/daily-buckets.ts DailyTrendPoint
 *                        裸数组；v0.11.0 起每点携带点级 byModel
 *                        Record<模型id, 当日 tokens>——镜像真实 wire 契约：
 *                        窗口内观察到的模型每日稠密出现、无活动日为零，
 *                        键序确定=全窗总量 desc + modelId asc。透视成
 *                        [{ modelId, values }] 序列由 data-source 的
 *                        normalizeTrendPayload 统一完成，mock 与真实
 *                        路径共用同一适配）
 *   GET /api/models    → buildModelMetrics()（stats/model-metrics.ts ModelMetric；
 *                        v0.12.0 起含 tokenShare：窗口 token 占比 0..1，
 *                        mock 以 tokens/Σtokens 自洽生成，Σ 恒为 1）
 *   GET /api/agents    → buildAgentStats()（stats/agent-fingerprint.ts AgentStat）
 *   GET /api/sessions  → buildSessions()（types.ts SessionSummary 列表）；
 *                        getMockSessions(sort, order, directory, range)
 *                        在此之上补齐 v0.4.0 排序契约（白名单/回退与后端
 *                        resolveSessionSortKey/Order（queries.ts）一致，
 *                        非法值回退默认不发 400）、v0.7.0 目录过滤契约
 *                        （精确匹配，缺省/空=不过滤，匹配不到=空数组）与
 *                        v0.9.0 时间范围契约（range 词表 7d|30d|90d，
 *                        timeUpdated 口径，缺省/空=全量，词表外非空值
 *                        抛错镜像后端 400）
 *   GET /api/hour-heatmap?days=90  → buildHourHeatmap()（168 项零填充，
 *                        {weekday 0=周日..6, hour 0-23, steps}，weekday-major；
 *                        步数从逐日序列按作息权重重分摊，与 trend 口径一致）
 *   GET /api/session-survival → buildSessionSurvival()（{totalSessions,
 *                        medianDurationSeconds, shortLivedShare, idleOutcomeCounts}）
 *   GET /api/compaction → buildCompaction()（{total, byReason,
 *                        recentDaily 30 天升序零填充, topSessions 前 10 降序}）
 *   GET /api/todo      → buildTodoStats()（queries.ts queryTodoStats 返回形状）
 *   GET /api/directories?limit=10 → buildDirectoryStats()（{totalDirectories,
 *                        totalSessions, directories[{directory, name, sessions,
 *                        steps, lastActiveMs|null}]}，长尾形态、trend 守恒）
 *   GET /api/session/:id/* → 回放 fixtures 见 mock-replay-data.js
 *
 * 全部数据由同一个确定性随机源在模块加载时生成一次，
 * 各视图的"今日"数字从同一份逐日序列推导——KPI 卡、趋势图、漏斗、
 * 热力图彼此口径一致。联调后 data-source.js 默认走真实 API，组件不感知。
 *
 * 量级参考真实重度用户：今日 ~5 亿 token、命中率 ~97%、月活跃模型 20+、
 * 深夜活跃为主。
 */

import { pathLastSegment } from "./format.js";

/** 趋势窗口上限 = 后端 MAX_TREND_DAYS（stats/daily-buckets.ts，366）。 */
export const CALENDAR_DAYS = 366;

const DAY_COUNT = CALENDAR_DAYS;
const SEED = 20261006;

/** mulberry32 确定性随机，保证每次刷新看到同一份数据。 */
function createSeededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

const random = createSeededRandom(SEED);
const randomInRange = (minValue, maxValue) => minValue + random() * (maxValue - minValue);

/** 本地时区日期 key（YYYY-MM-DD），往前回溯 dayOffset 天。 */
function localDateKeyBefore(dayOffset) {
  const date = new Date();
  date.setHours(0, 0, 0, 0);
  date.setDate(date.getDate() - dayOffset);
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const dayOfMonth = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${dayOfMonth}`;
}

/** YYYY-MM-DD → 当日本地零点 epoch 毫秒。 */
function dateKeyToEpochLocal(dateKey) {
  const [year, month, dayOfMonth] = dateKey.split("-").map(Number);
  return new Date(year, month - 1, dayOfMonth).getTime();
}

/* ------------------------------------------------------------
 * 模型目录：22 个模型。era 描述活跃窗口（窗口内天数下标 0..370），
 * peakShare 是该模型活跃期的日 token 份额峰值。
 * ------------------------------------------------------------ */
const MODEL_CATALOG = [
  { modelId: "glm-5.3",                 providerId: "z-ai",       era: { startDay: 295, endDay: 370, peakShare: 0.34 }, hitRate: 0.978, reasoningShare: 0.31, contextMedian: 148_000 },
  { modelId: "claude-sonnet-4.6",        providerId: "anthropic", era: { startDay: 120, endDay: 370, peakShare: 0.20 }, hitRate: 0.966, reasoningShare: 0.09, contextMedian: 132_000 },
  { modelId: "claude-opus-4.6",          providerId: "anthropic", era: { startDay: 60,  endDay: 330, peakShare: 0.15 }, hitRate: 0.972, reasoningShare: 0.14, contextMedian: 165_000 },
  { modelId: "gpt-5.6-terra",            providerId: "openai",    era: { startDay: 200, endDay: 370, peakShare: 0.13 }, hitRate: 0.948, reasoningShare: 0.27, contextMedian: 128_000 },
  { modelId: "gpt-5.2-codex",            providerId: "openai",    era: { startDay: 0,   endDay: 190, peakShare: 0.14 }, hitRate: 0.935, reasoningShare: 0.18, contextMedian: 96_000 },
  { modelId: "qwen3-coder-plus",         providerId: "alibaba",   era: { startDay: 0,   endDay: 370, peakShare: 0.10 }, hitRate: 0.951, reasoningShare: 0.06, contextMedian: 88_000 },
  { modelId: "grok-code-fast-2",         providerId: "xai",       era: { startDay: 255, endDay: 370, peakShare: 0.09 }, hitRate: 0.912, reasoningShare: 0.02, contextMedian: 74_000 },
  { modelId: "kimi-k2.5",                providerId: "moonshot",   era: { startDay: 80,  endDay: 340, peakShare: 0.07 }, hitRate: 0.944, reasoningShare: 0.11, contextMedian: 118_000 },
  { modelId: "gemini-3-pro",             providerId: "google",     era: { startDay: 30,  endDay: 250, peakShare: 0.08 }, hitRate: 0.958, reasoningShare: 0.19, contextMedian: 122_000 },
  { modelId: "deepseek-v4",              providerId: "deepseek",  era: { startDay: 150, endDay: 370, peakShare: 0.06 }, hitRate: 0.927, reasoningShare: 0.08, contextMedian: 82_000 },
  { modelId: "minimax-m2.5",             providerId: "minimax",   era: { startDay: 260, endDay: 370, peakShare: 0.05 }, hitRate: 0.939, reasoningShare: 0.07, contextMedian: 78_000 },
  { modelId: "doubao-seed-code",         providerId: "bytedance",  era: { startDay: 10,  endDay: 210, peakShare: 0.06 }, hitRate: 0.921, reasoningShare: 0.04, contextMedian: 72_000 },
  { modelId: "claude-opus-5",            providerId: "anthropic", era: { startDay: 40,  endDay: 370, peakShare: 0.035 }, hitRate: 0,      reasoningShare: 0.16, contextMedian: 158_000, cacheSupported: false },
  { modelId: "step-3-coder",             providerId: "stepfun",   era: { startDay: 95,  endDay: 300, peakShare: 0.03 }, hitRate: 0.903, reasoningShare: 0.05, contextMedian: 66_000 },
  { modelId: "ernie-5-code",             providerId: "baidu",     era: { startDay: 5,   endDay: 175, peakShare: 0.03 }, hitRate: 0.897, reasoningShare: 0.03, contextMedian: 64_000 },
  { modelId: "hunyuan-t1-code",          providerId: "tencent",   era: { startDay: 35,  endDay: 230, peakShare: 0.025 }, hitRate: 0.914, reasoningShare: 0.05, contextMedian: 60_000 },
  { modelId: "spark-4-coder",            providerId: "iflytek",   era: { startDay: 15,  endDay: 195, peakShare: 0.025 }, hitRate: 0.889, reasoningShare: 0.03, contextMedian: 58_000 },
  { modelId: "llama-4-maverick",         providerId: "meta-gw",   era: { startDay: 0,   endDay: 150, peakShare: 0.02 }, hitRate: 0.871, reasoningShare: 0.02, contextMedian: 52_000 },
  { modelId: "yi-lightning-code",        providerId: "01ai",      era: { startDay: 20,  endDay: 260, peakShare: 0.02 }, hitRate: 0.925, reasoningShare: 0.04, contextMedian: 70_000 },
  { modelId: "mistral-large-3",          providerId: "mistral",   era: { startDay: 0,   endDay: 120, peakShare: 0.02 }, hitRate: 0.882, reasoningShare: 0.02, contextMedian: 55_000 },
  { modelId: "phi-5",                    providerId: "microsoft",  era: { startDay: 0,   endDay: 90,  peakShare: 0.02 }, hitRate: 0.876, reasoningShare: 0.03, contextMedian: 48_000 },
  { modelId: "nova-pro-code",            providerId: "amazon-gw", era: { startDay: 25,  endDay: 320, peakShare: 0.015 }, hitRate: 0.893, reasoningShare: 0.03, contextMedian: 62_000 },
];

/** 活跃窗口份额曲线：30 天爬升 → 平台 → 30 天衰减。 */
function eraShareAtDay(era, dayIndex) {
  if (dayIndex < era.startDay || dayIndex > era.endDay) return 0;
  const rampLength = 30;
  const rampUp = Math.min(1, (dayIndex - era.startDay) / rampLength);
  const rampDown = Math.min(1, (era.endDay - dayIndex) / rampLength);
  return Math.min(rampUp, rampDown);
}

/* ------------------------------------------------------------
 * 逐日序列：一年前 ~1 亿/日增长到今日 ~5.5 亿/日。
 * ------------------------------------------------------------ */
function simulateDailySeries() {
  const dateKeys = [];
  for (let dayIndex = DAY_COUNT - 1; dayIndex >= 0; dayIndex -= 1) {
    dateKeys.push(localDateKeyBefore(dayIndex));
  }

  const points = [];
  const sharesByDay = [];

  for (let dayIndex = 0; dayIndex < DAY_COUNT; dayIndex += 1) {
    const growth = Math.pow(1 + dayIndex / DAY_COUNT, 2.2);
    const weeklyFactor = [1.02, 0.96, 0.98, 0.99, 1.04, 1.16, 1.12][new Date(dateKeys[dayIndex] + "T00:00:00").getDay()];
    let contextSupply = 112_000_000 * growth * weeklyFactor * randomInRange(0.78, 1.3);
    // 一年里有几天几乎没用（出差/休息），近期刻意不断档
    if (dayIndex < DAY_COUNT - 30 && random() < 0.02) contextSupply *= 0.04;

    const dayHitRate = Math.min(0.982, Math.max(0.88, 0.922 + 0.046 * (dayIndex / DAY_COUNT) + randomInRange(-0.016, 0.012)));
    const outputFraction = randomInRange(0.045, 0.075);
    const cacheRead = Math.round(contextSupply * dayHitRate);
    const paidInput = Math.round(contextSupply * (1 - dayHitRate));
    const outputTokens = Math.round(contextSupply * outputFraction);
    const steps = Math.max(4, Math.round(outputTokens / randomInRange(7_000, 12_000)));

    points.push({
      date: dateKeys[dayIndex],
      steps,
      input: paidInput,
      read: cacheRead,
      output: outputTokens,
      hitRate: dayHitRate,
    });

    // 当日模型份额：era 曲线 × 噪声后归一化
    const rawShares = MODEL_CATALOG.map(
      (model) => model.era.peakShare * eraShareAtDay(model.era, dayIndex) * randomInRange(0.7, 1.3),
    );
    const rawShareSum = rawShares.reduce((sum, value) => sum + value, 0);
    sharesByDay.push(
      rawShareSum > 0
        ? rawShares.map((share) => share / rawShareSum)
        : MODEL_CATALOG.map(() => 0),
    );
  }
  return { points, sharesByDay, dateKeys };
}

const simulated = simulateDailySeries();

/** 每模型逐日 token 序列（byModel），与 points 逐日对齐。 */
function buildByModelSeries() {
  const byModel = MODEL_CATALOG.map((model, modelIndex) => {
    const values = [];
    for (let dayIndex = 0; dayIndex < DAY_COUNT; dayIndex += 1) {
      const dayPoint = simulated.points[dayIndex];
      const dayTotal = dayPoint.input + dayPoint.read + dayPoint.output;
      values.push(Math.round(dayTotal * simulated.sharesByDay[dayIndex][modelIndex]));
    }
    return { modelId: model.modelId, values };
  });
  return byModel;
}

const byModelSeries = buildByModelSeries();

/* ------------------------------------------------------------
 * GET /api/overview —— KPI 卡数据（types.ts OverviewStats 扩展）
 * ------------------------------------------------------------ */
function buildOverview() {
  const todayPoint = simulated.points[DAY_COUNT - 1];
  const yesterdayPoint = simulated.points[DAY_COUNT - 2];
  const totalTokens = simulated.points.reduce(
    (sum, point) => sum + point.input + point.read + point.output, 0,
  );

  const last14Days = simulated.points.slice(-14);
  const totalSteps = simulated.points.reduce((sum, point) => sum + point.steps, 0);
  const totalSessions = Math.round(totalSteps / 45);

  // 混合费率粗估：~$0.13 / 百万 token（🟡 估算，仅量级参考）
  const todayTokens = todayPoint.input + todayPoint.read + todayPoint.output;

  return {
    todayTokens,
    todayInput: todayPoint.input,
    todayOutput: todayPoint.output,
    todayHitRate: todayPoint.hitRate,
    yesterdayHitRate: yesterdayPoint.hitRate,
    todaySteps: todayPoint.steps,
    yesterdaySteps: yesterdayPoint.steps,
    totalTokens,
    totalCost: 0, // DB 实值：本库 cost 常为 0（DESIGN §5）
    sessionCount: totalSessions,
    stepCount: totalSteps,
    todayCostEstimateUsd: Math.round(todayTokens / 1e6 * 0.13 * 100) / 100,
    sparklineTokens: last14Days.map((point) => point.input + point.read + point.output),
    sparklineHitRate: last14Days.map((point) => point.hitRate),
    sparklineSteps: last14Days.map((point) => point.steps),
    sparklineSessions: last14Days.map((point) => Math.max(1, Math.round(point.steps / 45))),
  };
}

/* ------------------------------------------------------------
 * GET /api/trend?days=N —— 裸数组 + 点级 byModel（v0.11.0 真实 wire）
 * ------------------------------------------------------------ */

/** modelId → 内部逐日序列（buildByModelSeries 的查找表）。 */
const seriesByModelId = new Map(byModelSeries.map((series) => [series.modelId, series]));

function buildTrend(days) {
  const boundedDays = Math.min(Math.max(days, 1), DAY_COUNT);
  const startDay = DAY_COUNT - boundedDays;
  const windowPoints = simulated.points.slice(startDay);

  // 窗口内观察到的模型（窗口总量 > 0），钉序镜像后端 daily-buckets.ts：
  // 全窗总量 desc + modelId asc 字典序决胜。
  const windowTotalByModelId = new Map();
  for (const series of byModelSeries) {
    let windowTotal = 0;
    for (let dayIndex = startDay; dayIndex < DAY_COUNT; dayIndex += 1) {
      windowTotal += series.values[dayIndex];
    }
    if (windowTotal > 0) windowTotalByModelId.set(series.modelId, windowTotal);
  }
  const orderedModelIds = [...windowTotalByModelId.keys()].sort(
    (leftModelId, rightModelId) => {
      const totalDifference =
        (windowTotalByModelId.get(rightModelId) ?? 0) -
        (windowTotalByModelId.get(leftModelId) ?? 0);
      if (totalDifference !== 0) return totalDifference;
      return leftModelId < rightModelId ? -1 : leftModelId > rightModelId ? 1 : 0;
    },
  );

  // 每点稠密 byModel：窗口内每个模型都出现，无活动日为零。
  return windowPoints.map((point, windowDayIndex) => {
    const dayIndex = startDay + windowDayIndex;
    const pointByModel = {};
    for (const modelId of orderedModelIds) {
      pointByModel[modelId] = seriesByModelId.get(modelId).values[dayIndex];
    }
    return { ...point, byModel: pointByModel };
  });
}

/* ------------------------------------------------------------
 * GET /api/models —— ModelMetric 排行（tokens 降序）
 * ------------------------------------------------------------ */
function nearestRankPercentile(sortedAscending, fraction) {
  if (sortedAscending.length === 0) return 0;
  const rank = Math.min(Math.max(Math.ceil(fraction * sortedAscending.length), 1), sortedAscending.length);
  return sortedAscending[rank - 1];
}

function buildModelMetrics() {
  const metrics = MODEL_CATALOG.map((model, modelIndex) => {
    const series = byModelSeries[modelIndex];
    const tokens = series.values.reduce((sum, value) => sum + value, 0);

    let steps = 0;
    let firstActiveDay = -1;
    let lastActiveDay = -1;
    for (let dayIndex = 0; dayIndex < DAY_COUNT; dayIndex += 1) {
      if (simulated.sharesByDay[dayIndex][modelIndex] > 0.002) {
        if (firstActiveDay < 0) firstActiveDay = dayIndex;
        lastActiveDay = dayIndex;
        steps += simulated.points[dayIndex].steps * simulated.sharesByDay[dayIndex][modelIndex];
      }
    }
    steps = Math.max(1, Math.round(steps));

    // 上下文样本池：对数正态感，中位数来自目录，p95 ≈ 3×中位
    const contextPool = [];
    for (let sampleIndex = 0; sampleIndex < 240; sampleIndex += 1) {
      const noise = randomInRange(0.35, 3.1);
      contextPool.push(Math.round(model.contextMedian * noise));
    }
    contextPool.sort((left, right) => left - right);

    const activeDays = Math.max(1, lastActiveDay - firstActiveDay + 1);
    const contextAvg = Math.round(contextPool.reduce((sum, value) => sum + value, 0) / contextPool.length);

    return {
      modelId: model.modelId,
      providerId: model.providerId,
      steps,
      tokens,
      hitRate: model.hitRate,
      outputPerStep: Math.round((tokens * 0.06) / steps),
      contextAvg,
      contextMedian: nearestRankPercentile(contextPool, 0.5),
      contextP95: nearestRankPercentile(contextPool, 0.95),
      reasoningShare: model.reasoningShare,
      firstSeen: firstActiveDay < 0 ? 0 : dateKeyToEpochLocal(simulated.dateKeys[firstActiveDay]),
      lastSeen: lastActiveDay < 0 ? 0 : dateKeyToEpochLocal(simulated.dateKeys[lastActiveDay]) + 86_400_000 * (activeDays > 1 ? 1 : 0),
      // 扩展字段（M2 对齐时保留）：通道是否上报缓存（DESIGN §10）
      cacheSupported: model.cacheSupported !== false,
    };
  });

  // v0.12.0 token 占比：tokens / Σ tokens 自洽生成——各模型 share 之和
  // 恒等于 1，与真实 wire 同形（原始分数 0..1；分母 0 时全 0）。
  const totalWindowTokens = metrics.reduce((sum, metric) => sum + metric.tokens, 0);
  for (const metric of metrics) {
    metric.tokenShare = totalWindowTokens > 0 ? metric.tokens / totalWindowTokens : 0;
  }

  metrics.sort((left, right) => right.tokens - left.tokens);
  return metrics;
}

/* ------------------------------------------------------------
 * GET /api/agents —— AgentStat[]（工具指纹）
 * ------------------------------------------------------------ */
const AGENT_TOOL_MIXES = [
  {
    agent: "build",
    sessions: 4820,
    toolCounts: { bash: 148_300, edit: 96_500, read: 88_400, grep: 51_200, glob: 37_900, task: 28_600, write: 12_400, todowrite: 9_800, webfetch: 6_200 },
  },
  {
    agent: "plan",
    sessions: 2140,
    toolCounts: { read: 89_200, grep: 44_600, glob: 32_100, ast_grep_search: 21_700, bash: 38_400, webfetch: 12_900, task: 8_300, todowrite: 6_900 },
  },
  {
    agent: "general",
    sessions: 1980,
    toolCounts: { bash: 62_900, read: 55_300, edit: 48_200, grep: 27_800, webfetch: 9_400, glob: 12_600, task: 11_900, write: 4_700 },
  },
  {
    agent: "explore",
    sessions: 960,
    toolCounts: { glob: 34_800, grep: 30_200, read: 58_900, ast_grep_search: 14_800, bash: 9_600 },
  },
];

function buildAgentStats() {
  return AGENT_TOOL_MIXES.map((agentMix) => {
    const toolEntries = Object.entries(agentMix.toolCounts);
    const tokens = Math.round(toolEntries.reduce((sum, [, count]) => sum + count, 0) * randomInRange(4_500, 5_500));
    const toolFingerprint = Object.fromEntries(
      toolEntries.sort((left, right) => right[1] - left[1]),
    );
    return { agent: agentMix.agent, sessions: agentMix.sessions, tokens, toolFingerprint };
  }).sort((left, right) => right.tokens - left.tokens);
}

/* ------------------------------------------------------------
 * GET /api/sessions —— SessionSummary 列表（最近 8 天，深夜为主）
 * ------------------------------------------------------------ */
const SESSION_TITLE_POOL = [
  "修复登录页 token 刷新竞态", "重构 db reader 为只读连接", "给看板补上空数据占位",
  "排查 heatmap 时区偏移一天", "uPlot 堆叠面积图图例开关", "会话导出 Markdown 分节渲染",
  "TUI 面板对齐 usage-meter 风格", "命中率双口径单测补齐", "SQLite WAL 并发读压测",
  "52 周日历热力图 5 档着色", "模型排行榜排序交互", "深浅色主题 CSS 变量收敛",
  "修复 tool part 解析丢字段", "端口占用自动 +1 重试", "导出文件名 slug 化",
  "opencode.db 大库聚合性能", "压缩事件按日分桶", "todo 完成率统计接入",
  "深夜 marathon 会话识别", "缓存 write 是否计入供给口径讨论", "sparkline 边界空数组",
  "fn key: mode=ro 打开方式验证", "mock 数据与真实量级对齐", "会话存活时长分布直方图",
  "agent 工具指纹归一化", "回放页系统提示词折叠面板", "turn 级成本条分段配色",
  "KPI 卡环比上一等长周期", "图表点击下钻到会话列表", "零构建前端模块划分",
];
const SESSION_DIRECTORIES = ["~/projects/aicode", "~/work/opencode-plugin", "~/lab/db-tooling", "~/scratch"];

function buildSessionSummaries() {
  const recentModelShares = simulated.sharesByDay[DAY_COUNT - 1];
  const sessions = [];
  for (let sessionIndex = 0; sessionIndex < 48; sessionIndex += 1) {
    // 按最近一天的模型份额加权抽模型
    let draw = random() * recentModelShares.reduce((sum, share) => sum + share, 0);
    let modelPick = MODEL_CATALOG[0];
    for (let modelIndex = 0; modelIndex < MODEL_CATALOG.length; modelIndex += 1) {
      draw -= recentModelShares[modelIndex];
      if (draw <= 0) { modelPick = MODEL_CATALOG[modelIndex]; break; }
    }

    // 深夜活跃：小时集中在 21~03 点
    const createdDayOffset = Math.floor(random() * 8);
    const nightHour = Math.floor(randomInRange(21, 27)) % 24;
    const createdDate = new Date();
    createdDate.setHours(0, 0, 0, 0);
    createdDate.setDate(createdDate.getDate() - createdDayOffset);
    createdDate.setHours(nightHour, Math.floor(random() * 60), Math.floor(random() * 60), 0);
    const durationMs = randomInRange(8 * 60_000, 13 * 3_600_000);
    const tokens = Math.round(randomInRange(1_800_000, 72_000_000));
    // v0.13.0 三分镜像（session_v2 三列直通的 wire 契约）：比例复刻日序列
    // 的生成规律（cache.read 占大头、纯 input 是扣掉缓存后的实付、output
    // 是零头），分项和严格 === tokens——余数兜底保证守恒（tokenShare 同款
    // 纪律），与 KPI 卡「入 = 纯输入、出 = output」口径一致。
    const sessionCacheHitRate = Math.min(0.982, Math.max(0.88, 0.922 + randomInRange(-0.016, 0.05)));
    const tokensCacheRead = Math.round(tokens * sessionCacheHitRate);
    const tokensInput = Math.round(tokens * (1 - sessionCacheHitRate));
    const tokensOutput = tokens - tokensCacheRead - tokensInput;

    sessions.push({
      id: sessionIndex === 0 ? "ses_replay_demo" : "ses_" + (0x8f3a0000 + sessionIndex * 7919).toString(16).padStart(8, "0"),
      title: SESSION_TITLE_POOL[sessionIndex % SESSION_TITLE_POOL.length],
      modelId: modelPick.modelId,
      agent: AGENT_TOOL_MIXES[sessionIndex % AGENT_TOOL_MIXES.length].agent,
      directory: SESSION_DIRECTORIES[sessionIndex % SESSION_DIRECTORIES.length],
      timeCreated: createdDate.getTime(),
      timeUpdated: createdDate.getTime() + durationMs,
      tokens,
      tokensInput,
      tokensOutput,
      tokensCacheRead,
      cost: 0,
    });
  }
  sessions.sort((left, right) => right.timeCreated - left.timeCreated);
  return { total: buildOverview().sessionCount, sessions };
}

/* ------------------------------------------------------------
 * GET /api/hour-heatmap?days=90 —— 168 项零填充（weekday-major）
 * 从统一随机源的逐日序列推导（与本文件头部自述一致）：取近 N 天
 * simulated.points 的每日 steps，按「该周几的 24 小时作息权重」重分摊——
 * 最大余数法保证每日分摊精确守恒，因此 168 格 steps 总和与
 * getMockTrend(同天数) 的 steps 总和严格相等（口径一致）。
 * 作息权重为确定性 profile（深夜 21~03 高峰，工作日白天次之，
 * 清晨 4~5 点权重为零——该时段恒为 0 格，6~7 点近零）。
 * ------------------------------------------------------------
 */
const HOUR_HEATMAP_WINDOW_DAYS = 90;

/** 某周几某小时的作息权重（0 = 该时段恒零；权重越小越常分到 0）。 */
function hourProfileWeight(weekday, hour) {
  const isWeekend = weekday === 0 || weekday === 6;
  const isNightOwl = hour >= 21 || hour <= 3;
  const isWorkHour = hour >= 10 && hour <= 18 && !isWeekend;
  const isSleepTrough = hour >= 4 && hour <= 5;
  const isLateNight = hour >= 6 && hour <= 7;
  if (isSleepTrough) return 0;
  if (isNightOwl) return isWeekend ? 3.4 : 3.0;
  if (isWorkHour) return 1.0;
  if (isLateNight) return 0.15;
  return 0.5;
}

/**
 * 最大余数法：totalValue 按权重比例精确分摊（Σ 结果 === totalValue）。
 * 热力图的逐日小时分摊与目录统计的 steps/会话数分摊共用此函数。
 *
 * 守恒契约：totalValue > 0 时 Σ 结果 === totalValue。因此 weights 全零
 * 或为空数组时无法满足契约，属调用方错误，直接 throw（当前两个调用方
 * 的权重都保证有非零槽位，正常路径不可达）。totalValue <= 0 时返回
 * 全零数组（Σ = 0 = totalValue，契约自洽）。
 *
 * 导出仅为冒烟脚本可对退化分支下断言，data-source 不消费它。
 */
export function distributeByLargestRemainder(totalValue, weights) {
  const weightSum = weights.reduce((sum, weight) => sum + weight, 0);
  if (weightSum <= 0 && totalValue > 0) {
    throw new Error(`distributeByLargestRemainder: 权重全零（${weights.length} 个槽位）无法守恒分摊 ${totalValue}`);
  }
  if (totalValue <= 0) return new Array(weights.length).fill(0);
  const exactShares = weights.map((weight) => (totalValue * weight) / weightSum);
  const allocations = exactShares.map((share) => Math.floor(share));
  const fractionalOrder = exactShares
    .map((share, slotIndex) => ({ slotIndex, fraction: share - Math.floor(share) }))
    .sort((left, right) => right.fraction - left.fraction || left.slotIndex - right.slotIndex);
  let remainder = totalValue - allocations.reduce((sum, value) => sum + value, 0);
  for (let orderIndex = 0; remainder > 0; orderIndex += 1) {
    allocations[fractionalOrder[orderIndex % fractionalOrder.length].slotIndex] += 1;
    remainder -= 1;
  }
  return allocations;
}

function buildHourHeatmap(days = HOUR_HEATMAP_WINDOW_DAYS) {
  const boundedDays = Math.min(Math.max(days, 1), DAY_COUNT);
  const stepCountGrid = new Array(168).fill(0);
  const recentPoints = simulated.points.slice(DAY_COUNT - boundedDays);

  for (const dayPoint of recentPoints) {
    // 契约口径：weekday 0=周日..6=周六，与 Date#getDay() 一致
    const weekday = new Date(dateKeyToEpochLocal(dayPoint.date)).getDay();
    const hourWeights = Array.from({ length: 24 }, (_, hour) => hourProfileWeight(weekday, hour));
    const hourAllocations = distributeByLargestRemainder(dayPoint.steps, hourWeights);
    for (let hour = 0; hour <= 23; hour += 1) {
      stepCountGrid[weekday * 24 + hour] += hourAllocations[hour];
    }
  }

  const cells = [];
  for (let weekday = 0; weekday <= 6; weekday += 1) {
    for (let hour = 0; hour <= 23; hour += 1) {
      cells.push({ weekday, hour, steps: stepCountGrid[weekday * 24 + hour] });
    }
  }
  return cells;
}

/* ------------------------------------------------------------
 * GET /api/session-survival —— 中位存活 / 短命占比 / idle 结局
 * totalSessions 与 /api/sessions 的 total 同源（口径一致）；
 * idleOutcomeCounts 键名对齐真实库 idle_outcome 实测值：
 * succeeded / failed / interrupted，NULL 结局归 none（比例仅演示性）。
 * ------------------------------------------------------------
 */
function buildSessionSurvival() {
  const totalSessions = sessionsPayload.total;
  const succeededCount = Math.round(totalSessions * 0.62);
  const failedCount = Math.round(totalSessions * 0.11);
  const interruptedCount = Math.round(totalSessions * 0.09);
  return {
    totalSessions,
    medianDurationSeconds: 2_730, // 45.5 分钟
    shortLivedShare: 0.312,
    idleOutcomeCounts: {
      succeeded: succeededCount,
      failed: failedCount,
      interrupted: interruptedCount,
      none: totalSessions - succeededCount - failedCount - interruptedCount,
    },
  };
}

/* ------------------------------------------------------------
 * GET /api/compaction —— 总数 / 按原因 / 近 30 日趋势 / Top 会话
 * byReason 键名对齐真实库实测值：auto / manual（unknown 兜底）；
 * total = byReason 求和（口径自洽）；recentDaily 30 天升序零填充；
 * topSessions 取 sessions mock 的真实 id，次数降序（前 10）。
 * ------------------------------------------------------------
 */
function buildCompaction() {
  const byReason = { auto: 1_596, manual: 296, unknown: 50 };
  const total = Object.values(byReason).reduce((sum, count) => sum + count, 0);

  const recentDaily = [];
  for (let dayOffset = 29; dayOffset >= 0; dayOffset -= 1) {
    const count = random() < 0.25 ? 0 : Math.round(randomInRange(1, 9));
    recentDaily.push({ dateKey: localDateKeyBefore(dayOffset), count });
  }

  const topSessions = sessionsPayload.sessions.slice(0, 10).map((session, sessionIndex) => ({
    sessionId: session.id,
    count: 40 - sessionIndex * 3,
  }));

  return { total, byReason, recentDaily, topSessions };
}

/* ------------------------------------------------------------
 * GET /api/todo —— queryTodoStats 返回形状
 * （total 含三个已知状态之外的状态，这里放 14 个 cancelled 演示「其他」段）
 * ------------------------------------------------------------
 */
function buildTodoStats() {
  const completed = 912;
  const pending = 233;
  const inProgress = 141;
  const otherStatusCount = 14;
  return { total: completed + pending + inProgress + otherStatusCount, completed, pending, inProgress };
}

/* ------------------------------------------------------------
 * GET /api/directories?limit=10 —— 按项目目录聚合（长尾形态）
 * 从统一逐日序列推导（与 hour-heatmap 同款纪律）：
 *  - steps：逐日按「目录权重」最大余数法分摊 → 各目录求和与
 *    getMockTrend(366) 的 steps 总和精确守恒（口径一致）。
 *  - sessions：与 overview/survival 同源（真实后端是同一条 COUNT(*)，
 *    三个视图恒等）——取 buildOverview().sessionCount 一次性按
 *    「权重 × 活跃天数」分摊，不做逐日取整，杜绝跨视图漂移。
 * 权重参考真实探针的长尾形态（主目录占大头 ~69%）；
 * ~/scratch（最后一个目录）在 DORMANT_AFTER_DAY_INDEX 后停用，
 * 其 lastActiveMs 停在旧日期，验证「最近活跃」的相对时间显示。
 * ------------------------------------------------------------ */
/** 与 SESSION_DIRECTORIES 下标一一对应的目录权重（Σ = 1）。 */
const DIRECTORY_SESSION_WEIGHTS = [0.69, 0.17, 0.10, 0.04];
/** 停用的目录下标（SESSION_DIRECTORIES 最后一个：~/scratch）。 */
const DORMANT_DIRECTORY_INDEX = 3;
/** 该目录在此下标之后不再活跃（约 60 天前）。 */
const DORMANT_AFTER_DAY_INDEX = DAY_COUNT - 61;

function buildDirectoryStats() {
  // 会话数同源链：overview.sessionCount === sessions.total === survival.totalSessions
  //（真实后端三者同一条 COUNT(*)）。目录 mock 挂同一源头一次性分摊，
  // Σ 各目录 sessions === 该值——目录面板 meta 与生存卡片恒等。
  const lifetimeSessionWeights = SESSION_DIRECTORIES.map(
    (_, directoryIndex) => DIRECTORY_SESSION_WEIGHTS[directoryIndex] *
      (directoryIndex === DORMANT_DIRECTORY_INDEX ? DORMANT_AFTER_DAY_INDEX + 1 : DAY_COUNT),
  );
  const sessionAllocations = distributeByLargestRemainder(
    buildOverview().sessionCount,
    lifetimeSessionWeights,
  );

  const directoryTotals = SESSION_DIRECTORIES.map((_, directoryIndex) => ({
    steps: 0,
    sessions: sessionAllocations[directoryIndex],
    lastActiveDayIndex: -1,
  }));

  for (let dayIndex = 0; dayIndex < DAY_COUNT; dayIndex += 1) {
    const dayPoint = simulated.points[dayIndex];
    const dayDirectoryWeights = SESSION_DIRECTORIES.map((_, directoryIndex) => {
      const isDormant = directoryIndex === DORMANT_DIRECTORY_INDEX && dayIndex > DORMANT_AFTER_DAY_INDEX;
      return isDormant ? 0 : DIRECTORY_SESSION_WEIGHTS[directoryIndex];
    });
    const stepAllocations = distributeByLargestRemainder(dayPoint.steps, dayDirectoryWeights);
    for (let directoryIndex = 0; directoryIndex < SESSION_DIRECTORIES.length; directoryIndex += 1) {
      directoryTotals[directoryIndex].steps += stepAllocations[directoryIndex];
      if (stepAllocations[directoryIndex] > 0) directoryTotals[directoryIndex].lastActiveDayIndex = dayIndex;
    }
  }

  const directories = SESSION_DIRECTORIES.map((directoryPath, directoryIndex) => ({
    directory: directoryPath,
    name: pathLastSegment(directoryPath),
    sessions: directoryTotals[directoryIndex].sessions,
    steps: directoryTotals[directoryIndex].steps,
    lastActiveMs: directoryTotals[directoryIndex].lastActiveDayIndex < 0
      ? null
      : dateKeyToEpochLocal(simulated.dateKeys[directoryTotals[directoryIndex].lastActiveDayIndex]),
  }));

  // 契约排序：steps desc → sessions desc → directory asc
  directories.sort((left, right) =>
    right.steps - left.steps ||
    right.sessions - left.sessions ||
    (left.directory < right.directory ? -1 : left.directory > right.directory ? 1 : 0));

  return {
    totalDirectories: directories.length,
    totalSessions: directories.reduce((sum, entry) => sum + entry.sessions, 0),
    directories,
  };
}

/* ------------------------------------------------------------
 * 导出（data-source.js 以带延迟的 Promise 包装这些同步结果）
 * ------------------------------------------------------------ */
const overviewPayload = buildOverview();
const modelMetricsPayload = buildModelMetrics();
const agentStatsPayload = buildAgentStats();
const sessionsPayload = buildSessionSummaries();
const sessionSurvivalPayload = buildSessionSurvival();
const compactionPayload = buildCompaction();
const todoStatsPayload = buildTodoStats();
const directoryStatsPayload = buildDirectoryStats();

export function getMockOverview() { return overviewPayload; }
export function getMockTrend(days) { return buildTrend(days); }
export function getMockModelMetrics() { return modelMetricsPayload; }
export function getMockAgentStats() { return agentStatsPayload; }

/* ------------------------------------------------------------
 * GET /api/sessions?sort&order&directory&range —— v0.7.0 目录过滤 /
 * v0.9.0 时间范围过滤语义
 * 排序白名单与回退对齐后端 resolveSessionSortKey / resolveSessionSortOrder
 * （db/queries.ts）：sort ∈ time_updated(默认)|time_created|tokens|cost|title，
 * 非白名单/缺省回退默认；order 仅 "asc" 翻转，其余回退 desc。
 * directory 为 null/"" 时不过滤（后端契约：缺省/空=无过滤）；非空时
 * 精确匹配 session.directory，匹配不到 → 空数组（过滤语义，合法结果，
 * 不抛错）。range 词表 = 7d|30d|90d（缺省/空=全量），过滤口径
 * timeUpdated（最近 N 天内更新，含边界日切点：now - N*86400_000）；
 * 词表外的非空值抛错——镜像后端 400 防御，mock 不发脏数据（前端 UI
 * 只从词表产生值，抛错仅钉契约）。任一过滤生效时 total 置 null：
 * mock 的 total 是全库假想计数，过滤后沿用会误导脚注，且真实源本就
 * total=null（裸数组）。并列决胜与后端 ORDER BY …, id ASC 一致：主键
 * 相等时按 id 升序。title 按码元序比较（近似 SQLite BINARY 整序，
 * 不用 localeCompare）。每次请求在副本上过滤+排序，sessionsPayload
 * 的基准次序不动（compaction topSessions 等共用它）。
 * ------------------------------------------------------------ */
const SESSION_SORT_FIELD_BY_KEY = {
  time_updated: "timeUpdated",
  time_created: "timeCreated",
  tokens: "tokens",
  cost: "cost",
  title: "title",
};

const SESSION_RANGE_DAYS_BY_VALUE = { "7d": 7, "30d": 30, "90d": 90 };

export function getMockSessions(
  sortKeyValue = "time_updated",
  sortOrderValue = "desc",
  directoryFilter = null,
  rangeFilter = "",
) {
  const safeSortKey = Object.hasOwn(SESSION_SORT_FIELD_BY_KEY, sortKeyValue)
    ? sortKeyValue
    : "time_updated";
  const safeSortOrder = sortOrderValue === "asc" ? "asc" : "desc";
  const isDirectoryFiltered = directoryFilter !== null && directoryFilter !== "";
  // 词表外的非空 range 抛错（镜像后端 400）；空/缺省 = 全量。
  const rangeDays = rangeFilter === null || rangeFilter === ""
    ? null
    : (Object.hasOwn(SESSION_RANGE_DAYS_BY_VALUE, rangeFilter)
      ? SESSION_RANGE_DAYS_BY_VALUE[rangeFilter]
      : undefined);
  if (rangeDays === undefined) {
    throw new Error(`unknown range "${String(rangeFilter)}"（契约词表：7d|30d|90d，缺省/空=全量）`);
  }
  const rangeCutoffMs = rangeDays === null ? 0 : Date.now() - rangeDays * 86_400_000;
  const baseSessions = sessionsPayload.sessions.filter((session) =>
    (!isDirectoryFiltered || session.directory === directoryFilter)
    && (rangeDays === null || session.timeUpdated >= rangeCutoffMs));
  const sortField = SESSION_SORT_FIELD_BY_KEY[safeSortKey];
  const directionSign = safeSortOrder === "asc" ? 1 : -1;
  const sortedSessions = [...baseSessions].sort((left, right) => {
    if (sortField === "title") {
      const titleCompare = (left.title < right.title ? -1 : left.title > right.title ? 1 : 0) * directionSign;
      if (titleCompare !== 0) return titleCompare;
    } else {
      const valueCompare = ((left[sortField] ?? 0) - (right[sortField] ?? 0)) * directionSign;
      if (valueCompare !== 0) return valueCompare;
    }
    // 与后端相同的 id ASC 决胜：方向无关，恒为升序
    return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
  });
  const isAnyFilterActive = isDirectoryFiltered || rangeDays !== null;
  return {
    total: isAnyFilterActive ? null : sessionsPayload.total,
    sessions: sortedSessions,
  };
}
// 按需构建（同 getMockTrend）：热力窗口必须与 trend 同 days 才守恒
export function getMockHourHeatmap(days) { return buildHourHeatmap(days); }
export function getMockSessionSurvival() { return sessionSurvivalPayload; }
export function getMockCompaction() { return compactionPayload; }
export function getMockTodoStats() { return todoStatsPayload; }
/** limit 只截取 directories 列表，totalDirectories/totalSessions 仍是全量口径。 */
export function getMockDirectoryStats(limit = 10) {
  const boundedLimit = Math.max(1, Math.floor(limit));
  return {
    ...directoryStatsPayload,
    directories: directoryStatsPayload.directories.slice(0, boundedLimit),
  };
}

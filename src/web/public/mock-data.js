/**
 * Mock 数据源（M3 阶段）。
 *
 * 形状严格对齐 DESIGN.md §6 与后端类型（src/db/types.ts、src/stats/*.ts）：
 *   GET /api/overview  → buildOverview()（types.ts OverviewStats + 前端卡片
 *                        所需的今日 in/out 分列、环比、sparkline、成本估算）
 *   GET /api/trend     → buildTrend(days)（stats/daily-buckets.ts DailyTrendPoint
 *                        + byModel 每模型日序列，供堆叠面积图分色）
 *   GET /api/models    → buildModelMetrics()（stats/model-metrics.ts ModelMetric）
 *   GET /api/agents    → buildAgentStats()（stats/agent-fingerprint.ts AgentStat）
 *   GET /api/sessions  → buildSessions()（types.ts SessionSummary 列表）
 *
 * 全部数据由同一个确定性随机源在模块加载时生成一次，
 * 各视图的"今日"数字从同一份逐日序列推导——KPI 卡、趋势图、漏斗、
 * 热力图彼此口径一致。M2 联调时把 data-source.js 切到真实 API 即可，
 * 组件不感知。
 *
 * 量级参考真实重度用户：今日 ~5 亿 token、命中率 ~97%、月活跃模型 20+、
 * 深夜活跃为主。
 */

/** 日历热力图覆盖 53 周（371 天），趋势图最大窗口与之相同。 */
export const CALENDAR_DAYS = 371;

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
 * GET /api/trend?days=N —— 逐日序列 + 每模型拆分
 * ------------------------------------------------------------ */
function buildTrend(days) {
  const boundedDays = Math.min(Math.max(days, 1), DAY_COUNT);
  const startDay = DAY_COUNT - boundedDays;
  return {
    points: simulated.points.slice(startDay),
    byModel: byModelSeries.map((series) => ({
      modelId: series.modelId,
      values: series.values.slice(startDay),
    })),
  };
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

    sessions.push({
      id: "ses_" + (0x8f3a0000 + sessionIndex * 7919).toString(16).padStart(8, "0"),
      title: SESSION_TITLE_POOL[sessionIndex % SESSION_TITLE_POOL.length],
      modelId: modelPick.modelId,
      agent: AGENT_TOOL_MIXES[sessionIndex % AGENT_TOOL_MIXES.length].agent,
      directory: SESSION_DIRECTORIES[sessionIndex % SESSION_DIRECTORIES.length],
      timeCreated: createdDate.getTime(),
      timeUpdated: createdDate.getTime() + durationMs,
      tokens,
      cost: 0,
    });
  }
  sessions.sort((left, right) => right.timeCreated - left.timeCreated);
  return { total: buildOverview().sessionCount, sessions };
}

/* ------------------------------------------------------------
 * 导出（data-source.js 以带延迟的 Promise 包装这些同步结果）
 * ------------------------------------------------------------ */
const overviewPayload = buildOverview();
const modelMetricsPayload = buildModelMetrics();
const agentStatsPayload = buildAgentStats();
const sessionsPayload = buildSessionSummaries();

export function getMockOverview() { return overviewPayload; }
export function getMockTrend(days) { return buildTrend(days); }
export function getMockModelMetrics() { return modelMetricsPayload; }
export function getMockAgentStats() { return agentStatsPayload; }
export function getMockSessions() { return sessionsPayload; }

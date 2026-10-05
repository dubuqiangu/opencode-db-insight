/**
 * 数据源统一入口：组件只 import 这里的函数，不感知 mock 还是真实 API。
 *
 * 联调切换：把 USE_MOCK 改为 false 即走真实 HTTP（DESIGN §6 路由），
 * 组件代码零改动。所有函数返回 Promise，失败时抛出带 reason 的 Error，
 * 由 app.js 的状态层渲染错误占位。
 */

import {
  getMockOverview,
  getMockTrend,
  getMockModelMetrics,
  getMockAgentStats,
  getMockSessions,
} from "./mock-data.js";

const USE_MOCK = true;
const API_BASE = "/api";

/** mock 模拟一点网络延迟，让骨架屏状态真实可见。 */
function resolveWithLatency(payload) {
  return new Promise((resolve) => {
    setTimeout(() => resolve(payload), 120 + Math.random() * 260);
  });
}

async function fetchJson(path) {
  const response = await fetch(API_BASE + path);
  if (!response.ok) {
    throw new Error(`API ${path} 返回 ${response.status}`);
  }
  return response.json();
}

/** GET /api/overview —— KPI 卡。 */
export function fetchOverview() {
  if (USE_MOCK) return resolveWithLatency(getMockOverview());
  return fetchJson("/overview");
}

/**
 * GET /api/trend?days=N —— 逐日序列 + byModel。
 * days 传 371 时同时供 52 周日历热力图使用。
 */
export function fetchTrend(days) {
  if (USE_MOCK) return resolveWithLatency(getMockTrend(days));
  return fetchJson(`/trend?days=${days}`);
}

/** GET /api/models —— 模型排行榜。 */
export function fetchModels() {
  if (USE_MOCK) return resolveWithLatency(getMockModelMetrics());
  return fetchJson("/models");
}

/** GET /api/agents —— agent 用量 + 工具指纹。 */
export function fetchAgents() {
  if (USE_MOCK) return resolveWithLatency(getMockAgentStats());
  return fetchJson("/agents");
}

/** GET /api/sessions?limit&offset —— 会话列表。 */
export function fetchSessions(limit = 20, offset = 0) {
  if (USE_MOCK) return resolveWithLatency(getMockSessions());
  return fetchJson(`/sessions?limit=${limit}&offset=${offset}`);
}

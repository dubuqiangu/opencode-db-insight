/**
 * 会话作用域下的看板 section 显隐映射（v0.20.0）：纯数据 + 纯函数，
 * 不碰 DOM——app.js 拿映射去切换 section 与 TOC 按钮的 hidden 属性。
 *
 * 判定标准是「口径维度」：面板统计的是**全部会话**的横向分布/排行/
 * 时间分布时，在单会话作用域里要么退化成无意义的单点（存活、时段
 * 热力、逐日趋势、日历），要么口径直接错位（分布卡、Agent 榜、目录
 * ——后端虽支持 ?session=，但这些面板的价值本身建立在多会话对比
 * 上）。保留区（KPI、Token 漏斗、模型榜、工具榜、工具健康、压缩、
 * todo、会话列表）都是「单会话也成立」或已由后端正确收窄的维度。
 *
 * 显隐走 hidden 属性而不是 class：视觉 lane 的 reveal 动画批次与
 * [hidden] 的 UA 语义互不干扰（styles.css .topbar-chip-slot 一节的
 * 同款纪律）。
 */

/**
 * 作用域激活时整体隐藏的 section id（index.html 的锚点 id）。
 * 与后端 SESSION_FILTER_CONSUMING_ROUTE_NAMES 是两个清单：路由清单
 * 是「哪些端点吃 ?session=」，这里是「哪些面板在单会话视图没有意义」
 * ——交集之外（如 trend）由 app 层决定：数据仍取（喂 Token 漏斗），
 * 面板本体隐藏。
 */
export const SESSION_SCOPE_HIDDEN_SECTION_IDS = [
  "panel-trend",
  "panel-calendar",
  "panel-hour-heatmap",
  "panel-survival",
  "panel-distribution",
  "panel-step-distribution",
  "panel-duration-distribution",
  "panel-child-share",
  "panel-agents",
  "panel-directories",
];

/** 作用域激活时保留的 section id（清单化是为了测试能断言「全集且互斥」）。 */
export const SESSION_SCOPE_KEPT_SECTION_IDS = [
  "kpi-row",
  "panel-tools",
  "panel-funnel",
  "panel-compaction",
  "panel-todo",
  "panel-models",
  "panel-sessions",
];

/**
 * 全部受管 section 的 hidden 映射：scopeActive=false 时一切不隐藏
 * （退出即恢复）；true 时隐藏区整体 hidden、保留区显式不 hidden
 * （显式 false 而非缺省，让 app 层可以无脑赋值不比状态）。
 */
export function sessionScopeSectionHiddenById(scopeActive) {
  const sectionHiddenById = new Map();
  for (const sectionId of SESSION_SCOPE_KEPT_SECTION_IDS) {
    sectionHiddenById.set(sectionId, false);
  }
  for (const sectionId of SESSION_SCOPE_HIDDEN_SECTION_IDS) {
    sectionHiddenById.set(sectionId, scopeActive === true);
  }
  return sectionHiddenById;
}

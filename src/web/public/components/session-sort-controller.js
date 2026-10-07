/**
 * 会话列表排序控制器（P2-2，v0.5.1 从 app.js 抽出）：持有 sort/order
 * 状态、按 sort/order 组合区分的缓存、请求序列守卫，把 session-list
 * 的列头/重置回调转成带 ?sort=/?order= 的 API 请求。app.js 只装配
 * （注入 fetchSessionsPage 等依赖），本模块不感知全局 state——竞态
 * 行为由 test/web-components.test.ts 的控制器竞态测试锁住：
 * 晚到响应不落 DOM 但入缓存、切排序弹掉旧请求、同组合重叠请求早
 * token 弃渲染。
 *
 * 缓存键假设（N-2 钉住）：今天 fetchSessionsPage 闭包内 limit/offset
 * 为常量单页（app.js 的 SESSION_LIST_PAGE_LIMIT / 0），键 `sort:order`
 * 足以区分条目。若将来分页参数化（limit/offset 可变），键必须扩为
 * `limit:offset:sort:order`，否则不同页会共享同一条目。缓存用 Map
 * 而非普通对象：键永远来自本模块写入的组合值，Map 顺带杜绝原型链
 * 键的查表歧义。
 */

import { renderSessionList } from "./session-list.js";
import { renderError } from "./state-views.js";
import { DEFAULT_SESSION_SORT_KEY, DEFAULT_SESSION_SORT_ORDER } from "../data-source.js";

/** sessions 缓存键：sort/order 组合（后端缓存键 sessions:[…,sort,order] 的前端对应）。 */
function sessionSortCacheKey(sortKey, sortOrder) {
  return `${sortKey}:${sortOrder}`;
}

/**
 * 创建会话列表排序控制器。
 *
 * 依赖注入（app.js 装配，测试替身可换）：
 * - containerElement：会话列表容器（app.js 的 #session-list）
 * - fetchSessionsPage(sortKey, sortOrder) → Promise<sessionPayload>：
 *   单页请求闭包，limit/offset 由装配方钉死（见头部 N-2 注释）
 * - getModelFilter() → string | null：模型下钻过滤（app 状态，只读访问器）
 * - markSectionSucceeded() / markSectionFailed()：顶栏失败计数回调
 *
 * 返回：
 * - load()：初始加载/错误重试入口
 * - changeSort(sortKey, sortOrder)：列头点击与重置入口共用的排序切换
 * - renderCurrent()：用当前 sort/filter 渲染（缺缓存 → 加载骨架；
 *   模型下钻过滤变化后调用）
 * - renderCurrentIfLoaded()：仅在缓存已有当前组合时渲染（主题切换后
 *   重读配色调用，与 app 其他区块的 `!== undefined` 守卫同语义）
 */
export function createSessionSortController({
  containerElement,
  fetchSessionsPage,
  getModelFilter,
  markSectionSucceeded = () => {},
  markSectionFailed = () => {},
}) {
  const sortState = {
    key: DEFAULT_SESSION_SORT_KEY,
    order: DEFAULT_SESSION_SORT_ORDER,
    cache: new Map(),
  };
  let loadSequence = 0;

  function renderCurrent() {
    const cachedSessionPayload =
      sortState.cache.get(sessionSortCacheKey(sortState.key, sortState.order)) ?? null;
    renderSessionList(
      containerElement,
      cachedSessionPayload,
      getModelFilter(),
      sortState.key,
      sortState.order,
      changeSort,
    );
  }

  function renderCurrentIfLoaded() {
    if (!sortState.cache.has(sessionSortCacheKey(sortState.key, sortState.order))) return;
    renderCurrent();
  }

  /**
   * 序列守卫（同 app.js loadTrendSection 的模式）：慢响应晚到不得覆盖
   * 当前排序——缓存仍按它自己的请求组合入库（晚到不浪费），但只有
   * 「最新一次请求 且 仍针对当前排序」的结果才允许落 DOM / 记成功。
   */
  async function load() {
    const requestToken = ++loadSequence;
    const requestSortKey = sortState.key;
    const requestSortOrder = sortState.order;
    try {
      const sessionPayload = await fetchSessionsPage(requestSortKey, requestSortOrder);
      sortState.cache.set(sessionSortCacheKey(requestSortKey, requestSortOrder), sessionPayload);
      if (requestToken !== loadSequence
        || requestSortKey !== sortState.key
        || requestSortOrder !== sortState.order) return;
      renderCurrent();
      markSectionSucceeded();
    } catch (error) {
      if (requestToken !== loadSequence
        || requestSortKey !== sortState.key
        || requestSortOrder !== sortState.order) return;
      renderError(containerElement, error, load);
      markSectionFailed();
    }
  }

  /** 排序切换（列头点击/重置共用）：命中缓存立即渲染，否则骨架 + 重新请求。 */
  function changeSort(nextSortKey, nextSortOrder) {
    if (sortState.key === nextSortKey && sortState.order === nextSortOrder) return;
    sortState.key = nextSortKey;
    sortState.order = nextSortOrder;
    if (sortState.cache.has(sessionSortCacheKey(nextSortKey, nextSortOrder))) {
      renderCurrent();
    } else {
      // 未取过的排序：先上骨架，不闪旧排序的数据
      renderSessionList(containerElement, null);
      load();
    }
  }

  return { load, changeSort, renderCurrent, renderCurrentIfLoaded };
}

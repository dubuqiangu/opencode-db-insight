/**
 * 会话列表排序控制器（P2-2，v0.5.1 从 app.js 抽出）：持有 sort/order/
 * directory/range 状态、按组合区分的 Map 缓存、请求序列守卫，把
 * session-list 的列头/重置/范围回调与目录下钻转成带
 * ?sort=/?order=/?directory=/?range= 的 API 请求。app.js 只装配（注入
 * fetchSessionsPage 等依赖），本模块不感知全局 state——竞态行为由
 * test/web-components.test.ts 的控制器竞态测试锁住：晚到响应不落 DOM
 * 但入缓存、切换任一维度弹掉旧请求、同组合重叠请求早 token 弃渲染。
 *
 * v0.7.0 扩维：目录→会话下钻过滤。directory 是服务端参数（与模型
 * 客户端行过滤正交），状态与缓存键随之扩维。
 * v0.9.0 扩维：时间范围（?range=7d|30d|90d，timeUpdated 口径）同模式
 * 入控制器受控状态——单一真源在此，app/session-list 不另存副本。
 *
 * 缓存键 = `sort:order:directory:range` 四维。注入性（键可逆、组合无
 * 碰撞）：sort/order/range 取值来自固定词表（不含冒号），directory 做
 * URL 编码入键——路径里的 ":"（盘符 D:/）编码后不再产生分段歧义，
 * 任意两组合映射到不同键。
 *
 * 缓存键假设（N-2 钉住）：今天 fetchSessionsPage 闭包内 limit/offset
 * 为常量单页（app.js 的 SESSION_LIST_PAGE_LIMIT / 0），现有键足够区分
 * 条目。若将来分页参数化（limit/offset 可变），键必须扩为
 * `limit:offset:sort:order:directory:range`，否则不同页会共享同一条目。
 * 缓存用 Map 而非普通对象：键永远来自本模块写入的组合值，Map 顺带杜绝
 * 原型链键的查表歧义。
 */

import { renderSessionList } from "./session-list.js";
import { renderError } from "./state-views.js";
import {
  DEFAULT_SESSION_SORT_KEY,
  DEFAULT_SESSION_SORT_ORDER,
  DEFAULT_SESSION_RANGE,
} from "../data-source.js";

/**
 * sessions 缓存键：sort/order/directory/range 四维组合（后端缓存键
 * sessions:[limit,offset,sort,order,directory,range] 的前端对应）。
 * directory 为 null（无过滤）时以空串占位，与 "" 按后端契约同为
 * 「不过滤」——两端对空串的语义一致，键也归一；range 同理（""=全部）。
 */
function sessionSortCacheKey(sortKey, sortOrder, directory, range) {
  return `${sortKey}:${sortOrder}:${encodeURIComponent(directory ?? "")}:${range ?? ""}`;
}

/**
 * 创建会话列表排序控制器。
 *
 * 依赖注入（app.js 装配，测试替身可换）：
 * - containerElement：会话列表容器（app.js 的 #session-list）
 * - fetchSessionsPage(sortKey, sortOrder, directory, range) → Promise<sessionPayload>：
 *   单页请求闭包，limit/offset 由装配方钉死（见头部 N-2 注释）
 * - getModelFilter() → string | null：模型下钻过滤（app 状态，只读访问器）
 * - markSectionSucceeded() / markSectionFailed()：顶栏失败计数回调
 *
 * 返回：
 * - load()：初始加载/错误重试入口
 * - changeSort(sortKey, sortOrder)：列头点击与重置入口共用的排序切换
 *   （directory/range 维持当前值，三组过滤正交可叠加）
 * - changeDirectory(directory | null)：目录下钻/取消（sort/range 维持
 *   当前值）；点击同一目录重复传入时由调用方先做 toggle 归 null
 * - changeRange(range)：时间范围切换（sort/directory 维持当前值）
 * - renderCurrent()：用当前 sort/directory/range/filter 渲染（缺缓存 →
 *   加载骨架；模型下钻过滤变化后调用）
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
  const viewState = {
    key: DEFAULT_SESSION_SORT_KEY,
    order: DEFAULT_SESSION_SORT_ORDER,
    directory: null,
    range: DEFAULT_SESSION_RANGE,
    cache: new Map(),
  };
  let loadSequence = 0;

  function renderCurrent() {
    const cachedSessionPayload =
      viewState.cache.get(sessionSortCacheKey(viewState.key, viewState.order, viewState.directory, viewState.range)) ?? null;
    renderSessionList(
      containerElement,
      cachedSessionPayload,
      getModelFilter(),
      viewState.key,
      viewState.order,
      changeSort,
      viewState.directory,
      viewState.range,
      changeRange,
    );
  }

  function renderCurrentIfLoaded() {
    if (!viewState.cache.has(sessionSortCacheKey(viewState.key, viewState.order, viewState.directory, viewState.range))) return;
    renderCurrent();
  }

  /**
   * 序列守卫（同 app.js loadTrendSection 的模式）：慢响应晚到不得覆盖
   * 当前视图——缓存仍按它自己的 (sort, order, directory, range) 快照
   * 入库（晚到不浪费），但只有「最新一次请求 且 仍针对当前四维组合」
   * 的结果才允许落 DOM / 记成功。四维快照独立于 token：缓存命中路径
   * 不发请求也不递增 token，只有快照比对能弹掉这类"token 仍新但视图
   * 已切走"的晚到者。
   */
  async function load() {
    const requestToken = ++loadSequence;
    const requestSortKey = viewState.key;
    const requestSortOrder = viewState.order;
    const requestDirectory = viewState.directory;
    const requestRange = viewState.range;
    try {
      const sessionPayload = await fetchSessionsPage(requestSortKey, requestSortOrder, requestDirectory, requestRange);
      viewState.cache.set(
        sessionSortCacheKey(requestSortKey, requestSortOrder, requestDirectory, requestRange),
        sessionPayload,
      );
      if (requestToken !== loadSequence
        || requestSortKey !== viewState.key
        || requestSortOrder !== viewState.order
        || requestDirectory !== viewState.directory
        || requestRange !== viewState.range) return;
      renderCurrent();
      markSectionSucceeded();
    } catch (error) {
      if (requestToken !== loadSequence
        || requestSortKey !== viewState.key
        || requestSortOrder !== viewState.order
        || requestDirectory !== viewState.directory
        || requestRange !== viewState.range) return;
      renderError(containerElement, error, load);
      markSectionFailed();
    }
  }

  /** 组合未取过时：先上骨架（不闪旧组合的数据）再发请求。 */
  function applyNextView(nextSortKey, nextSortOrder, nextDirectory, nextRange) {
    viewState.key = nextSortKey;
    viewState.order = nextSortOrder;
    viewState.directory = nextDirectory;
    viewState.range = nextRange;
    if (viewState.cache.has(sessionSortCacheKey(nextSortKey, nextSortOrder, nextDirectory, nextRange))) {
      renderCurrent();
    } else {
      renderSessionList(containerElement, null);
      load();
    }
  }

  /** 排序切换（列头点击/重置共用）：directory/range 维持当前值。 */
  function changeSort(nextSortKey, nextSortOrder) {
    if (viewState.key === nextSortKey && viewState.order === nextSortOrder) return;
    applyNextView(nextSortKey, nextSortOrder, viewState.directory, viewState.range);
  }

  /** 目录下钻/取消：sort/range 维持当前值。 */
  function changeDirectory(nextDirectory) {
    if (viewState.directory === nextDirectory) return;
    applyNextView(viewState.key, viewState.order, nextDirectory, viewState.range);
  }

  /** 时间范围切换（v0.9.0）：sort/directory 维持当前值。 */
  function changeRange(nextRange) {
    if (viewState.range === nextRange) return;
    applyNextView(viewState.key, viewState.order, viewState.directory, nextRange);
  }

  return { load, changeSort, changeDirectory, changeRange, renderCurrent, renderCurrentIfLoaded };
}

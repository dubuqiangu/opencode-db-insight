/**
 * 会话列表排序控制器（P2-2，v0.5.1 从 app.js 抽出）：持有 sort/order/
 * directory/range 状态、Map 缓存、请求序列守卫，把 session-list 的
 * 列头/重置/范围回调与目录下钻转成带 ?sort=/?order=/?directory=/?range=
 * 的 API 请求。app.js 只装配（注入 fetchSessionsPage 等依赖），本模块不
 * 感知全局 state——竞态行为由 test/web-components.test.ts 的控制器竞态
 * 测试锁住：晚到响应不落 DOM（token + 四维快照双保险）、切换任一维度
 * 弹掉旧请求、同组合重叠请求早 token 弃渲染。
 *
 * v0.7.0 扩维：目录→会话下钻过滤。directory 是服务端参数（与模型
 * 客户端行过滤正交），入控制器受控状态。
 * v0.9.0 扩维：时间范围（?range=7d|30d|90d，timeUpdated 口径）同模式
 * 入控制器受控状态——单一真源在此，app/session-list 不另存副本。
 *
 * 缓存语义（v0.9.1，ora-5 审查 P2 修复）＝**稳定维度缓存 + 时间窗视图
 * 直取**：sort/order/directory 是稳定量——同键永远同义，可缓存；range
 * 非空是唯一随墙钟移动的维度，09:00 的「最近 7 天」与 18:00 的「最近
 * 7 天」是两个集合，「同键」不再蕴含「同义」。因此：
 * - 非空 range 的视图一律绕过缓存**读与写**——进入即重新请求，成功也
 *   不落缓存（Map 只服务稳定维度，避免无意义积压）；
 * - 判定按「当前视图是否含时间窗」而非「哪个动作触发」：range 视图下
 *   切排序/切目录/换模型过滤同样直取，绕过任何一个入口都会留下陈旧
 *   窗口的侧门；
 * - 空串 range（「全部」）是稳定量，完整享受缓存命中。
 * 已知代价：时间窗视图在主题切换时不重取配色（renderCurrentIfLoaded
 * 只对缓存视图生效），待该视图下次数据交互自然刷新——低频可忽略。
 * 处方不引入时间戳/TTL 记账：range 切换是低频显式动作，重取代价远低于
 * 整类时间一致性问题的记账复杂度。
 *
 * 缓存键 = `sort:order:directory:range`。注入性（键可逆、组合无碰撞）：
 * sort/order/range 取值来自固定词表（不含冒号），directory 做 URL 编码
 * 入键——路径里的 ":"（盘符 D:/）编码后不再产生分段歧义，任意两组合
 * 映射到不同键。非空 range 条目永不写入，其键段只参与判别。
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
 * 只有 range 为空串的条目会被写入（见模块头缓存语义）。
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
 * - renderCurrent()：保证当前视图有内容可渲——稳定视图（空 range）读
 *   缓存（未入缓存渲骨架）；时间窗视图（非空 range）无缓存可依，骨架
 *   + 直取。模型下钻过滤变化后调用（过滤是客户端的，但数据源仍按
 *   视图属性决定直取与否）。
 * - renderCurrentIfLoaded()：仅在缓存持有当前组合时渲染（主题切换后
 *   重读配色调用）。时间窗视图从不入缓存，故对它恒为 no-op——见模块
 *   头「已知代价」。
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

  /** 用当前视图状态渲染给定 payload（null = 骨架）。 */
  function renderSessionPage(sessionPayload) {
    renderSessionList(
      containerElement,
      sessionPayload,
      getModelFilter(),
      viewState.key,
      viewState.order,
      changeSort,
      viewState.directory,
      viewState.range,
      changeRange,
    );
  }

  function renderCurrent() {
    if (viewState.range === "") {
      // 稳定视图：缓存即真相（未入缓存 → 骨架，由触发加载的路径补请求）
      renderSessionPage(
        viewState.cache.get(sessionSortCacheKey(viewState.key, viewState.order, viewState.directory, "")) ?? null,
      );
      return;
    }
    // 时间窗视图：缓存从不持有它——直取。判定看视图不看动作，模型
    // 过滤等调用方走到这里同样重新请求。
    renderSessionPage(null);
    load();
  }

  function renderCurrentIfLoaded() {
    if (viewState.range !== "") return; // 时间窗视图不入缓存，恒 no-op（见模块头已知代价）
    if (!viewState.cache.has(sessionSortCacheKey(viewState.key, viewState.order, viewState.directory, ""))) return;
    renderCurrent();
  }

  /**
   * 序列守卫（同 app.js loadTrendSection 的模式）：慢响应晚到不得覆盖
   * 当前视图——只有「最新一次请求 且 仍针对当前四维组合」的结果才允许
   * 落 DOM / 记成功。四维快照独立于 token：缓存命中路径不发请求也不递
   * 增 token，只有快照比对能弹掉这类"token 仍新但视图已切走"的晚到者。
   * 成功后直渲刚取到的 payload（不经 renderCurrent：时间窗视图无缓存
   * 可读，绕经它会在渲染前再发一次请求）。
   */
  async function load() {
    const requestToken = ++loadSequence;
    const requestSortKey = viewState.key;
    const requestSortOrder = viewState.order;
    const requestDirectory = viewState.directory;
    const requestRange = viewState.range;
    try {
      const sessionPayload = await fetchSessionsPage(requestSortKey, requestSortOrder, requestDirectory, requestRange);
      // 时间窗条目不写缓存：同键不蕴含同义（墙钟移动），Map 只服务稳定维度。
      if (requestRange === "") {
        viewState.cache.set(
          sessionSortCacheKey(requestSortKey, requestSortOrder, requestDirectory, ""),
          sessionPayload,
        );
      }
      if (requestToken !== loadSequence
        || requestSortKey !== viewState.key
        || requestSortOrder !== viewState.order
        || requestDirectory !== viewState.directory
        || requestRange !== viewState.range) return;
      renderSessionPage(sessionPayload);
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

  /**
   * 切换视图：稳定视图（空 range）且组合已入缓存 → 直接渲缓存；其余
   * （首次未见过的稳定组合，或一切含时间窗的视图）→ 先上骨架（不闪
   * 旧组合的数据）再请求。
   */
  function applyNextView(nextSortKey, nextSortOrder, nextDirectory, nextRange) {
    viewState.key = nextSortKey;
    viewState.order = nextSortOrder;
    viewState.directory = nextDirectory;
    viewState.range = nextRange;
    if (nextRange === ""
      && viewState.cache.has(sessionSortCacheKey(nextSortKey, nextSortOrder, nextDirectory, ""))) {
      renderCurrent();
    } else {
      renderSessionPage(null);
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

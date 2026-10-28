/**
 * 会话列表排序控制器（P2-2，v0.5.1 从 app.js 抽出）：持有 sort/order/
 * directory/range/day 状态、Map 缓存、请求序列守卫，把 session-list 的
 * 列头/重置/范围回调与目录下钻、日历日下钻转成带 ?sort=/?order=/
 * ?directory=/?range=/?day= 的 API 请求。app.js 只装配（注入
 * fetchSessionsPage 等依赖），本模块不感知全局 state——竞态行为由
 * test/web-components.test.ts 的控制器竞态测试锁住：晚到响应不落 DOM
 * （token + 快照双保险）、切换任一维度弹掉旧请求、同组合重叠请求早
 * token 弃渲染。
 *
 * v0.7.0 扩维：目录→会话下钻过滤。directory 是服务端参数（与模型
 * 客户端行过滤正交），入控制器受控状态。
 * v0.9.0 扩维：时间范围（?range=7d|30d|90d，timeUpdated 口径）同模式
 * 入控制器受控状态——单一真源在此，app/session-list 不另存副本。
 *
 * Milestone A 扩维：日历日（?day=YYYY-MM-DD）同模式入受控状态——热力图
 * 点某日 → 会话列表按该日过滤（服务端精确匹配 timeUpdated 所在本地日），
 * 与 directory/range 三者 AND 叠加。
 *
 * v0.20.0 扩维：会话作用域（changeSessionScope）——缓存键追加 scope
 * 段（见 sessionSortCacheKey），作用域载荷与全量载荷绝不共享条目；
 * 作用域视图锁定为单会话行（排序/范围交互不挂），取数来源由注入的
 * fetchSessionsPage 闭包按 scope 参数决定。
 *
 * 缓存语义（v0.9.1，ora-5 审查 P2 修复）＝**稳定维度缓存 + 时间窗视图
 * 直取**：sort/order/directory/day 是稳定量——同键永远同义，可缓存；
 * range 非空是唯一随墙钟移动的维度，09:00 的「最近 7 天」与 18:00 的
 * 「最近 7 天」是两个集合，「同键」不再蕴含「同义」。因此：
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
 * 缓存键 = `sort:order:directory:range:day:sessionScope`。注入性（键可逆、
 * 组合无碰撞）：sort/order/range 取值来自固定词表（不含冒号），directory
 * 与 day、sessionScope 做 URL 编码入键——路径里的 ":"（盘符 D:/）编码后
 * 不再产生分段歧义，任意两组合映射到不同键。非空 range 条目永不写入，
 * 其键段只参与判别。
 *
 * 缓存键假设（N-2 钉住）：今天 fetchSessionsPage 闭包内 limit/offset
 * 为常量单页（app.js 的 SESSION_LIST_PAGE_LIMIT / 0），现有键足够区分
 * 条目。若将来分页参数化（limit/offset 可变），键必须扩为
 * `limit:offset:sort:order:directory:range:day`，否则不同页会共享同一条目。
 * 缓存用 Map 而非普通对象：键永远来自本模块写入的组合值，Map 顺带杜绝
 * 原型链键的查表歧义。
 */

import { renderSessionList } from "./session-list.js";
import { renderError } from "./state-views.js";
import {
  DEFAULT_SESSION_SORT_KEY,
  DEFAULT_SESSION_SORT_ORDER,
  DEFAULT_SESSION_RANGE,
  SessionScopeNotFoundError,
} from "../data-source.js";

/**
 * sessions 缓存键：sort/order/directory/range/day/sessionScope 六维组合
 * （后端缓存键 sessions:[limit,offset,sort,order,directory,range] 的前端
 * 对应；v0.20.0 scope 段与后端 ?session= 聚合缓存键的 session 维度同一
 * 分离纪律——不同作用域的载荷绝不能共享条目，否则退出作用域会吃到
 * 单会话口径的陈旧缓存）。directory 为 null（无过滤）时以空串占位，
 * 与 "" 按后端契约同为「不过滤」——两端对空串的语义一致，键也归一；
 * range / day / sessionScope 同理（""/null = 全部）。只有 range 为空串
 * 的条目会被写入（见模块头缓存语义）。
 */
function sessionSortCacheKey(sortKey, sortOrder, directory, range, day, sessionScopeId) {
  return `${sortKey}:${sortOrder}:${encodeURIComponent(directory ?? "")}:${range ?? ""}:${encodeURIComponent(day ?? "")}:${encodeURIComponent(sessionScopeId ?? "")}`;
}

/**
 * 创建会话列表排序控制器。
 *
 * 依赖注入（app.js 装配，测试替身可换）：
 * - containerElement：会话列表容器（app.js 的 #session-list）
 * - fetchSessionsPage(sortKey, sortOrder, directory, range, day, sessionScopeId)
 *   → Promise<sessionPayload>：单页请求闭包，limit/offset 由装配方钉死
 *   （见头部 N-2 注释）；sessionScopeId 非 null 时由闭包决定取数来源
 *   （作用域视图 = 单会话载荷，不走 ?sort= 分页请求）
 * - getModelFilter() → string | null：模型下钻过滤（app 状态，只读访问器）
 * - onSessionScopeChange(sessionId, sessionTitle)：行内「只看此会话」
 *   按钮回调（透传给 session-list 渲染），null 时不渲染按钮
 * - onSessionScopeVanished()：作用域请求撞上 SessionScopeNotFoundError
 *   （会话已删）时的上抛口——app 层据此自动退出作用域；本模块不感知
 *   全局 state，默认 no-op
 * - markSectionSucceeded() / markSectionFailed()：顶栏失败计数回调
 *
 * 返回：
 * - load()：初始加载/错误重试入口
 * - changeSort(sortKey, sortOrder)：列头点击与重置入口共用的排序切换
 *   （directory/range 维持当前值，三组过滤正交可叠加）
 * - changeDirectory(directory | null)：目录下钻/取消（sort/range 维持
 *   当前值）；点击同一目录重复传入时由调用方先做 toggle 归 null
 * - changeRange(range)：时间范围切换（sort/directory 维持当前值）
 * - changeSessionScope(sessionScopeId | null)（v0.20.0）：作用域进入/
 *   退出（sort/order/directory/range 维持当前值）；缓存键带 scope 段，
 *   两个作用域的条目互不污染。作用域激活期间视图锁定：列表只显示该
 *   会话自身一行，排序/范围交互不挂
 * - renderCurrent()：保证当前视图有内容可渲——稳定视图（空 range）读
 *   缓存；缓存 miss（v0.19.1 起）与时间窗视图同形状：骨架 + 直取，
 *   不再留一副等触发方补请求的裸骨架。模型下钻过滤变化后调用（过滤
 *   是客户端的，但数据源仍按视图属性决定直取与否）。
 * - renderCurrentIfLoaded()：仅在缓存持有当前组合时渲染（主题切换后
 *   重读配色调用）。时间窗视图从不入缓存，故对它恒为 no-op——见模块
 *   头「已知代价」。
 * - refreshCurrentView()：后台定时刷新入口（app.js 的 refreshAllSections
 *   调用）——对当前视图直接重取，不再先删缓存条目（v0.19.1 P2-2：
 *   失败不赔缓存，成功由 load() 自然写回）。只动当前组合，其他组合
 *   缓存保留（切回去仍即时命中）。
 */
export function createSessionSortController({
  containerElement,
  fetchSessionsPage,
  getModelFilter,
  onSessionScopeChange = null,
  onSessionScopeVanished = () => {},
  markSectionSucceeded = () => {},
  markSectionFailed = () => {},
}) {
  const viewState = {
    key: DEFAULT_SESSION_SORT_KEY,
    order: DEFAULT_SESSION_SORT_ORDER,
    directory: null,
    range: DEFAULT_SESSION_RANGE,
    // Milestone A 日历日下钻：YYYY-MM-DD 或 null（不过滤）。入缓存键
    // （见 sessionSortCacheKey），与 directory/range 同为服务端过滤维度，
    // AND 叠加。
    day: null,
    // v0.20.0 会话作用域：null = 全部会话。入缓存键（见
    // sessionSortCacheKey），不与无作用域条目混存。
    sessionScope: null,
    cache: new Map(),
  };
  let loadSequence = 0;

  /** 用当前视图状态渲染给定 payload（null = 骨架）。
   * 作用域锁定视图（sessionScope 非 null）：排序/范围回调挂 null
   * （session-list 据此不渲染交互件），目录/范围展示值也归空——
   * 单会话载荷与这些服务端过滤维度口径错位，显示出来只会误导。 */
  function renderSessionPage(sessionPayload) {
    const isScopeLocked = viewState.sessionScope !== null;
    renderSessionList(
      containerElement,
      sessionPayload,
      getModelFilter(),
      viewState.key,
      viewState.order,
      isScopeLocked ? null : changeSort,
      isScopeLocked ? null : viewState.directory,
      isScopeLocked ? "" : viewState.range,
      isScopeLocked ? null : changeRange,
      {
        sessionScopeId: viewState.sessionScope,
        onSessionScopeChange,
      },
      isScopeLocked ? null : viewState.day,
      isScopeLocked ? null : changeDay,
    );
  }

  function renderCurrent() {
    if (viewState.range === "") {
      const cachedSessionPayload = viewState.cache.get(
        sessionSortCacheKey(viewState.key, viewState.order, viewState.directory, "", viewState.day, viewState.sessionScope),
      );
      if (cachedSessionPayload !== undefined) {
        // 稳定视图：缓存即真相，命中直渲。
        renderSessionPage(cachedSessionPayload);
        return;
      }
      // P2-3（v0.19.1）：缓存 miss（典型：load() 失败后缓存仍空）不再
      // 只落骨架等触发方补请求——与时间窗分支同形状：骨架 + 直取，
      // 否则模型过滤等入口会在失败后留下一副永不恢复的骨架。
      renderSessionPage(null);
      load();
      return;
    }
    // 时间窗视图：缓存从不持有它——直取。判定看视图不看动作，模型
    // 过滤等调用方走到这里同样重新请求。
    renderSessionPage(null);
    load();
  }

  function renderCurrentIfLoaded() {
    if (viewState.range !== "") return; // 时间窗视图不入缓存，恒 no-op（见模块头已知代价）
    if (!viewState.cache.has(sessionSortCacheKey(viewState.key, viewState.order, viewState.directory, "", viewState.day, viewState.sessionScope))) return;
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
    const requestDay = viewState.day;
    const requestSessionScope = viewState.sessionScope;
    try {
      const sessionPayload = await fetchSessionsPage(
        requestSortKey,
        requestSortOrder,
        requestDirectory,
        requestRange,
        requestDay,
        requestSessionScope,
      );
      // 时间窗条目不写缓存：同键不蕴含同义（墙钟移动），Map 只服务稳定维度。
      if (requestRange === "") {
        viewState.cache.set(
          sessionSortCacheKey(requestSortKey, requestSortOrder, requestDirectory, "", requestDay, requestSessionScope),
          sessionPayload,
        );
      }
      if (requestToken !== loadSequence
        || requestSortKey !== viewState.key
        || requestSortOrder !== viewState.order
        || requestDirectory !== viewState.directory
        || requestRange !== viewState.range
        || requestDay !== viewState.day
        || requestSessionScope !== viewState.sessionScope) return;
      renderSessionPage(sessionPayload);
      markSectionSucceeded();
    } catch (error) {
      // v0.20.0：作用域会话已删（SessionScopeNotFoundError）不落错误卡——
      // 上抛给 app 层自动退出作用域并轻提示，本视图随退出后的全量重载
      // 自然恢复。晚到的（快照已过期）作用域错误同样上抛：退出动作在
      // app 层有「已退出则忽略」守卫，多路并发 404 不会重复退。
      if (error instanceof SessionScopeNotFoundError) {
        onSessionScopeVanished();
        return;
      }
      if (requestToken !== loadSequence
        || requestSortKey !== viewState.key
        || requestSortOrder !== viewState.order
        || requestDirectory !== viewState.directory
        || requestRange !== viewState.range
        || requestDay !== viewState.day
        || requestSessionScope !== viewState.sessionScope) return;
      renderError(containerElement, error, load);
      markSectionFailed();
    }
  }

  /**
   * 切换视图：稳定视图（空 range）且组合已入缓存 → 直接渲缓存；其余
   * （首次未见过的稳定组合，或一切含时间窗的视图）→ 先上骨架（不闪
   * 旧组合的数据）再请求。
   */
  function applyNextView(nextSortKey, nextSortOrder, nextDirectory, nextRange, nextDay) {
    viewState.key = nextSortKey;
    viewState.order = nextSortOrder;
    viewState.directory = nextDirectory;
    viewState.range = nextRange;
    viewState.day = nextDay;
    if (nextRange === ""
      && viewState.cache.has(sessionSortCacheKey(nextSortKey, nextSortOrder, nextDirectory, "", nextDay, viewState.sessionScope))) {
      renderCurrent();
      // R1：缓存命中同样记成功——此前视图的加载失败计数不得残留顶栏
      //（renderCurrent 纯渲染不碰计数，网络成功路径在 load() 里已记）。
      markSectionSucceeded();
    } else {
      renderSessionPage(null);
      load();
    }
  }

  /** 排序切换（列头点击/重置共用）：directory/range/day 维持当前值。 */
  function changeSort(nextSortKey, nextSortOrder) {
    if (viewState.key === nextSortKey && viewState.order === nextSortOrder) return;
    applyNextView(nextSortKey, nextSortOrder, viewState.directory, viewState.range, viewState.day);
  }

  /** 目录下钻/取消：sort/range/day 维持当前值。 */
  function changeDirectory(nextDirectory) {
    if (viewState.directory === nextDirectory) return;
    applyNextView(viewState.key, viewState.order, nextDirectory, viewState.range, viewState.day);
  }

  /** 时间范围切换（v0.9.0）：sort/directory/day 维持当前值。 */
  function changeRange(nextRange) {
    if (viewState.range === nextRange) return;
    applyNextView(viewState.key, viewState.order, viewState.directory, nextRange, viewState.day);
  }

  /**
   * 日历日下钻/取消（Milestone A）：点热力图某日 → 会话列表按该日过滤
   * （服务端 ?day=YYYY-MM-DD 精确匹配 timeUpdated 所在日历日），sort/
   * directory/range 维持当前值。toggle 语义由调用方先做（点同一日 → null）。
   */
  function changeDay(nextDay) {
    if (viewState.day === nextDay) return;
    applyNextView(viewState.key, viewState.order, viewState.directory, viewState.range, nextDay);
  }

  /**
   * 作用域进入/退出（v0.20.0）：sort/order/directory/range 维持当前值。
   * 缓存键带 scope 段——同一组合在两个作用域下是两个条目，切回旧作用
   * 域仍即时命中；无作用域条目绝不会被作用域载荷污染。
   */
  function changeSessionScope(nextSessionScopeId) {
    if (viewState.sessionScope === nextSessionScopeId) return;
    viewState.sessionScope = nextSessionScopeId;
    applyNextView(viewState.key, viewState.order, viewState.directory, viewState.range, viewState.day);
  }

  /**
   * 后台定时刷新（v0.18.x）：对当前视图直接重取。时间窗视图（非空
   * range）从不入缓存，load() 即是重取；稳定视图也不再先删条目
   * （v0.19.1 ora-11 P2-2：delete 是纯负资产——load 失败会把整页
   * 好数据赔成错误态，缓存也随之变空；成功路径 load 本身就会写回
   * 缓存，删除步骤没有任何收益）。不做全量 cache.clear()：其他组合
   * 的条目与本视图无关，保留它们让用户切回时仍即时命中。
   */
  function refreshCurrentView() {
    load();
  }

  return {
    load,
    changeSort,
    changeDirectory,
    changeRange,
    changeDay,
    changeSessionScope,
    renderCurrent,
    renderCurrentIfLoaded,
    refreshCurrentView,
  };
}

# Changelog

本项目的所有显著变更记录在此文件中。
格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [SemVer](https://semver.org/lang/zh-CN/)。
每个里程碑完成后 push 并在此追加一条记录，方便回溯。

## [Unreleased]

### Added
- **回放页大内容截断保护**（v0.24.x）：回放页的 reasoning 正文**默认展开**且原先没有上限，实测本机库最大 reasoning part **150,908 字符、18 个超 100k**——这是唯一真正超限的渲染面，一进页面就吃这份布局成本。现 `REASONING_DISPLAY_MAX_CHARS = 100_000`，截断在码元边界（不留孤立高位代理），标题行补字符总数、块尾一行琥珀小字说明「仅显示前 N 字符，完整思考过程共 M 字符」。
  - **搜索侧仍扫全文**（与工具输出有意不同）：reasoning 默认展开，命中后第一眼就能看到所在段落；工具块默认折叠，若搜索越过截断就会「搜得到却看不见」。两个方向都由测试分别锁死。
  - 工具输出同样加上 `TOOL_OUTPUT_DISPLAY_MAX_CHARS = 200_000` 的保护（实测最大 131,821，未触发，属前瞻性护栏而非当前痛点）。
  - 与导出 Markdown 的 `TOOL_OUTPUT_CHARACTER_LIMIT = 4000` 有意不同（交互浏览宽、文档窄），因此提示里**不**引导用户「导出看全文」——导出只会更短。

- **回放页消息级深链**（`src/web/public/components/replay-deep-link.js`，新增）：`#/session/<id>?msg=<messageID>` 可直接定位到某一条消息。
  - `id → 可见下标` 复用 `isVisibleReplayMessageType` 过滤后的顺序，与 `renderTimeline` / `buildReplaySearchIndex` 同一口径（算错一档就会定位到隔壁消息）。
  - 目标在 200 条分页区之外时，连续 `appendNextChunk()` 直到渲染到它，再 `scrollIntoView`——与 `replay-search.js` 的导航路径同语义。
  - 落点高亮用独立的 `.replay-deep-link-target`（`replay.css`），与搜索的 `.replay-hit-current` 互不清除；2s 后自动消隐。
  - 未知 id / 空 id 静默 `notFound`，不滚动、不抛错——深链坏了不该让整个回放页失败。
  - 每个时间线节点（含 `system` / `model-switched` / `compaction` 通知行与空文本 user 占位）都带 `data-message-id` 与 `id="msg-<messageID>"`，给深链与外部锚点一个稳定落点。

### Fixed
- **会话路由正则吞掉查询串**：`app.js` 的 `routeByHash` 原用 `/^#\/session\/(.+)$/`，`ses_x?msg=msg_y` 会被整段当作会话 id 去查库，直接误报「旧表会话」。改为 `([^?]+)(\?.*)?`，会话段在 `?` 处截止。
- **侧栏 Todos 块：整块隐藏未生效**（v0.23.0 引入，未发布即修）。`buildSessionTodoView` 返回 `null` 时只隐藏了列表，标题行 `▼ Todos` 仍常驻 —— 与「全部完成后整块消失」的验收口径不符。现在标题行也由 `todoPage() === null` 门控，在函数子节点内保持响应式。
- **侧栏 Todos 块：侧栏窄于标签预算时仍会换行**。`<text>` 默认 `wrapMode: "word"`，44 列的标签在更窄的侧栏里会折成两行、把状态图标挤下去，正是截断要防的症状。内容单元格改为 `wrapMode="none"`，由 `clipToColumns` 负责宽度预算。
- **侧栏 Todos 块的三个逻辑缺陷**（v0.23.0 引入，未发布即修）：
  - 折叠点击改用 `onMouseUp`（与官方 `sidebar-metrics.tsx` 一致）；`onMouseDown` 在部分终端会先触发文本选区，导致折叠/展开时灵时不灵。
  - 删掉手动 `renderer.requestRender()`：官方侧栏插件从不主动重绘，依赖 1s tick；在 handler 里戳渲染器会让折叠瞬间闪一下。
  - 页码复位从「在 `createMemo` 里写 signal」改为 `createEffect` + 记录上一个 sessionId：原写法每次重跑都把页码打回 0，翻页实际翻不动。
  - 分页箭头回调改为基于本次渲染的页码快照并先判边界，避免越界写入后再被 clamp。
- **`npm run check` 的「构建门」是空头支票**：`tsconfig.json` 从未被任何脚本调用，而 `tsc` 对整个仓库有约 300 个既有类型错误（集中在 `test/web-components.test.ts` 等）。现拆分 `check:types`（`tsc --noEmit -p tsconfig.json`）并串进 `check`，同时把 `tsconfig.json` 的 `include` **收窄到本轮新增的 4 个模块**——让门真正通过，而不是红着等被忽略。补齐 `allowImportingTsExtensions`（`noEmit` 下合法）与 `skipLibCheck`。
- **todo 标签按显示列宽截断**（`src/tui/clip-columns.ts`，新增）：侧栏宽度有限，模型写的待办很长时会把状态图标挤出可视区并撑高整块。CJK / emoji 按 2 列计，截断处补 `…`，截断后永不超出预算。5 个用例覆盖 ASCII 原样、CJK 双列、混排不超预算、零预算、常量范围。
- **`<text>` 函数子节点的类型缺口收敛到一处**：`@opentui/solid` 运行时 `insert()` 确实特判函数子节点并包 `createRenderEffect`（`index.js:6523`），但其类型定义只写 `TextChildren | Element`。新增具名辅助 `live()` 集中该断言并注明机制，`sidebar-todo.tsx` 现可进入 `strict` 类型门。
- **注册期的卸载竞态**：`registerSessionTodoSidebar` 增加 `isDisposed` 标志，卸载后 `render` 直接返回 `null`，避免 dispose 与动态 import 竞态下把块挂进已销毁的上下文。

### Changed
- **宽表固定列宽**：`session-list.js`（13 列）、`model-table.js`（11 列）、`agent-table.js`（4 列）的 `<table>` 各自补 `<colgroup>`；`components.css` 的 `.data-table` 改为 `table-layout: fixed`，单元格加 `overflow: hidden; text-overflow: ellipsis`。
  原因：`white-space: nowrap` 配自动布局时，长模型 ID / 长会话标题会挤占数字列，列宽随内容漂移。参考 billion-context `src/web/page.ts` 的 `<colgroup>` 写法。
  每张表的第一列保持无宽度以吃掉剩余空间，避免固定布局下表格不满宽。

## [0.23.0] - 2026-10-19

### Added
- **TUI 右侧栏「Todos」块**：挂在宿主 `sidebar.content` 槽位，实时展示当前会话的 todo。已完成打 ✓、进行中打 ∼、未做打 ·；`in_progress` 恒在首位（多条并行按 `position`）；每页 4 条、底部 `‹ n/m ›` 可点翻页；**没有未完成项时整块消失**，有新 todo 自动出现。标题行整行点击折叠/展开，折叠态经 `context.storage.store` 持久化。
- `src/db/session-todo-queries.ts`：按 `session_id` 只读 `todo` 表（`ORDER BY position ASC`）。
- `src/stats/session-todo.ts`：纯函数视图模型（过滤 / 状态秩排序 / 隐藏规则 / clamp 分页），`SESSION_TODO_PAGE_SIZE = 4`。
- `test/session-todo.test.ts`：9 个用例（排序、未知状态丢弃、隐藏规则、分页边界、字段映射）。

### Changed
- **投递形态按官方 in-repo spec 校正**：`exports["./tui"]` 保持裸 `src/tui.tsx`（官方 `packages/opencode/specs/tui-plugins.md`：TUI 入口取 `exports["./tui"]`、宿主直接 `await import`、无预编译要求）；新增 `tsconfig.json`（`jsxImportSource: "@opentui/solid"`），`src/tui/sidebar-todo.tsx` 首行固定 `/** @jsxImportSource @opentui/solid */`。
- `npm run check` 升级为构建门：TUI 入口改为 `--bundle --platform=node --jsx-import-source=@opentui/solid`，并断言产物引用 `@opentui/solid/jsx-runtime`、不得出现 `react/jsx-runtime`。
- `src/tui.tsx` 用**动态 import + catch** 加载侧栏模块：宿主缺 solid/opentui 运行时或 slot API 不匹配时只丢侧栏块，`/insight` 等命令不受影响。

### Deferred
- **侧栏「提问列表 + 跳转到提问位置」**：数据面可行（`session_message` `type='user'`，已有 `(session_id, type, seq)` 索引），但 V2 插件 API **未暴露消息级定位**（`ui.router.navigate` 仅到会话粒度，无 scroll/reveal/focus），故缓办。详见 DESIGN.md §13 与该条的再触发条件。

（暂无——下一批变更记录于此）

## [0.22.0] - 2026-10-19 · B 档指标：工具错误率逐日趋势 + 失败中断识别

> 用户勾选 B 档两项：① 工具错误率逐日时序 ② 失败中断会话识别（🟡 推断口径）。均沿用既有「全部会话」口径；错误率时序为**直读** wire（🟢），失败中断为**推断**（🟡），页脚图例与之自洽。

### Added

- **工具错误率趋势卡**：新端点 `GET /api/tool-error-trend?days=<n>`（缺省 30、clamp 1..366）——按本地日分桶的 `{date, toolCalls, errors, errorRate}`；抽取与 `/api/tool-health` 收敛到共享模块 `src/db/tool-part-extraction.ts`（路径列表 / `name` 胜 `tool` 回退 / 空名丢弃 / 非字符串 → `"unknown"` / fast-path 上限 8，单点定义），跨路由 Σ `toolCalls` / Σ `errors` **恒等**并由守恒测试锁定。真库实测 56277 calls / 5870 errors，与 tool-health 完全相等。
- **会话失败与中断卡**：新端点 `GET /api/session-outcomes`（**复数**）——`{totalSessions, sessionsWithSteps, interruptedSessions, interruptedShare, byErrorType[], recentInterrupted[]}`；口径 = 会话**最后一条 assistant 对象消息**（`PARTITION BY session_id ORDER BY seq DESC` 取 rn=1）携带 `$.error` 即「以错误收尾」；`byErrorType` 为**会话级终局**错误类型（Σ count == `interruptedSessions`），`recentInterrupted` limit 5 按 `time_updated` 降序。真库实测 197/804 = 24.50%，byErrorType = aborted 84 / provider.error 49 / provider.auth 26 / unknown 15 / provider.transport 12 / provider.quota 8 / provider.internal 3。
- **`buildLocalDateKeys(days)`**：从 `daily-buckets.ts` 导出本地日键生成器，`tool-error-trend` 与既有逐日 trend 共用（此前是两份逐字拷贝）。

### Changed

- **工具类端点会话锚定统一**：`/api/tool-health` 与 `/api/tool-error-trend` 的 `session_message` 扫描**无条件锚定 `session_v2`**（排除孤儿消息），与 v0.21.0 三个分布及 `session-outcomes` 同锚；真库孤儿为 0，锚定前后数字完全相等。
- **`sessionsWithSteps` 口径统一**：`/api/session-outcomes` 的「有步骤的会话」改为与步数分布**同一集合**（`type='assistant'` 锚定 `session_v2` 去重计数），两张卡的「有步骤的会话」不再各说各话（parity 测试锁定）。
- **api.ts 缓存键收敛**：trend / hour-heatmap / directories / tool-error-trend 四处「parse days + clamp + 入键」三连收敛为 `boundedIntParamKey(...)`，既有缓存键字节不变（测试逐字节锁定）。
- **页脚精度图例扩档**：`🟡` 从「由 token 换算」扩为「推断/估算」；工具错误率趋势面板由误标的 🟡 改为不标记（实值），会话失败与中断面板保留 🟡 推断。

### Removed

- `SessionOutcomeStats.cleanSessions`：可由 `sessionsWithSteps - interruptedSessions` 派生且无 UI 消费，前端契约同步清理。
- `RECENT_INTERRUPTED_LIMIT` 8 → 5（对齐卡片显示上限，不再白传丢弃）。

### Fixed

- 工具错误率趋势卡范围芯片：「请求在途时点回上一窗口」不再被渲染闭包守卫吞掉；缓存未命中时工具栏选中态即时重绘。
- 错误率折线折叠开关改为模块级保活（原先每次重渲复位）。
- `data-source` 的 `USE_MOCK` 分支补 `getMockToolErrorTrend` / `getMockSessionOutcomes` 缝（离线预览不再永远空态）。

### Review

- 双 oracle 只读审视（数据/后端层 + 前端/生命周期层）**无 P0**；P1/P2 已在收口轮全部落地。回归 **521/521** + `npm run check` 0 + `git diff --check` 0；真库端到端独立复核一致（守恒 56277/5870、步数会话 804/804、中断 197/197、byType Σ 197）。

## [0.21.0] - 2026-10-18 · A 档指标：子代理开销占比 + 步数分布 + 墙钟时长

> 用户勾选 A 档三项：① 子代理开销占比卡 ② 步数分布直方图 ③ 墙钟时长（列表列 + 时长分布卡）。均沿用既有「全部会话」口径与对数半档分布语言，不引入估算口径（`time_compacting` 全 0 / `time_suspended` 仅 5 → 「活跃时长」无从精确，故只做墙钟）。

### Added

- **子代理开销占比卡**：新端点 `/api/child-share`——整体归总（子会话数 / 根会话数 / 子代与根 tokens / `childShare`）+ 直接子代消耗 TOP5 父会话清单（`topChildTrees`，仅汇总各父会话的直接子代，不含孙代）；占比卡为双段条 + 大号百分比 + top5 明细（真库 45.6% 子代占比、单父最多 148 直接子代）。
- **步数分布卡**：新端点 `/api/step-distribution`——每会话 assistant 消息数分布（对数半档桶 + p50/p90/p99 + 均值 / 最大值），复用 token 分布的对数桶语言；口径锚定 `session_v2`（排除孤儿消息，与 token / 时长分布同锚）。
- **墙钟时长**：会话列表新列「墙钟」（`time_updated - time_created`，无正时长显示「—」）+ 时长分布卡（新端点 `/api/duration-distribution`，毫秒分桶，前端 `formatDurationMs` 呈现）。
- **`formatDurationMs(ms)`**：紧凑时长格式化（`823ms` / `37s` / `3m 20s` / `2h 15m` / `3d 3h`）；与既有秒语义 `formatDuration` 并存不冲突。

### Changed

- 分布卡渲染器泛化为共享内部渲染器 `renderSharedDistributionCard(container, distribution, options)`（token / 步数 / 时长三卡共用一个对数桶渲染器，`formatAxis` / `formatMean` / `sampleUnit` / `exclusionLabel` 按卡配置）；`renderDistributionCard(container, distribution)` 仍为 token 卡公开签名。直方图横轴改为**按桶序等宽**呈现（原线性轴会把小值桶挤成一团），并加可横向滚动区 + 屏幕阅读器桶明细表。
- `SessionSummary` 载荷增 `durationMilliseconds`（additive，基础形状，`includeStepModelIds=false` 仍带；旧 wire 缺失降级 undefined）。
- 数值分布纯函数泛化为 `computeNumericDistribution(values)` + `NumericDistributionBucket/Stats`（token 端点保留 `computeSessionTokenDistribution` 薄封装，行为零变化）。

### Fixed

- **作用域切换在途请求竞态**（ora-13 审视 P2）：四个全局面板 loader（token / 步数 / 时长 / 子代理占比）在进入单会话作用域后，先前发出的请求若才返回 / 失败，仍会写回缓存并计入顶栏失败数；改为请求发出时记录作用域版本与请求序号，过期结果不再改写缓存 / DOM / 失败标记。
- **步数分布口径对齐**（ora-13 审视）：步数分布原直接 `GROUP BY session_message.session_id`，未锚定 `session_v2`，理论上会计入「会话已删、消息残留」的孤儿行；改为 `session_id IN (SELECT id FROM session_v2)`，与 token / 时长分布、列表富化同锚（真库孤儿为 0，此约束不改变当前输出）。
- **子代理榜口径文案**（ora-13 审视）：榜单原称「子树」，但数值仅含直接子代；改为「直接子代消耗 TOP5 · 按父会话汇总，不含孙代」，避免被读成整棵子树。
- **分布卡文案与可读性**（des-25 审视）：步数 / 时长卡不再复用 token 卡的「零消耗」措辞（分别按「零步数 / 正时长」表述）；时长卡说明改为「墙钟跨度 = time_updated - time_created」；均值单独格式化到合适精度；窄屏直方图加最小呈现宽度 + 横向滚动。

### Tests

- 466/466 全绿 + check 0；新增三端点 SQL / 载荷正确性（含孤儿消息回归 / 空库零载荷 / 503）、作用域竞态（20 用例）、分布卡共用渲染 / 时长列等测试；orchestrator 另做真库端到端独立核对（三端点数字与裸 SQL 全等、topChildTrees[0] 命中、墙钟字段相符）。

## [0.20.0] - 2026-10-16 · 统计维度「会话」贯穿 + 单会话指标集

> 用户需求两条：① 所有统计指标可增加统计维度 session，之前的全部 session 口径保留；② 可增加有价值、不重复、不啰嗦的新指标。默认仍为「全部会话」口径（逐字节不变），从会话列表可进入单会话模式。

### Added

- **统计维度「会话」**：10 条聚合路由接受可选 `?session=<id>`（overview / trend / models / tool-health / agents / todo / hour-heatmap / session-survival / compaction / directories）；未知 id → 404 `{ error: "session not found" }`（校验在缓存前单点，不污染 60s TTL 缓存；与路径路由措辞刻意区分）；缓存键统一追加 session 维度。
- **单会话模式 UI**：会话列表行内「只看此会话」→ 顶栏作用域 chip（`只看：<title> ✕`）；单会话下 7 个退化面板隐藏（逐日趋势 / 52 周日历 / 时段热力 / Agent 榜 / 目录 / 会话存活 / 分布卡）、7 个保留（KPI / Token 漏斗 / 模型榜 / 工具榜 / 工具健康 / 压缩 / todo，其中 todo 显示该会话自身）；TOC 同步隐藏；scope 会话消失（404）自动退出 + 轻提示，不弹错误卡。
- **会话列表新列**：命中率（严格口径 `cache.read / (input + cache.read + cache.write)`）、Reasoning、步数；旧 wire 缺字段降级为「—」，区分「未记录」与「真 0」。
- **子代理归总**：父会话行显示「+N 直接子会话」（tooltip 含合计 tokens，注明仅直接子代不含孙代），子会话行带层级标记。
- **会话 token 分布卡**：新端点 `/api/session-distribution`（对数半档桶，排除零消耗会话）+ 直方图卡（p50/p90/p99 标线、样本数与均值）。
- **回放页消耗曲线**：逐步累计 output + reasoning 曲线、峰值上下文徽标、本会话总量分位徽标（口径与分布端点一致：入 + 出 + cache.read）。

### Changed

- `SessionSummary` 载荷富化：`tokensReasoning` / `tokensCacheWrite` / `stepCount` / `parentSessionId` / `childSessionCount` / `childTokensTotal`（additive，旧前端忽略）。
- 步数计数为独立轻 COUNT 查询（不解析 JSON），与 modelIds 扫描解耦：`includeStepModelIds=false`（CSV 导出 / TUI 选单）只跳过 JSON 富化，不跳过计数。

### Fixed

- **回放分位徽标口径**（ora-12 审视 P1）：徽标比对总量曾含 `reasoning`，而分布分位 / 列表 Tokens 列口径不含 → 系统性高估档位；已统一为 `入 + 出 + cache.read`（曲线与峰值上下文两条轴不变）。

### Tests

- 428/428 全绿 + check 0；新增 session 过滤（15 用例）、分布端点（8 用例）、作用域接线（16 用例）、回放曲线（口径封缝）等测试文件；orchestrator 另做真库端到端独立核对（富化六字段 / 分布数学 / 过滤结果与裸 SQL 全等）。

## [0.19.1] - 2026-10-16 · ora-11 审视处方热修：性能 + 健壮性

> ora-11 全仓审视（v0.19.0 增量面）结论：无 P1；P2×6 全部放行。核心是 P2-4 性能热修——真库实测 modelIds 全表 GROUP BY 单次 ~2.6s（47k 行逐行 JSON 解析），自 0.19.0 起被会话列表每次排序/翻页、CSV 导出、每轮自动刷新反复触发。

### Fixed
- **P2-1**：localStorage 从整页启动的硬依赖降为可失败项——禁用站点数据的浏览器/嵌入 WebView 下 `getItem` 抛异常会白屏整个看板；读侧回退默认 5m，写侧 setItem 失败不阻塞间隔应用（修 UI 值与定时器错位）。
- **P2-2**：`refreshCurrentView` 删掉 `cache.delete` 分支——load() 成功本就无条件回写缓存，先删只会在失败时赔掉完好缓存；补该公开入口的首批测试（失败保缓存 + 成功回写）。
- **P2-3**：`renderCurrent()` 稳定视图缓存 miss 落骨架后直接补请求（对齐时间窗分支形状；v0.7.0 老问题，自动刷新把暴露窗口放宽后收口）。
- **P2-5**：修正与 fixture 相反的测试注释（fix-31 lane 524 阵亡半成品，断言本身正确）。
- **P2-6**：回放页停留期间自动刷新不再照跑（tick/补刷判定加 dashboardElement.hidden；切回看板由补刷判定追平）。
- **R-D**：step 富化降级 catch 收窄——非「no such table」错误先 console.error 再降级，防 0.19.0 修过的「点模型空列表」以无痕方式复发。

### Performance
- **P2-4 三档**：`querySessionList` 加 `includeStepModelIds` 开关（默认 true）——CSV 导出循环与 TUI 导出选单传 false（不消费 modelIds，白付 2.6s）；看板路径富化改 **IN 下推**（当页 15 id 前置短路，2.6s → ~531ms）；回放标题查找与看板共用路由、无法区分消费意图，由 IN 下推统一覆盖，不加投机性路由参数。残余 531ms/页（无 session_id 索引的行扫描底价）记 R-A 观察档。

### Tests
- 386/386 全绿（+2：refreshCurrentView 双场景）+ check 0 + esbuild 逐文件解析；R-B/R-C/R-A/R-E 台账记档见 tasks.md。

## [0.19.0] - 2026-10-16 · 模型下钻口径修复 + 看板自动刷新 + 版面一致性

> 用户驱动五条意见 + 定时刷新需求，三 lane 并行（fixer ×2 + designer）+ orchestrator 接管收尾。fix-31 lane 中途遭 provider 524 阵亡，落盘工作近完成，由 orchestrator 补一处极简库降级并接管验证。

### Added
- **看板后台定时自动刷新**：默认 5 分钟，可调 关/1m/5m/15m（顶部注入选择器，选择持久化 localStorage，键 `insight-auto-refresh-minutes`）；刷新 = 按当前视图（范围/过滤/排序）原样重取全部区块 + 会话列表失效当前视图缓存重载（`refreshCurrentView()`）；运行中防重入（Promise.allSettled 收尾），标签页隐藏暂停、回前台若已过期立即补刷（失败轮也计时戳，防连环重刷）。F5 刷新本就现查新数据（后端无服务端缓存），未额外处理。

### Fixed
- **模型下钻空列表**（口径错，非渲染 bug）：模型排行榜行来自 step 级 `$.model.id`，会话列表却按会话启动模型（`session_v2.model`）过滤——两口径天然错开，top 榜模型（如 glm-5.3 等只出现在步骤里的 id）点击必空。`SessionSummary` 新增 `modelIds`（会话内 step 级出现过的模型集合 ∪ 启动模型，"unknown" 占位不计入），列表改按 modelIds 命中过滤；旧宿主 wire 缺字段时回退启动模型精确匹配（行为不劣于修复前）。极简库（无 `session_message` 表，如 CSV 导出测试夹具）富化查询整体降级为空集合，不牵连主查询。

### Changed
- **四处范围切换器统一**：标签一律 `7d / 30d / 90d / All`（All 排最后）；趋势组 `all`→`All`、会话组「全部/7 天/30 天/90 天」→ 对应新标签（`?range=` 契约值一字未动）。会话选择器钉成滚动区内 sticky 定高控制行（44px 不透明），与另外三处右缘同轴且滚动常显。
- **会话列表与模型排行榜高度对齐**：共享 `--table-body-cap: 464px` 封顶 + 各自内滚 + `align-self: start` 自然收尾——消除「一块下方大片空白、另一块铺满」；两面板常态等高。
- **模型排行榜首列冻结**：模型名列横向滚动时 sticky 固定（普通/hover/选中三态不透明底色，新增双主题合成令牌 `--panel-accent-tint`；右缘 inset 分隔线；corner-th 层叠序处理纵横交叉），拖动看数据时模型名始终可见。
- 模型榜面板副标题：「点击行可过滤出用过该模型的会话」（口径随修复更新）。

### Tests
- 384/384 全绿（+2：modelIds 载荷/过滤契约）+ check 0 + esbuild 全改动 JS 逐文件解析过；auto-refresh 为 app.js 交互层（无测试锁的面），验收靠真机冒烟。

## [0.18.1] - 2026-10-15 · 全仓审视收口：样板归并 + 双定义收敛 + R1 状态一致性修复

> 用户驱动「审视并优化整个项目代码，不破坏功能、不引入风险」：ora-10 全仓行为保持审视（P1×4 / P2×4 / 拒绝×9 + 风险点 R1/R2），orchestrator 裁决放行 P1-1/2/3/4 与 R1，拒绝 P2-1/2/3（收益配不上验证成本）与 P2-4（行为变更，按其自身注释「再留一版」）。前端执行 lane 中途遭遇 provider 403，剩余四区块转换与 R1 四处由 orchestrator 按审视处方直养补完。

### Fixed
- **R1 缓存命中渲染不清失败计数**（低危 UI 状态机不一致，0.18.0 引入范围缓存后出现）：四处缓存命中路径（trend/models/heatmap 范围切换 + 会话列表 applyNextView）此前只渲数据不记成功——窗口 B 失败后切回已缓存的窗口 A，顶栏仍报「N 个区块加载失败」。models/heatmap 侧连带修复：加载失败时回正 `state.cache.models` / `state.cache.hourHeatmap` 指针（置 null），防主题重渲把旧窗口数据渲在当前窗口按钮高亮下（窗口错配）。

### Refactored（行为保持，均由 382/382 套件或全仓 grep 锁定）
- **P1-1**：`parseExtractedFieldList` 逐字节双定义收敛进 `src/db/rows.ts`（五车道并行期刻意隔离的产物，两条 lane 均终态后收口；函数体一字未改）。
- **P1-2**：`INTERNAL_ERROR_MESSAGE` 双定义单源化——`request-handler.ts` 改从 `api.ts` import。
- **P1-3**：format.js 三个零消费者死导出删除（`formatPointDelta` / `formatRatioDelta` / `svgElement`，全仓 grep 实证后删）。
- **P1-4**：app.js 七个同构简单区块加载器（overview / calendar / agents / survival / compaction / todo / directories）归并为 `createSimpleSectionLoader` 工厂，四要素声明式装配，重试闭包由工厂自引用保持等价；带序列守卫的 trend / models / heatmap 与特化失败路径的 tool-health 刻意保持手写。

### Tests
- 382/382 全绿（套件零增删，全部为等价重构）+ check 0 + esbuild 逐文件解析；R1 为 app.js 交互层修复（无测试锁的面），验收靠代码路径核对 + 真机冒烟（切窗口失败 → 切回缓存窗口 → 顶栏失败计数消失）。

## [0.18.0] - 2026-10-14 · 数据挖掘扩容版：Agent 榜 + 工具错误率 + 范围选择器 + 目录导航 -/insight-status

> 用户驱动「继续挖掘数据库，看 /insight 页面还能展示什么」：先对真实库做全量 schema 探矿（47,050 个工具段全带 `state.status`、86% 步数集中在近 30 天等事实），再对表现状盘点找差集，得出四个未展示矿脉；随后追加三笔看板易用性改造与一条命令删除。四条并行 lane（fix-27/fix-28/fix-29/des-21×2）交付。

### Added · 看板新增数据面
- **Agent 排行榜**（新面板，`#agent-table`）：每 agent 的会话数 / token 消耗（紧凑缩写）/ 偏好工具 top-3 chip，按 token 降序；消费既有 `GET /api/agents`（`AgentStat` 早就在返回，此前前端只取其合计工具数）——零后端改动。落位 `.tables` 区全宽（`span-both`），表格样式复用 `.data-table` 语言。
- **工具错误率**（新 API `GET /api/tool-health`）：两段式抽取 session_message 工具段的 `$.state.status`（真库分布 completed 41,478 / error 5,648 / running 1），`computeToolHealth` 纯聚合输出 `{tool, completed, error, running, total, errorRate}`。前端两处：工具调用 TOP10 每根条叠加错误色带（errorRate ≥10% 红 / <10% 琥珀）+ `err N%` 标注 + tooltip 增 Errors / Error rate 两行；面板头摘要行 `Global error rate X% · N / M calls failed`。
- **模型排行榜时间范围选择器**：7 天 / 30 天 / 90 天 / 全部（默认全部）。后端 `GET /api/models` 加可选 `?days=N`——SQL 层 scan-floor 下推（共享 +1 天 DST 松弛惯例）+ JS 侧本地午夜窗口回收（复刻 hour-heatmap 模式），缺省/非法/0/负数 = 全量（向后兼容，缓存键保持旧形状），clamp 1..366 且 clamp 后再入键（1000 与 366 共享一条目）。真库冒烟：7 天窗 11 个模型 vs 全量 88。
- **模型排行榜限高滚动**：`.model-body` 限高 464px + sticky 表头（`--panel` 实底 + inset box-shadow 复刻下边线），不再让 80+ 行模型榜吃掉半页。
- **活动时段热力窗口选择器**：7 / 30 / 90 / 全部（默认 90），副文案随选择动态变化。动机：用户反馈「标着近 90 天但永远像近一周」——实测数据 86% 步数集中在近 30 天（近 7 天 5,646 步、近 14 天 30,791 步）+ 7 行=周几的视觉误读；后端 `?days=` 早已支持，纯前端补选择器与动态文案。
- **页首目录导航**（`#toc-nav`，13 chip）：点击平滑滚动到对应面板 + 目标短暂高亮（`.toc-flash`，`prefers-reduced-motion` 降级）；`scroll-margin` 防标题被页沿遮挡。

### Changed
- **Reasoning 列标签**：模型榜「推理占比」列对齐英文 `Reasoning`（该列与 `reasoningShare` 载荷自 0.x 早已存在，本轮仅统一文案语言；诚实记录为文案变更而非新列）。
- **窗口切换交互**（models / hour-heatmap 共用模式）：序列守卫丢弃过期响应 + 分桶缓存命中即时渲染 + 未命中保留旧表不闪骨架。

### Removed
- **`/insight-status` 命令整体删除**（用户明确要求）：status-dialog 三模块（生命周期 / 内容行构建 / JSX 渲染）+ status-panel-data + 对应测试文件一并移除；`tui.tsx` 不再含 JSX（文件名保留，package.json exports/check 指向它）。命令收敛为三条：`/insight`、`/insight-export`、`/insight-refresh`。
  - **保留判定**：`queryAssistantStepRows` / `parseAssistantStepRow` / `AssistantStepRow` 未删——`test/sql-aggregation-parity.test.ts` 以它为 JS 聚合基线校验 SQL 侧管道，删除会破坏 parity 套件；属测试资产而非死代码。
  - 0.17.0 的 `/insight-status` 弹窗冒烟项随之作废（其余两项——网页 F5 取新、EACCES 端口修复——不受影响，仍待真机冒烟）。

### Tests
- 401 → 382 净变化：+10 tool-health（纯聚合边界 / 两段式抽取回退 / 路由 / 内存库行为锁）+10 models-days-window（窗口下推 / clamp / 全量回退 / 缓存键共享），-39 status-dialog 链（三测试文件 + 注册表两例）；382/382 全绿 + check 0；前端两批以 esbuild 逐文件解析 + DOM shim 契约冒烟（16/16 + 15/15）自验，合流后全量套件复跑绿。

## [0.17.0] - 2026-10-14 · 弹窗点击关闭 + KPI 双写法 + 看板载入即取新

- **弹窗标题条可点击关闭**：右上角钉 `✕ ESC` 关闭标记——content 模块按最宽正文行右对齐补位（弹窗内容自适应，即视觉右上角），标题条 `<text>` 挂 `onMouseDown`（@opentui/core `RenderableOptions` 原生 prop，0.5.14 实证）点击即关；宿主不投递鼠标事件时退化纯提示，ESC 键仍为保底（键层冒烟已由用户真机四步验证）。行携带 `closeAction` 标记，渲染层据此接线。
- **KPI Token 双写法**：今日总量由 `35,509,713` 升级为 `35,509,713（35.5M）`——全量与紧凑两套格式唯一相遇处；<1000 不注记（避免「500（500）」废话）。模型榜/趋势区维持紧凑缩写不变。
- **看板载入即取新**：`app.js` 每次页面载入先 `await GET /api/refresh`（仅清进程内 60s TTL 缓存，毫秒级）再拉区块——浏览器 F5 保证全新数据；refresh 失败不阻塞加载（退化为最多滞后 60 秒）。
- **端口重试链吞下 EACCES**（真机全量红→绿实证）：Windows WinNAT 保留端口段跨重启漂移，撞上时 `listen` 直接 `EACCES`——旧契约把它当致命错误，看板服务启动即死。v0.17.0 起与 `EADDRINUSE` 同按「前进」类处理（+1 重试）；真正宿主层面的 `EADDRNOTAVAIL` 维持一次失败。旧的两处「EACCES 必须快速失败」行为锁随之改写为新契约锁。

### Tests
- 弹窗内容测试 +4：注记阶梯（0/999/1.2M/35.5M/12.3G）、标题右钉 + closeAction + 头宽=最宽正文行、null 数据态仍带关闭标记、窄正文兜底 gap；
- 端口重试：新增「EACCES 保留段跳过」回归锁，致命类样本换 EADDRNOTAVAIL（resilience P1-1 意图不变）；全量 401/401 绿 + check 0。


## [0.16.2] - 2026-10-13 · 安装修复（彻底）：vendor define + 全依赖面钉死

> 0.16.1 钉死直接依赖后 `opencode plugin update` 仍失败——tarball 干净安装探针追出第二、三层根因，本版把安装面收缩到镜像稳定的最小集。

### 根因修正（推翻 0.16.1 的「上游断链」归因）
- 真实根因是**本机 npm 走 npmmirror 镜像 + 我们依赖面浮动**的复合：`@opentui/core@0.6.2` 与 `@aws-sdk/credential-provider-web-identity@3.972.80` 在 registry.npmjs.org 上**都存在**（已直查核实），是镜像没同步到。上游没断，断的是「浮动范围 × 镜像滞后」的组合。
- 第一层（0.16.1 已修）：`@opencode/plugin: latest` 浮动 → 解析到 2.0.27 新树。
- 第二层：peerDependencies 也是浮动（`>=0.5.8`）→ `@opentui/solid` 解析到 0.6.2，它要求 `@opentui/core@0.6.2`（镜像缺失）→ ETARGET。
- 第三层：即使前两层钉死，`@opencode/plugin@2.0.23` 自身的深树（effect/AI-SDK/@aws-sdk 链）里仍有浮动范围，新解析撞上镜像缺 `@aws-sdk/...@3.972.80` → ETARGET。结论：**只要运行时依赖里有深浮动树，镜像滞后一天就堵死一次安装**，逐个钉浮动范围是打地鼠。

### 修法（安装面最小化）
- **vendor `Plugin.define`**：上游 define 是恒等函数，宿主只校验 default export 的 `{ id, setup }` 形状（二进制实证）。新增 `src/plugin-definition.ts`（`defineInsightPlugin` 恒等助手），两个入口改用它——**`@opencode/plugin` 整棵深树从安装面消失**（effect/AI-SDK/@aws-sdk 不再被安装），降级为 devDependencies 仅供本地类型与测试。
- **peerDependencies 全钉死**到本地验证过的匹配集：`@opentui/core@0.5.14`、`@opentui/solid@0.5.14`（两者互为精确配对，双双在镜像中存在）、`solid-js@1.9.12`——397 项测试全程基于该集验证。
- **推送前新增安装性门禁**：`npm pack` → 干净目录安装 tarball，必须全树解析成功才算可发布（本轮起固化；0.16.0/0.16.1 均因缺此门禁带病发布）。

### 环境事实（记入台账，非本仓库可控）
- npm 安装会**向上找最近 package.json 作为项目根**：本机家目录（`%USERPROFILE%\package.json`）恰有一份，而宿主插件缓存戳目录（`~\.cache\opencode\npm\...\<epoch>\`）没有自己的 package.json——即宿主每次插件安装都会把家目录依赖树合并进解析。家目录 package.json 一旦被污染会拖炸宿主全部插件更新（本轮探针曾写入 `file:` 引用，已清理还原并做了带时间戳的 `.bak` 备份）。

### Tests
- 397/397 全绿（vendoring 为恒等替换，零行为变化；`check` exit 0）。server-resilience 的 P2-2 用例在全量并发下有一次时序抖动挂红，单文件重跑与全量复跑均绿——与改动无关，挂账观察。


## [0.16.1] - 2026-10-13 · 安装修复：钉死 @opencode/plugin 依赖

- **背景**：0.16.0 发布后 `opencode plugin update` 失败（NpmInstallFailedError）。手动 npm 探针取到真实根因：`ETARGET — No matching version found for @opentui/core@0.6.2`——我们的直接依赖声明为 `@opencode/plugin: latest`，latest 现解析到 2.0.27，其依赖树深处要求 `@opentui/core@0.6.2`，而 npm 上最高只发布到 0.6.1（上游断链发布）。0.15.x 时代能装上纯属缓存幸运，浮动 `latest` 使每次安装都暴露在上游发布质量风险之下。
- **修法**：`@opencode/plugin` 钉死为 `2.0.23`（本地开发与 397 项测试全程基于该版本验证，宿主 2.0.27 二进制内的 TUI API 面已由侦察定案兼容）；`INSIGHT_VERSION` 同步 0.16.1，package-lock 刷新。
- **教训**（固化为规则）：运行时依赖禁用 `latest` 浮动标签——发布物的可安装性必须是确定性的，上游断链一次就够堵死所有新装。


## [0.16.0] - 2026-10-13 · 交互重做版：状态弹窗化 + 看板端口发现修复

> 用户活体冒烟（重启 TUI 后实测）驱动的一版：四命令注册问题在 0.15.1 修复后，暴露出两个潜伏更深的问题——/insight 与 /insight-refresh 的跨进程 storage 通道自诞生起就不可能工作（TUI flavor 无 storage.get）；/insight-status 面板排版粗糙且无关闭途径。本版一并重做。经 ora-9 增量审查（P0=0）后发布。

### Fixed · 看板端口发现（/insight、/insight-refresh 恒报「看板服务未启动」）
- **根因**：TUI flavor 的 `Context.storage` 只有 `store/memory` 没有 `get`（宿主类型 node_modules/@opencode/plugin/dist/tui/context.d.ts:6-22），而读取实现只探测 `storage.get` → 恒 null；且 server 进程与 TUI 进程的 storage 是不同后端，跨进程 storage 通道本身不成立。测试 fake 曾用 server 形状 `{storage:{get}}` 掩盖此缺陷（与 0.15.1 的 bind 空串同类「宽松 fake 掩盖宿主形状」问题）。
- **修法**：TUI 侧改为健康探测——server 健康响应增加 `service` 标识字段（防误报），新增 `src/tui/discover-dashboard-port.ts` 并发探测 127.0.0.1:18789..18798 的 GET /api/health（与 server EADDRINUSE 重试策略精确一致、有测试锁死），升序取首个命中；两命令改造 + 旧 storage 读取路径清理 + README 排障行按新机制改写（原归因已失实）。
- 测试：fake TUI context 全部改为真实宿主形状（storage 无 get）；覆盖全段拒绝→报错、命中开 URL、外来服务串号跳过、响应形状校验、十口并发性、refresh 同理；红锚点验证「命令走旧 storage 路径则新测试必红」。

### Changed · /insight-status 弹窗化重设计（新交互能力）
- **session.panel 侧栏面板 → ui.dialog.show 弹窗**：弹窗无「打开面板收起 sidebar/断开 terminal」副作用；**ESC 关闭经自注册 modal keymap 层**（宿主自定义 dialog 内容不免费处理 ESC，按宿主 storybook 先例接线，enabled 窗口期由 Solid signal 驱动仅弹窗存活期为 true）；`r` 键就地刷新不重开；页脚固定「ESC 关闭 · r 刷新数据」提示。
- **内容图表化**：今日概览大数字完整千分位 + 命中率 20 格带轨道进度条；模型 TOP5 **零截断**（列宽自适应最长 id，54 字符完整显示——旧 40 字符行宽截断差评根源已除）+ 14 格比例条按 web 面板 m1..m5 调色板逐行着色 + 数值/占比右对齐；近 7 日趋势 28 格条形图（旧 12 格的 2.3 倍）+ 日期等宽 + 今天高亮；配色全部取自 web 深色主题 tokens，无新造色。
- **模块化**：`status-dialog.ts`（生命周期）/ `status-dialog-content.ts`（纯函数内容，零 JSX/零宿主 API/零 Date.now）/ `status-dialog-render.tsx`（唯一 JSX）；数据查询沿用 `status-panel-data.ts`；tui.tsx 保持纯装配。
- **移除**：panel 路线整体下线（status-panel-text.ts、status-panel-controller.ts 含 60s 自动刷新循环、session.panel slot claim、test/status-panel.test.ts），grep 零残留；数据层行为口径迁移至 test/status-dialog-data.test.ts 保全。/insight-export 的 ui.dialog.select 未受影响。

### Fixed · 审查处方（ora-9 P1/P2）
- v0.11.0 时间炸弹测试：pinnedNowMs 硬编码绝对日期（窗口滑出后确定性红）→ 改相对 `Date.now()` + 新增窗口内部动态锚点断言 + CLOCK RULE 头注（禁绝对日期）。
- open() 顺序缺陷（处方 P2#1）：show 能力检查提到全库扫描之前（无 ui.dialog 宿主零扫描）；show 抛异常时复位 open flag（原缺陷：flag 卡 true → modal 键层空转激活、r 键劫持按键每按一次全库扫描）。
- teardown 无条件 clear（处方 P2#2）：改为仅本弹窗存活时才 clear，不误杀 /insight-export select 或他插件弹窗。
- fake 键层返回值背离（处方 P2#4）：补 void 返回的生产路径覆盖。
- 文档对账（处方 P1#2）：DESIGN.md §8/§9 五处失实（panel 三件套/storage 读端口/session.panel 路线等）与 src/index.ts 头注释（端口写入「for the M6 TUI commands」已无读者）按探测与弹窗实况改写。

### Tests
- 374 → **397**（+23 净增）：端口探测 9 + 双命令改造/宿主形状 fake 重构 + 弹窗内容 18 + 弹窗生命周期 11 + 数据层迁移 2 + registry 重写 5 + 处方回归 4；红→绿验证 5 处在案（探测旧路径、千分位正则、窗口内部锚点、show 异常复位、clear 守卫）。

### Open（不阻塞发布）
- **真机冒烟（用户侧，一分钟）**：打开弹窗 → ESC 关 → r 刷新 → 再 ESC——397 测试全部跑在 fake 宿主上，最承重假设「自定义 dialog 使宿主进入 modal 输入模式使键层可达」需真机确认（ora-9 P1#3）。
- 挂账下版（ora-9 P2）：多实例端口歧义消歧（health 加 per-instance 标识）、status-panel-data.ts 机械改名 status-dialog-data、index.ts 端口写入死代码一次性清理、趋势行空转长度断言收紧。


## [0.15.3] - 2026-10-11 · 测试加固版：v0.1.0 存量面板测试面全量入库 + verify-install 注册失败检查

> 审计遗留队列第二波：审计 ⚠️#2 完整销账（0.15.2 已补 tooltip/kpi-card，本版补齐其余全部存量面板）+ 审计建议项 verify-install 宿主日志检查落地。全部改动可溯源至 ora-8 审计处方（处方型，免下一代审查）。

### Added（补测试面，352 → **374**，+22）
- **calendar-heatmap ×5**（审计优先级首位）：日历格渲染/分位色阶落档/周一列对齐/月份标签恰一次、跨月标注、null/空/全零降级（密度退化锁）、hover tooltip 接线。
- **token-funnel ×4**：四层顺序/份额文案/polygon 顶边宽严格比例（不锁绝对像素）、零值层亚像素发丝线、null/全零降级返回 null、hover 接线。
- **tool-bars ×4**：跨 agent 聚合降序/条形满轨/占比分母口径、TOP10 截断与长名截断、三态降级占位、hover 接线。
- **state-views ×3**：loading 骨架块宽序列 + aria-busy、empty 富文本契约与 hint、error 对 Error 敌意消息转义 + 重试路由 + 非 Error 降级。
- **replay-turn-bar ×3**：三段顺序与宽度（max(2px) 保底）、零值段省略与模型切换 ⚑ 标记、null/全零/非对象降级、hover 接线。
- **theme ×2**：cssVar/modelPalette 十二槽/chartTheme 七槽映射；prefersDark 探测、matchMedia 查询串锁定、onSchemeChange 注册/路由/退订。
- **trend-chart 加深 ×1**：renderTrendChart 数据入口降级分支（null/单点占位、legend 清空、无 uPlot 实例化、返回 cleanup）。
- **红验证 ×2**（纪律要求 ≥2）：calendar-heatmap 改坏 levelOfValue 顶档 → 红（700→level 4 断言）→ 恢复；token-funnel 改坏 supply → 3 测试红 → 恢复；两组件源码 git status 确认干净。
- 测试基建：calendarTrendFixture / funnelTrendFixture / funnelPolygonTopWidth（比例断言用），夹具 example 系列虚构占位。

### Added（脚本能力）
- **verify-install.ps1 新增第 7 项检查（WARN 级，不影响退出码）**：扫描宿主日志中 v0.15.1+ 才存在的两条 TUI 注册失败 console.error 文案，0 命中 → PASS / >0 → WARN（附重启复跑指引）/ 无日志 → SKIP。路径全程 `$env:USERPROFILE` 动态构造（无硬编码用户名）；日志以 FileShare::ReadWrite 打开（宿主持有追加写锁时仍可读，实测踩坑记录）；中文匹配串以 `\uXXXX` 转义构建（脚本无 BOM，兼容 Windows PowerShell 5.1 的 ANSI 误读）。**命中计数排除宿主 `spawning process` 命令行回显行**（orchestrator 加固：探测/grep 命令嵌入匹配串会被宿主记进日志造成永久自污染误报，实测命中 opencode.log:86253 后加过滤，本机实跑 PASS）。
- 本机实跑：7 项全 PASS，`VERIFY OK v0.15.3 @ <HEAD>`。

## [0.15.2] - 2026-10-11 · 审计对账清账版：文档回写 + tooltip XSS 持久回归锁 + mock 会话侧 clamp

> 来源：oracle 全量审计（设计目标 vs 实现）——核心面零遗漏，债务集中在文档失实与 v0.1.0 存量测试豁免区。本版按审计处方一次性收口，全部改动可溯源至审计清单（处方型，免下一代审查）。

### Added（补测试面）
- **tooltip XSS 持久回归锁（v0.1.1 P0-2 销账）**：当年 P0（MCP 工具名/modelId 注入源未转义）只经一次性冒烟验证、脚本未入库——tooltip.js 改回坏形态 347 测试照绿。现补 2 个回归测试（showTooltip/hideTooltip 入口 + bindHoverTooltip payloadBuilder 路径），payload 用 P0 原始形状（`<img src=x onerror=…>`、`"><script>`、恶意 swatch），断言转义后文本在场、原文不在场、平铺解析中 img/script/svg 标签数为 0；**已做红验证**（临时恢复 P0 未转义形态 → fail 2 → 逐字节恢复 → 全绿）。
- **kpi-card 测试面（零入库 → 5 测试）**：精度标签口径（4 卡头 exact/实值 + 仅成本估算行 estimate/估算）、环比方向与文案（▲25.0%/▲2.0pp）、sparkline 数据入口（4 锚点收于 x=100.00、常量序列退化分支无 NaN、<2 值整段省略）、持平/缺基线降级（— 环比）、null overview 单块骨架。
- **mock 守恒不变式测试**：全部会话 tokensOutput ≥ 0 且 input+output+cacheRead ≤ tokens（宽松界，clamp 生效时守恒放宽的语义写进注释）。

### Fixed
- **mock 会话级 tokensOutput clamp**（ora-7 P2 销账）：`Math.max(0, …)` 一行——Math.round 双半值进位理论可产生负 output（当前确定性 SEED 不可达，从未修过）；注释钉死会话侧与 v0.15.0 目录侧（最大余数法）修复的区别，勿误读为全局已修。
- **tasks.md 两处勾稽失真**：B1 服务端排序（0.4.0 已落地）与 0.3.0 oracle 审查（即 v0.3.1 来源）补勾，台账自相矛盾消除。

### Changed
- **文档对账回写（审计文档债 8 项全清）**：README 从 v0.1.x 功能面回写至实况（四条命令补 /insight-refresh、CSV 导出九列/BOM/RFC 4180、模型排行榜 token 占比、趋势 byModel 堆叠、会话列表排序/下钻/时间窗/入出分列、回放页内搜索）；DESIGN.md 头部版本实况化（0.15.x，删除与「唯一依据」自相矛盾的 0.1.0-draft）、§5 目录维度行补 tokens 三分、§6 路由表补 /api/export/sessions.csv 与 /api/refresh（sessions 行补三 wire 分项、trend 行补 byModel）、§7 补回放内搜索、§8 补第四条命令、**新建 §13 备选清单**（ghost line、成本直方图 p50/p90/p99 各「是什么/为何暂不采纳/再触发条件」——§2.3 断头引用落地）、精度标签措辞收窄为实况（KPI 卡徽标 + 全局图例脚注，决策：不补实现）、§3.1 树刷新（347 用例、6 个缺失组件、mock 文件与 USE_MOCK 说明）。
- cache.ts:57 过期注释销账：refresh 伏笔 v0.14.0 已兑现。
- 测试 347 → **352**（+5）。

## [0.15.1] - 2026-10-11 · 修复：TUI 四条斜杠命令在真实宿主上从未注册（bind 空串触发宿主形状校验）

### Fixed
- **P0：删除四条命令的 `bind: ""`**（command-registry.ts）。宿主 `keymap.tsx` 的 `groupCommands` 校验对有 id 的命令执行 `typeof bind === "string" && !bind → throw "Keymap command bindings cannot be empty"`（该字符串已在本机 opencode.exe 二进制中核实），`keymap.layer()` 初始形状校验同步抛错；旧代码的 catch 把异常**静默吞掉**返回 undefined → 四命令（/insight、/insight-status、/insight-export、/insight-refresh）**自 v0.11.0 起在真实宿主上从未注册成功**，宿主日志零报错——这正是五个版本未被发现的原因。修复为直接省略 `bind` 字段（类型 `bind?: false | string`，省略即无键位，与 oh-my-opencode-slim 参照实现一致）。
- **静默吞错加固**：`registerInsightTuiCommands` 与 `registerStatusPanelSlot` 的 catch 在返回 undefined 前先 `console.error` 记录错误——保持 T6.3 永不抛契约，但注册失败从此可在宿主日志中诊断。

### Added
- **宿主校验镜像回归锁**（tui-command-registry.test.ts）：`buildHostValidatingKeymapHarness` 镜像宿主 `groupCommands` 关键规则（有 id + 空串 bind → 抛错；palette/slash 命令必须有非空 id），断言注册在镜像宿主规则的 fake 上成功——旧代码该测试红（layer 抛错被吞、返回 undefined），现有宽松 fake 不做形状校验正是回归曾潜伏五版的盲区。
- **形状锁断言**：每个注册命令的 `bind` 必须为 undefined 或非空字符串。
- 测试 345 → **347**（+2）。

## [0.15.0] - 2026-10-09 · 目录面板 tokens 汇总（入/出双列 + 口径警示）

### Added
- **目录聚合三 SUM**（`queryDirectoryStats`）：`DirectoryStat` 增补必填 `tokensInput/tokensOutput/tokensCacheRead`（v2 汇总口径，与 v0.13.0 会话列表同表同列零 join 差异——无混口径）；SQL 走**预聚合方案**——step 子查询改 `GROUP BY session_id`（每会话恰一行），扇出结构性消失，三 SUM 不被步数放大；外层步数改 `COALESCE(SUM(step_counts.step_count), 0)` 保零步目录语义；GROUP BY/空目录排除/JS 三键排序全部不动；`api.ts` 零改动（缓存键不含字段）
- **目录面板入/出双列**（前端）：插在「步骤」与「最近活跃」之间，两处 grid 模板同步扩列（桌面 +2×56px 轨道、移动端七列变体 + 隐藏选择器 nth-child(5)→(7) 顺移修正）；title 沿用会话列口径文案 + 目录特有对账警示（会话级汇总 vs 消息级 ~0.36% 系统差 · 无目录会话不计入 → 各目录相加 ≠ 全库）；三字段 `?? 0` 诚实渲染；旧 wire 未知 cache.read 不伪装成 0
- **mock 三分分摊**：buildDirectoryStats 逐日按目录权重对日序列三分**各自**走最大余数法分摊（与 steps 同款纪律）——output 永不为负（负值回扣问题自然消解）、Σ 目录三分 === Σ getMockTrend(366) 三分（跨视图守恒断言）
- 测试 340 → **345**（+5：后端——真实 :memory: 夹具扇出回归面「多步会话 tokens 不被步数放大」+ 三分守恒手推精确断言 + fake 镜像 SUM + deepEqual 两处连锁；前端——列序/title 逐字/零值兜底/旧 wire 不伪装/mock 守恒三对总值）
- 活库探针 6/6：16 目录逐行与 SQL 直查三分**全等**（扇出若存在必红）、Σ 目录三分守恒（in 331.9M/out 13.7M/read 4.19B）、榜首目录 in 302.9M 可见；「空目录排除在活库可观测」断言经甄别为探针假设错误——活库唯一空目录会话三分全 0（排除语义由 parity 夹具锁定），历史第四次探针自证纪律命中

### Changed
- directory-queries.ts 文件头口径注释：COUNT(DISTINCT) 防扇出表述更新为预聚合结构描述 + token 口径 bullet
- index.html 目录面板副标题：「会话与步骤」→「会话、步骤与入/出 token」（加列后原句事实性缺漏，des-18 越界 flag 经协调方 copy 复核后接受保留）

## [0.14.0] - 2026-10-09 · /insight-refresh 刷新命令

### Added
- **`GET /api/refresh`**（服务器）：读 `resultCacheSize()` → `clearResultCache()` → 200 JSON `{status:"ok", cleared:N}`——覆盖全部服务端缓存面（12 处 cachedResult 同一模块级 Map；CSV/.md 导出本就不走缓存）；路由自身不入缓存（空缓存时 cleared=0）、**db 无关**（db null 仍 200，503 名单不加）、GET/HEAD 门不放宽（POST → 405 既有行为）；cache.ts:57 预留注释的"future refresh command"伏笔兑现
- **`/insight-refresh` 斜杠命令**（TUI，第 4 条命令）：**跨进程回环**——TUI 与 server 是两个插件 flavor 两个进程，命令内直接 import 清缓存是静默 no-op（侦察钉死），故走 `readInsightServerPort` + fetch `127.0.0.1:{port}/api/refresh`（AbortController ~5s 超时防御）；成功 toast「已清除 N 条统计缓存（看板刷新页面后生效）」——看板页面无自动轮询，刷新提示必要；端口缺失/超时/非 200/坏 JSON 全降级 error toast **永不抛**；依赖注入 `{fetchImpl?, readPortImpl?}` 供测试观察
- 测试 331 → **340**（+9：路由——200 形状/精确计数/db-null/自身不入缓存/清空后重算行为锁；命令——端口缺失/fetch 失败/成功文案；注册——数量 4/slash 名单/runRefresh 注入）
- 真实服务探针 10/10：铺 4 路由→refresh 精确清 4、空缓存→0、重算健康、405 GET 门、未知路由 404 不破坏、精确计数 2→2（探针末段一次自误断言经甄别为探针算术错误——overview 健康检查留的 1 条未计入，代码行为正确）

## [0.13.0] - 2026-10-09 · 会话列表 tokens 双指标列（入/出分项 + 口径注释债修正）

### Added
- **`/api/sessions` 分项透传**（后端）：SessionSummary 增补必填 `tokensInput`/`tokensOutput`/`tokensCacheRead`（session_v2 三列经 coerceNumber 逐值直通）；**既有 `tokens` 折叠总和与 `cost` 行为零变化**（折叠表达式逐字保留）；SESSION_LIST_SELECT_SQL/排序白名单/directory+range 过滤/缓存键/CSV 九列全部零改动——零新增 SQL、零性能代价（三列本就已在 SELECT 中）
- **「滞后」注释债修正（数据源决策修正）**：活库探针实证推翻既有"session_v2 lagging"假设——844 会话 **0 个 v2 落后 / 69 个 v2 领先**，28/28 带压缩会话 v2 全领先（session_message 被压缩修剪，消息级聚合对压缩会话**低估**）；四处注释 + DESIGN.md 两处改为如实表述，"历史统计仍以 message 级为准"的口径决策不变（跨面板两口径存在 ~0.36% 系统差，注释钉住）
- **前端「入」「出」双指标列**：插在更新时间与 Tokens 总量之间（分项→总量聚合读序，沿用 0.12.0 占比紧邻总量的布局语言）；**口径与 KPI todayInput/todayOutput 严格一致**（入 = 纯输入不含 cache.read，出 = 纯输出——经 deriveOverviewExtension 核对）；cache.read 在 Tokens 总量单元格 title 报分项（旧 wire 未知分项只报公式不编造）；新列不 sortable（`sortKey: null` 原生支持，排序白名单不扩）；`?? 0` 兜底旧 wire，tokens=0 诚实渲染 "0"
- **mock 镜像**：每会话三分项自洽（分项和 === tokens 严格守恒，tokenShare 同款纪律），cache.read > 纯输入的活库形态保真
- **九列密度收紧**（scoped `.session-table`，不碰共享规则）：半宽面板内不出横向滚动条
- 测试 327 → **331**（+4：后端——api-routes 分项透传/折叠回归 + parity 列形状锁追加分项断言；前端——入/出列渲染（9 列序/口径 title/精确单元格串）/旧 wire 兜底/mock 自洽）
- 真实库探针 8/8：100 行三字段有限数、折叠恒等逐行成立、榜首 ses_f09126be 真实分布（in 53M/out 3M/read 1.19B）、directory 下钻与 range=7d 分项随行、cost Σ=0 留位复核

## [0.12.1] - 2026-10-09 · v0.12.0 增量审查修复

### Fixed
- **P1-1 测试午夜窗口必红**（非 0.12.0 引入，旧代码测试卫生）：behavior-queries 的 fresh 夹具锚点 `Date.now() − 1h` 在 00:00–01:00 跑测试时落在昨日 23:xx，被 days=1 窗口的"今日本地零点"下限裁掉 → 断言必红（oracle 独立复跑 326/327 实证）。锚点改 `Date.now()`（"现在"恒在窗内，断言只数总量不数格子，无副作用）——发布门不再每天有 1 小时说谎
- **P2-1 Σ=1 过度声明软化**：ModelMetric 接口注释改为"sum to 1 up to floating-point rounding"（每项除法 ≤0.5 ulp；85 模型活库实测偏差 1 ulp = 1.0000000000000002）；model-metrics 测试精确 `equal(Σ, 1)` 改 1e-9 容差（精确断言靠夹具数值运气，是埋给未来夹具作者的地雷），与 mock 侧容差纪律对齐
- **P2-2 占比列显示位数 1 → 2 位小数**（协调方拍板）：活库 4.43B 总量下 55/85 行在 1 位小数渲染 "0.0%"——列的信息量在其设计动机（长尾可见性）处失效；2 位让 0.05%–1% 长尾可读（"42.70%"/"0.00%"）。期望字符串经 IEEE754 实证推导非心算；hitRate 1 位与推理占比 0 位不动
- **P2-3 daily-buckets 注释措辞收紧**：整数键例外从 "canonical numeric string" 收紧为 "integer-valued array-index key (canonical numeric string in [0, 2³²−2))"——JS 提前枚举的精确条件（"1e21"/"-0"/"007" 形似但不跳队）；纯注释零代码

## [0.12.0] - 2026-10-08 · 模型排行榜 token 占比列

### Added
- **`/api/models` 逐模型 `tokenShare`**（后端）：`ModelMetric` 增补必填 `tokenShare: number`（原始 0..1 分数不取整，显示端格式化）；计算全落 `computeModelMetrics` 纯函数层——分组扫描内自 Σ 分母（复用 totalUsageTokens 口径，input+output+cache.read），**零 SQL/路由/缓存键改动**；分母 ≤ 0 → 全 0（除零防护对齐 hitRate 写法）；分母 > 0 时 Σ tokenShare === 1 构造性成立；排序键不动（仍 tokens desc——share desc 与 tokens desc 数学等价）
- **前端「token 占比」列**：紧邻「总 token」（第 5 列，绝对量 ↔ 份额逐行对照）；**1 位小数**（与推理占比 0 位刻意区分——mock 长尾低至 0.45%，0 位取整会谎报 "0%"）；旧 wire 缺失/NaN → "—"（不可得约定，复制 hitRate/cost 模式），诚实 0 渲染 "0.0%" 不降级；排序经 compareMetric `?? 0` 既有路径自动继承（缺失按 0 全并列保序）；「新列首点 desc」契约遵守
- **mock 镜像**：buildModelMetrics 后处理 `tokenShare = tokens / Σ tokens`（与真实 wire 同形；Σ=1 浮点 1e-16 内自洽）
- 测试 321 → **327**（+6：后端——多模型逐模型精确值/Σ=1/分母 0；前端——renderModelTable 从零建 4 用例：列清单+单元格渲染/排序交互（fixture 故意 share ∝̸ tokens 证明比较器读 share）/旧 wire 降级/mock 镜像；shim 扁平约束下 innerHTML.includes 断言 + `pinModelSortState` 钉模块级排序态自证）
- 真实库探针 7/7：85 模型逐个 share ∈ [0,1]、Σ=1、**Σ 模型 tokens === overview.totalTokens 逐字节相等**（跨面板口径一致实证）、排序 tokens desc、share × Σ === tokens、榜首 space-bunny-free 70.4%、活库无 unknown 桶

## [0.11.0] - 2026-10-08 · 趋势图 byModel 真实化（双车道 + wire 形状对账）

### Added
- **`/api/trend?days=N` 逐日 byModel**（后端）：每 `DailyTrendPoint` 增补点级 `byModel: Record<模型id, 该模型当日 tokens>`（值口径 = input+read+output，与点总量同一行级提取、同 JS 强转口径——聚合全在 JS，延续"SQLite 数字强转会破坏旧口径"纪律；SQL 仅增补 `$.model.id` 行级提取）；每日稠密（窗口内观察到的每个模型在每点出现，无活动日零填充）；**键序确定**：全窗 token 总量 desc + modelId asc 字典序决胜（注释+测试双锁）；Σ byModel === 点总量构造性成立；缓存键/MAX_TREND_DAYS=366/503/垃圾参数零改动；wire 保持**裸数组**（向后兼容旧消费方）
- **前端直通**：normalizeTrendPayload 从"byModel 硬置 []"改为**点级 Record 透视**成 trend-chart 消费的序列 `[{modelId, values}]`（按点序对位、键并集为模型清单、透视顺序确定）——按模型分色的堆叠面积图 + 图例开关（早已完整实现、mock 路径跑通）在真实数据上不再降级；**mock 镜像真实 wire**（getMockTrend 改裸数组 + 点级 Record，mock 不再"领先一格"）；防御性归一保留（点级损坏形态逐点零补、全部点损坏 → []、旧无 byModel 裸数组 → [] 降级、垃圾载荷 → 空数据）
- **交叉消费点接线**：`fetchOverview`（KPI 卡的今日/昨日分列、环比、sparkline 从 trend 序列推导）统一改走 normalize(...).points 拆包——端到端测试钉住 KPI 推导字段存活（防 wire 演进静默降级为 —）
- **wire 形状对账**（双车道分歧的收敛）：前端初版按对象封装 `{points, byModel}` 实现、后端钉在裸数组+点级 Record——独立服务探针实证真实形态后，前端归一层以点级透视适配（后端形态胜出：裸数组向后兼容旧消费方）；封装分支按 YAGNI 移除（一个 wire 一个形状）
- 测试 307 → **321**（+14：后端——逐日桶值精确/排序键双锁/确定性/窗口外模型不泄漏/单模型退化 + 真实 SQLite 手工对账 + parity 夹具自动扩展；前端——透视正确性/确定性/零值层保留/降级路径/rankModels 序列构建面/fetchOverview 端到端）
- 真实库探针 19/19：7/30 天双窗裸数组 → 透视 10/34 模型层、每层 values 与 points 逐日对位、Σ 模型层 === 点总量逐日一致、透视确定性、消费面可吃（modelId 非空 + 有限数）、mock 与真实同形同走通

## [0.10.1] - 2026-10-07 · v0.10.0 增量审查修复

@oracle 对 v0.10.0 增量的审查（P0 零 / P1 零 / P2×1）发现项的修复版本。审查确认面：通知行占位对齐经 5876 行真实会话（71 通知行）逐位实证、失败回合空 haystack 判定无害（content:[] 的 provider 错误回合只出 meta chrome）、防抖异步真实性、高亮记账三条路径全入账、DOM shim 第三次扩展无假绿方向偏差（偏差方向更严格）、跨渲染防抖泄漏判定无行为缺陷（闭包隔离 + 200ms 上界）。

### Fixed
- **P2-1 readToolInput 结构单点化**：渲染侧 buildToolPartElement 原仍自留一份内联 `JSON.stringify(input, null, 2)` 守卫——与提取侧的逐字一致靠注释纪律维持，未来改展示形态时"看得见搜不到"回归类会静默复活且全部测试照绿。修复（审查修法②）：**渲染侧改为消费 `readToolInput(stateRecord)` 作为唯一出处**（参数 pre 文本 = 单点产出），把"两份人肉同步"变成"一份代码"，结构上杜绝漂移；**新增渲染→搜索单向包含性集成锁**（经 renderTimeline 渲染含工具块消息，取参数 pre 的 textContent，断言其出现在对应消息 haystack 中）——渲染形态再内联变形即响亮失败。43 → 44 项组件测试（42 基线 + 1 结构锁，保留既有 mirror 行为锁）

## [0.10.0] - 2026-10-07 · 回放内搜索（纯前端单车道）

### Added
- **回放时间线页内查找栏**（全前端第一个文本输入，样式借回放面板语言）：输入即搜 + 200ms 防抖（具名常量 `REPLAY_SEARCH_DEBOUNCE_MS` 测试钉住）；命中计数（跨全消息非仅可见区）+ 上一处/下一处导航；键盘约定 Enter 下一处 / Shift+Enter 上一处 / Esc 退出（浏览器查找栏惯例）；无命中文案与导航 no-op；空串/空白/Esc 即时退出并清高亮
- **搜索文本视图单点 `replay-message-text.js`**：五个提取纯函数从 replay-timeline 原样迁出共享（渲染与搜索同一出处，杜绝"搜得到渲染不出"的口径漂移）；`buildReplaySearchIndex` 按时间线可见顺序预计算小写合并 haystack（大小写不敏感=两侧同 lower），逐键只做 includes
- **搜索范围六类（与渲染口径逐字对齐）**：user 正文 / assistant text / reasoning / tool name / **tool input** / tool output。**工具入参为收敛探针实证补齐**：初版契约漏了 state.input——它在 UI 上渲染为工具块参数（"看得见却搜不到"，真实会话实证 "opencode" 差值 1077/4073≈26%）；`readToolInput` 逐字镜像渲染形态（`JSON.stringify(input, null, 2)` 同守卫同序列化同空串出口），补齐后差值收窄至 39/540≈7%（剩余为 step-start 等不渲染元数据面，正确不可搜）。通知行（system/model-switched/compaction）刻意排除：其渲染文本为截断拼装，搜全文会命中渲染不出来的文本
- **节点级高亮（契约钉死）**：`.replay-hit`（琥珀左缘）+ `.replay-hit-current`（当前导航位 accent 醒目）；正文一律 textContent 写入，零 `<mark>`、零转义风险；清除走记账式精确摘除
- **分页区命中**：导航到未渲染区（>200 条外）驱动 `appendNextChunk()` 连续追加到目标条再 `scrollIntoView` 定位；追加区间其余命中一并补高亮（与"加载更多"手动路径同语义）；分页控制器扩 `renderedCount`/`nodeAt(index)`（既有事实非新状态源）
- **状态清零**：搜索态全部存活在查找栏闭包内，随 `renderSessionReplay` 每次渲染整体重建——切换会话/退出回放自然清零，renderSequence 竞态守卫下无残留（集成测试钉住）
- 测试 300 → **306**（+6：六类文本视图纯函数逐类命中/大小写/多 part、查找栏 DOM/防抖/计数/步进换标/Esc 退出、210 条夹具分页区命中驱动追加、会话切换零残留、mock 228 条全链路 16 处命中步进到尾）；DOM shim 第三次扩展（value/classList/fire/children/fragment——对应真实 DOM 语义）；回放 DOM 首次有测试
- 真实会话探针对账：索引↔可见记录逐位对齐（通知行占位空 haystack 不脱位）、六类命中双向对账、readToolInput 渲染形态逐字一致、626 个真实工具入参进搜索面

## [0.9.1] - 2026-10-07 · v0.9.0 增量审查修复

@oracle 对 v0.9.0 增量的审查（P0 零 / P1 零 / P2×1）发现项的修复版本。审查确认面：三态词表封闭性（hasOwn 电池 + 敌意键逐一测试）、冻结时钟真实夹具、四形态 SQL 字节锁、导出每页同阈值、注入面闭合、双侧边界夹逼、600+300 翻页陷阱设计、活库 828 行 epoch-ms 全整数（跨类型序陷阱不存在）。

### Fixed
- **P2-1 时间窗视图绕过前端缓存**：range 是首个随墙钟移动的缓存维度，永不过期的 Map 缓存在页面长驻时把旧快照静默当作"最近 7 天"（同键不再蕴含同义）。修复：**按视图判定非按动作判定**——非空 range 的视图一律绕过缓存读与写（总是重新请求，杜绝整类"陈旧窗口再售"；range 视图下切排序/切目录也直取，堵住"仅 changeRange 绕过"的动作面漏洞）；空串 range（全部）是稳定量、保持完整缓存命中；renderCurrent 升级为"保证有内容"语义（模型过滤路径在 range 视图下直取而非卡死骨架）；已知代价：主题切换时时间窗视图不重取配色，待下次数据交互刷新（注释钉住）。既有稳定维度测试零改动通过；改写 1（被消灭的 7d 缓存命中断言）+ 新增 1（按视图判定核心语义），35 → 36

## [0.9.0] - 2026-10-07 · 时间范围筛选（双车道）

### Added
- **`?range=7d|30d|90d` 时间窗过滤**（后端）：过滤 `time_updated >= 请求时刻 − N×86400000`（epoch-ms 数值绑定——time_updated 为 epoch-ms 整数列，与既有 scan 层先例同形态，无需 CAST；ISO 文本形态的跨类型静默回退已被真实夹具测试排除）；词表单点 `SESSION_RANGE_WINDOW_DAYS_BY_RANGE_KEY`；三态解析器 `resolveSessionRange`（缺省/空=全量 / 合法=窗口 / **未知非空 → 400** 响亮失败，`Object.hasOwn` 防原型链键 500，400 响应体含词表提示）；503 短路在参数解析之前（两路由测试锁）
- **生效面**：`/api/sessions` 与 `/api/export/sessions.csv` 同契约（导出是过滤视图快照）；导出全量翻页循环**每页**带同一阈值（无重无漏不变量扩展到过滤子集——600 窗内+300 窗外行夹具锁：第二页丢条件会被计数断言当场抓获）；与 `?directory=` 组合 AND 交集；**目录面板零影响**（面板间零耦合）
- **SQL 组织**：`SESSION_RANGE_FILTER_SQL` 与 `SESSION_DIRECTORY_FILTER_SQL` 并列单点常量；绑定顺序 `directory → range 阈值 → limit → offset`（SQL 捕获测试四形态字节级锁定，无过滤分支与 0.9.0 前字节一致）
- **缓存键四维**：`sessions:[limit,offset,sort,order,directory,range]`——range 维用**原始词**（非 Date.now() 派生阈值，阈值每毫秒漂移会摧毁缓存），空串与缺省共享键，非法词 400 在缓存写入之前（键数零增，测试锁）
- **前端**（复用趋势图 `.range-switch` 胶囊样式，零新体系）：面板顶部 `全部 | 7 天 | 30 天 | 90 天` 分段控件（词表单点 `SESSION_RANGE_OPTIONS`，UI 只产合法值）；三态贯穿（加载骨架/空态/表格均保留选择器，空结果不锁死用户）；controller 缓存键四维扩维 `sort:order:directory:range`——**键内 directory 走 URL 编码**（盘符 `:` 消除分段歧义）+ 四维快照竞态守卫（「token 仍新但 range 已切走」的晚到者被弹掉，新测试钉住）；三维正交（切范围不清目录/排序、下钻不清范围）；导出 URL 双参数单点拼接（directory 在前 range 在后，`rangeQueryParam`/`directoryQueryParam` 并列）；导出按钮 title 四组合按过滤态更新；脚注追加范围段（服务端参数先于客户端模型过滤的既有顺序）；mock 词表外非空值抛错（镜像 400，不发脏数据）、total 置 null 降级（同 v0.7.0 理由）
- fake-insight-db 补 range 最小镜像（否则阈值侵占 limit 绑定槽——v0.7.0 directory 镜像同先例）
- 测试 282 → **299**（+17：三态解析器+冻结时钟阈值算术+9 非法词+原型链敌意键、真实 SQL 各窗命中+边界 `>=` 钉死、directory×range 四象限交集、SQL 捕获四形态、API 400 词族、503 先行、缓存键维度、导出快照+翻页带 range、组件四态切换/缓存分键/快照守卫/导出单点/脚注/mock 双侧边界）
- 真实库探针 16/16：7d/30d/90d 单调命中（284/387/500）、行行在窗、空串=全量、400 含词表、导出行数=列表行数（284=284 全量翻页不截断）、directory×range 叠加行行双条件、目录面板零影响

## [0.8.1] - 2026-10-07 · v0.8.0 增量审查修复

@oracle 对 v0.8.0 增量的审查（P0 零 / P1 零 / P2×2）发现项的修复版本。导出链路核心承诺全部审查确认：转义完备（活库 828 行实测含引号/逗号/CJK 标题，引号包裹+翻倍形态正确）、BOM+CRLF 字节级正确（EF BB BF）、全量翻页确定性终止、注入面闭合（SQL 参数绑定 + href 双重编码）、缓存零占用、.md 路由零扰动。

### Fixed
- **P2-1 格式回归**：session-list.js 两语句被 0.8.0 挤进一行（分号分隔语义等价、行为零变化）——恢复两行，消 diff 噪声与后续编辑踩坑面
- **P2-2 恰好整页边界测试缺口**：多页集成夹具原只有 502 行（整页+短页），未锁"行数恰为翻页大小整倍数"时的终止语义——补 500-exact 真实 SQLite 测试（记录数精确 501、id 零重复、首末行排序不变形、跑完即终止证明）

## [0.8.0] - 2026-10-07 · 导出增强：会话汇总 CSV（双车道）

### Added
- **`GET /api/export/sessions.csv`**：会话汇总 CSV 导出（后端）——九列固定序 `id,title,modelId,agent,directory,timeCreated,timeUpdated,tokens,cost`；RFC 4180 转义（含逗号/双引号/CRLF/CJK 的标题为 torture 夹具主敌，内嵌引号翻倍、CJK 不触发包裹）；每记录 CRLF 结尾；**UTF-8 BOM**（Excel 中文不乱码）；`Content-Type: text/csv; charset=utf-8` + `Content-Disposition: attachment`；**全量翻页**——按页拉取（每页 500 钳位上限）直到短页，`id ASC` 决胜保证无重无漏（活库 827 行端到端验证不截断）
- **目录过滤复用**：`?directory=` 契约与 /api/sessions 完全一致（URLSearchParams 解码、精确匹配、缺省/空=全量、miss=仅表头 200——过滤语义非回退）；排序固定 sessions 默认序（time_updated desc + id ASC，注释钉住"导出是快照不是视图"）；一次性点击**不走缓存**（`resultCacheSize === 0` 测试锁）
- **前端导出入口**：会话面板脚注「导出 CSV」文字链接（`.sort-reset` 脚注动作语言的延伸，样式同款）；原生 `<a href download="sessions.csv">` 零 JS——Content-Disposition attachment 双保险；**URL 编码单点** `directoryQueryParam`（fetchSessions 与导出共用，无两处漂移）；携带当前目录过滤（controller 状态透传，不另存副本，切目录后旧 href 自然消失）；**mock 模式渲染期常量隐藏**（dev 预览无真实路由，不闪现）；悬停 title 按过滤态说明导出的是服务端全量视图（与列表分页/模型客户端过滤无关）
- CSV 构造独立模块 `src/web/session-summary-csv.ts`（纯函数，不塞 api.ts）
- 测试 269 → **281**（+12：纯函数 torture 逐行字节级断言 + mini RFC 4180 parser 往返、真实 SQLite 集成（默认序证明/目录子集/miss/502 行多页翻取）、api-routes（路由匹配+5 错拼 404/503 短路/响应头/缓存零条目）、组件（URL 单点/双态/stale href））
- 既有单会话 `.md` 导出路由零改动

## [0.7.1] - 2026-10-07 · v0.7.0 增量审查修复

@oracle 对 v0.7.0 增量的审查（P0 零 / P1 零 / P2×1）发现项的修复版本。

### Fixed
- **可点目录行恢复悬停读全路径**（P2-1）：0.7.0 挂下钻交互时误把 name-cell 的全路径 title 一并摘除（行级"点击过滤"提示取代了它）——真实路径普遍很长，CSS 截断后无法悬停读全。修复：name-cell 路径 title **恒保留**，行级操作提示仅在可点时叠加（嵌套 title 语义：悬停名称区显示路径、悬停行其余区域显示操作提示）。补断言：可点行的 name cell 保留全路径 title

### 审查确认（证据）
- 双车道交付质量高：SQL 单点常量与逐字节回归锁真实（对照 0.6.1 模板原文）、绑定顺序 [directory, limit, offset] 与占位符一致、注入面 5 恶意值坍缩字节相同、URLSearchParams `+` 语义正确走通道、fake 错位 hack 良性（漂移即响亮失败非静默假绿）、三维竞态守卫的 token-抓不住窗口被新测试钉住、chips/属性/脚注全走 escapeHtml、空串目录行三层自洽（上游 /api/directories 本就排除空串，组件守卫是防御性冗余）、mock 过滤态 total=null 与真实源天然一致、隐私零命中
- 备注 N 无需行动：活库无空格/CJK 路径（特殊字符面由夹具持有）

## [0.7.0] - 2026-10-07 · 目录→会话下钻过滤（全栈）

### Added
- **`GET /api/sessions?directory=<项目目录路径>`**：精确下钻过滤（后端）——参数化 `WHERE directory = ?`（值只经绑定参数进 SQLite，其余 token 全编译期字面量）；**缺省/空串 → 无过滤**（默认 SQL 与 0.6.1 逐字节一致，硬编码字面量回归锁）；**匹配不到 → 空数组 200**（过滤语义 ≠ sort/order 的回退语义，合法结果不抛错）；SELECT 列单与 WHERE 谓词各为单点常量（无过滤/过滤两形状不可能漂移）；缓存键扩维 `sessions:[limit,offset,sort,order,directory]`（空串与缺省同键）；URLSearchParams 解码，中文/空格/引号路径精确匹配
- **目录面板行可点下钻**（前端）：非空目录行挂 `.selectable`，toggle 语义与模型排行榜完全对齐（选中行再点=取消）；选中行 `.selected` 高亮；**空串目录行不挂下钻**（后端契约空串=无过滤，点了会自相矛盾——宁可不做，注释钉住）；无回调纯展示行为与 0.6.1 一致
- **目录过滤+模型过滤叠加**：两过滤正交可叠加（目录服务端参数、模型客户端行过滤）；面板头部 chips 枚举化（目录/模型各带独立 ✕）；脚注先目录后模型再排序描述；空态文案按叠加组合区分（双叠加空态提示"试试取消其中一个"，不被误读成库空）
- **controller 三维扩维**：状态与缓存键 `sort:order:directory`（键无碰撞——sort/order 白名单无冒号，盘符 `D:/` 的冒号无歧义）；`changeSort` 维持 directory、`changeDirectory` 维持 sort（两维互不干扰）；竞态守卫升三维快照（token 匹配但目录快照漂移的窗口被独立校验钉住——缓存命中不增 token 路径）；默认请求路径与 0.6.1 逐字节一致（空/缺省不携带参数）
- **mock 契约对齐**：`getMockSessions(sort, order, directory)` 精确匹配、miss=空数组、过滤态 total 置 null（真实源本就裸数组）；dev 模式目录下钻行为与真实源一致
- 测试 258 → **269**（+11：真实 SQLite 夹具——精确子集/特殊字符目录/注入面绑定锁/默认 SQL 字节回归/过滤×排序叠加/分页；api-routes 缓存维度/503；组件——下钻 toggle/空串行不可下钻/chips 叠加/空态文案/mock 契约；竞态——目录维度缓存分键/快照漂移守卫）

## [0.6.1] - 2026-10-07 · v0.6.0 增量审查修复

@oracle 对 v0.6.0 增量的审查（P0 零 / P1 零 / P2×1）发现项的修复版本。

### Fixed
- **costCell 亚分值边界**（P2-1）：降级判定从原始值挪到舍入之后——`0 < cost < 0.005`（如 0.004）此前 `toFixed(2)` 后为 0 仍渲染 `"$0"`，恰好踩进降级设计想避免的形态；现在亚分值与精确 0 同走 "—" 降级，"0 与未记录同义"语义自洽。活库数据免疫（最小非零 cost 0.13，探针实证），纯潜伏洞。补夹具行 + 断言：亚分值永不渲染 "$0"

### 审查确认（证据）
- 五键列头映射与后端白名单一一对应；更新时间格式化与创建时间逐 token 相同；初始箭头零特判、首点翻转契约正确；新列两插值点无用户可控文本（XSS 面安全）；断言反转与既有测试零冲突、1970 epoch 断言时区稳定；mock cost 全 0 忠实活库常态（823 行 822 行 cost=0）；隐私零命中
- 备注 N-1/N-2（KPI 卡口径为"参照"非"逐字复刻"、负值忠实透传）无需行动

## [0.6.0] - 2026-10-07 · 会话列表补更新时间 / Cost 两列，五排序键全可达

### Added
- **更新时间列**（sort 键 `time_updated`）与 **Cost 列**（sort 键 `cost`）：列布局 `标题 | 模型 | Agent | 创建时间 | 更新时间 | Tokens | Cost`——时间两列相邻、Cost 紧挨 Tokens，数字列右对齐，零新样式
- **五键全量闭环**：后端五个排序白名单键全部有可见列头，0.5.0 审查备忘的"无可见列不设入口"缺口关闭
- **初始态箭头自然涌现**：默认 time_updated desc 现对应可见列——初始渲染即带 ▼ + `.sorted` 高亮（组件零特判，isSorted 匹配即亮）；脚注逻辑不变（默认态纯文本、非默认态 `.sort-reset` 重置入口）

### Changed
- **Cost 格式化口径**（不新造口径）：`$` + 原始值（kpi-card 惯例），浮点噪声截两位；**0 / null / 非有限数 → "—"** + 说明 title（本库 cost 字段常为 0，DESIGN §5；0 与"未记录"同义，避免满屏 `$0`）——降级惯例同 model-table hitRateCell
- 更新时间格式化与创建时间列逐字相同：`formatRelative` 显示 + `formatDateTime` 悬停
- mock 核对：buildSessions 的 timeUpdated/cost 字段齐全无需补；cost 保持全 0 忠实 DESIGN §5 实值——dev 模式 Cost 列"—"降级路径正是真实库常态
- 测试 257 → **258**（+1 新增：两新列渲染与点击路由/初始箭头反转断言；+1 更新：sortable 数 3→5、data-sort-key 五键深比较、初始态由"无 sorted"反转为"time_updated 恰一个 sorted + 箭头"）

## [0.5.1] - 2026-10-07 · v0.5.0 增量审查修复

@oracle 对 v0.5.0 增量的审查（P0 零 / P1 零 / P2×3）发现项的修复版本。

### Fixed
- **脚注查表防原型链**（P2-1，纪律闭环）：`SORT_LABEL_BY_KEY[sortKey] ?? 默认` 改为 `Object.hasOwn()` 先行判断——原型链键（`toString`/`__proto__`/`constructor`）回退默认 label，不再渲染继承函数串。与 0.4.1 后端 hasOwn 纪律对称，新增 hostile 键渲染测试三例
- **守卫与缓存分键测试化**（P2-2）：排序接线从 app.js 平铺逻辑抽为可注入依赖的 `components/session-sort-controller.js`（Map 缓存 + 序列守卫 + 状态持有，app.js 只装配，~70 行迁出、行为零变化）；新增竞态测试三例——晚到响应不落 DOM 但入缓存槽（切回零请求命中）、同组合重叠请求只渲染晚 token、被顶掉的 reject 静默丢弃而当前请求 reject 出错误态并可按在屏排序重试。oracle 逐行推演过的两条主打行为首次获得可持续自动化锁
- **默认排序回路**（P2-3，UX 补齐）：非默认排序态下脚注排序描述变为可点击重置入口（`.sort-reset`，沿用列头 hover 语言），点击回默认 time_updated desc——走既有回调与缓存命中路径，零新列零新组件；默认态与纯展示用法保持纯文本

### 备注
- N-2 钉进模块头注释：controller 缓存键现为 `sort:order`，将来分页参数化必须扩为 `limit:offset:sort:order`
- 测试 252 → **257**（+5：原型链脚注 ×1、重置入口 ×1、竞态 ×3）

## [0.5.0] - 2026-10-07 · v0.2-B 前端收尾：会话面板排序接线

### Added
- **会话列表排序交互**（v0.2-B 前端收尾）：列头点击范式与模型排行榜一致（复用 `th.sortable` 样式，零新样式体系）——点击新列 desc 起步、同列再点切方向；排序归属服务端，组件只产出 `(sortKey, sortOrder)` 交回调重新请求 `/api/sessions?sort=&order=`，客户端不重排（保住分页确定性契约）
- **列→sort 键映射**：标题→`title`、创建时间→`time_created`、Tokens→`tokens`；`time_updated`（默认）与 `cost` 无可见列不设入口（不新造列，保证默认视图与 0.4.1 一致）；初始态无箭头，脚注动态说明当前排序
- **缓存按 sort:order 组合分键** + 请求序列守卫（慢响应晚到不覆盖当前排序）；排序切换缓存命中立即渲染、未命中先上骨架
- **前端契约默认值单点**：`DEFAULT_SESSION_SORT_KEY/ORDER` 从 data-source.js 导出，组件与 app 统一取用；**默认组合不携带 sort/order 参数——默认请求路径与 0.4.1 逐字节一致**
- mock 会话分支补齐排序语义：白名单解析（含 `Object.hasOwn` 防原型链键，与 0.4.1 后端修复同款）、非法回退默认、`id ASC` 决胜、码元序 title
- index.html 会话面板补「点击列头排序」提示；测试 249 → **252**（+3：sortable 列头渲染/脚注/行序钉死、点击回调与方向翻转、mock 白名单回退与决胜）

### Changed
- **dev 模式（mock）会话默认序 `time_created desc` → `time_updated desc`**：对齐后端契约（0.4.0 起真实 API 默认即 time_updated desc），消除 dev 漂移；每次在副本上排序，共享基准 payload 不受影响

## [0.4.1] - 2026-10-07 · v0.4.0 增量审查修复

@oracle 对 v0.4.0 增量的审查（P0 零 / P1×1 / P2×2）发现项的修复版本。

### Fixed
- **sort 白名单原型链洞**（P1-1，活库复现）：`?sort=toString` 等 Object.prototype 键经 `in` 运算符原型链通过白名单检查，继承函数被 string 化进 SQL → 永久 500，违反"非法回退默认"契约。修复：`Object.hasOwn()` 替换 `in`（resolveSessionSortOrder 用严格等值比较，无同类问题）；三处测试 hostile 清单补入 toString/__proto__/constructor（红→绿：修复前三处全红、API 层以 500 失败；修复后全绿）；真机探针验证三键 200 且回退默认序
- **title 排序 collation 夹具**（P2-2）：夹具改混大小写对（`Date`/`datebook`），期望序列仅在 BINARY collation 下成立——锁住 schema collation 语义假设
- **N-2 注释**：JS 重排比较器 id 决胜的 UTF-16/UTF-8 序一致性假设（ASCII id）钉进注释

### Docs
- CHANGELOG 0.4.0 的兼容性声明按审查结论改写为如实描述：默认排序键与 0.3.1 相同；并列行 `id ASC` 为新增确定性钉死（0.3.1 对并列顺序本就未指定）；活库 top-200 默认页经探针验证与旧 SQL 逐字节一致（原"逐值一致（测试锁）"声明两半都不成立，已撤回）

## [0.4.0] - 2026-10-07 · v0.2-B sessions 服务端排序

### Added
- **`GET /api/sessions?sort=&order=`**：服务端排序参数（v0.2-B，backlog 清空）——sort 白名单 `time_updated`（默认）/ `time_created` / `tokens`（三列合成）/ `cost` / `title`，TS 常量 map 键→固定 SQL 片段，原始输入永不进 SQL 文本；order 默认 desc、仅接受 `asc`/`desc`；非法/缺省回退默认（与 limit 同语义，不发 400）
- **确定性分页**：`ORDER BY <白名单片段> <方向>, id ASC` 次级键——同键并列翻页不重复不跳行
- **缓存键** `sessions:[limit,offset,sort,order]` 用白名单解析后的值（非法值与默认同键，不膨胀缓存）
- 测试 241 → **249**（+8）：真实 `node:sqlite :memory:` 夹具对拍（10 种白名单组合、tokens-asc 与 JS 重排逐值一致、并列翻页确定性、垃圾回退字节级 deepEqual、注入面 SQL 白名单正则锁）+ api-routes 缓存变体/503
- **默认行为兼容**：默认排序键与 0.3.1 相同（time_updated desc）；并列行新增 `id ASC` 确定性次级键——0.3.1 对并列行的相对顺序本就未指定，0.4.0 将其钉死（活库当前 top-200 默认页经真实库探针验证与旧 SQL 输出逐字节一致）；fake sessions 分支不镜像排序语义、归属真实夹具（发布清单 #2）

## [0.3.1] - 2026-10-07 · v0.3.0 增量审查修复 + 隐私加固

@oracle 对 v0.3.0 增量的审查（P0 零 / P1×3 / P2×5）发现项的修复版本；测试 233 → 241。

> 本版本与 0.3.0 的功能内容已合并为单一提交发布（原 0.3.0 提交因含真实目录路径示例被历史重写移除）。

### Fixed
- **隐私残留清零**（P1-1，硬红线）：docstring 示例与测试夹具中的真实机器路径全部换为虚构占位（`D:/projects/example-alpha` 等），全库按正反斜杠与真实用户名双形态 grep 零命中；此教训同步进发布清单（见下）
- **守恒锁升级为真实 SQL 结构回归锁**（P1-3）：queryDirectoryStats 加入 `node:sqlite` `:memory:` 受控夹具测试（test/directory-stats-sql-parity.test.ts，5 用例）——零步目录在列、NULL/空串排除、非对象/非法 JSON 不计步、守恒、三键排序全部由**真实 SQL 语义**锁定，LEFT→INNER 退化现在会红
- **目录面板入库测试**（P1-2）：renderDirectoryPanel 进 web-components.test.ts（恶意 directory 双插入点转义锁——文本节点 + title 属性；null/空列表降级占位）
- **前后端 name 推导对拍锁**（P2-5）：6 个固定样例同时喂后端 directoryDisplayName 与前端 pathLastSegment，逐值相等 + 硬编码锚点双保险——双镜像同漂也红
- **mock 会话数同源恒等**（P2-2）：目录面板会话数改挂 overview.sessionCount 同源链，四视图（目录/生存/overview/sessions）mock 恒等，镜像真实后端单一 COUNT(*) 同源性
- **distributeByLargestRemainder 退化契约**（P2-3）：全零权重 + 正总量 → throw（原静默返回全零违反守恒契约）；零/负总量 → 全零数组（自洽）
- **fake 谓词补齐**（P2-1）：fake 目录分支步数过滤补上 json_valid+object 镜像，与真实 SQL 语义一致
- **过期注释三处**（P2-4）：router.ts 路由数表述改为不绑定数字；smoke 注释改为漂移安全表述；api.ts 缓存键补命名说明

### Added
- **发布清单**（oracle 建议采纳）：新增前端面板必须同时进 web-components.test.ts；新增 SQL 聚合必须进真实 SQLite 受控夹具测试；推送前隐私扫描必须同时覆盖正斜杠与反斜杠两种路径形态

## [0.3.0] - 2026-10-06 · v0.3-A 按项目目录统计

### Added
- **`GET /api/directories?limit=10`**：按项目目录统计——目录排行（原样完整路径 + 展示名末段切分 / 会话数 / assistant 步数 / 最近活跃 MAX time_updated），全量口径无 days 窗口；limit 默认 10、钳位 1..50（查询与缓存键均用钳位值）；排序三键确定性（steps desc → sessions desc → directory asc，JS 比较器拥有 wire 顺序）；NULL/空 directory 排除出列表与 totals（真实库恰 1 条，探针实证）
- **src/db/directory-queries.ts**：steps 复用 scan-conventions 的 ASSISTANT_OBJECT_DATA_PREDICATE 单点口径（无副本）；`COUNT(DISTINCT s.id)` 防 LEFT JOIN 扇出；totals 由全量分组结果派生（守恒由构造保证）
- **前端目录统计面板**（components/directory-panel.js）：榜单行 = 展示名 + 完整路径次行（全插入点 escapeHtml）+ 步数条形（以榜首为基准，适配长尾形态）+ 会话/步数/最近活跃列；meta 行「共 N 目录 · M 会话」；`.span-both` 全宽区块；<720px 折叠最近活跃列
- **mock**：getMockDirectoryStats 从 simulated.points 统一随机源按最大余数法分摊（各目录 steps 求和 === mock trend 同口径总步数，精确守恒）；distributeStepsAcrossHours 泛化为 distributeByLargestRemainder（顺修零返回硬编码长度隐患）
- format.js 新增 pathLastSegment（双分隔符切分 / 尾分隔符 / 回退原串，前后端 mock 共用）
- 测试 222 → **233**（+11：目录查询 8 + api-routes 2 + 真实库 smoke 1）——含守恒锁（Σ sessions === totalSessions、Σ steps === 全库 assistant 行数）与排序确定性（fake 故意无序返回反证 JS 排序）

### Fixed
- router.ts 路由注册遗漏风险补位：/api/directories 接入 InsightRoute union 与分发（实现轨道的最小必要越域改动，已复核）

## [0.2.1] - 2026-10-06 · v0.2.0 增量审查修复

@oracle 对 v0.2.0 增量代码的审查（P0 零 / P1×2 / P2×6，含真实库探针验证）发现项的修复版本；测试 208 → 222。

### Fixed
- **hour-heatmap 窗口口径对齐**（P1-1）：bucketStepsByHourAndWeekday 新增窗口下界参数（最老一天本地零点），slack 行不再入格——修复前 days=1 时窗口实为 48h（偏差可达 100%）；顺带跳过 timeCreated<=0 的 1970 落格理论变体。**跨路由守恒回归测试**：同 days 下 heatmap 步数总和 === trend steps 求和（先红后绿复现）
- **谓词/时间口径单点化**（P2-3）：新建 src/db/scan-conventions.ts（ASSISTANT 谓词、DAY_MS、下推 floor 与回收窗口成对导出），trend/heatmap/compaction 全走同一构建器，消除"注释同步"漂移入口
- **缓存键钳位**（P2-6）：trend 与 hour-heatmap 的 cache key 均用 Math.min(days, 366)，days=1000 与 366 不再各占缓存槽
- **fake 的 SQLite reason 语义修正**（P2-2）：布尔→"0"/"1"、对象→JSON 文本等，并加 node:sqlite 内存库权威联测锁 fake↔真实语义一致（含非法 JSON 文本/SQL NULL 形状）
- **前端死代码清理**（P2-1）：删除 fetchTodo / todo-card 的不可达 null 分支，注释对齐真实契约（db 不可用统一 503）
- **mock 保真度**（P2-4）：survival 键名对齐真实库（succeeded/failed/interrupted/none）、compaction reason 对齐（auto/manual/unknown）、heatmap mock 改从 simulated.points 最大余数法精确分摊（守卫 mock 内部跨视图步数守恒）；顺带修复 getMockHourHeatmap 忽略 days 参数的 bug；回放夹具 reason 对齐真实库
- **tooltip swatch 白名单**（P2-5）：swatch 只接受 var(--x) / #hex 形态，恶意值静默不渲染色块，关闭 style 注入 sink

### Added
- **前端组件入库测试**（P1-2）：test/web-components.test.ts（10 用例，薄 DOM 垫片）——五个新区块的渲染/转义/占位断言进入 npm test 回归网；strictHitRate 前后端镜像对拍测试（同 fixture 逐值相等，后端口径将来一改即红）

## [0.2.0] - 2026-10-06 · v0.2-A 统计补全

### Added
- **GET /api/hour-heatmap?days=90**：7×24 时段习惯热力（168 格零填充，本地时间分桶，assistant 步骤计数）；看板新增 7×24 SVG 热力区块（复用日历热力分档配色，hover 单层转义提示）
- **GET /api/session-survival**：会话存活统计（中位存活时长 / 短命占比（<5 分钟）/ idle 结局分布）；看板新增存活卡片
- **GET /api/compaction**：压缩事件统计（总数 / 按 reason SQL 聚合（缺失归 unknown）/ 近 30 日零填充升序 / Top 10 会话）；看板新增压缩面板（30 柱迷你趋势 + Top 会话点击进回放）
- **GET /api/todo 前端消费**：todo 完成率卡片（完成率 + 分状态 4 段进度条）
- **回放页严格命中率**：回放头部新增 strictHitRate 指标（前端复刻 hit-rate.ts 公式并逐位对拍一致），旁注口径"cache.write 计入分母"
- 新查询文件 src/db/behavior-queries.ts（SQL 侧聚合，不物化 data 全文，沿用 aggregate-queries 口径纪律）
- 测试 194 → 208（behavior-queries 13 + 路由注册 1 + api-routes 扩展）

### Changed
- 日历热力组件导出分档配色函数供热力区块复用；format.js 新增 formatDuration（秒 → 人类可读时长）
- verify-install.ps1 升级为真"一键安装自验证"：未注册时脚本自跑 `opencode plugin add`（首装），已注册走 `plugin update`，验证链完全复用；注册检查改为事后重读——首装实测 VERIFY OK（v0.1.2 @ eaf5902 五项全 PASS，update 路径 654c6fd 亦过）

### Docs
- DESIGN.md 新增 §3.1 仓库目录树章节（模块职责逐目录标注）；§6 路由表补齐 v0.2-A 三条新路由与此前遗漏的 /api/todo

### 真机验证（T7.3 服务侧，v0.1.2 阶段完成）
- 插件经宿主重启后加载：双实例 127.0.0.1:18789/18790（端口重试按设计工作），health 均 `{"status":"ok","version":"0.1.2","dbStatus":"ok"}`
- `insight-server-port` storage 键实证持久化于 opencode.db（OpenCode V2 插件 storage 落库）；看板 HTML 在线
- TUI 三命令冒烟待用户在终端实测

## [0.1.2] - 2026-10-06 · 增量审查修复

@oracle 对 v0.1.1 修复代码的增量审查（含真实 node:sqlite 探针验证）发现项的修复版本；测试 194 用例全绿（191 + 3 新增）。

### Fixed
- **overview 聚合口径对齐**（P1-1）：queryOverview 改用与 trend/models/agents 相同的"多路径 json_extract + JS coerceNumber"模式——单路径 json_extract + SQLite 算术会把文本 token `'12abc'` 前缀解析成 12、布尔 `true` 转成 1（旧 JS 口径均按 0）；today 边界改回 toLocalDateKey 比较，不再 CAST(time_created)；parity fixture 补文本/布尔/null/文本时间戳四类奇异形状，对账闸门从此能暴露此类分歧
- **连接守卫真实文案与结构化判别**（P2-1）：致命错误判定升级为 code === ERR_INVALID_STATE 优先 + ERR_SQLITE_ERROR 的 SQLITE_CORRUPT/SQLITE_NOTADB errcode，文案匹配降为兜底并补入语句级真实文案 "statement has been finalized"
- **守卫回调引用判别**（P2-2）：旧连接延迟报错不再把新打开的健康连接置 null（引用判别替代 null 判别，防 fd 泄漏）
- 移除仓库根目录三个 `_probe*.ts` 调试残留（P2-3）
- verify-install.ps1：upstream 分支推导替代硬编码 origin/master、Push-Location/Pop-Location 保护调用方 cwd（P2-4）

### Added
- tasks.md 增设 v0.2 结构化执行计划（启动门槛 = T7.3 真机验证；v0.2-A 统计补全五项 / v0.2-B 低优先项 / 已知限制三条）

## [0.1.1] - 2026-10-06 · 发布前全项目审查修复

@oracle 全项目审查（2 P0 / 7 P1 / 17 P2）后的修复版本；测试 191 用例全绿，前端离线冒烟 147 断言全绿。

### Fixed — P0
- **P0-1 大库同步全表扫描**：四统计路由改 SQL 侧聚合（json_extract 只取 token 数值与 model id，不物化 data 全文）+ days 下推 time_created；实测冷缓存 overview/trend/models ~350-570ms、**agents 3940ms → 630ms**（工具指纹改 content 数组快路径直取 + 长数组 json_each 回退，只抽小字段三元组）
- **P0-2 tooltip XSS**：showTooltip 的 title/label/value 全部经 escapeHtml（注入源：MCP 工具名、modelId）

### Fixed — P1
- listen 失败路径先关 db 再抛出；teardown 先 close server 再 best-effort 清 storage；setup 失败先 close 再抛
- db 运行中失效自愈（致命错误签名守卫置 null 重开）+ /api/health 改真实探活（SELECT 1）
- close 竞态：shuttingDown 标志，关闭后不再重开连接
- Host 头校验：仅 127.0.0.1/localhost[:port]，否则 403（防 DNS rebinding 读走会话内容）
- TTL 缓存加 64 条上限（防无界增长）；session-list 空态/脚注/renderError 转义

### Fixed — P2（节选）
- 导出层截断代理对安全、标题折叠换行、notice `*` 转义；findSessionSummaryById 改直接 WHERE id=；空消息会话 404 文案与"不存在"区分；500 只回 internal error；面板 interval 惰性启动；providerId 取首个非空；explicitSessionId typeof 守卫；前端 fetch 15s 超时 + 范围切换竞态守卫、20 万条消息 min/max 循环化、排序稳定化、hash 编解码往返、日历 DST 安全步进

### Added
- scripts/verify-install.ps1：推送后一键安装自验证（HEAD 已推送 → plugin update → registry commit 一致 → 落盘版本/文件树镜像 → opencode.json 注册；未安装时引导 plugin add，退出码区分）

## [0.1.0] - 2026-10-06 · 首个可用版本（M0~M7）

### 发布摘要
- **Web 看板**（127.0.0.1:18789 起，占用自动+1）：KPI 卡（环比 ▲▼ / sparkline / 🟢🟡 精度标签）、逐日堆叠趋势、52 周日历热力图、工具条形图、Token 漏斗、模型排行榜（10 列排序下钻）、会话列表
- **单会话回放**：角色时间线（🧑/🤖/💭/🔧/🔔）+ turn 级成本条 + 系统提示词面板 + 大会话分块加载 + 旧表会话 404 文案
- **导出**：/api/export/session/:id.md 与 /insight-export 命令，角色分节 Markdown 落盘 ./insight-exports/
- **终端面**：/insight（打开看板）、/insight-status（今日用量/命中率/模型 TOP5/7 日条形，60s 刷新）
- 技术债闭环：queryAssistantStepRows 上提为 queries.ts 导出（SQL 全收敛 §4 达成）、toast 助手单一实现
- 测试 165 用例全绿（含真实库集成）

（以下为各里程碑明细）

## [M1] 取数层与聚合

### Added
- 只读 DB 访问层（node:sqlite 特性探测 + 全部查询函数）、统计聚合纯函数（命中率/模型指标/agent 指纹/会话存活/小时热力/60s TTL 缓存）、node:test 测试套件 67 用例全绿（含真实库冒烟，库缺失自动跳过）。
- T1.1 实测决策：Bun 1.4.0 与 Node 24 均支持 node:sqlite，无需 better-sqlite3 回退。

## [M5-core] 导出渲染器（M5 核心部分，服务端路由与命令待接）

### Added
- 会话 Markdown 导出渲染器（src/export/）：角色分节标注（🧑用户/🤖助手/工具调用/系统指令/模型切换/压缩事件）、自适应围栏转义、4000 字符工具输出截断、系统提示词尾节；10 用例测试全绿。

## [M2] Web 服务与 API

### Added
- HTTP 服务（src/web/，仅绑定 127.0.0.1）：默认端口 18789、占用自动 +1 重试（≤10 次）、close() 释放端口与 db；router/api/static-files/request-handler 分层，路径穿越防护
- API 路由（DESIGN §6 全表）+ 60s TTL 缓存；db 不可用→503、旧表会话→404；插件装配写入实际端口到 storage
- 测试 42 用例（含真实库 fetch 集成、端口重试链、10 并发、teardown 复绑证明）

## [M3-skeleton] 看板前端骨架（mock 数据）

### Added
- 15 文件零构建前端（src/web/public/）：KPI 卡（in/out 分列、▲▼ 环比、sparkline、🟢🟡 精度标签）、uPlot 堆叠面积趋势（按模型分色+图例开关+命中率折线）、52 周日历热力图、工具条形图、Token 漏斗、模型排行榜（10 列排序+下钻）、会话列表（→ #/session/:id 占位）
- 深浅双主题（CSS 变量 + prefers-color-scheme）、区块级容错（独立加载/空态/错误重试）、窄屏响应式
- data-source 单一数据入口（USE_MOCK 开关，联调只改一处）；DOM-shim 冒烟 41/41、量级断言 13/13

## [M5] 导出路由与命令

### Added
- GET /api/export/session/:id.md（text/markdown + RFC 5987 中文附件名；404/503 错误约定）
- /insight-export 斜杠命令：无参 dialog.select 最近 20 会话，进程内直连查询层+渲染器，落盘 ./insight-exports/；全防御式 context 访问
- slug/文件名纯函数（中文保留、非法字符替换、代理对安全截断）、flattenSystemPromptForExport、fake-insight-db 测试基座
- 测试 24 用例（8 文件名 + 7 路由含真实库集成 + 6 命令含写盘失败容错 + fake db 基座）

## [M3-wiring] 看板联调接线

### Changed
- data-source.js 切换到真实 API（USE_MOCK=false）：overview/trend/models/agents/sessions 五路 fetch + 形状适配器单独导出
- trend/sessions 裸数组兼容（byModel 空时趋势降级为总量单层、sessions 无 total 时脚注降级）；模型表无 cacheSupported 时按 hitRate===0 判定"通道无缓存"
- 日历窗口 371→366 对齐后端 MAX_TREND_DAYS；顶栏接 /api/health 探活
- KPI 对账实测：overview.todayTokens === /api/trend 末日总量（86,178,515 一致）

## [M4] 单会话回放视图

### Added
- #/session/:id 回放页：角色时间线（🧑用户/🤖助手/💭reasoning 折叠/🔧工具块含超长折叠/🔔系统与压缩事件斜体行）
- turn 级成本条：缓存读/实付/输出三段分色 + hover token + ⚑ 模型切换标
- 系统提示词折叠面板（instruction key 分块展示）；旧表会话 404 → 专门文案
- 大会话性能：>200 条消息"加载更多"分块渲染 + 会话切换渲染竞态守卫
- 组件：session-replay/replay-timeline/replay-turn-bar + replay.css（深浅主题走既有变量）
- 离线验证：esbuild 18/18、M4 冒烟 46/46（fetch 打桩回真实后端裸形状）

## [M6] 终端面板与命令

### Added
- /insight 命令：storage 读端口 → 三平台打开浏览器（win start/darwin open/xdg-open），非回环 URL 拒绝，失败降级 toast 手动 URL
- /insight-status 面板：今日总量+命中率、模型 TOP5 横条、近 7 日字符条形；60s 定时刷新、teardown 清理、db 连接即用即关
- 数据卫生：db 缺失/异常 →「db-insight: 数据不可用」；空结果 →「今日暂无用量」；行宽 ≤40 字符（代理对安全）
- tui-context/command-registry/status-panel-{data,text,controller} 模块化拆分；tui.tsx 薄装配（Solid signal）
- 测试 29 用例（命令矩阵 8 + 面板文本/采集/控制器 12 + 注册与 slot 6 + fake db 扩展）

### Technical Debt（M7 处理）
- status-panel-data.ts 重复一条只读 SELECT（queries.ts 无今日分组导出），建议上提为 queries.ts 导出
- showInsightToast 在 tui-context.ts 与 export-command.ts 各一份，M7 合并

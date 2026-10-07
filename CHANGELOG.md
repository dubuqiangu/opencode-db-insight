# Changelog

本项目的所有显著变更记录在此文件中。
格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [SemVer](https://semver.org/lang/zh-CN/)。
每个里程碑完成后 push 并在此追加一条记录，方便回溯。

## [Unreleased]

（暂无——下一批变更记录于此）

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

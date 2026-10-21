# tasks.md

> 每个任务小而可独立验证；完成一项勾一项。每完成一个里程碑（M0~M7）：
> commit → push → 在 CHANGELOG.md 记一条。

## M0 骨架与文档（push #1）

- [x] T0.1 写 DESIGN.md（架构/数据面/API/图表选型/风险）——验证：本文档评审通过
- [x] T0.2 写 tasks.md ——验证：与 DESIGN.md 交叉核对无缺口
- [x] T0.3 项目骨架：package.json（官方契约 exports）、src/index.ts 与 src/tui.tsx 空插件占位、.gitignore、LICENSE、README 骨架 ——验证：`npm install` 后 esbuild 两个入口均通过
- [x] T0.4 git init + 首次 commit + 建 GitHub 仓库 + push ——验证：`git log` / 远端可见；推送前完成敏感信息扫描（无真实用户名/绝对路径/凭据）
- [x] T0.5 业界调研结论合并进 DESIGN §2.3/§5/§7（图表选型校准 + 精度标签 + 两级回放）——验证：文档交叉核对无矛盾

## M1 取数层与聚合（push #2）

- [x] T1.1 **实测 node:sqlite 可用性**——✅ Bun 1.4.0 与 Node 24 均可用（readOnly 连接真实库查询正常），决策已写入 DESIGN §4，无需回退
- [x] T1.2 `src/db/queries.ts`：db 路径解析 + 只读连接 + 全部 SQL（overview/trend/models/agents/sessions/messages/instruction_blob/todo）——✅ 连真实库冒烟全通过（67 用例 0 失败；schema 已实测校准：time 为 epoch-ms、model JSON 用 providerID 键、tool part 名在 name 字段、instruction_state→instruction_blob 关联）；注意：Node v24.14.1 Windows 下 `node --test test/` 目录形式不可用，test 脚本已改为 node 内建 glob `test/*.test.ts`
- [x] T1.3 `src/stats/`：纯聚合函数——hitRate、dailyBuckets、modelMetrics（步均输出/中位/p95/推理占比/活跃区间）、agentFingerprint、sessionSurvival、hourHeatmap——✅ 单测覆盖正常值/空数组/除零/单条数据/日期边界（本地午夜与当日最后 1ms 同桶）/时钟倒挂
- [x] T1.4 进程内缓存层（60s TTL，key=路由参数）——✅ 单测命中/过期/独立 key/清空（src/stats/cache.ts：buildCacheKey + cachedResult，M2 API 层直接包裹）

## M2 Web 服务（push #3）

- [x] T2.1 `src/web/server.ts`：127.0.0.1 绑定、端口占用自动+1（最多 10 次，可注入 serverFactory 测试）、teardown 关闭（closeAllConnections 释放 keep-alive + 关 db）、/api/health——✅ 真实 socket 测试通过：teardown 后端口可用裸 server 复绑证明真正释放；两台 server 同端口实测 EADDRINUSE 重试链；10 并发请求全 200
- [x] T2.2 API 路由装配（DESIGN §6 全表）+ JSON 错误约定（db 缺失→503）——✅ /api/{health,overview,trend,models,agents,sessions,todo} + /api/session/:id/{messages,system-prompt} 全路由实测（真实库 fetch 集成测试 109 用例全绿）；坏参数回落默认值（days=abc→30）；旧表会话 404 "session not found in current tables"；60s TTL 缓存按 函数名+参数 包裹全部查询；index.ts 已装配真实 server 并把实际端口写入 storage（insight-server-port），db 路径可经 storage（insight-db-path）覆盖
- [x] T2.3 静态文件服务 `src/web/public/`——✅ 探活实测：/ 与组件/样式/vendor 全部 200、路径穿越（/../ 与 %2e%2e）均 404、服务干净退出

## M3 看板前端（push #4）

- [x] T3.1 KPI 卡片行 + 布局骨架 + 深浅色主题；卡片含环比 ▲▼、sparkline、精度标签——✅ 骨架完成（mock 数据，DOM-shim 冒烟 41/41）；真实数据验证随 T3.7
- [x] T3.2 逐日趋势（uPlot 堆叠面积图按模型分色 + 命中率折线）——✅ 同上
- [x] T3.3 模型/agent 环形图 + 工具条形图（手写 SVG）——✅ 同上（工具条形图 + agent 维度）
- [x] T3.4 模型排行榜明细表（10 列、列头排序、下钻过滤）——✅ 同上；小时热力格未做（排入 v0.2 备选）
- [x] T3.5 52 周日历热力图（GitHub 式）——✅ 骨架完成（371 天窗口，非零日分位 5 档）
- [x] T3.6 Token 漏斗（上下文供给→缓存命中→实付输入→输出）——✅ 骨架完成，各层从同一逐日序列推导，口径与 KPI 一致
- [x] T3.7 联调接线：data-source.js 的 USE_MOCK 切到真实 API——✅ 真实服务对账：overview.todayTokens === /api/trend 末日总量（86,178,515 一致）；trend/sessions 裸数组、ModelMetric 无 cacheSupported（按 hitRate===0 判定）全部与适配器吻合；静态页 200

## M4 单会话回放（push #5）

- [x] T4.1 会话列表页（分页/排序）→ 点击进回放——✅ 真实 sessions 端点接入（无 total → 脚注降级文案），hash 路由往返冒烟通过
- [x] T4.2 回放视图：角色时间线 + 系统提示词折叠面板——✅ 真实会话探活（250 条消息、tokens/content 形状正确、system-prompt 200）；fixtures 248 条含压缩/超长工具输出全断言
- [x] T4.3 旧表会话回放降级提示——✅ 实测 legacy id → 404 "session not found in current tables"，前端专门文案
- [x] T4.4 turn 级成本条——✅ 缓存读/实付/输出三段分色 + hover + ⚑ 模型切换标，冒烟断言通过

## M5 Markdown 导出（push #6）

- [x] T5.1 服务端导出渲染 `/api/export/session/:id.md`——✅ 真实库集成测试：200 + text/markdown + attachment 头（RFC 5987 中文文件名）+ 正文含角色分节；404/503 错误约定全测
- [x] T5.2 `/insight-export` 斜杠命令（无参弹出最近 20 会话选择；导出到 ./insight-exports/）——✅ 逻辑层 6 用例全绿（fake context + tmp 目录落盘 + 四条失败路径容错）；TUI 真机冒烟排入 M7

## M6 TUI 面板（push #7）

- [x] T6.1 `/insight` 打开浏览器命令（跨平台 open + toast 显示端口）——✅ 三平台命令矩阵 + 非回环 URL 拒绝 + storage 缺失/异常降级全测；真机冒烟排 M7
- [x] T6.2 `/insight-status` 终端面板：今日总量/命中率/模型 TOP5/7 日字符条形——✅ 单次扫描喂四组件、60s 刷新 + teardown 清理、连接即用即关；真机冒烟排 M7
- [x] T6.3 数据卫生：面板限量渲染、异常静默——✅ null→"数据不可用"、空结果→"今日暂无用量"、行宽 ≤40 字符（代理对安全）、TOP5 截断

## M7 收敛与发布（push #8）

- [x] T7.1 对照 DESIGN.md 逐项核验（需求→设计→任务→实现双向追溯），缺口回填——✅ 双向对账完成（§4/§5/§6/§8/§9/§10 逐条比对实现与 tasks.md 勾项）；发现 8 处差异已整理成决策清单交付（小时热力未接 API/前端、会话存活与压缩事件有口径无消费、strictHitRate 未接线、/api/sessions 排序参数缺、状态面板降级 toast 而非 dialog、导出文件名时间戳粒度、导出目录 §8 与 §9 表述冲突、sqlite 打开方式用 readOnly 选项而非 mode=ro URI）——按任务约定差异交用户决策，不回填 DESIGN.md
- [x] T7.2 README 完整化：安装（github:add 三方式）/更新/卸载/验证/排障——✅ README 重写完成：一句话简介+功能清单（三条斜杠命令、看板六区块、回放）、安装三方式表格（官方 add 推荐 / git clone / opencode.json file://，注明单方式）、plugin update/remove/list 验证命令（更新需重启）、使用说明（端口 18789 起 +1 重试、./insight-exports/、db 路径通用写法）、排障表（看板未启动/数据不可用/旧表 404/0% 命中率/日志位置）、与 usage-meter 互补、MIT；全文无本机绝对路径与用户名，todo 等未上前端的指标已按实测降级表述
- [ ] T7.3 `opencode plugin update` 后重启实测全部功能 + 卸载重装干净
- [ ] T7.5 v0.1.0 版本号 + CHANGELOG 汇总 + 用户验收

## v0.2 执行计划（待 T7.3 真机验证通过后启动）

**启动门槛**：T7.3 真机验证（plugin add + 重启 + 三命令冒烟）必须先通过——P1-3（storage 跨插件可见性）若失败，/insight 命令修复优先于一切 v0.2 功能。

### v0.2-A 统计补全（已完成，push #11，2026-10-06）

- [x] A1 小时×星期热力：/api/hour-heatmap 路由 + 7×24 SVG 热力区块（复用日历热力分档配色）——✅ 真实库联测 168 格序正确，冷 545ms / 缓存命中 1ms
- [x] A2 会话存活统计：/api/session-survival 路由 + 存活卡片（中位时长/短命占比/idle 结局条）——✅ 结局计数守恒 789==789
- [x] A3 压缩事件统计：/api/compaction（byReason SQL 聚合 + 近 30 日 + Top 10）+ 压缩面板——✅ 双守恒 54==54，byReason SQL 侧聚合不物化 data
- [x] A4 strictHitRate 接线到回放页头部并注明口径——✅ 前端复刻公式与 hit-rate.ts 原版逐位对拍一致（0.91603 ↔ 91.6%）
- [x] A5 前端消费 /api/todo（todo 完成率卡片，4 段进度条）——✅ 70.2% mock 验证 + 段宽合计精确 100%
- [x] 版本 0.2.0（后端三路由 + 前端五区块），测试 194 → 208 全绿

### v0.2-B 低优先改进（可选拆批）
- [x] B1 /api/sessions 服务端排序参数（当前客户端排序够用；若 v0.2-A 的区块增多触发表格重构再一并做）——✅ 0.4.0 已落地（push #14，见下文「v0.2-B sessions 服务端排序」节；backlog 清空自述见 0.4.0 节）

### 已知限制（记录在案，不修）
- content part type 为奇异形状（如数组）时新旧提取器极少数分歧——真实数据不出现，parity 测试覆盖正常形状
- unix 下运行中删除 opencode.db：连接持有 fd 继续服务冻结快照，guard 无法感知（Windows 下删除被锁文件直接失败同样不触发）——README 已有排障说明基础
- 首屏冷缓存 6 路由串行约 2.5s 同步阻塞（23k 行规模，60s TTL 后归零）——随库增长需再评估（如改为 worker 线程聚合）

## v0.1.1 审查修复（push #9，2026-10-06）

- [x] @oracle 全项目审查（2 P0 / 7 P1 / 17 P2 + 测试盲区清单）
- [x] P0-1 SQL 侧聚合 + days 下推 + agents 快路径优化——✅ 实测：overview/trend/models 350-570ms、agents 3940→630ms；对账测试快照去竞态后全绿
- [x] P0-2 tooltip XSS + P1-7 空态/脚注转义——✅ 前端冒烟 147/147（smoke-xss 14 断言：恶意工具名/modelId 按文本呈现）
- [x] P1-1/2/4/5/6 生命周期、自愈、Host 校验、缓存上限——✅ 各配针对性测试（server-resilience 6 用例）
- [x] P2 全部 17 项（含前端 fetch 超时/竞态、DST 安全、稳定排序、hash 往返）——✅ smoke-dst 子进程跨 America/New_York 两次 DST 切换验证
- [x] scripts/verify-install.ps1 推送验证脚本——✅ 首装引导分支冒烟通过；完整链路待 plugin add 后实测
- [x] 版本 0.1.0 → 0.1.1（package.json / lock / INSIGHT_VERSION 三处同步）

## v0.1.2 增量审查修复（push #10，2026-10-06）

- [x] @oracle 增量审查 v0.1.1 修复代码（P0 零 / P1×1 / P2×4，含真实 node:sqlite 探针验证）
- [x] P1-1 overview 口径对齐（多路径 json_extract + coerceNumber，fixture 补 4 类奇异形状）——✅ 对账闸门全绿，计时复核 overview 606ms 无回归
- [x] P2-1 守卫结构化判别（ERR_INVALID_STATE / SQLITE_CORRUPT / SQLITE_NOTADB + 语句级真实文案）——✅ 探针实测三类错误形状，恢复链对齐真实宿主
- [x] P2-2 守卫回调引用判别——✅ 交错场景测试：旧连接延迟报错不废新连接
- [x] P2-3 删除 _probe*.ts 调试残留（3 文件）
- [x] P2-4 verify-install.ps1 upstream 推导 + cwd 保护——✅ 冒烟通过（exit 2 首装引导、cwd 不变）
- [x] 版本 0.1.1 → 0.1.2（package.json / lock / INSIGHT_VERSION 三处同步）；测试 194/194

## v0.2.1 增量审查修复（push #12，2026-10-06）

- [x] @oracle 增量审查 v0.2.0 代码（P0 零 / P1×2 / P2×6，含真实库探针）
- [x] P1-1 heatmap 窗口回收 + 跨路由守恒测试（先红后绿：days=1 复现 actual 2 expected 1）——✅ 真实库复测 16/16
- [x] P1-2 前端组件 DOM 垫片测试入库（10 用例）+ strictHitRate 镜像对拍锁——✅ 后端口径变更将触发测试红
- [x] P2-2 fake SQLite reason 语义修正 + node:sqlite 内存库权威联测
- [x] P2-3 scan-conventions.ts 单点化（谓词/floor/回收窗口）
- [x] P2-6 trend+heatmap 缓存键钳位
- [x] P2-1 fetchTodo 死代码删除（前端轨道）
- [x] P2-4 mock 保真度对齐真实库 + heatmap mock 统一随机源分摊（前端轨道，顺带修 days 参数透传 bug）
- [x] P2-5 tooltip swatch 白名单防注入（前端轨道）
- [x] 版本 0.2.0 → 0.2.1；测试 208 → 222 全绿

## 审查收敛备忘（2026-10-06，v0.2.1 后）

三代审查-修复循环后判定收敛，暂不启动第四代增量审查，依据：
- 发现量级逐代收缩：0.1.0 全项目（2P0/7P1/17P2）→ 0.1.1 修复审查（1P1/4P2）→ 0.2.0 审查（0P0/2P1/6P2，P1 为测试覆盖与口径会计类）
- 历次审查抓的漂移类别已全部有入库回归锁：SQL 口径（sql-aggregation-parity + 跨路由守恒测试）、前端镜像（strictHitRate 对拍锁）、组件渲染/转义（web-components.test.ts）、谓词单点（scan-conventions.ts）
- 0.2.1 修复为 oracle 处方 + 红绿复现 + 活实例（127.0.0.1:18789/18790）端到端实证
- 残余风险由 TUI 三命令冒烟（用户侧）与上述回归网承担；下次 src/ 运行时变更时按版本纪律正常走实现→审查→修复

## v0.3-A 按项目目录统计（push #13，2026-10-06）

- [x] 真实库探针定契约：804 会话 / 16 非空目录 / 1 NULL 排除 / 无大小写变体 / 无孤儿消息 / 长尾形态（top1 占 ~69% 会话）
- [x] 后端（fix-14）：src/db/directory-queries.ts（共享谓词单点 + COUNT(DISTINCT) 防扇出 + JS 确定性排序）+ /api/directories 路由（limit 钳位、缓存键用钳位值、503/500 同构）+ router.ts 注册 + 版本 0.3.0——233/233 全绿，check 0
- [x] 前端（des-12）：directory-panel.js（全插入点 escapeHtml、榜首基准条形、.span-both 全宽）+ loader + mock 统一随机源分摊（steps 求和 === trend 精确守恒）——23 断言冒烟全绿
- [x] 收敛复核：233/233 独立复跑 + 独立服务真机联测 14/14（含与裸 SQL 逐值对拍 16 目录 / 804 会话 / top1 554 会话 26276 步、limit 钳位、totals 不截、前端资产接线）
- [x] 文档：DESIGN §3.1 树（+3 文件、测试数 233）、§5 目录维度行、§6 路由表 +/api/directories、CHANGELOG 0.3.0
- [x] oracle 增量审查 0.3.0 delta → 有 P0/P1 则修后推 0.3.1——✅ 已完成，审查结论与修复即下节「v0.3.0 增量审查修复（v0.3.1）」

## v0.3.0 增量审查修复（v0.3.1，2026-10-07）

- [x] @oracle 审 v0.3.0 delta：P0 零 / P1×3 / P2×5；核心链路（LEFT JOIN 谓词位置、扇出防护、守恒、钳位缓存、XSS 链）真实库探针实证通过
- [x] P1-1 隐私残留清零（硬红线）：真实目录路径全部换虚构占位——该问题是 v0.3.0 发布扫描的正则盲点（只查了反斜杠形态，漏了正斜杠同形态），已修流程（见发布清单）
- [x] P1-3 真实 SQLite 结构回归锁：directory-stats-sql-parity.test.ts 5 用例（零步目录在列 / 排除语义 / 非法形状不计步 / 守恒 / 排序）——LEFT→INNER 退化现在会红
- [x] P1-2 目录面板入库测试：恶意 directory 双插入点转义锁 + null/空列表降级占位
- [x] P2-1 fake 步数谓词补 json_valid+object 镜像
- [x] P2-2 mock 会话数同源恒等（目录/生存/overview/sessions 四视图恒等）
- [x] P2-3 distributeByLargestRemainder 全零权重 throw 契约
- [x] P2-4 过期注释三处；P2-5 pathLastSegment↔directoryDisplayName 对拍锁
- [x] 版本 0.3.1；测试 233 → 241 全绿
- [x] 历史清理：c3c1c0d..HEAD 压合为单一干净提交发布（原 0.3.0 提交含真实路径，force-push 移除，tag v0.3.0 删除并以 v0.3.1 取代）

## 发布清单（oracle 建议采纳，v0.3.1 起生效）

1. **新增前端面板** → 必须同时进 test/web-components.test.ts（转义双插入点 + 降级占位用例）
2. **新增 SQL 聚合** → 必须进真实 node:sqlite :memory: 受控夹具测试（锁 SQL 结构语义，不能只靠 fake JS 镜像）
3. **推送前隐私扫描** → 路径形态正则必须同时覆盖正斜杠与反斜杠两种写法（本版教训：只查反斜杠漏掉了正斜杠形态才放走真实路径）、裸词（本机盘根目录名）与精确用户名双查；测试夹具/docstring 示例一律用虚构占位（example-a / example-user 级），不用活库真实值
4. 契约钉死 → 双轨并行 → 收敛复核（独立复跑测试 + 真实库探针）→ 扫描 → 推送 → oracle 增量审查 → 修复闭环

## v0.2-B sessions 服务端排序（push #14，2026-10-07）

- [x] 契约：sort 白名单（time_updated/time_created/tokens/cost/title）TS 常量 map 键→SQL 片段、order 白名单、非法回退默认、id ASC 确定性次级键、缓存键含排序维度
- [x] 实现（fix-15）：queries.ts 白名单 + 解析函数 + querySessionList 排序参数；api.ts 路由解析 + 缓存键；版本 0.4.0 三处同步
- [x] 测试 241 → 249：真实 SQLite 夹具对拍（10 组合/JS 重排一致/并列翻页/注入面正则锁/垃圾字节级回退）+ api-routes 缓存变体/503
- [x] 收敛复核：249/249 独立复跑 + check 0 + 真实库路由探针 8/8（默认形状/升序/降序/垃圾 deepEqual 回退/三页无重复无跳行/time_created 端到端）
- [x] 文档：DESIGN §6 路由表 sessions 行、CHANGELOG 0.4.0
- [x] oracle 增量审查 0.4.0 delta：P0 零 / P1×1（sort 白名单原型链洞，活库复现）/ P2×2（兼容性声明失实 / collation 夹具）——P1+P2 修复后推 0.4.1

backlog 清空：v0.2-A（0.2.0）、v0.3-A（0.3.1）、v0.2-B（0.4.0）全部落地

## v0.4.1 修复 0.4.0 审查发现项（push #15，2026-10-07）

- [x] P1-1 sort 白名单原型链洞：Object.hasOwn 替换 in 运算符——`?sort=toString/__proto__/constructor` 从永久 500 恢复为回退默认序；三处测试 hostile 清单补键（红→绿：修复前三红含 500 断言、修复后全绿）；真机探针 5/5（三键 200 + deepEqual 默认 + tokens asc 回归）
- [x] P2-2 title 夹具混大小写对（Date/datebook），锁 BINARY collation 假设
- [x] P2-1 兼容性声明改写为如实描述（CHANGELOG 0.4.0 条目，orchestrator 执行）
- [x] N-2 UTF-16/UTF-8 序一致性假设注释
- [x] 版本 0.4.1 三处同步；249/249 全绿（清单喂入不增测试数）、check 0
- 按"审查收敛备忘"，0.4.1 为 oracle 处方修复（红→绿 + 真机实证 + 回归锁），不再派下一代审查

## v0.5.0 v0.2-B 前端收尾：会话面板排序接线（push #16，2026-10-07）

- [x] 缺口识别：v0.4.0 排序 API 就绪但前端不携带 sort/order、面板无排序控件（data-source.js:210 核实）——"API 就绪但用户摸不到"
- [x] 实现（des-14，des-13 因提供方 503 中断后重派）：列头点击范式对齐 model-table；排序归服务端（组件只出 (sortKey, sortOrder) 回调，客户端不重排）；缓存按 sort:order 分键 + 请求序列守卫；DEFAULT_SESSION_SORT_KEY/ORDER 契约默认单点；默认组合不携带参数（默认请求路径与 0.4.1 逐字节一致）
- [x] 列→键映射：title/time_created/tokens 三列可排序；time_updated/cost 无可见列不设入口（不新造列）；脚注动态说明当前排序
- [x] mock 会话分支契约对齐：白名单（含 Object.hasOwn 防原型链）+ 回退 + id ASC 决胜 + 码元序 title；dev 默认序 time_created desc → time_updated desc（消除 dev 漂移，对齐真实 API）
- [x] 测试 249 → 252（+3 组件入库：sortable 列头/脚注/行序钉死、点击回调与方向翻转、mock 白名单回退）；DOM shim 扩展（addEventListener/click/querySelectorAll 复合选择器）
- [x] 收敛复核：252/252 独立复跑 + check 0 + 独立服务探针 7/7（新资产含排序契约、index 提示、默认 API 零变化、sort=title asc 端到端）
- [x] 文档：CHANGELOG 0.5.0
- [x] oracle 增量审查 0.5.0 delta：P0 零 / P1 零 / P2×3（脚注查表原型链 / 守卫缓存零测试覆盖 / 默认排序无回路）——全部修复后推 0.5.1

## v0.5.1 修复 0.5.0 审查发现项（push #17，2026-10-07）

- [x] P2-1 脚注查表 hasOwn 防原型链（toString/__proto__/constructor 回退默认 label，纪律闭环）+ hostile 渲染测试
- [x] P2-2 controller 抽取：app.js 平铺逻辑 → `components/session-sort-controller.js`（Map 缓存 + 序列守卫，app 只装配，行为零变化）+ 竞态测试三例（晚到不落 DOM 但入缓存 / 重叠请求晚 token 胜 / 陈旧 reject 丢弃、当前 reject 出错误态可重试）
- [x] P2-3 脚注重置入口：非默认态"按X排序"可点击回默认 time_updated desc（走既有回调与缓存命中路径）；默认态/纯展示保持纯文本
- [x] N-2 注释钉住：缓存键 `sort:order`，分页参数化时必须扩 `limit:offset:sort:order`
- [x] 版本 0.5.1 三处同步；257/257（+5）；check 0；独立服务探针 6/6（controller 资产/hasOwn/重置入口/app 装配/默认 API 回归）
- 按"审查收敛备忘"，0.5.1 为 oracle 处方修复（红→绿 + 竞态回归锁 + 探针实证），不再派下一代审查
- v0.2-B 前端收尾完整闭环：实现（0.5.0）→ 审查 → 修复（0.5.1）

## v0.6.0 会话列表补更新时间/Cost 两列（push #18，2026-10-07）

- [x] 用户拍板里程碑：补齐 0.5.0 审查备忘的"无可见列不设入口"缺口，五排序键全可达
- [x] 实现（des-14）：列布局 标题|模型|Agent|创建时间|更新时间|Tokens|Cost；更新时间→time_updated、Cost→cost；初始态 time_updated 列头带 ▼+sorted（isSorted 匹配即亮，零特判）；cost 降级"—"+说明 title（本库 cost 常 0，DESIGN §5）；格式化复用既有口径（formatRelative/formatDateTime/$+kpi-card 惯例）
- [x] mock 核对：timeUpdated/cost 字段齐全无需补；cost 全 0 忠实实值——dev 模式"—"降级即真实库常态
- [x] 测试 257 → 258（+1 新增、+1 更新：sortable 3→5、data-sort-key 五键深比较、初始箭头反转断言、两新列点击路由）
- [x] 收敛复核：258/258 独立复跑 + check 0 + 独立服务探针 11/11（五键映射/降级渲染/重置入口/默认 API/sort=cost desc 端到端）
- [x] 文档：CHANGELOG 0.6.0
- [x] oracle 增量审查 0.6.0 delta：P0 零 / P1 零 / P2×1（costCell 亚分值 "$0" 边界，活库免疫纯潜伏）——修复后推 0.6.1

## v0.6.1 修复 0.6.0 审查发现项（push #19，2026-10-07）

- [x] P2-1 costCell 降级判定挪到舍入之后：0.004 等亚分值与精确 0 同走 "—"，不再渲染 "$0"（一行修复，orchestrator 直接执行）；夹具补 ses_example_foxtrot cost=0.004 + 断言永不出现 "$0"
- [x] 版本 0.6.1 三处同步；258/258（断言增强不增测试数）；check 0
- 按"审查收敛备忘"，0.6.1 为 oracle 处方修复（一行 + 断言锁），不再派下一代审查

## v0.7.0 目录→会话下钻过滤（push #20，2026-10-07，双车道并行）

- [x] 用户拍板里程碑：点目录面板行 → 会话列表按该项目目录过滤（全栈）
- [x] 契约钉死：?directory= 精确匹配参数化 WHERE；缺省/空=无过滤（默认 SQL 与 0.6.1 逐字节一致）；miss=空数组 200（过滤语义≠回退语义）；缓存键 sessions:[limit,offset,sort,order,directory]；URLSearchParams 解码
- [x] 后端（fix-15）：SESSION_LIST_SELECT_SQL/SESSION_DIRECTORY_FILTER_SQL 单点常量；querySessionList 第 6 参 directoryValue；真实 SQLite 夹具 4 测试（精确子集/特殊字符/注入面字节锁/叠加分页）+ api-routes 3（缓存维度/503/端到端）；fake 最小目录镜像
- [x] 前端（des-14）：目录行可点 toggle 对齐模型下钻；空串行不挂下钻（自洽决定）；chips 枚举化（目录/模型叠加独立清除）；controller 三维扩维 sort:order:directory（键无碰撞论证）+ 三维竞态快照守卫（token 匹配目录漂移窗口钉住）；mock 契约对齐（miss=空、过滤态 total=null）
- [x] 测试 258 → 269（+11：后端 7 + 组件 4）
- [x] 收敛复核：版本 0.7.0 三处同步（协调方统一 bump）+ 合并 269/269 独立复跑 + check 0 + 真实库探针 9/9（真实目录 575 会话命中行行同目录/空串=缺省/miss=空 200/过滤×排序叠加/注入形值零泄漏）
- [x] 文档：CHANGELOG 0.7.0
- [x] oracle 增量审查 0.7.0 delta：P0 零 / P1 零 / P2×1（可点目录行悬停路径 affordance 回退）——修复后推 0.7.1

## v0.7.1 修复 0.7.0 审查发现项（push #21，2026-10-07）

- [x] P2-1 name-cell 路径 title 恒保留（行级操作提示叠加不取代，嵌套 title 语义并存）；断言改 container 级扁平查询（DOM shim 平铺无子树，行级 querySelector 必空——踩过一次记入）
- [x] 版本 0.7.1 三处同步；269/269（断言增强不增测试数）；check 0
- 按"审查收敛备忘"，0.7.1 为 oracle 处方修复（一行 + 断言锁），不再派下一代审查
- v0.7.0 目录下钻完整闭环：双车道实现 → 审查 → 修复（0.7.1）

## v0.8.0 导出增强：会话汇总 CSV（push #22，2026-10-07，双车道并行）

- [x] 用户拍板里程碑：全库/按目录过滤 CSV 导出（浏览器下载入口）
- [x] 契约钉死：/api/export/sessions.csv 九列固定序、RFC 4180 + CRLF + UTF-8 BOM、?directory= 复用 /api/sessions 过滤契约、固定默认序（快照非视图）、一次性不走缓存、attachment 响应头
- [x] 后端（fix-15）：session-summary-csv.ts 纯函数模块（escapeCsvField/renderSessionSummaryCsv）；router [export, sessions.csv] 三段分支（.md 四段零改动）；api case 全量翻页（每页 500 钳位，短页终止，id ASC 决胜无重无漏）；真实 SQLite 集成（502 行多页锁）+ api-routes（5 错拼 404/503/响应头/缓存零条目锁）
- [x] 前端（des-14）：脚注「导出 CSV」链接（.sort-reset 语言延伸）；原生 <a download> 零 JS；directoryQueryParam 编码单点（fetchSessions 共用）；mock 渲染期常量隐藏不闪现；切目录后 stale href 自然消失（测试钉死）
- [x] 测试 269 → 281（+12）
- [x] 收敛复核：版本 0.8.0 三处同步（协调方统一 bump）+ 合并 281/281 独立复跑 + check 0 + 真实库探针 10/10（BOM 字节级 ef bb bf/表头/全量 827=827 不截断/过滤 576=576 行行同目录/miss 仅表头——注意 fetch().text() 的 TextDecoder 默认剥 BOM，BOM 判定必须走 arrayBuffer 字节级，探针假阴性已甄别）
- [x] 文档：CHANGELOG 0.8.0
- [x] oracle 增量审查 0.8.0 delta：P0 零 / P1 零 / P2×2（一行格式回归 + 恰好整页边界测试缺口）——修复后推 0.8.1

## v0.8.1 修复 0.8.0 审查发现项（push #23，2026-10-07）

- [x] P2-1 session-list.js 两语句恢复两行（格式回归，行为零变化）
- [x] P2-2 补 500-exact 真实 SQLite 边界测试（记录数精确 501 / id 零重复 / 首末行排序不变形 / 跑完即终止证明）；页大小 500 为模块局部常量不可注入，故直接 500 行夹具
- [x] 版本 0.8.1 三处同步；282/282（+1）；check 0
- [x] 审查确认面（证据入 CHANGELOG）：转义完备（活库 828 行实测）、BOM/CRLF 字节级、全量翻页确定性、注入面闭合、缓存零占用、.md 路由零扰动
- 按"审查收敛备忘"，0.8.1 为 oracle 处方修复，不再派下一代审查
- v0.8.0 导出增强完整闭环：双车道实现 → 审查 → 修复（0.8.1）

## v0.9.0 时间范围筛选（push #24，2026-10-07，双车道并行）

- [x] 用户拍板里程碑：会话列表按 timeUpdated 时间窗过滤（7d/30d/90d 预设）
- [x] 契约钉死：`?range=` 词表 7d|30d|90d；缺省/空=全量；未知非空 → 400 响亮失败（防 typo 静默回退）；epoch-ms 阈值服务端按请求时刻计算、参数化绑定；生效面 /api/sessions + /api/export/sessions.csv 同契约；目录面板零耦合；缓存键四维（range 用原始词非漂移阈值）
- [x] 后端（fix-15）：SESSION_RANGE_FILTER_SQL 单点常量 + resolveSessionRange 三态解析（Object.hasOwn 防原型链 500）；绑定顺序 directory→range→limit→offset 四形态字节锁（无过滤分支与 0.7.0 前字节一致）；导出翻页每页带阈值（600+300 行夹具锁第二页丢条件）；fake-insight-db 补 range 最小镜像（防阈值侵占 limit 槽，v0.7.0 同先例）；+11 测试
- [x] 前端（des-14）：.range-switch 胶囊分段控件（词表单点、零新样式体系）；三态贯穿（骨架/空态/表格均保留）；controller 四维缓存键 + 键内 directory URL 编码消盘符歧义 + 四维快照竞态守卫；三维正交互不清除；导出 URL 双参数单点拼接（directory 前 range 后）+ title 四组合；脚注范围段；mock 词表外抛错镜像 400、total=null 降级；+6 测试
- [x] 测试 282 → 299（+17）
- [x] 收敛复核：版本 0.9.0 三处同步（协调方统一 bump）+ 合并 299/299 独立复跑 + check 0 + 真实库探针 16/16（单调 284/387/500、行行在窗、空串=全量、400 含词表、导出 284=284 翻页不截断、双叠加、目录面板零影响——探针自身一次 base 前缀笔误已甄别非实现问题）
- [x] 文档：CHANGELOG 0.9.0
- [x] oracle 增量审查 0.9.0 delta：P0 零 / P1 零 / P2×1（range 时间敏感维度 vs 前端永生缓存）——修复后推 0.9.1

## v0.9.1 修复 0.9.0 审查发现项（push #25，2026-10-07）

- [x] P2-1 时间窗视图绕过缓存（des-14）：按视图判定非按动作判定——非空 range 一律绕过缓存读写（堵住"仅 changeRange 绕过"的动作面漏洞，range 视图下切排序/目录也直取）；空 range 保持完整缓存；renderCurrent"保证有内容"语义（模型过滤路径不卡死骨架）；已知代价（主题切换时间窗视图不重取配色）注释钉住；改写 1 + 新增 1 测试（35→36），既有稳定维度测试零改动通过
- [x] 版本 0.9.1 三处同步；300/300（+1）；check 0
- 按"审查收敛备忘"，0.9.1 为 oracle 处方修复，不再派下一代审查
- v0.9.0 时间范围筛选完整闭环：双车道实现 → 审查 → 修复（0.9.1）

## v0.10.0 回放内搜索（push #26，2026-10-07，纯前端单车道）

- [x] 用户拍板里程碑：回放页消息内搜索/高亮，提升长会话回放体验
- [x] 侦察（exp-2）先行：消息全量在内存（分页仅渲染层）→ 纯前端可做，无后端车道；文本提取纯函数已存在可共享；正文全 textContent（节点级高亮零 XSS 面）
- [x] 契约钉死：搜索范围与渲染口径一致；大小写不敏感（两侧同 lower）；命中计数跨全消息 + 上一处/下一处导航；分页区命中驱动 appendNextChunk 追加定位；节点级高亮（replay-hit/replay-hit-current，不做 <mark> 文本级）；清空即复原；切换会话状态清零
- [x] 实现（des-14）：查找栏挂时间线面板头（全前端首输入框，样式借面板语言）；输入即搜 + 200ms 防抖；Enter/Shift+Enter/Esc 键盘约定；replay-message-text.js 单点（五提取函数迁出共享 + buildReplaySearchIndex 预计算索引）；索引 i ↔ 时间线节点 i 对齐不变量（同谓词同序，通知行占位空 haystack 不脱位）；DOM shim 第三次扩展（value/classList/fire/children/fragment）
- [x] 收敛探针实证缺口并补齐：工具入参 state.input 渲染可见却不在契约五类内（"opencode" 差值 1077/4073≈26%）→ readToolInput 逐字镜像渲染形态（JSON.stringify null,2）入搜索面（六类），补齐后差值 39/540≈7%（剩余 step-start 等不渲染面正确不可搜）；des-14 提请的 replay-search.js 注释/tooltip 漂移由协调方直接修（六类同步）
- [x] 测试 300 → 306（+6，回放 DOM 首次有测试）；探针甄别两次探针自身断言错误（谓词入参形态、跨会话比较）均非实现问题
- [x] 版本 0.10.0 三处同步（协调方统一 bump）+ 合并 306/306 独立复跑 + check 0
- [x] 文档：CHANGELOG 0.10.0
- [x] oracle 增量审查 0.10.0 delta：P0 零 / P1 零 / P2×1（readToolInput 镜像缺结构性联动）——修复后推 0.10.1

## v0.10.1 修复 0.10.0 审查发现项（push #27，2026-10-07）

- [x] P2-1 readToolInput 结构单点化（des-14，审查修法②）：buildToolPartElement 删内联序列化改消费单点（行为零变化，镜像方向反转为消费）；新增渲染→搜索单向包含性集成锁（renderTimeline 渲染工具块 → 参数 pre textContent 必须出现在对应 haystack 中，再内联变形即响亮失败）；42 → 43 组件测试
- [x] 审查确认面（证据入 CHANGELOG）：5876 行真实会话通知行占位逐位实证、失败回合空 haystack 无害、防抖/记账/分页驱动/零残留全真锁、shim 扩展无假绿方向偏差、跨渲染防抖泄漏闭包隔离无行为缺陷
- [x] 版本 0.10.1 三处同步；307/307（+1）；check 0
- 按"审查收敛备忘"，0.10.1 为 oracle 处方修复，不再派下一代审查
- v0.10.0 回放内搜索完整闭环：侦察 → 单车道实现 → 探针实证缺口补齐 → 审查 → 修复（0.10.1）

## v0.11.0 趋势图 byModel 真实化（push #28，2026-10-08，双车道并行 + wire 对账）

- [x] 用户拍板里程碑：看板数据增强（侦察后钉定性价比最高方向——趋势图按模型分层，前端堆叠图早已建好唯独缺真实数据）
- [x] 契约钉死：/api/trend 逐日 byModel（点级 Record、每日稠密零填充、键序全窗总量 desc + id asc 决胜、Σ=点总量构造性、聚合在 JS、wire 保持裸数组向后兼容）；mock 为 wire 参照
- [x] 后端（fix-15）：json_extract 增补 $.model.id 行级提取 + bucketDailyTrend 按 (日,模型) 分桶；DailyTrendPoint.byModel 必填 + DailyTrendSample.modelId；排序键注释+测试双锁；真实 SQLite 夹具手工对账 + parity 夹具自动扩展 + 窗口外模型不泄漏锁
- [x] 前端（des-14）：normalizeTrendPayload 直通（初版对象封装形态）+ fetchOverview 交叉消费点改 normalize 拆包（KPI 推导端到端钉死）+ rankModels 序列构建面测试
- [x] wire 形状对账（des-15，前一会话网络故障失联后新会话接手）：双车道 wire 分歧——独立服务探针实证真实 wire=裸数组+点级 Record，前端归一层改点级透视适配、封装分支 YAGNI 移除、mock 镜像真实 wire（不再领先一格）、测试按真实形状重整（降级路径保持）
- [x] 测试 307 → 321（+14）
- [x] 收敛复核：版本 0.11.0 三处同步（协调方统一 bump；lock 内 @pkgjs/parseargs 0.11.0 为传递依赖巧合非误改）+ 合并 321/321 独立复跑 + check 0 + 真实库探针 19/19（7/30 天双窗透视 10/34 层、逐日对位、Σ 模型层=点总量、确定性、消费面可吃、mock 同形）
- [x] 文档：CHANGELOG 0.11.0
- [x] oracle 增量审查 0.11.0 delta（ora-6）：P0=0 / P1=0 / P2×4 信息级——无 0.11.1。审查证据：321/321 独立复跑 + 活库只读探针（30/366 天全链路、活库无 unknown 桶、残差 ≥0 逐日实证）+ delta 全文隐私扫描零命中
- P2 备忘（ora-6，信息级不修，随下版处理）：① daily-buckets 契约注释补"纯数字 modelId 的 JS 整数键枚举序例外"（消费面全序自证不受影响）；② mock 与后端在零总量模型上语义分叉 + Math.round 近似守恒（量级不可见，可接受）；③ days=366 稠密 byModel 使 wire ~716KB 恰落在不用 byModel 的日历热力图消费点（模型数×数量级增长时再缓解，YAGNI）

## v0.12.0 模型排行榜占比列（push #29，2026-10-08，双车道并行）

- [x] 用户拍板里程碑：C 模型排行榜占比列（/api/models 增补 tokenShare + 前端占比列）
- [x] 侦察（exp-4）：/api/models 无参数 JS 聚合路由、面板与 overview 同源同口径（Σ 模型 tokens ≡ overview.totalTokens）、reasoningShare 现成占比列模式、renderModelTable 组件测试零覆盖、mock getMockModelMetrics 在位
- [x] 契约钉死：tokenShare 原始 0..1 分数（显示端格式化）、computeModelMetrics 纯函数层自 Σ 分母、分母 0 → 全 0、排序键不动（share desc ≡ tokens desc 数学等价）、SQL/路由/缓存键零改动
- [x] 后端（fix-16）：ModelMetric + tokenShare、单次分组扫描内累加全模型分母、除零防护对齐 hitRate 写法；parity deepEqual 零断言改动自动扩展（实测 fixture+live 双绿）
- [x] 前端（des-16）：占比列紧邻「总 token」1 位小数（与推理占比 0 位区分，长尾 0.45% 不谎报 0%）、旧 wire 缺失/NaN → "—"、compareMetric `?? 0` 自动继承、首点 desc 契约、mock 自洽镜像、renderModelTable 从零建 4 用例（含 pinModelSortState 钉模块级排序态自证）
- [x] 测试 321 → 327（+6）
- [x] 收敛复核：版本 0.12.0 三处同步（npm version 精确更新根条目——lock 内 @pkgjs/parseargs 0.11.0 恰撞版本号，盲替换会破坏传递依赖，改用 npm version 规避）+ 合并 327/327 独立复跑 + check 0 + 真实库探针 7/7（85 模型 Σ=1、跨面板口径逐字节相等 4,425,138,390、榜首 70.4%、活库无 unknown 桶）
- [x] 文档：CHANGELOG 0.12.0
- [x] oracle 增量审查 0.12.0 delta（ora-6 复用会话）：P0=0 / **P1=1**（非 delta 缺陷——behavior-queries fresh 夹具午夜窗口必红，oracle 独立复跑 326/327 实证）+ P2×3（Σ=1 过度声明/占比列 1 位小数长尾读零/注释措辞）
- [x] 0.12.1 处方修复（fix-16 会话复用，处方型修复不派下一代审查）：P1-1 锚点改 now、P2-1 注释软化+容差断言、P2-2 占比列 2 位小数（活库 55/85 行 1 位读零实证）、P2-3 array-index 措辞收紧；版本 0.12.1 三处同步 + 327/327 独立复跑 + check 0
- 随版处理：ora-6 上轮 P2-1 注释补丁（整数型键枚举序例外）已在 v0.12.0 落地并经本轮审查核实合格（P2-3 措辞收紧已随 0.12.1 处理）

## v0.13.0 会话列表 tokens 双指标列（push #31，2026-10-09，双车道并行）

- [x] 用户拍板里程碑：B 目录 tokens 双指标（"继续执行"采纳推荐项；cost 因活库 ≈0 留位——探针复核 Σcost=0.0000）
- [x] 侦察（exp-5）：下钻与顶层共用 session-list 组件（加列两者生效）；SELECT 早已取出 v2 三列仅在 parse 折叠；**活库实证推翻"v2 滞后"假设**（844 会话 0 落后/69 领先，28/28 压缩会话全领先——session_message 被压缩修剪，消息级反而低估）→ 数据源钉 v2 零成本路线
- [x] 契约钉死：SessionSummary 增 tokensInput/tokensOutput/tokensCacheRead（v2 三列 coerceNumber 直通），tokens 折叠/cost 行为零变化，SELECT/排序白名单/过滤/缓存键/CSV 零改动；前端「入」「出」两列口径与 KPI todayInput/todayOutput 严格一致（纯输入/纯输出，cache.read 不混入）；新列不 sortable；顺带修正四处+DESIGN 两处 lagging 注释债
- [x] 后端（fix-17）：parseSessionSummaryRow 折叠+透传、类型+四处注释修正、fake 夹具真实分项分布（暴露直通错误）+ parity 列形状锁追加分项断言、api-routes 分项透传/折叠回归测试；CSV 夹具仅类型补齐三行（先例范围）
- [x] 前端（des-17）：入/出列（更新时间与 Tokens 之间）、KPI 口径核对（deriveOverviewExtension todayInput=纯 input）、cache.read 走总量 title 分项提示、sortKey:null 原生非排序+column.title 口径 tooltip、`?? 0` 兜底、mock 三分项严格守恒、九列密度 scoped 收紧、3 组新测试（列序/兜底/自洽）
- [x] 测试 327 → 331（+4）
- [x] 收敛复核：DESIGN.md:191 残留滞后表述由协调方顺手修正（对齐 :29 实证措辞）+ 版本 0.13.0 三处同步 + 合并 331/331 独立复跑 + check 0 + 真实库探针 8/8（折叠恒等逐行、榜首真实分布 in 53M/out 3M/read 1.19B、下钻/range 分项随行、cost 留位复核）
- [x] 文档：CHANGELOG 0.13.0 + DESIGN.md 注释债两处
- [x] oracle 增量审查 0.13.0 delta（ora-7）：P0=0 / P1=0 / P2×1（mock 余数吸收理论负 output——Math.round 双半值进位可致 −1，已被确定性 PRNG + 逐会话非负断言双层封死，可选加固不阻塞）+ 1 观察（前端"严格一致"限定口径措辞属实，接受）。口径对齐声明核实成立（KPI todayInput 纯 input 零错配）；深层翻页 1167 行无串行；榜首 v2 分布逐位吻合；隐私硬红线通过
- P2 备忘（ora-7，可选加固随下版顺手）：mock-data.js:417-420 tokensOutput 为负时从 tokensCacheRead 回扣 1（或改 read 吸收余数）——触发条件为 Math.round 双半值进位，当前 SEED 下不可达

## v0.14.0 /insight-refresh 刷新命令（push #32，2026-10-09，单车道）

- [x] 用户拍板里程碑：/insight-refresh 刷新命令（question 工具连续第七次成功转化）
- [x] 侦察（exp-6）：**进程拓扑钉死最大坑**——TUI flavor（./tui）与 server flavor（.）两个进程，命令内直接 import clearResultCache 是静默 no-op，必须走服务器路由 + fetch 回环；cache.ts 模块级单例覆盖全部 13 处服务端缓存；看板页面无自动轮询（toast 文案需提示刷新页面）；tui-command-registry 测试的数量/索引断言是必改点
- [x] 契约钉死：GET /api/refresh（清前读 resultCacheSize 报 N、自身不入缓存、db 无关不进 503 名单、GET/HEAD 门不放宽）；/insight-refresh 命令（读端口→fetch 回环→success toast「已清 N 条（刷新页面后生效）」，全降级永不抛，依赖注入 {fetchImpl?, readPortImpl?}）；注册第 4 条命令
- [x] 实施（fix-18，fix-17 会话复用）：refresh-command.ts 新文件 + api.ts/router.ts 路由 + command-registry 注册 + 四面测试（路由形状/精确计数/db-null/行为锁 + 命令降级/文案 + 注册数量 4）；实施中一次 api-routes.test.ts 中间编辑事故已同轮自愈并经全量 grep + 340/340 实证无残留
- [x] 测试 331 → 340（+9）
- [x] 收敛复核：版本 0.14.0 三处同步 + 合并 340/340 独立复跑 + check 0 + 真实服务探针 10/10（4→4/0→0/2→2 精确计数三段吻合、重算健康、405 门、404 面不破坏；末段一次自误断言经甄别为探针算术错误——历史第三次探针自证纪律命中，代码零问题）
- [x] 文档：CHANGELOG 0.14.0
- [x] oracle 增量审查 0.14.0 delta（ora-7 会话复用）：P0=0 / P1=0 / P2×2 全文档级，无需 0.14.1——审查证据：340/340 独立复跑、四条降级路径逐一核实（fetch 零调用锁死/HTTP 状态精确插值/坏形状四变体/异常三变体）、api-routes 中间编辑事故独立核验自愈属实（23→26 test 块逐名 diff 零丢失）、全真链路活探（storage 键逐字一致、5000ms 超时真实触发）、隐私零命中（历次最干净 delta）
- 两处 P2 已由协调方顺手处置（文档级一行）：P2-1 CHANGELOG"13 处 cachedResult"数字失实修正为 12（根因：协调方早前 grep 命中含 case "models" 一行）；P2-2 /api/refresh 副作用 GET 的跨源清缓存安全残留已补记 DESIGN.md §10（影响仅性能，接受现状）

## v0.15.0 目录面板 tokens 汇总（push #33，2026-10-09，双车道）

- [x] 用户拍板里程碑：目录面板 tokens 汇总（question 工具连续第八次成功转化）
- [x] 侦察（exp-5 网络中断 errored 不可复用 → exp-7 重试成功）：扇出风险钉死——现有 LEFT JOIN 每会话 N 行，直接加 SUM 会按步数虚高，方案 A（step 子查询预聚合 GROUP BY session_id）结构性消除；同表证明（目录查询主表=session_v2，与 SESSION_LIST_SELECT_SQL 同表同三列零 join 差异）；目录面板无排序控制器（加列不触发白名单）；mock 目录段缺全部 tokens 字段；deepEqual 三处连锁；CSS 双断点
- [x] 契约钉死：DirectoryStat 加 tokensInput/tokensOutput/tokensCacheRead 必填（行解析 ?? 0 coerce）；SQL 方案 A + 三 SUM 同一 GROUP BY；api.ts 零改动；空目录排除语义沿用；前端口径沿用 session-list title 模式 + 目录特有对账警示（~0.36% 系统差 · Σ目录≠全库）；目录 Σ ≠ KPI 全库不写相等断言
- [x] 实施（双车道并行）：fix-18 后端（方案 A SQL + 三 SUM + 类型注释 + fake 镜像 SUM + 真实 :memory: 夹具扇出回归面 + 守恒手推断言 + deepEqual 两处）/ des-18 前端（入/出列两处 grid 模板 + 移动端 nth-child(7) 顺移修正 + title 口径 + mock 逐日三分各自最大余数法分摊——负 output 问题自然消解 + 跨视图守恒断言 + 3 用例）；des-18 越界 flag：index.html 副标题一行文案（加列后事实性缺漏）——协调方 copy 复核接受保留
- [x] 测试 340 → 345（后端 +2 / 前端 +3）
- [x] 收敛复核：版本 0.15.0 三处同步 + 合并 345/345 独立复跑 + check 0 + 活库探针 6/6（16 目录逐行与 SQL 直查三分全等——扇出若存在必红；Σ 守恒 in 331.9M/out 13.7M/read 4.19B；「空目录排除可观测」断言经甄别为探针假设错误——活库唯一空目录会话三分全 0，排除语义由 parity 夹具锁定，历史第四次探针自证纪律命中）；fixer 自报 SQL 模板缩进未命中事故经重试成功无残留（345/345 实证）
- [x] 文档：CHANGELOG 0.15.0
- [x] oracle 增量审查 0.15.0 delta（ora-7 会话复用）：P0=0 / P1=0 / P2×1 注释级 + 观察×1，无需 0.15.1——审查证据：独立复跑 345/345（parity 实库未 skip）、活库三段抽查（typeof 审计 855/855 全 integer、预聚合性能反快 ~23% 中位 1121.6ms vs 旧形态 1462.3ms、JS 独立重算 16/16 目录三分逐位全等非循环论证）、nth-child(7) 与 head 7 span DOM 对齐核实、扇出回归面"回退旧形态必红"实证（gamma 4 步将答 16000≠4000）、mock 停用目录零权重槽余量递增永不触及的结构证明、隐私零命中
- P2-1 已由协调方顺手处置（注释级一行进 src，非纯 docs）：SQL 侧 SUM 的类型假设写进 directory-queries.ts SQL 模板注释（区别于 P1-1 禁令：overview 加的是 session_message JSON 文本值，这里加的是 writer 恒写数值的 session_v2 结构列，勿复制到 message 数据）——定向 41/41 + check 0 实证注释零行为影响；观察项（全 NULL token 组无夹具覆盖，YAGNI 可不加）不挂账

## v0.15.1 修复：TUI 四条斜杠命令从未注册（push #34，2026-10-11，orchestrator 主诊 + fixer 单车道）

- [x] 起因：用户报告 /insight 输入后看不到任何 db-insight 斜杠命令（此前 TUI 三命令冒烟从未活体验证过——服务器面 3/3 通过掩盖了 TUI 面从未起效）
- [x] 诊断（orchestrator 直诊，服务器/宿主双进程日志面排查）：宿主日志零 db-insight 失败记录（usage-meter 的 OPENTUI_FORCE_UNICODE 冲突失败系干扰项，与本问题无关）→ 宿主源码 anomalyco/opencode packages/tui/src/context/keymap.tsx groupCommands 校验：有 id 命令若 bind 为空字符串则从 layer() 同步抛错「Keymap command bindings cannot be empty」（该字符串在本机 opencode.exe 二进制核实 3 处命中）→ 我们四命令全传 bind: "" → 抛错被 command-registry.ts 的 catch 静默吞掉返回 undefined → 命令从未注册、宿主日志零报错（v0.11.0 起潜伏五版的根因链完整闭合）；参照 oh-my-opencode-slim（真实宿主可工作）palette/slash 命令不传 bind
- [x] 实施处方型修复（fixer，红→绿 + 回归锁，免下一代审查）：删四处 bind: ""（省略字段，类型 bind?: false | string）+ 两个 catch 吞错前 console.error（T6.3 永不抛契约不变）+ 宿主校验镜像 fake（buildHostValidatingKeymapHarness，宽松 fake 不做形状校验正是盲区）+ 形状锁断言
- [x] 验证：347/347（345+2）+ check 0；版本 0.15.1 同步（package.json + api.ts INSIGHT_VERSION）
- [x] 文档：CHANGELOG 0.15.1
- [x] 发布：敏感扫描独立执行（本机路径/用户名模式扫描，仅排除 npm 依赖名误报项，凭据/产物干净，待推送范围二次扫干净）→ commit 6d12860 → push → tag v0.15.1 远端核实 → plugin update → verify-install 6/6 PASS（0.15.1 @ 6d12860，src 67/test 37 镜像）
- [ ] 用户活体验证（唯一待办）：重启 TUI → 输入 / 应出现四命令 → /insight 打开看板、/insight-status 面板、/insight-export csv、/insight-refresh 刷新 toast

## v0.15.2 审计对账清账版（push #35，2026-10-11，双车道 fix-19/fix-20）

- [x] 起因：用户要求按设计目标全量对账检查遗漏——oracle 全量审计（ora-8）：核心面零遗漏（❌ 空集），禁令核验 7/7 通过，两条发布纪律生效后无一版本违规；真实债务 = 文档失实（DESIGN 九版未回写/README 停 v0.1.x/§13 断头引用）+ v0.1.0 存量测试豁免区（tooltip XSS P0 无持久回归锁为最尖锐项）
- [x] 用户拍板（question 第九次成功转化）：对账清账版（推荐项）
- [x] 实施双车道（写域隔离）：fix-19 文档回写（README 四命令/CSV 导出/排行榜占比/byModel/回放搜索 + DESIGN 头部实况化/§5 tokens 三分/§6 两路由/wire 字段/§7 回放搜索/§8 第四命令/§13 备选清单新建/精度标签措辞收窄——决策：不补实现/§3.1 树 352 用例）；fix-20 测试与小修（tooltip XSS 持久回归锁 ×2 含红验证：临时恢复 P0 形态 fail 2 → 逐字节恢复 → 全绿；kpi-card 测试 ×5 面向精度标签/环比/sparkline/降级；mock 会话侧 tokensOutput clamp 一行 + 守恒不变式宽松界测试——注释钉死与 0.15.0 目录侧修复的区别；tasks.md 两处勾稽补勾 B1/0.3.0 审查；cache.ts:57 伏笔注释销账）
- [x] 审查豁免依据：全部改动逐条可溯源至 ora-8 审计处方清单，处方型免下一代审查（0.15.1 同例）
- [x] 验证：352/352（347+5）+ check 0 + 红验证记录在案
- [x] 发布：版本 0.15.2 同步（package.json + api.ts INSIGHT_VERSION）→ CHANGELOG 0.15.2 → 敏感扫描独立执行四项全干净 → commit fe21c1e → push → tag v0.15.2 远端核实 → plugin update → verify-install 6/6 PASS（0.15.2 @ fe21c1e，src 67/test 37 镜像）
- [x] 审计遗留确认延后项维持原状（零总量分叉/Math.round 近似/days=366 wire/全 NULL 组夹具/主题切换重取/冷缓存串行——理由经审计核验仍在场）
- [ ] 仍开放：TUI 四命令用户活体冒烟（tasks.md 上节末行）；审计建议项未立项——verify-install.ps1 增「宿主日志 grep 注册失败」检查、CSV 十二列立项决策、其余 6 个存量面板测试按 tooltip > kpi-card 之后的优先级排后续版本

## v0.15.3 测试加固版（push #36，2026-10-11，双车道 fix-21/fix-22 + orchestrator 加固）

- [x] 起因：用户「继续修复」——推进审计遗留队列第二波（0.15.2 已清 tooltip/kpi-card/文档/clamp，本波清剩余存量面板测试 + verify-install 增强建议项）
- [x] 实施双车道（写域隔离）：fix-22 测试面（web-components.test.ts +633 行 +22 测试：calendar-heatmap×5/token-funnel×4/tool-bars×4/state-views×3/replay-turn-bar×3/theme×2/trend-chart 数据入口降级×1，红验证 ×2 在案——calendar-heatmap levelOfValue 改坏→红→恢复、token-funnel supply 改坏→3 红→恢复，两组件 git status 确认干净）；fix-21 脚本（verify-install.ps1 第 7 项 WARN 级注册失败检查：$env:USERPROFILE 动态构造路径、FileShare::ReadWrite 开活日志、\uXXXX 转义兼容 PS 5.1 无 BOM、WARN 不影响退出码）
- [x] orchestrator 加固：命中计数排除 spawning process 命令回显行——fix-21 红探测自污染实证（opencode.log:86253 宿主把含匹配串的探测命令行记进日志），过滤后本机实跑 PASS；此类误报（任何嵌入匹配串的命令被宿主记账）自此结构性免疫
- [x] 审查豁免依据：全部改动可溯源至 ora-8 审计处方（⚠️#2 完整销账 + 建议项），处方型免下一代审查（0.15.1/0.15.2 同例）
- [x] 验证：374/374（352+22）+ check 0 + 红验证记录在案
- [x] 发布：版本 0.15.3 同步 → CHANGELOG 0.15.3 → 敏感扫描独立执行全干净（含新脚本路径动态构造复核，无硬编码用户名）→ commit 6f0aa83 → push → tag v0.15.3 远端核实 → plugin update → verify-install 7/7 PASS（0.15.3 @ 6f0aa83，第 7 项检查本机 PASS）
- [x] 审计遗留处置状态更新：⚠️#2 存量测试豁免区至此**全量销账**（v0.1.0 八面板 + trend-chart 深化全部入库）；剩余开放项仅 TUI 活体冒烟（用户侧）与 CSV 十二列立项决策（question 拍板）

## v0.15.3 后续 · 台账用户名泄漏事故处置（push #37，2026-10-11，orchestrator 直办）

- [x] 事故：v0.15.3 台账以双引号 here-string 写入，$env:USERPROFILE 被 PowerShell 展开为真实路径写入 tasks.md 并随 d4e4cb4 推送；排查另发现旧账——v0.15.1 台账含字面扫描模式描述（用户名形态），因扫描排除项按行匹配 npm 依赖名而成盲区漏网
- [x] 快速止血：2a0bd61 改写两行为脱敏等义描述（动态构造路径字面量/无用户名模式描述），独立终扫双干净后推送
- [x] 历史重写（用户拍板）：从 v0.15.1 基点 cherry-pick 重建 6 提交链——096585c（0.15.1 台账，修复行内嵌）/173b51b（v0.15.2 发布）/7b6c610（0.15.2 台账）/af176f0（v0.15.3 发布）/dfb9cb1（0.15.3 台账，修复并吸收 2a0bd61，该提交不再保留）；三重验证：树与重写前逐字节一致（git diff 空）、全历史 -S 双模式零残留、工作树终扫干净
- [x] 远端落位：master force-with-lease 推送（dfb9cb1）+ v0.15.2/v0.15.3 tag 重打（173b51b/af176f0）+ ls-remote 核实；v0.15.0/v0.15.1 tag 未动；本地 reflog expire + gc --prune=now，含用户名的旧提交对象从本地对象池彻底清除（loose=0）
- [x] 宿主重装：plugin update 至新哈希，verify-install 7/7 PASS（0.15.3 @ dfb9cb1，src 67/test 37 镜像保持）；npm test 374/374 + check 0
- [x] 教训固化（三条，全部当场生效）：① 台账/文档写入一律单引号 here-string，杜绝变量静默展开；② 敏感扫描排除项按文件（package-lock.json）不按行内容——按行排除会制造「同行兼提排除项与污染」盲区；③ 扫描与推送永不串进同一条命令（本次事故直接诱因：扫描报警被链式 push 吞掉）

## v0.16.0 状态弹窗化 + 端口发现修复（push #38，2026-10-13，fix-25/fix-26 + ora-9 审查）

- [x] 需求（用户原话）：/insight-status 面板改弹窗样式 + 图表化 + ESC 可关闭；修 /insight、/insight-refresh 报「看板服务未启动（storage 中无端口记录）」
- [x] 实施：status-dialog 三模块（content.ts / render.tsx + ESC modal 键层 + r 刷新键）+ discover-dashboard-port（18789..18798 逐端口 /api/health 探测）
- [x] ora-9 全量审查：P0=0；处方型修复（P1#2 文档 + P2#1/#2/#4 行为缺陷）随 fix-26 落地，免下一代审查（红→绿 + 回归锁）
- [x] 验证：397/397 绿 + check 0 + verify-install 7/7 PASS
- [x] 发布 4f8f181 + tag v0.16.0 远端已核实；但 `opencode plugin update` 失败（NpmInstallFailedError）——引出 0.16.1/0.16.2 安装修复链
- [ ] 真机 ESC/r 冒烟待用户活体验证（ora-9 P1#3 唯一遗留承重假设：自定义 dialog 使宿主进入 modal 输入模式使键层可达）

## v0.16.1 安装修复（第一层，push #39，2026-10-13）

- [x] plugin update 失败 → 手动 npm 探针取到真实报错 ETARGET @opentui/core@0.6.2 → 当时归因为「上游断链发布」（后被 0.16.2 探针推翻）
- [x] 修法：@opencode/plugin 钉死 2.0.23；INSIGHT_VERSION 同步 0.16.1，lock 刷新；发布 dc260ea + tag
- [x] plugin update 仍失败 → tarball 干净安装探针追出第二、三层根因（0.16.2 素材）；教训：只钉直接依赖、peer 与深树仍浮动 = 打地鼠

## v0.16.2 依赖面手术 + 家目录污染清理（push #40，2026-10-13，orchestrator 直养）

- [x] 根因更正：`--registry https://registry.npmjs.org` 直查证实「缺失」版本（@opentui/core@0.6.2、@aws-sdk/credential-provider-web-identity@3.972.80）都存在——真根因 = 本机 npmmirror 镜像同步滞后 × 我们依赖面浮动；0.16.1 的「上游断链」系误诊，CHANGELOG 已更正
- [x] 手术：vendor define（src/plugin-definition.ts defineInsightPlugin，恒等函数 + 宿主只校验 default export {id,setup} 形状，二进制实证）→ @opencode/plugin 移 devDependencies（2.0.23 仅类型/测试）；peerDependencies 三钉死 @opentui/core@0.5.14 + @opentui/solid@0.5.14（精确配对）+ solid-js@1.9.12——effect/AI-SDK/@aws-sdk 深树从安装面消失（105 包小集，全镜像稳定）
- [x] 门禁固化：npm pack → 干净目录 tarball 安装为推送前必过项（本轮 PASS；0.16.0/0.16.1 均因缺此门禁带病发布）
- [x] 环境事实（非仓库可控）：npm 安装向上找最近 package.json 当项目根——宿主插件缓存戳目录无自己的 package.json，即宿主每次插件安装都合并家目录依赖树；本轮 tarball 探针曾把 file: 引用写进家目录 package.json（污染会拖炸宿主全部插件更新），已手动清条目 + npm install 调和（103 包移除、node_modules 9 项归位、带时间戳 .bak 备份在位），临时探针目录与 tgz 已删；文档一律 %USERPROFILE% 占位
- [x] 敏感扫描独立执行且先读输出再推：抓到本轮自泄 CHANGELOG 用户名路径一处，当场改占位符复扫清零（扫描纪律第三次实锤生效：台账 here-string 单引号 + 夹具虚构 + 扫描排除按文件不按内容）
- [x] 验证：397/397 绿（P2-2 server-resilience 全量并发下一次时序抖动，单文件与全量复跑均绿，挂账观察）；真机 `opencode plugin update` exit=0 首次成功 + verify-install 7/7 PASS（0.16.2 @ 0fbcdfc，src 71 / test 41，宿主日志无 TUI 注册失败）
- [x] 发布 0fbcdfc + tag v0.16.2 远端核实（master == tag == origin）
- [x] 用户活体冒烟（一分钟）：打开状态弹窗 → ESC 关闭 → r 刷新 → 再 ESC——ora-9 P1#3 承重假设实锤成立（2026-10-14 用户真机四步全过）；双端口存活观察项随会话重启收敛

## v0.17.0 弹窗点击关闭 + KPI 双写法 + 看板载入即取新 + EACCES 端口修复（push #41，2026-10-14，orchestrator 直养）

- [x] 用户需求三连（真机冒烟后追加）：弹窗右上角显示 esc 点击即关闭；KPI 补缩写注记；网页 F5 保证同步最新数据
- [x] 右上角 ✕ ESC：content 模块按最宽正文行右对齐补位 + 行携带 closeAction，render 层给标题条 <text> 挂 onMouseDown（@opentui/core RenderableOptions 原生 prop，0.5.14 d.ts 类型链实证 TextBufferOptions→RenderableOptions）；宿主不投递鼠标事件时退化纯提示，ESC 键保底（键层冒烟已真机验证）
- [x] KPI 双写法：35,509,713（35.5M）——全量与紧凑唯一相遇处，<1000 不注记；模型榜/趋势维持紧凑
- [x] F5 取新：app.js 载入先 await GET /api/refresh（只清 60s TTL 缓存）再拉区块；失败退化为 TTL 语义不阻塞
- [x] EACCES 修复（真机全量红→绿实证）：Windows WinNAT 保留段跨重启漂移，server 端口重试链旧契约把 EACCES 当致命错 → 撞保留段启动即死；改为与 EADDRINUSE 同按前进类 +1 重试；致命类样本换 EADDRNOTAVAIL；旧「EACCES 快速失败」双锁改写为新契约锁 + 新增保留段跳过回归锁
- [x] 探针纪律升级：tarball 探针目录先 npm init 自带 package.json，切断 npm 向上找项目根到家目录的路径（0.16.2 污染类根防）；本轮实证家目录零污染
- [x] 验证：401/401 绿 + check 0 + 探针门禁过（103 包 5 秒）+ 敏感扫描四项清零 + verify-install 7/7 PASS（0.17.0 @ b6d0af5）
- [x] 发布 b6d0af5 + tag v0.17.0 远端核实；plugin update 首跑 exit=1 带瞬态栈但安装已完整落盘（verify 7/7 实证），复跑干净收敛（exit=0「No plugin updates available」）——瞬态挂账观察
- [ ] 用户真机冒烟（重启 TUI 后）：/insight-status → 标题条右上角见 ✕ ESC → 鼠标点击关闭 → KPI 行见「全量（缩写）」→ 网页 F5 数据全新；若点击无效（宿主未开鼠标上报）则 ESC 键兜底属预期降级（**v0.18.0 起弹窗已整体移除，前两项作废**；网页 F5 与 EACCES 两项仍有效，并入 v0.18.0 冒烟清单）

## v0.18.0 数据挖掘扩容版：Agent 榜 + 工具错误率 + 范围选择器 + 目录导航 − /insight-status（push #42，2026-10-14，exp-12 + fix-27/28/29 + des-21×2 五车道）

- [x] 需求（用户原话）：继续挖掘数据库看 /insight 页面还能展示什么；追加四笔：删 /insight-status、模型榜加 7/30/90/全部时间范围（默认全部）+ 压缩高度、时段热力「要么不展示要么动态」（选动态）、页首目录点击跳转
- [x] 数据探矿（orchestrator 直做，node:sqlite 只读探针）：schema 全量 dump + 聚合探针锁定四矿脉——工具段 47,050 全带 state.status（error 5,648/12%）、agent 分布 librarian 209/fixer 153/explore 74、reasoning 23,042/37,204 行非零、cache_read 45 亿；贫矿排除：cost 总计 $0.13、summary_additions 几乎全 NULL、resume_attempts/fork 全 0
- [x] 现状盘点（exp-12）：15 条 API + 15 区块逐一对照，实锤 AgentStat 与 reasoningShare 早已在现有载荷里躺着——Agent 榜/Reasoning 列为纯前端，tool-health 是唯一新后端面
- [x] fix-27 `GET /api/tool-health`：两段式抽取加 `$.state.status`（不动 agent 统计既有抽取）、computeToolHealth 纯聚合（unknown 计 total 不计桶、total 降序+tool 升序决胜）、路由 + 缓存 + 10 测试；真库实跑前五：shell 13,529（err 7.6%）/ read 9,533（1.1%）/ edit 7,174（6.0%）/ grep 4,509（13.7% 最刺眼）/ bash 3,057（1.0%）
- [x] des-21 第一批：Agent 排行榜（`.tables` 区 span-both 全宽、tokens 降序、top-3 偏好工具 chip）、Reasoning 列文案对齐英文、工具 TOP10 错误色带（≥10% 红 / <10% 琥珀）+ `err N%` 标注 + tooltip 增行 + 全局错误率摘要行；DOM shim 契约冒烟 16/16
- [x] fix-29 删 /insight-status：status-dialog 三模块 + status-panel-data + 39 条测试移除；命令收敛三条；`queryAssistantStepRows`/`parseAssistantStepRow`/`AssistantStepRow` 经 grep 验证保留（sql-aggregation-parity 以它为 JS 聚合基线，属测试资产非死代码）；文档 stale 引用由 orchestrator 清（DESIGN 命令树/模块树/§8、README 两处；CHANGELOG/M6/tasks 历史区按史实保留）
- [x] fix-28 `/api/models?days=`：scan-floor 下推 + JS 本地午夜回收（复刻 hour-heatmap 惯例）、缺省/非法/0/负 = 全量且缓存键保持旧无参形状、clamp 1..366 后入键（1000≡366 共享条目）+ 10 测试；真库冒烟 7 天窗 11 模型 vs 全量 88（firstSeen 全落窗内）
- [x] des-21 第二批：模型榜范围选择器（序列守卫 + 分桶缓存 + 未命中保留旧表不闪骨架）+ 限高 464px sticky 表头滚动、时段热力 7/30/90/全部选择器 + 副文案动态化、页首 13 chip 目录导航（.toc-flash 高亮 + reduced-motion 降级 + scroll-margin）；契约冒烟 15/15 + 上批回归 16/16；esbuild 过程抓到 state 键重复真 bug 当场修复
- [x] 热力图谜底记档：后端无 bug——days 下推与窗口回收一直正确；「永远像近一周」= 数据集中（近 7 天 5,646 步 / 近 14 天 30,791 步 / 近 30 天 86%）+ 7 行=周几的视觉误读；故选动态化而非隐藏
- [x] 验证：382/382 绿 + check 0（401→382 = +10 tool-health +10 models-days-window −39 status-dialog 链）；合流后 orchestrator 复跑全量确认无 lane 间咬合问题
- [x] 发布门禁：敏感扫描四类清零 → tarball 探针过（68 包干净安装）→ c333dc4 feat + d7aeee4 台账 → push + tag v0.18.0 远端核实（master == tag == d7aeee4）→ verify-install 7/7 PASS（0.18.0 @ d7aeee4，src 70=70 / test 40=40）→ 全引用 update 复跑 exit=0「No plugin updates available」干净收敛。**勘误**：`opencode plugin update` 传短 id（`opencode-db-insight`）会报「Plugin is not configured」exit=1——CLI 只认全引用 `github:dubuqiangu/opencode-db-insight`；0.17.0 台账的「update 首跑瞬态挂账」按此修正理解（应验过均为短 id 调用，非瞬态）
- [ ] 用户真机冒烟（重启 TUI 后）：/insight 打开看板 → 页首目录 chip 跳转 → Agent 榜（librarian 应居首）→ 工具榜错误色带 + 全局错误率 → 模型榜切 7 天/全部 + 限高滚动 → 时段热力切窗口文案随动 → 输入 / 确认只剩三条命令 → 网页 F5 数据全新（承 0.17.0 遗留）→ 0.18.0 加载后行为正常

## v0.18.1 全仓审视收口：样板归并 + 双定义收敛 + R1 状态一致性修复（push #43，2026-10-15，ora-10 审视 + fix-30/des-21 执行 + orchestrator 直养补完）

- [x] 需求（用户原话）：审视并优化整个项目的代码，但是不要破坏原有的功能，也不要引入新的风险
- [x] ora-10 全仓行为保持审视：P1×4（机械可执行）/ P2×4（存疑）/ 拒绝×9（含 tui.tsx 改名、序列守卫工厂化、stride 游走合并等「看似可简化实为 load-bearing」项）+ 风险点 R1（缓存命中不清 failedSections）/ R2（tool-health 无重试入口，有意设计，仅记档）；排除清单全部按约定绕开（两段式抽取、TTL、端口重试、vendor define、parity 资产等）
- [x] 裁决：放行 P1-1/2/3/4 + R1（des-21 刚合流产物里的真 bug 顺手修）；拒绝 P2-1/2/3（app.js 无测试锁的面，收益配不上验证成本）与 P2-4（index.ts 端口写入清理是行为变更，其注释自述「再留一版」，非本审视范围）
- [x] fix-30（P1-1/P1-2 后端）：parseExtractedFieldList 双定义收敛进 rows.ts（函数体一字未改，调用侧 stride/path-builder/字段表全不动）+ INTERNAL_ERROR_MESSAGE 单源化（request-handler 改 import api.ts，方向无环已验证）；382/382 + check 0
- [x] des-21 前端 lane 中途 provider 403 阵亡（P1-3 已完成：format.js 三死导出 grep 实证后删；P1-4 完成 3/7：overview/calendar/agents 工厂化；R1 未动）
- [x] orchestrator 直养补完（剩余量小且机械，上下文已在手）：P1-4 后四区块（survival/compaction/todo/directories）转换 + R1 四处（trend/models/heatmap 缓存命中补 markSection(true) + session-sort-controller applyNextView 补 markSectionSucceeded()）+ models/heatmap 失败回正 state.cache.models/hourHeatmap 指针置 null（防主题重渲窗口错配）；esbuild 逐文件解析过 + 382/382 + check 0
- [x] 发布门禁：敏感扫描四类清零 → tarball 探针过（68 包干净安装）→ d3a17f9 → push + tag v0.18.1 远端核实（master == tag == d3a17f9）→ verify-install 7/7 PASS（0.18.1 @ d3a17f9，src 70=70 / test 40=40）。**update 假警报完整归因（修正 0.18.0 勘误）**：两个独立现象——① 短 id 确定性报「Plugin is not configured」exit=1（CLI 只认全引用）；② 全引用在**刚推送后的首跑**也会一过性 exit=1 带栈（本次实证），verify-install 内嵌同命令成功落盘、随后独立复跑 exit=0「No plugin updates available」干净收敛。结论：以 verify-install 的 7/7 为安装实证唯一标准，update 首跑 exit=1 一律复跑收敛后再看
- [ ] 用户真机冒烟追加两项：① R1 场景——任一区块加载失败后切回已缓存窗口，顶栏失败计数应消失；② 七个简单区块（KPI/日历/Agent 榜/存活/压缩/todo/目录）初载与重试按钮行为与 0.18.0 无异

## v0.19.0 模型下钻口径修复 + 看板自动刷新 + 版面一致性（push #44，2026-10-16，fix-31/fix-32/des-22 三 lane 并行 + orchestrator 接管收尾）

- [x] 用户五条意见 + 定时刷新需求：① 参考同类生态调研（lib-4 同类工具 15 条候选 + lib-5 deepseek harness 定性：DeepSeek 官方 dsh，⭐250k，8 条可借鉴面板模式，已留档待用户勾选）② 四处 7d/30d/90d/All 风格一致 ③ 模型点行会话列表空的口径 bug ④ 会话列表与模型榜高度对齐 ⑤ 模型榜首列冻结 ⑥ 后台定时刷新（F5 本就现查新数据）
- [x] fix-31（模型下钻 + 标签统一）：根因诊断 = 排行榜行取 step 级 `$.model.id`、列表按启动模型 `session_v2.model` 过滤，两口径天然错开（探针实证 top3 step 模型按启动模型计的会话数全 0）。修复 = SessionSummary 增 `modelIds`（step 集合 ∪ 启动模型，双路径同口径），列表按命中过滤 + 旧 wire 降级；SESSION_RANGE_OPTIONS 标签统一 7d/30d/90d/All（All 排最后，rangeValue 契约值未动）。lane 收尾时遭 provider 524 阵亡，落盘近完成（+319/−30 含测试），orchestrator 接管：补一处极简库降级（无 session_message 表时富化查询置空集合——CSV 导出夹具即此形态，5 个 real-SQL 红收敛）+ 验证
- [x] des-22（版面三件）：等高封顶 `--table-body-cap: 464px` 共享变量 + `align-self: start` 自然收尾；首列 sticky 冻结（双主题令牌 `--panel-accent-tint`、三态底色、corner-th 层叠、inset 分隔线，scrollport = .model-body 单一滚动容器）；会话选择器 sticky 控制行右缘同轴；panel-sub 文案按定稿逐字落
- [x] fix-32（自动刷新）：默认 5m 可调 关/1m/5m/15m（localStorage `insight-auto-refresh-minutes`，防 Number(null)===0 误读）；refreshAllSections 按当前视图原样重取全区块 + 会话列表 refreshCurrentView()（仅失效当前组合缓存）；防重入 + 隐藏暂停 + 回前台过期补刷（失败轮也计时戳防连环重刷）；控件 JS 注入零新增 CSS
- [x] 合流回归：384/384 全绿（+2 净增）+ check 0 + esbuild 全改动 JS 逐文件解析过
- [x] 发布门禁：敏感扫描四类清零 → tarball 探针过（68 包干净安装，407.8KB）→ 793f52f → push + tag v0.19.0 远端核实（master == tag == 793f52f）→ plugin update 全引用一次干净通过（本次无一过性）→ verify-install 7/7 PASS（0.19.0 @ 793f52f，src 70=70 / test 40=40）
- [ ] 用户真机冒烟（重启 TUI 后）：四处切换器标签与样式一致（All 排最后）→ 模型榜点 glm-5.3 等「只出现在步骤里」的模型行 → 会话列表非空且都是用过它的会话 → 会话列表与模型榜两块等高、无大片空白 → 模型榜横向拖动时模型名列冻结 → 顶部自动刷新选择器（默认 5m）挂后台 5 分钟数据自刷 → 切到别的标签页再切回若已过期立即刷新 → F5 数据全新 → 承接 0.18.1 未验的 R1 场景与七区块回归

## ora-11 全仓审视（v0.19.0 增量面，2026-10-16）裁决记录

- [x] 结论：**无 P1**；P2×6 全部放行（→ v0.19.1 热修，fix-33 执行）+ R×5 记档；标签统一连锁面 / des-22 CSS 全套 / refreshInFlight 护栏 / visibilitychange 补刷语义 / R1 状态机在自动刷新轮次下的一致性——全部推演放行
- [x] **P2-4/R-A 实测证据（真库计时入档）**：modelIds 全表 GROUP BY 单次 **2581/2620/3246ms**（47k assistant 行逐行 JSON 解析，962 组）；IN 下推版（session_id IN 当页 15 id 前置）**531/528/533ms**（无 session_message.session_id 索引的行扫描底价）。含义：0.19.0 起会话列表每次排序/翻页服务端拖 2.6s、CSV 导出点击连吃两回、自动刷新每轮 2.6s 同步阻塞事件循环——升级为准 P1 热修；IN 下推为过渡方案，残余 531ms/页记 R-A 观察档
- [x] P2-1 localStorage 白屏风险（读侧 try/catch 回退默认 5；写侧 setItem 失败不阻塞 applyAutoRefreshInterval）
- [x] P2-2 refreshCurrentView 的 cache.delete 纯负资产（load() 成功本就无条件回写缓存；先删只会在失败时赔掉完好缓存）→ 删分支 + 补该入口首个测试
- [x] P2-3 renderCurrent() 稳定视图缓存 miss 落骨架后直接 load()（对齐时间窗分支形状；v0.7.0 老问题被 auto-refresh 放宽暴露）
- [x] P2-5 fix-31 测试注释与 fixture 相反（web-components ~L1705，524 阵亡半成品，断言本身正确）
- [x] P2-6 回放页停留期间自动刷新照跑 → tick/补刷判定加 dashboardElement.hidden
- [x] R-D catch 宽度一行加固：非「no such table」错误先 console.error 再降级（防 v0.19.0 修过的 bug 无痕复发）
- [x] **R-B 台账修正（R2 处境变化）**：v0.18.1 R2 裁定「tool-health 无重试入口，F5 兜底」自 v0.19.0 起不再成立——自动刷新每轮都调 loadToolHealthSection，构成事实重试通道（默认 5m 自愈）。边界如实记档：① 仅自动刷新非关时成立，手动关闭后退回 F5 兜底；② 失败仍按设计静默（摘要行清空 + 顶栏计数），无错误占位。**不改代码**
- [x] **R-C 记档（设计取舍，不修）**：自动刷新把瞬时故障从静默陈旧变成可见错误态——「如实反映」哲学的自然延伸，接受；冒烟清单补场景：拔起后端 5s → 下一轮错误态 → 恢复后端 → 再下一轮自愈
- [ ] **R-E 真机观察挂账**：node:sqlite 同步 API + 自动刷新一轮 14 端点串行阻塞事件循环——0.19.1 后单轮最重面 = modelIds IN 下推 ~531ms + 日历 366 天端点；真机停在回放页观察整 5 分钟边界的翻页延迟手感，超标再议（调大默认间隔/错峰加载均为行为变更，下版决策）
- [x] fix-33 落地（六处方全落实）：P2-4 三档（开关 false 于 CSV/TUI 直调两处；看板富化 IN 下推 2.6s→531ms；回放标题路径由 IN 下推统一覆盖、不加投机参数）+ P2-1 localStorage 双侧 try/catch + P2-2 删 cache.delete 并补入口首测 + P2-3 稳定分支 miss 补请求（补测）+ P2-5 注释纠正 + P2-6 回放页停刷 + R-D catch 收窄；386/386（+2）+ check 0 + esbuild 过
- [x] v0.19.1 发布门禁：合流回归 386/386 + check 0 → 脱敏四类清零 → tarball 探针过（68 包干净安装，413.8KB）→ 0e93cc7 → push + tag v0.19.1 远端核实（master == tag == 0e93cc7）→ plugin update 全引用一次干净通过 → verify-install 7/7 PASS（0.19.1 @ 0e93cc7，src 70=70 / test 40=40）
- [ ] 用户真机冒烟追加（v0.19.1）：① 排序/翻页会话列表不再卡顿 2.6s（服务端富化 531ms 过渡）② 回放页停留 5 分钟后端不刷、切回看板追平 ③ R-C 场景——拔起后端 5s → 下一轮错误态 → 恢复 → 再下一轮自愈 ④ R-E 手感观察——回放页整 5 分钟边界翻页是否卡顿，超标回报
## v0.20.0 统计维度「会话」贯穿 + 单会话指标集（进行中，2026-10-16，fix-34/des-23/fix-35 三 lane + fix-36 收口）

- [x] 用户新增需求（两条）：① 所有统计指标可增加统计维度 session，之前的全部 session 口径保留 ② 可增加有价值的、不重复、不啰嗦的新指标
- [x] **fix-34（后端）**：10 条路由吃 `?session=`（overview/trend/models/tool-health/agents/todo/hour-heatmap/session-survival/compaction/directories；sessions 列表/会话路径/两导出忽略该参数，测试锁「未知 id → 200」）；过滤片段单点 `buildSessionFilterSqlFragments`（缺省空串、SQL 字节不变）；未知 id → 404 `{ error: "session not found" }`（专用常量，与路径路由措辞区分，校验在缓存前单点）；缓存键统一追加 sessionFilterId 维度；SessionSummary 富化 tokensReasoning/tokensCacheWrite/stepCount/parentSessionId/childSessionCount/childTokensTotal；步数计数为独立轻 COUNT（不解析 JSON，`includeStepModelIds=false` 只关 JSON 富化不关计数）；新端点 `/api/session-distribution`（对数半档桶边 10^(k/2) 圆整 3 位有效数字，max=10^D → 2D+2 桶，排除全零会话，nearestRank 分位）。410/410（+24）+ check 0
- [x] **des-23（视觉）**：`components/distribution-card.js`（renderDistributionCard(container, distribution) → cleanupFn）+ `components/replay-token-curve.js`（renderReplayTokenCurve(container, stepTokens) → cleanupFn|null，空 steps null）；分布卡 section `#panel-distribution`（.span-both）+ TOC 入口；顶栏预置 `#session-scope-chip`（常驻节点默认 hidden，激活写 innerHTML + 摘 hidden 属性——容器选择器 :not([hidden])，必须走属性）；chip DOM 模式全文已交接线层；双主题全走既有变量，零新增色值；两组件 esbuild 解析过 + 最小 DOM 垫片冒烟 20 断言过
- [~] **fix-35（前端接线）**：死于 provider 403（IP 封禁类基础设施故障，与 fix-31 同型），**死于测试阶段临界点**——实现完整落盘（app.js +285 / session-list.js +141 / data-source.js +146 / session-replay.js +77 / session-sort-controller.js +104，新建 session-scope-chip.js、session-scope-visibility.js、test/helpers/web-dom-shim.ts），但新测试未建、九列断言未更新。**task_revive 被拒**（errored 会话非保留态，board 明载「Cancelled or errored sessions are not reusable」）→ 按规程不重复同一 objective 于该会话，改派全新 lane fix-36 只收口测试
- [x] **fix-36 收口**（fix-35 阵亡后的替代 lane）：修 web-components:1028 九列断言（9→12 + 三新表头非排序断言）+ 新建 `test/web-session-scope.test.ts` 16 用例（data-source 十条 URL 带参与 404 翻译 / sort-controller 缓存键分离与 404 退出链 / session-list 三新列含旧 wire 降级与子代理徽标两形态 / scope chip 激活退出与 404 轻提示 / 显隐 map 14 项与 index.html 锚点对齐）。**426/426（+16）+ check 0，零实现 bug**
- [x] **orchestrator 真库端到端独立验证**（探针，非 lane 产出）：真实 HTTP 端点 × 裸 SQL 交叉对账全过——富化六字段全等（stepCount=6904 精确等于 assistant 行数、childSessionCount/childTokensTotal 与 parent_id 自连接全等）；分布 totalSessions=正值会话数、Σ桶=totalSessions、max/p50/p90 与自有 nearestRank 一致、桶边单调不重叠；`?session=` 过滤后 trend steps=6904 精确相等、过滤后 byModel tokens 合计=1458694980 与该会话 totalTokens 一字不差；未知 id → 404 契约体、空参 ≡ 缺省、缺省路径形状不变。**（另记：探针自身两处 FAIL 均为我自己的假设错误——trend 载荷 byModel 是每模型 tokens 非步数；已修正复验全过）**
- [x] **测试基建观察档**：`server-integration` 的 `bad port` = 并行套件下多测试文件并发绑 port 0 的既有间歇抖动——单跑该文件 2/2 全绿、全套复跑未复现；非本次改动引入，不追
- [x] **ora-12 审视（v0.20.0 增量 ~1400 行）裁决**：P1×1 + P2×5 + R×6。后端 SQL/端点契约/分布数学/显隐 map 完整性/scope 生命周期三链（enter/exit/vanish 无半态无递归）/与 v0.19.1 四项修复（P2-6/P2-3/P2-1/localStorage）的交互——**逐项放行**
  - **P1-1（必修 → fix-37）**：回放分位徽标比对总量含 `reasoning`，而分布分位/列表 Tokens 列口径不含 → 系统性高估档位，且与同页头部总量自相矛盾；恰好落在无测试锁的 fix-35→fix-36 跨 lane 接缝
  - **P2-2 / P2-4 / P2-5（顺手封缝 → fix-37）**：子代理徽标文案「+N 子会话」→「+N 直接子会话」（真机证据：607 行会话既是子又是父、单父最多 148 直接子代 → 多级树真实存在，旧文案会被读成整棵子树）；显隐 map 补反向断言；补「徽标口径 == 分布口径」断言（封 P1 同类回归）
  - **P2-1 / P2-3 缓办记档**（实测成本可忽略，见下）；**R-1**（stepCount 原始行计数 vs overview JSON 口径差异，列头 tooltip 可注明）；**R-2**（scope 锁定行靠翻 /api/sessions 上限 2000 行，超 2000 会话的库会空行且不 404）；**R-3**（trend 不在跳过取数名单，隐藏面板失败仍计顶栏数）；**R-4**（mock 源忽略 scope）；**R-5**（旧库无 todo.session_id 列时 scope 下 500，真机已证列存在）；**R-6**（distribution-card.js:5 注释端点拼写 `/api/session-sistribution`，待顺手改）
  - **真机量化证据（入档）**：稳态 `/api/sessions?limit=15` **1ms**（冷启 504ms）、`/api/session-distribution` **0-3ms**、`/api/export/sessions.csv` **18-23ms**、`/api/overview?session=` 1ms（冷启 121ms）、`/api/trend?days=366` 4ms（冷启 841ms）→ 进入/退出 scope 的双份列表请求合计 ≈8ms、CSV 富化 18-23ms，均无感；**单轮自动刷新新增面不构成阻塞脉冲**（新增查询都在 IN(15) 或 ~800 行 session_v2 上）
- [x] fix-37 落地（P1-1 + P2-2 + P2-4 + P2-5）：428/428（+2）+ check 0 + esbuild 过；无写域外触碰
- [x] v0.20.0 发布门禁：终态回归 exit=0 + check 0 → 脱敏四类清零（119 tracked，12 新文件全为源/测试）→ tarball 探针过（68 包干净安装，474.7KB，新组件在包内）→ 61c8d51 → push + tag v0.20.0 远端核实（master == tag == 61c8d51）→ plugin update 全引用（首跑 exit=1 为已归因一过性，verify 内嵌同命令成功「Updated Server plugin」）→ verify-install 7/7 PASS（0.20.0 @ 61c8d51，src 77=77 / test 45=45）
- [ ] 用户真机冒烟（v0.20.0）：会话行「只看此会话」→ 顶部 scope chip 出现、退化面板隐藏、保留面板只算该会话 → ✕ 退出恢复全部口径 → 新三列（命中率/Reasoning/步数）与子代理徽标 → 分布卡直方图与 p50/p90/p99 标线 → 回放页累计曲线/峰值上下文/分位徽章 → 会话删除后 scope 自动退出不弹错误卡
- [ ] 交付合并「新增可视化指标」完整勾选清单（lib-4 同类工具 15 条 + lib-5 deepseek harness 8 条 + DB 探针 10 项，扣除已实现项）

## v0.21.0 A 档指标（子代理占比 + 步数分布 + 墙钟时长，2026-10-16，fix-38 阵亡 / fix-38b 续做 + des-24 视觉并行）

- [x] 用户勾选「先 A」：A 档三项 = ① 子代理开销占比卡 ② 步数分布直方图 ③ 墙钟时长（列 + 时长分布卡）；B 档（工具错误率时序 / 失败中断识别）下一轮；C 档（cache write 趋势 / 步均耗时）已淘汰
- [x] **orchestrator 真库数据面探针（入档）**：子代理占比——964 会话中 612 子会话（63.5%）、子代 tokens 23.7 亿/51.9 亿 = **45.6%**；352 父会话仅 47 个（13.4%）有直接子代、单父最多 148 直接子代 → topChildTrees 看清 45.6% 被几棵大树吃掉。步数分布——754 会话、max 6969、对数半档 8 桶分布良好（179/114/200/185/66/6/3/1）、p50=17/p90=101/p99=394、129 单步会话。墙钟时长——950/964 有正时长、avg 263min/max 366h；`time_compacting` 全 0、`time_suspended` 仅 5 → 「活跃时长」无从精确，本轮只做墙钟列 + 时长分布，不引入估算口径
- [~] **fix-38（A 档后端）**：死于 Telegram 群校验错误（「Verify your Telegram account」= 新基础设施故障，非代码），**死于半途**——纯函数泛化已落盘（`computeNumericDistribution` + `NumericDistributionBucket/Stats` 类型新增，保留 `computeSessionTokenDistribution` 兼容封装，行为零变化），但三端点/墙钟富化/测试全未做。**errored 会话不可复活** → 改派 fix-38b 只续做剩余（不重做已落盘泛化）
- [x] fix-38b/fix-39（后端续做）：三端点 + 墙钟富化 + 15 测试落地；443 用例，唯一 fail 是 des-24 视觉半途产物（index.html 锚点已加、scope-visibility 未注册）
- [x] des-24（A 档视觉）：分布卡泛化复用（`renderSharedDistributionCard` + `formatAxis`/`formatMean`/`sampleUnit`/`exclusionLabel`）+ 子代理占比卡（childShare 双段条 + topChildTrees top5）+ 三卡 section 布局 + 墙钟列 `.col-duration` + `formatDurationMs` 新增；末尾死于 Telegram 校验（基础设施），产物完整
- [x] fix-40（接线 lane）：三新卡挂载（import/cleanup/锚点/loader/refreshAllSections/scope 守卫/重渲）+ data-source 三 fetch + 墙钟列表列——**但半途退出**，`wallClockCell` 与其 `<td>` 未落、scope-visibility 清单未纳三面板、两处测试断言未同步
- [x] orchestrator 补缝：`wallClockCell` + 墙钟 `<td>`（修 12↔13 列错位）、`session-scope-visibility.js` HIDDEN 清单纳三面板、`web-session-scope.test.ts` L700 精确清单 + `web-components.test.ts` 13 列/列序断言
- [x] **orchestrator 独立真库端到端核对**：三端点数字与裸 SQL 全等（step totalSessions/桶和/max、duration totalSessions/max、child-share 964/612/childShare/topChildTrees[0] 命中、sessions 墙钟字段相符）——先 19/19，步数锚定后复测 13/13 全绿
- [x] **ora-13 审视裁决**：P2×4——①作用域在途请求竞态→fix-41 修（app.js 四 loader 过期守卫 + 20 用例）；②对数桶线性轴→des-25 改按桶序等宽 + 可滚动区 + sr-only 桶表；③时长卡文案与口径不符→des-25 改「墙钟跨度 = time_updated - time_created · 仅正值」；④TOP 榜称「子树」但只含直接子代→des-25 改「直接子代消耗 TOP5 · 按父会话汇总，不含孙代」。**另：步数分布未锚 session_v2（孤儿行）→ orchestrator 加 `session_id IN (SELECT id FROM session_v2)`（真库孤儿 0，行为不变，补夹具回归）**
- [x] des-25 视觉审视裁决：P2×6 全部落地（等宽桶/窄屏滚动/child-share 两栏 DOM 与榜单容器/均值格式/按卡口径文案/可访问桶明细）；零新增硬编码色值
- [x] 合流回归：**466/466（+23）** + check 0 + `git diff --check` 0（修 queries.ts / tasks.md CRLF 漂移 + types.ts 尾空格）
- [x] v0.21.0 发布门禁：脱敏扫描四类清零（131 tracked，新文件全为源/测试；`%USERPROFILE%` 命中为文档通用占位符）→ tarball 探针过（`opencode-db-insight-0.21.0.tgz`，497.2KB，三新组件在包内）→ commit `5b8b3da` → push + tag v0.21.0（master == tag == origin == `5b8b3da`）→ `plugin update`（`Updated Server plugin`）→ verify-install **7/7 PASS**（0.21.0 @ `5b8b3da`，src 80=80 / test 47=47）
- [ ] 用户真机冒烟（v0.21.0）：重启 TUI 生效 → 步数分布卡（对数桶 p50/p90/p99 标线、窄屏可横向滚动）→ 时长分布卡（墙钟跨度文案、formatDurationMs）→ 子代理开销占比卡（45.6% 双段条 + 直接子代 TOP5 链到回放）→ 会话列表「墙钟」列与 13 列对齐 → 进入「只看此会话」三新卡随分布卡一起隐藏、顶栏无失败数（修竞态回归）

## v0.22.0 B 档指标（工具错误率逐日趋势 + 失败中断识别）· 2026-10-18（fix-42 后端 / des-25 两卡 / fix-43 接线 + 收口轮 fix-44/fix-45/fix-46/fix-48/des-25）

- [x] 用户选定 B 档两项：① 工具错误率**逐日时序**（🟢 直读 `$.state.status`）② **失败中断会话识别**（🟡 推断：会话最后一条 assistant 对象消息带 `$.error`）
- [x] **契约钉死**：`GET /api/tool-error-trend?days=<n>`（缺省 30 / clamp 1..366 / **不吃 `?session=`** / 60s TTL）；`GET /api/session-outcomes`（**复数**路径，收口自后端原单数；不吃 `?session=`）；`byErrorType` 为**会话级终局**错误类型（Σ == `interruptedSessions`）；`recentInterrupted` 按 `time_updated` 降序；两端点锚定 `session_v2`
- [x] **fix-42 后端**：两端点查询 + 纯函数（`bucketDailyToolErrors`、`rankErrorTypes`/`buildSessionOutcomeStats`）+ 路由（`router.ts` 联合类型/case、`api.ts` `cachedResult` 60s），25 用例
- [x] **des-25 两卡**：`renderToolErrorTrendCard` / `renderSessionOutcomeCard` + CSS + `index.html` 两面板锚点与 TOC + 4 用例
- [x] **fix-43 接线**：`data-source` 两 fetch + `app.js` loader/重渲 + scope 隐藏清单（`panel-tool-error-trend`/`panel-session-outcomes` 单会话口径隐藏）+ 16 用例
- [x] **收口 1（fix-45）**：tool-part 抽取第三份拷贝收敛到 `src/db/tool-part-extraction.ts`（路径/回退/空名/`"unknown"`/fast-path 上限 8 单点）+ `buildLocalDateKeys` 从 `daily-buckets.ts` 导出共用 + **跨路由守恒测试**（Σ 29/9 手算锚定）
- [x] **收口 2（fix-44）**：`sessionsWithSteps` 与步数分布**同集合**（parity 测试）+ 删 `cleanSessions` + `RECENT_INTERRUPTED_LIMIT` 8→5 + `boundedIntParamKey` 缓存键收敛（键逐字节锁定）+ 路由清单补齐
- [x] **收口 3（fix-46 + des-25）**：芯片选中态缓存未命中即时重绘、契约清理、`USE_MOCK` 缝补齐（`getMockToolErrorTrend`/`getMockSessionOutcomes`）；错误率开关模块级保活、非法本地日剔除、「全部」复用 `MAX_TREND_DAYS`、条宽注解、hero 计数与占比互相兜底、芯片在途敞口闭合
- [x] **收口 4（fix-48）**：`/api/tool-health` 与 `/api/tool-error-trend` **无条件锚定 `session_v2`**（与三分布/session-outcomes 同锚）+ 孤儿排除回归；真库探针证明锚定前后 56211/5870 **完全相等**（孤儿 0）
- [x] **双 oracle 只读审视**：ora-16（数据/后端层）+ ora-15（前端/生命周期层）**无 P0**，P1/P2 已全部落地（含 🟡/🟢 图例扩档、孤儿锚定分叉、闭包守卫）
- [x] **合流回归**：**521/521** + `npm run check` 0 + `git diff --check` 0 + 全改动文件纯 LF
- [x] **orchestrator 独立真库端到端复核**：工具端点守恒 56277/5870 恒等；孤儿 assistant 0；`sessionsWithSteps` 804 == 步数分布 804 == 裸 SQL 804；`interruptedSessions` 197 == 裸 SQL 197，`byErrorType` Σ 197（缺 type 0 例）；`interruptedShare` 0.2450 == 197/804；榜单 len 5 且降序；`cleanSessions` 已不存在
- [x] 版本回写：`package.json` / `INSIGHT_VERSION` → 0.22.0；DESIGN §3/§5/§6/§7/§13、CHANGELOG 0.22.0 段、本台账
- [x] v0.22.0 发布门禁（2026-10-19）：脱敏扫描四类清零（136 tracked，新文件全为源/测试；`%USERPROFILE%` 为文档占位符、`provider.internal` 为 `\.internal\b` 误报）→ tarball 探针过（`opencode-db-insight-0.22.0.tgz`，536.3KB / 145 文件，两新卡 + 三新查询模块在包内）→ commit `4832d21` → push + tag v0.22.0（master == tag == origin == `4832d21`）→ `plugin update`（`Updated Server plugin "opencode-db-insight"`）→ verify-install **7/7 PASS**（0.22.0 @ `4832d21`，src 87=87 / test 51=51）
- [ ] 用户真机冒烟（v0.21.0 + v0.22.0）：重启 TUI 生效 → 工具错误率趋势卡（范围芯片 7/30/90/全部、错误率折线折叠保活、🟢 实值副标题）→ 会话失败与中断卡（hero 197 中断 / 24.5%、终局错误类型条、最近中断清单链回放、🟡 推断副标题）→ 进入「只看此会话」两新卡隐藏 → 页脚图例 🟡 推断/估算

## v0.23.0 TUI 侧栏 todo 块（2026-10-19）orchestrator 直养 + fix-49 数据层

- [x] **需求确认**：挂 db-insight；每页 4 条、`in_progress` 恒首位；提问列表 + 消息跳转**暂不做**但记录（DESIGN §13）；侧栏按官方实现
- [x] **官方取证**（lib-6）：「可折叠头部 + 逐行可点」唯一官方范本 = `packages/tui/src/feature-plugins/sidebar/mcp.tsx` L6（storage.store）/ L26-38（折叠头）/ L50-61（列表项 onMouseUp）；`context.renderer` 是官方 API（typings L483）但官方侧栏插件零调用；侧栏无官方分页范式（仅 `footer.tsx` 按终端高度裁剪）
- [x] **投递形态取证**（lib-6）：官方 in-repo spec `packages/opencode/specs/tui-plugins.md` 无反预编译要求；社区活例 `@streetturtle/opencode-context-progress@2.0.0` 的 `./tui` 直接指向裸 `dist/tui.tsx` + peerDeps 声明 `@opentui/*`/`solid-js`，与 db-insight 现有姿态一致 → **按官方走裸 TSX**，不迁移 bundle
- [x] fix-49 数据层：`src/db/session-todo-queries.ts`（精确 SQL，`db===null → []`，同步）+ `src/stats/session-todo.ts`（状态秩排序 / 隐藏规则 / clamp 分页，`SESSION_TODO_PAGE_SIZE=4`）+ `test/session-todo.test.ts`（9 例）；530/530
- [x] 侧栏块 `src/tui/sidebar-todo.tsx`：`sidebar.content` slot + `storage.store("session-todo.view")` 持久化折叠态 + 1s tick 驱动重读 + 全动态读取走函数子节点；多页 `‹ n/m ›` 翻页；切会话页码归零；连接 open→finally close
- [x] `src/tui.tsx` fail-safe 接线：动态 import + catch，侧栏加载失败不牵连 `/insight` 命令
- [x] 构建门：新增 `tsconfig.json`（`jsxImportSource: @opentui/solid`）；`npm run check` 改 `--bundle --platform=node --jsx-import-source=@opentui/solid` 并断言产物引用 `@opentui/solid/jsx-runtime`、禁 `react/jsx-runtime`
- [x] 构建门**真正生效**（v0.24.0）：`tsconfig.json` 原先不被任何脚本调用，而 `tsc` 全仓有约 300 个既有错误。现拆出 `check:types` 并串进 `check`，`include` 收窄到本轮 4 个模块，补齐 `allowImportingTsExtensions` + `skipLibCheck`；`sidebar-todo.tsx` 经具名辅助 `live()` 进入 strict 门
- [x] **决定性证据**：esbuild bundle 产物引用 `@opentui/solid/jsx-runtime`（非 react）→ 裸 TSX 路线本机可行；`npm run check` exit 0；`npm test` 530/530；改动文件全 LF 无 BOM
- [ ] **真机冒烟（待用户完整重启）**：侧栏 Todos 块出现 → 标题行点击即时 ▼/▶ → 折叠态重启后保留 → 每页 4 条 + `‹ n/m ›` 可翻 → `in_progress` 在首位 → 全部 completed 时整块消失 → 新 todo 写入后 1s 内出现 → 切换会话页码归零 → `/insight` 命令仍正常（验证 fail-safe 未误伤）
- [ ] 发布：脱敏扫描（独立一步、先读输出）→ commit + push + tag v0.24.0 → `plugin update` → `verify-install.ps1` 全绿
- [ ] 台账待补：DESIGN §11 的 check 命令描述、README 的侧栏说明
## v0.23.0 追加：参考项目归档 + 宽表列宽（2026-10-20）

- [x] 建 repo 级参考目录 `references/`（工作区根，非 git 仓库，不会被误提交），归档 5 个快照：billion-context（MIT，0.1.202，`48d45e7`）、opencode-mem（MIT，2.32.0）、opencode-plugin-otel（MPL-2.0，2.0.1）、oc-tps（无 license，0.0.12）、Opencode-Context-Analysis-Plugin（无 license，1.0.0）
- [x] `references/README.md`：仓库元数据表（版本/提交/license/大小）+ 选型理由
- [x] `references/CAPABILITY-AUDIT.md`：对话记录回溯专项审计
      - 结论：5 个项目中**只有 billion-context 有对话回溯**；其余 4 个（记忆库 / 遥测 / TPS / 单命令条形图）都没有
      - billion-context 回溯实现：`src/export.ts:83` `renderHandoff` → `sessions-data.ts:957/1017` → 前端 `client.ts:1565` `renderHandoffMd`；1.5MB 截断 + 指向完整导出；reasoning 用原生 `<details>`
      - db-insight 对比：会话列表/消息时间线/搜索跳转三项**不弱于**它（`replay-search.js:161` 已用 `scrollIntoView`）；落后项是轨迹图框选缩放、PNG 导出、大内容截断保护
- [x] 宽表固定列宽：`session-list.js`（13 列）、`model-table.js`（11 列）、`agent-table.js`（4 列）各补 `<colgroup>`；`components.css` `.data-table` 改 `table-layout: fixed` + 单元格 `overflow: hidden; text-overflow: ellipsis`
- [x] 验证：`npm test` 535/535、`npm run check` 0（已含 `check:types`）、CHANGELOG 为 LF 无 BOM
- [x] 侧栏 todo 逻辑复核与修复（2026-10-21，oracle 独立审查 + 自校）：折叠改 `onMouseUp`、删 `requestRender`、页码复位改 `createEffect`、分页箭头先判边界；新增 `src/tui/clip-columns.ts` 按显示列宽截断（CJK/emoji 计 2 列），`test/session-todo.test.ts` 增至 14 例
- [x] **全部完成后整块隐藏（含标题行）**：`buildSessionTodoView` 返回 `null` 时标题行也一并消失，函数子节点内门控以保持响应式。原实现只隐藏列表，标题 `▼ TodosUnited` 常驻，与验收口径不符
- [x] **窄侧栏换行**：内容 `<text>` 加 `wrapMode="none"`，避免侧栏窄于 44 列时把状态图标挤下去
- [x] **类型门落地**：`tsconfig.json` 原先不被任何脚本调用（`npm run check` 只跑 esbuild，不做类型检查），而 `tsc` 全仓有约 300 个既有错误。改为拆出 `check:types` 并串进 `check`，`include` 收窄到本轮 4 个模块（`clip-columns.ts` / `sidebar-todo.tsx` / `session-todo.ts` / `session-todo-queries.ts`），补齐 `allowImportingTsExtensions` + `skipLibCheck`，门现真正通过
- [x] **`<text>` 函数子节点类型缺口收敛**：`@opentui/solid` 运行时 `insert()` 特判函数子节点并包 `createRenderEffect`（`index.js:6523`），类型定义未描述。新增具名辅助 `live()` 集中该断言，`sidebar-todo.tsx` 进入 strict 门
- [x] **注册期卸载竞态**：`registerSessionTodoSidebar` 加 `isDisposed`，dispose 后 `render` 返回 `null`，避免动态 import 与卸载竞态把块挂进已销毁上下文
- [x] 参考项目二次复查已写入 `references/CAPABILITY-AUDIT.md` §7：模型表 11 列对齐（此前疑点系探针正则缺陷）；markdown/样式/i18n/diagnostics 均不值得搬；剩余 4 项目仅 oc-tps 生命周期与 Context-Analysis 的 telemetry 校准有参考价值
- [ ] **后续评估（未做）**：回放页大内容截断保护；回放页消息锚点 hash 深链；token 曲线框选缩放；PNG 导出
- [ ] 说明：本次改动只在源码；运行中的 18789-18792 服务加载的是安装态 0.22.0，需发布后才会体现

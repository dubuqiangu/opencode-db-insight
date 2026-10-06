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

- [x] T7.1 对照 DESIGN.md 逐项核验（需求→设计→任务→实现双向追溯），缺口回填——✅ 双向对账完成（§4/§5/§6/§8/§9/§10 逐条比对实现与 tasks.md 勾项）；发现 8 处差异已整理成决策清单交付（小时热力未接 API/前端、会话存活与压缩事件有口径无消费、strictHitRate 未接线、/api/sessions 排序参数缺、状态面板降级 toast 而非 dialog、导出文件名时间戳粒度、导出目录 §8 与 §9 表述冲突、sqlite 打开方式readOnly 选项而非 mode=ro URI）——按任务约定差异交用户决策，不回填 DESIGN.md
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
- [ ] B1 /api/sessions 服务端排序参数（当前客户端排序够用；若 v0.2-A 的区块增多触发表格重构再一并做）

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
- [ ] oracle 增量审查 0.3.0 delta → 有 P0/P1 则修后推 0.3.1

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

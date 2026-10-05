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

## v0.2 Backlog（来自 T7.1 设计对账，未排期）

- [ ] 小时×星期热力：/api/hour-heatmap 路由 + 看板前端区块（纯函数已备）
- [ ] 会话存活统计：API 路由 + 前端区块（纯函数已备）
- [ ] 压缩事件统计：按会话/按日计数（当前仅导出渲染通知行）
- [ ] strictHitRate 接线到回放页并注明口径
- [ ] /api/sessions 服务端排序参数（当前客户端排序够用）
- [ ] 前端消费 /api/todo（todo 完成率卡片）

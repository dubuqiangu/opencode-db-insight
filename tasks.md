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

- [ ] T1.1 **实测 node:sqlite 可用性**（在 OpenCode 运行时环境跑最小只读查询）——验证：脚本输出真实行数；不可用则按 DESIGN §4 回退并记录决策
- [ ] T1.2 `src/db/queries.ts`：db 路径解析 + 只读连接 + 全部 SQL（overview/trend/models/agents/sessions/messages/instruction_blob/todo）——验证：node:test 冒烟（连真实库跑通每条查询）
- [ ] T1.3 `src/stats/`：纯聚合函数——hitRate、dailyBuckets、modelMetrics（步均输出/中位/p95/推理占比/活跃区间）、agentFingerprint、sessionSurvival、hourHeatmap——验证：node:test 单测（含空数据、除零、单条数据边界）
- [ ] T1.4 进程内缓存层（60s TTL，key=路由参数）——验证：单测命中/过期

## M2 Web 服务（push #3）

- [ ] T2.1 `src/web/server.ts`：127.0.0.1 绑定、端口占用自动+1、teardown 关闭、/api/health——验证：curl /api/health 返回端口与 db 可达性
- [ ] T2.2 API 路由装配（DESIGN §6 全表）+ JSON 错误约定（db 缺失→503）——验证：curl 逐路由对照 DESIGN 口径抽查数字（对照已知：全历史总量/今日命中率）
- [ ] T2.3 静态文件服务 `src/web/public/`——验证：浏览器打开根路径出页面骨架

## M3 看板前端（push #4）

- [ ] T3.1 KPI 卡片行 + 布局骨架 + 深浅色主题；卡片含环比 ▲▼（vs 上一等长周期）、sparkline、精度标签（🟢实值/🟡估算）——验证：浏览器实测与降级（overview 空数据时显示占位）
- [ ] T3.2 逐日趋势（uPlot 堆叠面积图按模型分色 + 命中率折线）——验证：对照 /api/trend 数据点抽查 3 天
- [ ] T3.3 模型/agent 环形图 + 工具条形图（手写 SVG）——验证：hover 出数值、空数据不渲染错误
- [ ] T3.4 模型排行榜明细表 + 小时热力格——验证：列齐全（DESIGN §5），排序可用
- [ ] T3.5 52 周日历热力图（GitHub 式）——验证：抽样 3 个日期格对照库中日token
- [ ] T3.6 Token 漏斗（上下文供给→缓存命中→实付输入→输出）——验证：各层数字与 overview 口径一致

## M4 单会话回放（push #5）

- [ ] T4.1 会话列表页（分页/排序）→ 点击进回放——验证：真实会话往返浏览
- [ ] T4.2 回放视图：角色时间线（user/assistant/reasoning/工具输入输出/system）+ 系统提示词折叠面板——验证：抽 1 个含工具调用+压缩的会话，对照库中原始 JSON 核对无遗漏
- [ ] T4.3 旧表会话（2026-09-23 前）回放降级提示——验证：造一个旧 session_id 访问，返回明确文案
- [ ] T4.4 turn 级成本条（每步 cache读/实付/输出分段 + 模型切换标注）——验证：抽 3 个多步会话对照 step token 数据

## M5 Markdown 导出（push #6）

- [ ] T5.1 服务端导出渲染 `/api/export/session/:id.md`——验证：curl 落盘文件，角色分节与 DESIGN §8 一致
- [ ] T5.2 `/insight-export` 斜杠命令（无参弹出最近 20 会话选择；导出到 ./insight-exports/）——验证：TUI 实测导出 2 个会话

## M6 TUI 面板（push #7）

- [ ] T6.1 `/insight` 打开浏览器命令（跨平台 open + toast 显示端口）——验证：Windows 实测
- [ ] T6.2 `/insight-status` 终端面板：今日总量/命中率/模型 TOP5/7 日字符条形——验证：TUI 实测；API 不可用时静默降级文案
- [ ] T6.3 数据卫生：面板限量渲染、异常静默——验证：断网/杀服务进程场景

## M7 收敛与发布（push #8）

- [ ] T7.1 对照 DESIGN.md 逐项核验（需求→设计→任务→实现双向追溯），缺口回填
- [ ] T7.2 README 完整化：安装（github:add 三方式）/更新/卸载/验证/排障
- [ ] T7.3 `opencode plugin update` 后重启实测全部功能 + 卸载重装干净
- [ ] T7.5 v0.1.0 版本号 + CHANGELOG 汇总 + 用户验收

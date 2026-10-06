# Changelog

本项目的所有显著变更记录在此文件中。
格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [SemVer](https://semver.org/lang/zh-CN/)。
每个里程碑完成后 push 并在此追加一条记录，方便回溯。

## [Unreleased]

（暂无——下一批变更记录于此）

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

# Changelog

本项目的所有显著变更记录在此文件中。
格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [SemVer](https://semver.org/lang/zh-CN/)。
每个里程碑完成后 push 并在此追加一条记录，方便回溯。

## [Unreleased]

### Added
- M2 HTTP 服务（src/web/，仅绑定 127.0.0.1）：startInsightServer 默认端口 18789、EADDRINUSE 自动 +1 重试最多 10 次（serverFactory 可注入测试）、close() 释放端口并关闭 db；router.ts 纯路由匹配、api.ts 路由处理、static-files.ts 静态解析（防路径穿越）、request-handler.ts node:http 胶水。
- M2 API 路由（DESIGN §6 全表）：/api/health（端口/版本/dbStatus）、/api/overview、/api/trend?days=、/api/models、/api/agents、/api/sessions?limit=&offset=、/api/todo、/api/session/:id/messages、/api/session/:id/system-prompt；全部查询套 60s TTL 缓存；db 不可用→503 {error}，旧表会话→404 "session not found in current tables"，坏参数回落默认值。
- M2 插件装配（src/index.ts）：setup 启动真实 server 并把实际端口写入 storage（insight-server-port），db 路径支持 storage 覆盖（insight-db-path），teardown 清理 storage 并关停 server。
- M2 测试：路由匹配/参数容错、静态路径穿越防护、端口重试（假 serverFactory）、真实库 fetch 集成（health/overview/trend/sessions/messages 404/system-prompt）、teardown 端口复绑证明、并发 10 请求、index 装配往返。

### Changed
- （M1）test 脚本改为 `node --test --experimental-strip-types "test/*.test.ts"`：Node v24.14.1（Windows）下 `node --test <目录>` 形式报 "Cannot find module"，改用 node 内建 glob 跨平台可用。

### Added (M0)
- 项目骨架：DESIGN.md（设计文档）、tasks.md（任务清单）、CHANGELOG.md、README 骨架、LICENSE（MIT）、OpenCode V2 插件空入口（src/index.ts / src/tui.tsx）。

### Changed
- DESIGN.md 图表选型按业界调研校准（ccusage / claude-lens / OpenWebUI / opencode-stats 等已验证形态）：KPI 卡增加环比 ▲▼ 与精度标签（🟢实值/🟡估算）、逐日堆叠面积图按模型分色、新增 52 周日历热力图与 Token 漏斗、回放视图升级为会话级+turn 级两级。

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

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

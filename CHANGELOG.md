# Changelog

本项目的所有显著变更记录在此文件中。
格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [SemVer](https://semver.org/lang/zh-CN/)。
每个里程碑完成后 push 并在此追加一条记录，方便回溯。

## [Unreleased]

### Added
- M1 取数层（src/db/）：opencode.db 只读连接（node:sqlite 特性探测，失败返回 null 供 API 层 503）、全部查询函数——overview / dailyTrend / modelMetrics / agentStats / sessionList / sessionMessages / todoStats / sessionSystemPrompt（instruction_state → instruction_blob）；行解析与 JSON 容错收敛在 src/db/rows.ts，共享类型在 src/db/types.ts。
- M1 聚合纯函数（src/stats/，零 IO）：hit-rate（双口径命中率 + 总量口径）、daily-buckets（本地时区日分桶、零填充）、model-metrics（步均输出/中位/p95 上下文/推理占比/活跃区间）、agent-fingerprint（工具偏好指纹）、session-survival（存活时长分布）、hour-heatmap（小时×星期热力）、cache（60s TTL 进程内缓存，key=函数名+参数 JSON）。
- M1 测试（test/，node:test）：全部 stats 纯函数单测（正常值/空数组/除零/单条数据/日期边界/时钟倒挂）+ 行解析单测 + 连真实 opencode.db 的冒烟测试（库缺失自动 skip）。

### Changed
- test 脚本改为 `node --test --experimental-strip-types "test/*.test.ts"`：Node v24.14.1（Windows）下 `node --test <目录>` 形式报 "Cannot find module"，改用 node 内建 glob 跨平台可用。

### Added (M0)
- 项目骨架：DESIGN.md（设计文档）、tasks.md（任务清单）、CHANGELOG.md、README 骨架、LICENSE（MIT）、OpenCode V2 插件空入口（src/index.ts / src/tui.tsx）。

### Changed
- DESIGN.md 图表选型按业界调研校准（ccusage / claude-lens / OpenWebUI / opencode-stats 等已验证形态）：KPI 卡增加环比 ▲▼ 与精度标签（🟢实值/🟡估算）、逐日堆叠面积图按模型分色、新增 52 周日历热力图与 Token 漏斗、回放视图升级为会话级+turn 级两级。

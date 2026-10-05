# Changelog

本项目的所有显著变更记录在此文件中。
格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [SemVer](https://semver.org/lang/zh-CN/)。
每个里程碑完成后 push 并在此追加一条记录，方便回溯。

## [Unreleased]

### Added
- 项目骨架：DESIGN.md（设计文档）、tasks.md（任务清单）、CHANGELOG.md、README 骨架、LICENSE（MIT）、OpenCode V2 插件空入口（src/index.ts / src/tui.tsx）。

### Changed
- DESIGN.md 图表选型按业界调研校准（ccusage / claude-lens / OpenWebUI / opencode-stats 等已验证形态）：KPI 卡增加环比 ▲▼ 与精度标签（🟢实值/🟡估算）、逐日堆叠面积图按模型分色、新增 52 周日历热力图与 Token 漏斗、回放视图升级为会话级+turn 级两级。

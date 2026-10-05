# opencode-db-insight

OpenCode V2 插件：从本地 opencode.db 挖掘历史用量数据的统计看板 + 单会话回放 + Markdown 导出。

- `/insight` —— 打开本地 Web 看板（模型排行榜、逐日趋势、缓存命中率、agent 工具指纹、单会话回放）
- `/insight-status` —— 终端统计面板（今日用量、命中率、模型 TOP5）
- `/insight-export` —— 把任意会话导出为角色分节标注的 Markdown

与 [opencode-usage-meter](https://github.com/)（实时指标）互补：本插件只做历史侧分析。

状态：开发中（见 [tasks.md](tasks.md) 与 [DESIGN.md](DESIGN.md)）。

## 安装（发布后）

```sh
opencode plugin add github:dubuqiangu/opencode-db-insight
```

安装 / 更新 / 卸载 / 排障的完整命令将在 v0.1.0 发布时补全。

## License

MIT

# opencode-db-insight

OpenCode V2 插件：只读分析本地 `opencode.db` 的历史用量——浏览器统计看板、单会话回放、终端面板与 Markdown 导出。

## 功能

- **`/insight`** —— 在浏览器打开本地 Web 看板（`http://127.0.0.1:18789/` 起，端口被占用自动 +1）：
  - KPI 总览（今日/累计 token、今日缓存命中率、会话数、步数、费用）
  - 模型排行榜（步数、总量、命中率、步均输出、中位/p95 上下文、推理占比）
  - 逐日趋势（token 分项 + 命中率折线）与 52 周日历热力图
  - agent 工具指纹、Token 漏斗（todo 完成率等其余指标经 `/api/todo` 等 JSON 接口提供）
- **单会话回放**（看板内点会话进入）：角色时间线（用户/助手/工具输入输出/系统消息）+ 系统提示词折叠面板 + turn 级成本条
- **`/insight-status`** —— 终端侧栏统计面板：今日总量、命中率、模型 TOP5、近 7 日字符条形图（60 秒自动刷新）
- **`/insight-export [会话ID]`** —— 把任意会话导出为角色分节的 Markdown（无参数时弹出最近 20 个会话供选择）

与 [opencode-usage-meter](https://github.com/dubuqiangu/opencode-usage-meter)（实时指标）互补：它管**实时**，本插件只做**历史**侧分析。

## 安装

> ⚠️ 同一插件只能用**一种**方式安装；混用会导致重复加载或更新失败。

| 方式 | 操作 | 适用 |
|---|---|---|
| ① 官方仓库安装（推荐） | `opencode plugin add github:dubuqiangu/opencode-db-insight` | 正常用户 |
| ② 手动 clone | `git clone https://github.com/dubuqiangu/opencode-db-insight ~/.config/opencode/plugins/opencode-db-insight` 然后 `cd ~/.config/opencode/plugins/opencode-db-insight && npm install` | 想改源码/跟 main |
| ③ opencode.json 指本地路径 | 在 `opencode.json` 的 `"plugin"` 字段配置 `"opencode-db-insight": "file:///到本仓库的路径"`（Windows 亦可用 `file:///D:/...` 三斜杠形式） | 本地开发联调 |

前置要求：运行 OpenCode 的 Node/Bun 需带 `node:sqlite`（OpenCode 自带的 Bun 1.4+ 与 Node 24+ 均已实测可用）；插件对数据库始终**只读**打开。

## 更新 / 卸载 / 验证

```sh
opencode plugin list                       # 验证：应列出 opencode-db-insight
opencode plugin update opencode-db-insight # 更新（更新后需重启 OpenCode 生效）
opencode plugin remove opencode-db-insight # 卸载
```

更新/安装后**重启 OpenCode**，输入 `/insight` 应在 toast 中看到实际端口并打开浏览器看板，即安装成功。

## 使用

- 三条斜杠命令：`/insight`（打开看板）、`/insight-status`（终端面板）、`/insight-export [会话ID]`（导出）。
- 看板地址：`http://127.0.0.1:18789/`，被占用时自动 +1 重试（至多 10 次）；`/insight` 的 toast 显示**实际**端口，也可看 `/api/health`。
- 导出目录：`./insight-exports/`（相对 OpenCode 启动目录），文件名 `<时间戳>-<会话标题>.md`，中文标题保留。
- 数据源：只读打开 OpenCode 数据库（Unix：`~/.local/share/opencode/opencode.db`；Windows：`%USERPROFILE%\.local\share\opencode\opencode.db`），路径可在插件 storage 中用 `insight-db-path` 覆盖。

## 排障

| 症状 | 原因与处理 |
|---|---|
| `/insight` 提示「看板服务未启动」 | server 端未把端口写入 storage——通常是插件刚安装/更新还没随本会话启动：**重启 OpenCode**；仍不行先 `opencode plugin list` 确认插件已启用 |
| 面板显示「db-insight: 数据不可用」 | `opencode.db` 不存在（OpenCode 尚未产生历史数据）或运行时缺 `node:sqlite`；用 health 路由 `curl http://127.0.0.1:18789/api/health` 看 `dbStatus` |
| 看板某会话 404「session not found in current tables」 | 2026-09-23 之前的旧表（`part`/`message`）会话**不在**统计与回放范围（避免双计），属预期行为 |
| 某模型命中率恒为 0% | 部分通道（provider 侧）不上报缓存数据，看板模型行已标注，非故障 |
| 更多日志 | OpenCode 日志目录：`~/.local/share/opencode/log/`（Windows：`%USERPROFILE%\.local\share\opencode\log\`）；插件 API 层对 db 缺失/坏参/旧表均有固定错误约定，可先看 `/api/health` |

导出文件包含完整会话内容（可能含敏感信息），分享前请自行检查。

## License

MIT

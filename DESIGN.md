# opencode-db-insight 设计文档（DESIGN.md）

> 版本：0.1.0-draft · 状态：设计中（图表选型待全网调研校准）
> 本文档是实现的唯一依据；需求变更先改本文档再改代码。

## 1. 背景与目标

OpenCode 在本地 SQLite 数据库（`~/.local/share/opencode/opencode.db`，下称 **opencode.db**）中完整记录了每个会话的消息、token 用量、工具调用、上下文压缩等历史数据。现有插件 `opencode-usage-meter` 专注**实时**指标（tok/s、当前会话、滚动窗总量），不读库、不存数据（其项目红线）。

本项目补上**历史侧**：一个 OpenCode V2 插件，提供

1. **本地 Web 看板**：斜杠命令启动/打开，展示历史用量的汇总统计与单会话回放；
2. **终端面板**：与 usage-meter 风格对齐的常用指标（今日总量、命中率、模型 TOP5）；
3. **会话导出**：把任意会话导出为角色分节标注的 Markdown。

**不重复造轮子的边界**：实时速率、流式估算校准等 usage-meter 已覆盖的能力不做；本项目只做"库里有、但实时插件做不了"的历史分析。

## 2. 调研结论（摘要）

### 2.1 opencode-usage-meter（本地项目，已完成调研）

- TUI 插件，取数走宿主 HTTP 聚合 API `GET /api/experimental/session/stats`，零采集零存储；
- 已覆盖：tok/s、等待计时、今日/滚动窗总量、双口径命中率、费用、上下文占用告警、子代理聚合、近 7 日字符条形图；
- 可复用：`stats-source.ts` 的刷新/去抖骨架、`format.ts` 的 CJK 感知 token 估算、`panel-content.ts` 的聚合纯函数与两种命中率公式。

### 2.2 opencode.db 数据面（已完成实测）

- 当前写入表为 `session_v2`（会话汇总）与 `session_message`（逐条消息）；旧表 `part`/`message` 已停写，不可作为数据源；
- `session_v2.tokens_*` 汇总字段对**活跃会话滞后**，历史统计一律以 `session_message` 逐条累加为准，`session_v2` 仅用于会话列表与目录/agent 维度；
- token 结构（assistant 消息 `data.tokens`）：`input` / `output` / `reasoning` / `cache.read` / `cache.write`；
- 角色类型齐全：`user` / `assistant`（内含 text、reasoning、tool 三种 part）/ `system`（指令更新通知）/ `model-switched` / `compaction` / `idle` / `synthetic`；
- 系统提示词本体在 `instruction_blob`（按内容哈希存储，含环境块、工具目录、日期），可还原会话当时的指令注入；
- 工具调用的输入参数与执行输出完整保留在 tool part 的 `state.input` / `state.output`。

### 2.3 业界看板调研

@librarian 全网调研（LiteLLM / Helicone / Langfuse / 个人 token 统计工具的指标与图表选型）**进行中**，返回后校准 §7 图表选型并在本文档记录变更。

## 3. 总体架构

```
┌─ OpenCode 宿主 ─────────────────────────────────────┐
│  server 插件 (src/index.ts)                          │
│   ├─ insight server（node:http，仅绑定 127.0.0.1）    │
│   │   ├─ GET /api/*        → JSON 统计 API           │
│   │   └─ GET /*            → 静态看板页面             │
│   └─ db reader（node:sqlite，只读连接 opencode.db）  │
│  TUI 插件 (src/tui.tsx)                              │
│   ├─ /insight           → 打开看板（浏览器）          │
│   ├─ /insight-status    → 终端统计面板                │
│   └─ /insight-export    → 会话导出 Markdown           │
└─────────────────────────────────────────────────────┘
        浏览器访问 http://127.0.0.1:<port>/
```

- **单一职责分层**：`src/db/`（只读取数）→ `src/stats/`（纯聚合函数，可测）→ `src/web/`（HTTP 服务与 API）→ `src/web/public/`（前端页面）→ `src/export/`（Markdown 导出）→ `src/tui/`（终端面板）；
- 入口文件（index.ts / tui.tsx）只做装配与生命周期清理，不承载业务逻辑；
- 单文件超 ~400 行即拆分（同全局规则）。

## 4. 数据源与读取层

- 路径解析：默认 `~/.local/share/opencode/opencode.db`（Windows 为 `%USERPROFILE%\.local\share\opencode\opencode.db`），允许通过 storage 持久化设置覆盖；
- **只读连接**：`node:sqlite` 以 `file:...?mode=ro` URI 打开，避免写锁与 WAL 干扰；宿主正在写库时并发读是安全的（WAL 模式）；
- 风险点：OpenCode 运行时若为 Bun，`node:sqlite` 可用性需实测（tasks T1.1）；不可用则回退 `better-sqlite3`（引入构建依赖，最后手段）；
- 全部 SQL 收敛在 `src/db/queries.ts` 单文件，便于替换与审计。

## 5. 指标目录（口径定义）

| 指标 | 公式 / 来源 | 说明 |
|---|---|---|
| 今日总量 | Σ(tokens.input+output+cache.read) 当日 assistant 消息 | 以 session_message 为准 |
| 缓存命中率 | cache.read / (cache.read + input) | usage-meter 同款口径；会话严格口径含 write，面板注明 |
| 模型单点指标 | 步数、总量、命中率、步均输出、步均上下文、中位/p95 上下文、推理占比、活跃区间 | 排行榜核心 |
| agent 指纹 | Σ 各工具调用次数 / 该 agent 总调用 | 工具偏好分布 |
| 逐日趋势 | 按本地时区分桶：步骤、input、read、output、命中率 | 折线/面积图数据 |
| 小时热力 | 历史步骤数按 小时×日期 分桶 | 作息画像 |
| 会话存活 | time_created→time_updated 时长分布、idle_outcome 计数 | 短命会话占比 |
| 压缩事件 | compaction 消息计数（按会话/按日） | 马拉松会话信号 |
| todo 完成率 | completed / total | `todo` 表 |

## 6. Web API 设计（全部 GET，JSON）

| 路由 | 内容 |
|---|---|
| `/api/overview` | KPI 卡：今日/累计 token、今日命中率、会话数、步数、cost |
| `/api/trend?days=30` | 逐日序列：tokens 分项 + 命中率 |
| `/api/models` | 模型单点指标排行 |
| `/api/agents` | agent 用量 + 工具指纹 |
| `/api/sessions?limit=&offset=` | 会话列表（标题/模型/agent/时间/token，可排序） |
| `/api/session/:id/messages` | 单会话全部消息（角色分型，供回放） |
| `/api/session/:id/system-prompt` | 该会话关联的 instruction_blob 内容 |
| `/api/export/session/:id.md` | 服务端渲染的 Markdown 导出 |
| `/api/health` | 端口/版本/db 可达性探活 |

## 7. 前端与图表选型（v1，待调研校准）

- 零构建前端：原生 HTML + ES module JS + 手写 CSS，图表不引重型库——折线/面积用 **uPlot**（约 50KB，本地 vendored），环形图与横向条形图用手写 SVG（实现量小、无依赖）；
- 布局模式（业界通用，最终以调研结果校准）：
  1. 顶部 KPI 卡片行（今日 token、命中率、步骤、会话数）
  2. 图表网格：逐日消耗堆叠面积图 + 命中率折线（同轴双图）；模型/agent 占比环形图；工具调用横向条形图；小时热力格
  3. 模型排行榜明细表（§5 单点指标列）
  4. 会话列表 → 点击进入**单会话回放视图**：左列角色时间线（user / assistant 文本 / reasoning / 工具输入输出 / system），系统提示词折叠面板
- 深浅色主题跟随系统 `prefers-color-scheme`。

## 8. TUI 面

- `/insight`：打开看板（Windows `start` / macOS `open` / Linux `xdg-open`），并在 toast 显示实际端口；
- `/insight-status` 面板（`session.panel` slot，无 sidebar 时降级 dialog）：今日总量、今日命中率、模型 TOP5、7 日趋势字符条形图——视觉语言对齐 usage-meter（图标行、静默降级）；
- `/insight-export [会话ID]`：无参数时弹出 `dialog.select` 列最近 20 个会话；导出到 `./insight-exports/<日期>-<slug>.md`，角色分节（`## 🧑 用户` / `## 🤖 助手` / reasoning 引用块 / 工具调用代码块）。

## 9. 生命周期与安全

- server 插件 `setup()` 内启动 HTTP 服务，`teardown` 关闭；端口默认 `18789`，被占用时自动 +1 重试（最多 10 次），实际端口写入 storage 供 TUI 读取；
- 仅绑定 `127.0.0.1`，不对外网暴露；无鉴权（本机单人使用）；
- DB 连接只读；API 不返回凭据类表（`credential` / `account` 等绝不触碰）；
- 导出文件可能含会话内容：导出路径固定在用户目录下，README 提示注意敏感信息后再分享。

## 10. 已知限制

- `session_v2` 汇总滞后 → 所有统计以 `session_message` 累加为准，大库全量聚合首次请求可能达数百 ms，考虑进程内缓存（TTL 60s）；
- 历史遗留旧表（`part`/`message`，止于 2026-09-23）**不在**统计范围（避免双计）；回放视图对旧会话显示"仅新表支持"；
- claude-opus-5 / gpt-5.6-terra 等通道上报 0% 命中率是 provider 侧不报缓存，看板在模型行标注"通道不支持缓存"提示，避免误读；
- 时区按运行机器本地时间分桶。

## 11. 验证方法

- 语法：`npx esbuild src/tui.tsx --loader:.tsx=tsx --jsx=automatic`（对 index.ts 同理）；
- 单元：`node:test` 覆盖 stats 纯函数（命中率、分桶、模型指标、指纹）；
- 集成：`curl http://127.0.0.1:<port>/api/overview` 等逐路由实测（用本机真实库）；
- 端到端：`opencode plugin update` + 重启，实测斜杠命令、面板、导出、降级路径（db 缺失时 API 返回 503 文案）。

## 12. 里程碑

| 阶段 | 内容 | 交付物 |
|---|---|---|
| M0 | 骨架 + 文档 + 仓库 | design/tasks/changelog + 可 esbuild 的空插件 |
| M1 | 取数层 + 聚合纯函数 + 测试 | db reader、stats 模块、单测 |
| M2 | HTTP 服务 + JSON API | /api/* 全路由 |
| M3 | 看板前端（KPI/趋势/排行） | index 页 |
| M4 | 单会话回放视图 | session 页 |
| M5 | Markdown 导出 | /insight-export |
| M6 | TUI 面板 + 命令打磨 | /insight-status |
| M7 | 安装验证 + README 收敛 | v0.1.0 发布 |

每完成一个里程碑：commit → push GitHub → 记录 CHANGELOG.md（见 changelog 约定）。

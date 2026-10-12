# opencode-db-insight 设计文档（DESIGN.md）

> 版本：0.15.x（与 package.json / api.ts INSIGHT_VERSION 同步，当前 0.15.1）· 状态：实现中（v0.4.0 起随版本演进同步回写，2026-10-11 已与实现对账）
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
- `session_v2.tokens_*` 汇总字段**含被压缩（compaction）修剪的消息级历史**，message 级聚合对压缩会话反而低估；活库实证 v2 从不低于 message 级（844 会话 0 落后/69 领先，28/28 压缩会话 v2 领先），但历史统计口径仍一律以 `session_message` 逐条累加为准（跨面板注意 v2 与 message 级存在 ~0.36% 系统差），`session_v2` 仅用于会话列表与目录/agent 维度；
- token 结构（assistant 消息 `data.tokens`）：`input` / `output` / `reasoning` / `cache.read` / `cache.write`；
- 角色类型齐全：`user` / `assistant`（内含 text、reasoning、tool 三种 part）/ `system`（指令更新通知）/ `model-switched` / `compaction` / `idle` / `synthetic`；
- 系统提示词本体在 `instruction_blob`（按内容哈希存储，含环境块、工具目录、日期），可还原会话当时的指令注入；
- 工具调用的输入参数与执行输出完整保留在 tool part 的 `state.input` / `state.output`。

### 2.3 业界看板调研（@librarian 已完成，star 数实时查证于 2026-10-05）

**同类项目已存在，但组合定位是空位**：ccusage（18.9k★）有数据无交互 web 页；claude-lens（250★）有完整页面规格书但不支持 OpenCode 数据源；opencode-stats（75★，Rust+ratatui）只有终端无 web；touchkale/opencode-dashboard（3★，单文件 Python）已验证"读同一个 opencode.db + 手绘 SVG"可行。**"OpenCode 原生插件 + web 看板/回放 + 终端面板"这个组合目前无人占据**——指标与图表选型不需要再发明，直接采用业界已验证形态。

关键可借鉴仓库：

| 仓库 | Stars | License | 借鉴点 |
|---|---:|---|---|
| ryoppippi/ccusage | 18,877 | MIT | 五种聚合口径（daily/weekly/monthly/session/blocks）；cache read/write 分列；models.dev 定价缓存 |
| foyzulkarim/claude-lens | 250 | MIT | **页面规格书 `specs/claude-lens-pages.md` 可当 PRD 用**；三级数据精度标签；Session Detail/Turn Inspector 两级回放 |
| Cateds/opencode-stats | 75 | MIT | 终端看板直接竞品（Rust+ratatui 读 OpenCode SQLite）；时间范围三档热键 |
| open-webui/open-webui | 153,985 | 自定义 | Analytics 布局范式：KPI 行 → 大时序图 → 双明细表 → 行级下钻 |
| touchkale/opencode-dashboard | 3 | MIT | 单文件零依赖读同一 db 手绘 SVG——轻量档可行性证明 |

业界共识图表选型（已验证，直接采用）：模型占比→表+%列或环形图；每日消耗→**堆叠面积/堆叠条**（按模型分色）；趋势→折线+上周期 ghost line（ghost line 最终未采纳，见 §13）；工具调用→**横向条形**；长期活跃→**GitHub 式日历热力图**（CLI 圈最讨喜的图，三家在用）；时段习惯→小时×星期二维热力；成本异常→直方图+p50/p90/p99 刻度线（成本直方图未采纳，见 §13）。

差异化设计采纳（v0.1 内实现的排进任务，其余进 §13 备选）：
1. **数据精度分级标签**（🟢 DB 实值 / 🟡 估算）：本库 cost 字段常为 0，UI 必须明示每个数字的可信度；
2. **KPI 卡环比 delta（▲▼ vs 上一等长周期）**；
3. **GitHub 式 52 周日历热力图**作主视图之一；
4. **Token 漏斗**（上下文供给 → 缓存命中 → 实付输入 → 输出）——叙事图，比纯占比表直观；
5. **回放视图升级为两级**：会话级（角色时间线）+ turn 级成本条。

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
│   ├─ /insight-export    → 会话导出 Markdown           │
│   └─ /insight-refresh   → 清空 server 统计缓存（跨进程回环）│
└─────────────────────────────────────────────────────┘
        浏览器访问 http://127.0.0.1:<port>/
```

- **单一职责分层**：`src/db/`（只读取数）→ `src/stats/`（纯聚合函数，可测）→ `src/web/`（HTTP 服务与 API）→ `src/web/public/`（前端页面）→ `src/export/`（Markdown 导出）→ `src/tui/`（终端面板）；
- 入口文件（index.ts / tui.tsx）只做装配与生命周期清理，不承载业务逻辑；
- 单文件超 ~400 行即拆分（同全局规则）。

### 3.1 仓库目录树

```
opencode-db-insight/
├─ scripts/                      # 工具脚本：verify-install.ps1（推送后一键安装自验证）
├─ src/
│  ├─ index.ts                   # 插件入口：装配 insight server + 端口持久化 + 生命周期清理
│  ├─ tui.tsx                    # TUI 插件入口：装配四条斜杠命令
│  ├─ db/                        # 只读取数层
│  │  ├─ queries.ts              #   SQL 收敛处（会话列表 / 回放步骤 / todo）
│  │  ├─ aggregate-queries.ts    #   SQL 侧聚合（overview / trend / models / agents，与旧 JS 口径逐字段对账）
│  │  ├─ behavior-queries.ts     #   v0.2 行为统计（小时热力 / 会话存活 / 压缩事件）
│  │  ├─ scan-conventions.ts     #   扫描口径单点（assistant 谓词 / DAY_MS / 下推 floor 与回收窗口成对导出，0.2.1 起）
│  │  ├─ directory-queries.ts    #   v0.3 按项目目录统计（会话数 / 步数 / tokens 三分 / 最近活跃，预聚合 GROUP BY 消扇出）
│  │  ├─ rows.ts                 #   行记录解析与类型强制（coerceNumber / coerceText）
│  │  └─ types.ts                 #   数据面类型定义（SessionSummary / AssistantStepRow / ...）
│  ├─ stats/                     # 纯聚合函数层（无 IO，可单测）
│  │  ├─ daily-buckets.ts / model-metrics.ts / agent-fingerprint.ts / hit-rate.ts
│  │  └─ hour-heatmap.ts / session-survival.ts    # v0.2 纯函数（热力分桶带窗口回收下界）
│  │  └─ cache.ts                #   60s TTL + 64 条上限的结果缓存
│  ├─ web/                       # HTTP 服务层（node:http，仅绑定 127.0.0.1）
│  │  ├─ server.ts               #   生命周期（listen / shutdown / 端口重试）
│  │  ├─ request-handler.ts      #   Host 头校验（防 DNS rebinding）
│  │  ├─ router.ts / api.ts      #   路由分发 / JSON API（INSIGHT_VERSION 常量）
│  │  ├─ session-summary-csv.ts #   会话汇总 CSV 渲染纯函数（v0.8.0，RFC 4180 + BOM）
│  │  ├─ static-files.ts         #   静态文件服务（路径逃逸防护）
│  │  ├─ db-connection-guard.ts  #   连接自愈守卫（结构化致命错误判别）
│  │  └─ public/                 #   前端看板（原生 ESM，零构建）
│  │     ├─ app.js / data-source.js / format.js / theme.js / tooltip.js
│  │     ├─ mock-data.js / mock-replay-data.js
│  │     │                       #     USE_MOCK 开关（data-source.js）的 dev-only 预览
│  │     │                       #     数据源：不请求路由，内容为虚构数据（离线演示用）
│  │     ├─ components/          #     KPI 卡 / 趋势图 / 日历热力 / hour-heatmap 时段热力 /
│  │     │                       #     token 漏斗 / 模型表 / 会话列表（session-list +
│  │     │                       #     session-sort-controller 排序控制器 +
│  │     │                       #     session-csv-export 导出入口）/ 回放视图（session-replay /
│  │     │                       #     回放时间线与成本条 / replay-message-text 文本单点 /
│  │     │                       #     replay-search 页内搜索）/ 压缩面板 / 存活卡片 /
│  │     │                       #     目录统计面板 / 空态与加载态
│  │     └─ vendor/uplot/        #     uPlot 本地化（无 CDN 依赖）
│  ├─ export/                    # Markdown 导出渲染（角色分节 / 格式化辅助）
│  └─ tui/                       # TUI 命令实现
│     ├─ command-registry.ts     #   斜杠命令注册表
│     ├─ status-dialog.ts / status-dialog-content.ts / status-dialog-render.tsx
│     │                       #   /insight-status 弹窗三模块：生命周期 / 内容行构建 / JSX 渲染
│     ├─ open-dashboard-command.ts / export-command.ts
│     ├─ refresh-command.ts      #   /insight-refresh：跨进程回环清 server 缓存（v0.14.0）
│     ├─ discover-dashboard-port.ts  # 看板端口探测：18789..18798 并发 GET /api/health（v0.16.x TUI 侧发现机制）
│     └─ tui-context.ts         #   宿主 toast 降级助手
├─ test/                         # 347 用例：模块测试 + 集成 / 韧性 / SQL 对账 + 行为 / 目录 / 排序 / CSV / 搜索 / 刷新等回归面（随版本持续增补）
│  └─ helpers/                   # fake-insight-db / step 工厂
├─ DESIGN.md / tasks.md / CHANGELOG.md / README.md
└─ package.json / LICENSE
```


## 4. 数据源与读取层

- 路径解析：默认 `~/.local/share/opencode/opencode.db`（Windows 为 `%USERPROFILE%\.local\share\opencode\opencode.db`），允许通过 storage 持久化设置覆盖；
- **只读连接**：`node:sqlite` 以 `new DatabaseSync(path, {readOnly: true})` 打开（T1.1 实测采纳；与 `file:...?mode=ro` URI 等价），避免写锁与 WAL 干扰；宿主正在写库时并发读是安全的（WAL 模式）；
- 可用性已实测（2026-10-05，T1.1）：`node:sqlite DatabaseSync` 在 Bun 1.4.0（插件实际运行时）与 Node 24 均可用，`readOnly: true` 连接真实库查询正常，**无需 better-sqlite3 回退**；保留 try/catch 特性探测，探测失败时 API 返回 503 并在 health 中标注；
- 全部 SQL 收敛在 `src/db/queries.ts` 单文件，便于替换与审计。

## 5. 指标目录（口径定义）

| 指标 | 公式 / 来源 | 说明 |
|---|---|---|
| 今日总量 | Σ(tokens.input+output+cache.read) 当日 assistant 消息 | 以 session_message 为准 |
| 缓存命中率 | cache.read / (cache.read + input) | usage-meter 同款口径；严格口径含 write 的 `strictHitRate` 纯函数已备，v0.2 在回放页接线并注明口径 |
| 模型单点指标 | 步数、总量、命中率、步均输出、步均上下文、中位/p95 上下文、推理占比、活跃区间 | 排行榜核心 |
| agent 指纹 | Σ 各工具调用次数 / 该 agent 总调用 | 工具偏好分布 |
| 逐日趋势 | 按本地时区分桶：步骤、input、read、output、命中率 | 折线/面积图数据 |
| 小时热力 | 历史步骤数按 小时×星期 分桶（窗口回收下界与 trend 同构） | 作息画像（v0.2 已接线） |
| 会话存活 | time_created→time_updated 时长分布、idle_outcome 计数 | 短命会话占比（v0.2 已接线） |
| 压缩事件 | compaction 消息计数（按会话/按日/按 reason） | 马拉松会话信号（v0.2 已接线） |
| 目录维度 | 会话数 / assistant 步数 / tokens 三分（tokensInput / tokensOutput / tokensCacheRead，读 session_v2 汇总列）/ 最近活跃（MAX time_updated）按 session_v2.directory 聚合 | 全量口径，NULL/空目录排除出列表与 totals（v0.3 已接线）；tokens 三分为预聚合方案——step 子查询先 GROUP BY session_id 消除行扇出，SUM 不被步数放大（v0.15.0） |
| todo 完成率 | completed / total | `todo` 表 |
| 数字精度标签 | cost 为 DB 实值标 🟢；tokens 换算金额标 🟡 估算 | 采纳 claude-lens 精度分级；精度徽标仅在 KPI 卡逐数生效（kpi-card.js），模型表 / 会话列表 / 回放等其余面板由 index.html 页脚全局图例（🟢/🟡 说明）兜底语义 |

## 6. Web API 设计（全部 GET；除 sessions.csv 为 CSV 附件外均 JSON）

| 路由 | 内容 |
|---|---|
| `/api/overview` | KPI 卡：今日/累计 token、今日命中率、会话数、步数、cost |
| `/api/trend?days=30` | 逐日序列：tokens 分项 + 命中率；每点含 `byModel`（模型 id → 当日 tokens，值口径 input+read+output；键序 = 全窗总量 desc + modelId asc，v0.11.0），供按模型分色堆叠面积图 |
| `/api/models` | 模型单点指标排行 |
| `/api/agents` | agent 用量 + 工具指纹 |
| `/api/hour-heatmap?days=90` | 7×24 时段热力网格（168 格零填充，weekday=0 周日为外层） |
| `/api/session-survival` | 会话存活统计（中位时长 / 短命占比 / idle 结局分布） |
| `/api/compaction` | 压缩事件统计（总数 / 按 reason / 近 30 日逐日 / Top 10 会话） |
| `/api/todo` | todo 完成率统计（供看板卡片） |
| `/api/directories?limit=10` | 按项目目录统计（目录排行：会话数 / 步数 / 最近活跃；limit 钳位 1..50，全量口径无 days 窗口） |
| `/api/sessions?limit=&offset=&sort=&order=&directory=&range=` | 会话列表（标题/模型/agent/时间/token/cost）；每行含分项 `tokensInput` / `tokensOutput` / `tokensCacheRead`（session_v2 三列直通，v0.13.0；既有 `tokens` 折叠总和口径不变）；服务端排序：sort 白名单 time_updated（默认）/time_created/tokens/cost/title，order 默认 desc，非法回退默认；`id ASC` 次级键保证分页确定性；`?directory=` 精确下钻过滤（v0.7.0，miss=空 200）、`?range=7d|30d|90d` 时间窗（v0.9.0，未知非空 → 400）；缓存键含全部维度 |
| `/api/session/:id/messages` | 单会话全部消息（角色分型，供回放） |
| `/api/session/:id/system-prompt` | 该会话关联的 instruction_blob 内容 |
| `/api/export/session/:id.md` | 服务端渲染的 Markdown 导出 |
| `/api/export/sessions.csv` | 会话汇总 CSV 导出（v0.8.0）：九列固定序 id,title,modelId,agent,directory,timeCreated,timeUpdated,tokens,cost；RFC 4180 转义 + CRLF + UTF-8 BOM（Excel 中文不乱码）；全量翻页拉取（500/页）不截断，固定 sessions 默认序 + `id ASC` 决胜保证无重无漏；`?directory=` / `?range=` 与 sessions 同契约（导出是过滤视图快照）；一次性点击不走缓存 |
| `/api/refresh` | 清空进程内统计结果缓存（v0.14.0）：GET，恒 200 `{status:"ok", cleared:N}`；不依赖 db（db 为 null 仍 200，不进 503 名单）；路由自身不入缓存（避免自占用缓存槽），清空后下次查询重算 |
| `/api/health` | 端口/版本/db 可达性探活 |

## 7. 前端与图表选型（v1.1，已按 §2.3 调研结论校准）

- 零构建前端：原生 HTML + ES module JS + 手写 CSS，图表不引重型库——折线/面积用 **uPlot**（约 50KB，本地 vendored），环形图、横向条形、日历热力、漏斗用手写 SVG（实现量小、无依赖）；
- 布局采用业界三段式共识（OpenWebUI 范式）：
  1. **KPI 卡片行**：今日 token（in/out 分列）、今日命中率（▲▼ 环比昨日）、步骤数、会话数；每张卡含 sparkline；数字带精度标签（🟢 实值 / 🟡 估算）
  2. **图表网格**：逐日消耗**堆叠面积图（按模型分色）**+ 命中率折线；**52 周日历热力图**；工具调用横向条形图；Token 漏斗（供给→缓存命中→实付→输出）
  3. **明细表区**：模型排行榜（§5 单点指标列，可排序）→ 会话列表（行可点开 → 回放视图）
- **单会话回放视图**（两级）：会话级角色时间线（user / assistant 文本 / reasoning / 工具输入输出 / system）+ 系统提示词折叠面板；turn 级每步成本条（cache 读/实付/输出分段，模型切换标注）；
- **回放页内搜索**（v0.10.0）：查找栏输入即搜（200ms 防抖）+ 命中计数 + 上一处/下一处导航（Enter / Shift+Enter / Esc 浏览器查找栏惯例）；搜索面为六类文本（user 正文 / assistant text / reasoning / tool name / tool input / tool output），提取与渲染共用 replay-message-text.js 单点（杜绝"搜得到渲染不出"的口径漂移）；通知行刻意排除；节点级高亮，导航到未渲染分页区时驱动追加加载。
- 深浅色主题跟随系统 `prefers-color-scheme`；图表点击可下钻到过滤后的会话列表（drill-anywhere，v0.1 至少模型行→会话列表）。

## 8. TUI 面

- `/insight`：打开看板（Windows `start` / macOS `open` / Linux `xdg-open`），并在 toast 显示实际端口；
- `/insight-status` 用量弹窗（`ui.dialog.show` + size "large"；宿主无 ui.dialog 时降级为 toast 提示「当前界面不支持弹窗」）：今日总量、今日命中率、模型 TOP5、7 日趋势字符条形图——视觉语言对齐 usage-meter（图标行、静默降级）；ESC（关闭）/ r（按需重扫一次）由 setup 时注册一次的 **modal keymap 层**自接线，其 `enabled` 信号仅在弹窗存活窗口期为真（宿主 `keymap.layer` 返回 void、无手动卸载，靠 enabled 窗口期收工）；
- `/insight-export [会话ID]`：无参数时弹出 `dialog.select` 列最近 20 个会话；导出到**当前工作目录** `./insight-exports/<YYYYMMDD-HHmmss>-<slug>.md`，角色分节（`## 🧑 用户` / `## 🤖 助手` / reasoning 引用块 / 工具调用代码块）。
- `/insight-refresh`（v0.14.0，第 4 条命令）：清空 **server 进程**内 60s 统计结果缓存。TUI 与 server 是两个插件 flavor、两个进程——命令内直接 import `clearResultCache` 清的只会是 TUI 进程自己的空 Map（静默 no-op），故走**跨进程 fetch 回环**：探测看板端口（并发 `GET http://127.0.0.1:18789..18798/api/health`，仅认带本插件服务标识的响应，见 src/tui/discover-dashboard-port.ts）→ `GET http://127.0.0.1:{port}/api/refresh`（约 5s 超时防御）；成功 toast「已清除 N 条统计缓存（看板刷新页面后生效）」，无响应/超时/非 200/坏 JSON 全降级 error toast，永不抛。

## 9. 生命周期与安全

- server 插件 `setup()` 内启动 HTTP 服务，`teardown` 关闭；端口默认 `18789`，被占用时自动 +1 重试（最多 10 次）；TUI 侧通过 18789..18798 的 `/api/health` 健康探测发现端口（src/tui/discover-dashboard-port.ts），server 侧将实际端口写入 storage 为**遗留保留——已无读者**（后续版本清理）；
- 仅绑定 `127.0.0.1`，不对外网暴露；无鉴权（本机单人使用）；
- DB 连接只读；API 不返回凭据类表（`credential` / `account` 等绝不触碰）；
- 导出文件可能含会话内容：导出落在运行 OpenCode 时的工作目录 `./insight-exports/` 下，README 提示注意敏感信息后再分享。

## 10. 已知限制

- `session_v2` 汇总**含被压缩（compaction）修剪的消息级历史**（message 级对压缩会话低估；活库实证 v2 从不低于 message 级，844 会话 0 落后/69 领先）→ 历史统计口径仍以 `session_message` 累加为准（跨面板注意两口径存在 ~0.36% 系统差），大库全量聚合首次请求可能达数百 ms，考虑进程内缓存（TTL 60s）；
- 历史遗留旧表（`part`/`message`，止于 2026-09-23）**不在**统计范围（避免双计）；回放视图对旧会话显示"仅新表支持"；
- claude-opus-5 / gpt-5.6-terra 等通道上报 0% 命中率是 provider 侧不报缓存，看板在模型行标注"通道不支持缓存"提示，避免误读；
- `/api/refresh` 是唯一带副作用的 GET 路由（清统计缓存）：恶意网页理论上可从浏览器跨源 GET 本地该端点清缓存——影响仅限性能（多一次重算），不破坏数据、不可读数据，接受现状不做防护（ora-7 审查结论）；
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

## 13. 备选清单（有意未采纳的图型）

§2.3 中"其余进 §13 备选"的落点。以下图型在设计调研阶段进入过候选，经评估**有意未采纳**；记录于此防止重复调研，并给出再触发条件。

- **趋势 ghost line（上一周期同长基线虚线）**
  - 是什么：趋势图上叠加前一等长周期的同位序列，以虚线呈现"同期对比"。
  - 为何暂不采纳：KPI 卡已提供 ▲▼ 环比 delta（今日 vs 昨日），趋势图本身已按模型分色堆叠面积，再叠一条历史基线序列在高频多模型场景下视觉噪声大于信息增量。
  - 再触发条件：出现明确的"与上周期逐日对比"诉求，且 KPI 环比角标不足以表达时。
- **成本直方图 + p50/p90/p99 刻度线**
  - 是什么：会话级 cost 分布直方图，分位数刻度线用于识别成本异常会话。
  - 为何暂不采纳：本库 `cost` 字段常为 0（活库实测绝大多数行为 0），直方图退化为单柱零信息；tokens 换算金额属估算口径，做分位数刻线会把估算伪装成精确（与 §5 精度标签纪律相悖）。
  - 再触发条件：provider 侧开始落真实 cost，或引入公开定价表做系统化估算并带上精度标签之后。

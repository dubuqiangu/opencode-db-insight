# opencode-db-insight 设计文档（DESIGN.md）

> 版本：0.22.x（与 package.json / api.ts INSIGHT_VERSION 同步，当前 0.22.0）· 状态：实现中（v0.4.0 起随版本演进同步回写，2026-10-18 已与实现对账）
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
| 子代理开销占比 | Σ子代 tokens / Σ(子代+根) tokens；子代 = `session_v2.parent_id IS NOT NULL` | v0.21.0；tokens 口径 = input+output+cache.read；另出「直接子代消耗 TOP5」父会话（只含直接子代，不含孙代） |
| 会话步数分布 | 每会话 assistant 消息数分布（对数半档桶 + p50/p90/p99） | v0.21.0；锚定 `session_v2`（排除孤儿消息，与 token / 时长分布同锚） |
| 会话墙钟时长 | `session_v2.time_updated - time_created`（仅正值会话）分布 + 会话列表列 | v0.21.0；**非「活跃时长」**——`time_compacting` 全 0、`time_suspended` 仅 5，无从精确，故只做墙钟不引入估算 |
| 工具错误率逐日趋势 | 按本地日分桶：tool 段 `$.state.status === "error"` 的调用数 `toolCalls` 与 `errors`，错误率 = `errors / toolCalls` | v0.22.0；**直读** wire（🟢 实值，非换算）；全部会话口径、锚定 `session_v2`；与 `/api/tool-health` **同源抽取**（跨路由 Σ `toolCalls` / Σ `errors` 恒等，有守恒测试锁定） |
| 失败中断会话 | 会话最后一条 assistant **对象**消息（`PARTITION BY session_id ORDER BY seq DESC` 取 rn=1）携带 `$.error` 即判「以错误收尾」；`interruptedShare = interruptedSessions / sessionsWithSteps` | v0.22.0；**推断口径**（🟡）——`session_v2` 无 status/error 列，只能自消息推断；`byErrorType` 为**会话级终局**错误类型（Σ count == `interruptedSessions`；终局缺 `type` 者不计桶但仍计入中断）；`sessionsWithSteps` 与步数分布同集合（锚定 `session_v2`、`type='assistant'` 去重计数） |
| 压缩事件 | compaction 消息计数（按会话/按日/按 reason） | 马拉松会话信号（v0.2 已接线） |
| 目录维度 | 会话数 / assistant 步数 / tokens 三分（tokensInput / tokensOutput / tokensCacheRead，读 session_v2 汇总列）/ 最近活跃（MAX time_updated）按 session_v2.directory 聚合 | 全量口径，NULL/空目录排除出列表与 totals（v0.3 已接线）；tokens 三分为预聚合方案——step 子查询先 GROUP BY session_id 消除行扇出，SUM 不被步数放大（v0.15.0） |
| todo 完成率 | completed / total | `todo` 表 |
| 数字精度标签 | cost 为 DB 实值标 🟢；tokens 换算金额标 🟡 估算 | 采纳 claude-lens 精度分级；精度徽标仅在 KPI 卡逐数生效（kpi-card.js），模型表 / 会话列表 / 回放等其余面板由 index.html 页脚全局图例（🟢/🟡 说明）兜底语义 |

## 6. Web API 设计（全部 GET；除 sessions.csv 为 CSV 附件外均 JSON）

| 路由 | 内容 |
|---|---|
| `/api/overview` | KPI 卡：今日/累计 token、今日命中率、会话数、步数、cost |
| `/api/trend?days=30` | 逐日序列：tokens 分项 + 命中率；每点含 `byModel`（模型 id → 当日 tokens，值口径 input+read+output；键序 = 全窗总量 desc + modelId asc，v0.11.0），供按模型分色堆叠面积图 |
| `/api/models?days=N` | 模型单点指标排行（v0.18.0 加可选时间窗：scan-floor 下推 + 本地午夜回收；缺省/非法/0/负 = 全量且缓存键保持旧无参形状；clamp 1..366，clamp 后入键） |
| `/api/agents` | agent 用量 + 工具指纹 |
| `/api/tool-health` | 工具健康榜（v0.18.0）：session_message 工具段 `$.state.status` 两段式抽取聚合 `{tool, completed, error, running, total, errorRate}`，total 降序；**v0.22.0 起扫描无条件锚定 `session_v2`（排除孤儿消息，与各分布 / `session-outcomes` 同锚）**，抽取与 `/api/tool-error-trend` 收敛到共享模块 `tool-part-extraction.ts` |
| `/api/hour-heatmap?days=90` | 7×24 时段热力网格（168 格零填充，weekday=0 周日为外层；v0.18.0 起前端可选 7/30/90/全部窗口，副文案随选择动态化） |
| `/api/session-survival` | 会话存活统计（中位时长 / 短命占比 / idle 结局分布） |
| `/api/session-distribution` | 会话 token 总量分布（对数半档桶 + p50/p90/p99），排除零消耗会话（v0.20.0） |
| `/api/step-distribution` | 会话步数分布（每会话 assistant 消息数，锚定 session_v2 排除孤儿消息）（v0.21.0） |
| `/api/duration-distribution` | 会话墙钟时长分布（毫秒，仅 `time_updated > time_created` 的正值会话）（v0.21.0） |
| `/api/child-share` | 子代理开销占比（子/根会话数与 tokens、childShare）+ 直接子代消耗 TOP5 父会话（v0.21.0） |
| `/api/tool-error-trend?days=30` | 工具错误率逐日时序（v0.22.0）：本地日分桶的 `{days, points[{date, toolCalls, errors, errorRate}]}`；缺省 30、clamp 1..366（clamp 后入缓存键）；全部会话口径、**不吃 `?session=`**；与 `/api/tool-health` 同源抽取（跨路由 Σ 守恒） |
| `/api/session-outcomes` | 失败中断会话（v0.22.0，🟡 推断）：`{totalSessions, sessionsWithSteps, interruptedSessions, interruptedShare, byErrorType[], recentInterrupted[]}`；`sessionsWithSteps` 与步数分布同口径（锚定 `session_v2`），`recentInterrupted` limit 5（`time_updated` 降序）；全部会话口径、**不吃 `?session=`**（路径为**复数**） |
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
- **载入即取新**（v0.17.0）：`app.js` 每次页面载入先 `await fetchRefresh()`（`GET /api/refresh`，仅清进程内 60s TTL 缓存、不碰库）再拉各区块——浏览器 F5 保证全新数据；refresh 失败不阻塞加载（退化为最多滞后 60 秒的 TTL 语义）。
- **Agent 排行榜**（v0.18.0，`#agent-table` 全宽 span-both）：每 agent 会话数 / token 紧凑缩写 / 偏好工具 top-3 chip，tokens 降序；消费既有 `/api/agents`，零后端改动；表格复用 `.data-table` 语言。
- **工具错误率**（v0.18.0）：工具 TOP10 条叠加错误色带（errorRate ≥10% 红 / <10% 琥珀）+ `err N%` 标注 + tooltip 增行；面板头 `#tool-health-caption` 摘要全局错误率（Σerror/Σtotal）；health 加载失败只清摘要行，条形图本体照常渲染（无色带）。
- **范围选择器 ×2**（v0.18.0）：模型榜 7/30/90/全部（默认全部，`?days=` 下推后端）+ 限高 464px sticky 表头滚动容器；时段热力 7/30/90/全部（默认 90，副文案动态化——修「标 90 天视觉像一周」误读：实测 86% 步数集中近 30 天）。切换共用「序列守卫 + 分桶缓存 + 未命中保留旧表不闪骨架」模式。
- **分布卡族**（v0.21.0）：token / 步数 / 时长三张对数半档直方图共用共享内部渲染器 `renderSharedDistributionCard(container, distribution, options)`（`formatAxis` / `formatMean` / `sampleUnit` / `exclusionLabel` 按卡配置；`renderDistributionCard` 仍为 token 卡公开签名）；横轴按**桶序等宽**（原线性轴会把小值桶挤成一团），配可横向滚动区（窄屏）与屏幕阅读器桶明细表；会话列表加「墙钟」列（`time_updated - time_created`，`formatDurationMs` 紧凑呈现，无正时长显示「—」）。
- **子代理开销占比卡**（v0.21.0，`#panel-child-share` span-both）：双段占比条（子代 = `--accent` / 根 = `--blue`）+ 大号百分比 + 一句概括 + 直接子代消耗 TOP5 父会话清单（每行链到该会话回放）；左概览 / 右榜单两栏，窄屏折单栏。
- **工具错误率趋势卡**（v0.22.0，`#panel-tool-error-trend` span-12）：本地日的错误数与错误率时序；错误率折线可折叠（选择状态**跨重渲保活**）；范围 7/30/90/全部（「全部」复用 `MAX_TREND_DAYS`，与后端 clamp 同源）；工具段非法本地日直接剔除；副标题标 **🟢 实值**（直读 `$.state.status`，非换算）。
- **会话失败与中断卡**（v0.22.0，`#panel-session-outcomes` span-both）：以错误收尾会话的 hero 计数 + 占比（分母 = 有步骤会话，计数与占比互相兜底降级）+ 终局错误类型条（条宽为**相对榜首**占比）+ 最近中断记录清单（标题链到该会话回放）；副标题标 **🟡 推断**。
- **页首目录导航**（v0.18.0，`#toc-nav` 19 chip）：点击平滑滚动 + `.toc-flash` 短暂高亮（reduced-motion 降级）+ `scroll-margin` 防遮挡。
- **页脚精度图例**（v0.22.0 扩档）：`🟢 实值 = 直接来自数据库 · 🟡 推断/估算 = 由消息字段推断或由 token 换算，仅作参考`——「工具错误率趋势 = 实值」「会话失败与中断 = 推断」据此自洽。

## 8. TUI 面

- `/insight`：打开看板（Windows `start` / macOS `open` / Linux `xdg-open`），并在 toast 显示实际端口；
- `/insight-export [会话ID]`：无参数时弹出 `dialog.select` 列最近 20 个会话；导出到**当前工作目录** `./insight-exports/<YYYYMMDD-HHmmss>-<slug>.md`，角色分节（`## 🧑 用户` / `## 🤖 助手` / reasoning 引用块 / 工具调用代码块）。
- `/insight-refresh`（v0.14.0）：清空 **server 进程**内 60s 统计结果缓存。TUI 与 server 是两个插件 flavor、两个进程——命令内直接 import `clearResultCache` 清的只会是 TUI 进程自己的空 Map（静默 no-op），故走**跨进程 fetch 回环**：探测看板端口（并发 `GET http://127.0.0.1:18789..18798/api/health`，仅认带本插件服务标识的响应，见 src/tui/discover-dashboard-port.ts）→ `GET http://127.0.0.1:{port}/api/refresh`（约 5s 超时防御）；成功 toast「已清除 N 条统计缓存（看板刷新页面后生效）」，无响应/超时/非 200/坏 JSON 全降级 error toast，永不抛。

## 9. 生命周期与安全

- server 插件 `setup()` 内启动 HTTP 服务，`teardown` 关闭；端口默认 `18789`，被占用（EADDRINUSE）或被系统保留段拒绝（EACCES，Windows WinNAT 排除范围跨重启漂移，v0.17.0 起按前进类处理）时自动 +1 重试（最多 10 次）；TUI 侧通过 18789..18798 的 `/api/health` 健康探测发现端口（src/tui/discover-dashboard-port.ts），server 侧将实际端口写入 storage 为**遗留保留——已无读者**（后续版本清理）；
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
- **工具错误率时序 / 失败中断识别**（v0.21.0 B 档缓办 → **v0.22.0 已采纳**）：见 §5 / §6 / §7 的 v0.22.0 条目。缓办的自我条件已分别落实——错误率时序以「按时序的两段式 `$.state.status` 抽取 + 本地日分桶」实现（与 `/api/tool-health` 共享抽取模块，跨路由守恒）；失败中断识别以「最后一条 assistant 对象消息的 `$.error`」推断，带 **🟡 推断** 标签并以「会话级终局错误类型」界定，`session_v2` 无 status/error 列的空白用「🟡 仅作参考」的页脚图例兜底。
- **cache write 趋势 / 步均耗时**（v0.21.0 C 档，**淘汰**）
  - 是什么：cache write token 的逐日趋势；每步平均耗时指标。
  - 为何淘汰：真库实测 cache write 仅 8/964 会话有值（`tokens_cache_write` 基本为 0），趋势线退化为零线；步均耗时与既有「墙钟时长」高度重叠，单列反而啰嗦（与 §5「不重复、不啰嗦」纪律相悖）。
  - 再触发条件：cache write 覆盖率显著上升（如 provider 侧开始普遍落缓存写），或出现明确的步级性能排查诉求。

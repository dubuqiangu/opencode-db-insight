# 数据层契约（DATA-CONTRACT）

> 建立于 2026-10。所有表结构来自真实 `opencode.db` 的 `sqlite_master`，行数来自 `COUNT(*)`。
> 本文件回答：**每张表实际被谁读写、外键指向哪里、哪些列真用上了**。审查代码时以本文件为依据，不靠猜。

---

## 一、插件实际读取的表（FROM 白名单）

按源码里的 `FROM` / `JOIN` 逐表统计，另把每处嵌入 SQL 的 `SESSION_V2_ANCHOR_PREDICATE_SQL` 引用计为一次 `session_v2` 读取（常量定义行不计）——0.29.1 起孤儿锚定收敛为单点常量，`session_v2` 的字面出现次数不再等于读取点数量。因此下表的 `session_v2` 读取次数是**方法相关**的 ≈45（锚定常量按其被引用的次数计），并非字面出现次数（每次改动后重新统计，数字变化即为信号）：

| 表 | 读取次数 | 用途 |
|---|---|---|
| `session_v2` | ≈45 | 会话列表、KPI 汇总、成本/token、行为统计、目录下钻、分布、成员资格、**消息扫描的孤儿锚定** |
| `session_message` | 26 | 消息正文（user/assistant/tool/reasoning）、消息级历史、全文搜索 |
| `todo` | 3 | 侧栏 Todos 块、状态分布 |
| `instruction_state` | 1 | 会话系统提示词（current_values） |
| `instruction_blob` | 1 | 系统提示词块体（hash → value） |

**结论：插件从不直接读旧表 `session`、`message`、`part`。** 它们是宿主升级遗留的表，插件完全绕开；
凡涉及会话都锚定 `session_v2`。
---

## 二、两张会话表的真相（DDL 实测）

| | `session`（旧表） | `session_v2`（新表） |
|---|---|---|
| 行数 | **535** | **1077** |
| 外键 | `project_id → project(id)` | `project_id → project(id)` |
| 插件是否读 | **否** | **是** |
| 子表外键归属 | `message`、`part`、`todo`、`session_share` | `session_message`、`instruction_state`、`instruction_entry`、`session_inbox`、`session_pending` |

**关键架构事实**：宿主把消息与会话从「`session` + `message` + `part`」三表迁到
「`session_v2` + `session_message`」两表后，**旧表的子表外键没有跟着迁**。于是：

- `todo` 的外键仍指向旧表 `session`（已发现并加 `session_v2` 锚定 + 降级路径）。
- `session` 有 2 行不在 `session_v2`（todos=0、messages=0，当前无可见症状）。

---

## 三、外键归属总表（哪张子表跟哪张父表级联）

| 子表 | 父表 | 级联 |
|---|---|---|
| `session_message` | `session_v2` | DELETE CASCADE |
| `instruction_state` | `session_v2` | DELETE CASCADE |
| `instruction_entry` | `session_v2` | DELETE CASCADE |
| `session_inbox` | `session_v2` | DELETE CASCADE |
| `session_pending` | `session_v2` | DELETE CASCADE |
| `message` | `session`（旧） | DELETE CASCADE |
| `part` | `message`（旧） | DELETE CASCADE |
| `todo` | `session`（旧） | DELETE CASCADE |
| `session_share` | `session`（旧） | DELETE CASCADE |

**风险点**：插件只锚定 `session_v2`。若将来宿主把 `todo` / `session_share` 迁到
`session_v2` 语义，或反过来删 `session` 行，外键仍指向旧表会产生孤儿行。

---

## 四、关键表行数（真实库实测）

| 表 | 行数 | 备注 |
|---|---|---|
| `session_v2` | 1077 | 活跃会话主表 |
| `session` | 535 | 旧表，插件不读 |
| `session_message` | 61007 | 插件主读表 |
| `message` | 7437 | 旧表，插件不读 |
| `part` | 27010 | 旧表，插件不读 |
| `todo` | 252 | 分布在上百会话中 |
| `instruction_state` | 532 | 会话系统提示词状态 |
| `instruction_blob` | 147 | 提示词块体 |
| `event` / `event_sequence` / `kv` | 214 / 1085 / 375 | 宿主内部，插件不读 |
| `credential` | 2 | 宿主凭据存储，**插件不读** |

> 活库会持续写入：任何探针的样本数在一次会话内发生变化是正常的；
> **但若同一批探针反复读出的计数互相矛盾，先怀疑脚本，不要先怀疑数据。**

---

## 五、插件实际用到的列

### `session_v2`

`id`、`title`、`agent`、`model`、`time_created`、`time_updated`、`cost`、`tokens_input`、
`tokens_output`、`tokens_reasoning`、`tokens_cache_read`、`tokens_cache_write`、`project_id`、
`directory`、`path`、`slug`、`version`、`time_compacting`、`time_archived`、`time_suspended`、
`resume_attempts`、`time_idle`、`time_viewed`、`parent_id`、`idle_outcome`

> 列多但**不是全用**。`fork_session_id`、`fork_boundary`、`share_url`、`summary_*`、
> `metadata`、`revert`、`permission` 属于宿主保留字段，插件不读。

### `session_message`

`id`、`session_id`、`type`、`seq`、`time_created`、`time_updated`、`data`

> `data` 是 JSON 文本，含 user/assistant/tool/reasoning 正文与结构化字段。
> **这是凭据泄漏的主载体**：导出面已脱敏（`src/export/redact-credentials.ts`），回放页按用户选择保持原文。

### `todo`

`content`、`status`、`priority`、`position`、`time_created`、`time_updated`

> `priority` 取出但不参与排序与渲染——它在本库无区分度，拿来排序只会更差（已判定非缺陷）。
> `position` 由 `PRIMARY KEY(session_id, position)` 保证稠密唯一，代表用户与上游的数组顺序。

### `instruction_state` / `instruction_blob`

`current_values`（state）、`value`（blob）。系统提示词经 `hash → blob` 解引用。

---

## 六、插件读取的 SQL 形态（已核查）

- **所有消息扫描**都带 `AND session_id IN (SELECT id FROM session_v2)`（0.29.1 起收敛为单点常量 `scan-conventions.ts` 的 `SESSION_V2_ANCHOR_PREDICATE_SQL`，v0.29 的 7 个查询与 legacy 全局扫描共用），排除旧表孤儿行；`/api/search` 亦在其列——它是**全库全局口径、不吃 `?session=`**，但仍锚定 `session_v2`。
- 会话列表：`FROM session_v2` + `?sort=` 白名单排序 + `?directory=` / `?range=` 过滤。
- 消息级历史：`FROM session_message` + `type` 过滤 + `time_created >= ?`（增量）。
- 侧栏 todo：`FROM todo WHERE session_id = ? AND session_id IN (SELECT id FROM session_v2)`；
  无 `session_v2` 表时降级为不带锚定的版本。
- 系统提示词：`instruction_state.current_values` + `instruction_blob.value`。

---

## 七、wire 载荷（DESIGN.md §6 的补齐 / delta）

DESIGN.md §6 是路由与载荷的**权威总表**；本节的定位是：① 完整列出 §6 只给一句话、但值得写出 JSON 形状的少数端点；② 给出字段级 delta。字段名一律以源码为准；全部端点**只读**、锚定 `session_v2`。引入版本：`/api/search` v0.25.0；`/api/tool-tokens` v0.27.0（v0.28.0 起改自包含分词估算）；`/api/tool-error-trend` 与 `/api/session-outcomes` v0.22.0；`/api/models` 的 `previousTokens` v0.26.0；`/api/token-ledger`（A1）、`/api/session/:id/events`（A2/A3）、`/api/content-composition`（A4）、`/api/file-activity`（B5）、`/api/session-lineage`（B6）、`/api/export/session/:id.svg`（B8）均 v0.29.0（借鉴 dsh-context 实时透视 + billion-context 上下文引擎的可移植形状）。

### 检索：`/api/search`

```json
{
  "query": "关键字",
  "mode": "substring",
  "hits": [
    { "sessionId": "ses_…", "sessionTitle": "…", "messageId": "msg_…",
      "messageType": "assistant", "snippet": "…<mark>关键字</mark>…", "hitCount": 2 }
  ],
  "total": 41,
  "error": "invalid regex"
}
```

- `mode` ∈ `substring` | `regex`；子串大小写不敏感。
- `hits` 上限 200（按 `messageId` 去重），`total` 为真实全量匹配数；空 `q` 返回空 `hits`（200）。
- `error` 仅在正则语法非法时出现，值为 `"invalid regex"`（HTTP 仍 200，非 500）。
- 全库全局口径、锚定 `session_v2`、不吃 `?session=`。

### 工具：`/api/tool-tokens` —— `ToolTokenStat[]`

```json
{ "tool": "bash", "tokens": 123456, "share": 0.42, "steps": 37 }
```

- `tool` 为工具名（`""` 表示「无工具」桶）；`tokens` 为按**分词估算**权重分摊的整数（全表 Σ 精确等于全量步 token）；`share` 为该行占全量步 token 的比例（全表 Σ=1）；`steps` 为该工具出现的步数。
- 每 part 规模取自 `$.state.input` 与输出字段（`$.state.metadata.output` 字符串，否则 `$.state.content[]` 各 `{type:"text",text}` 拼接），**不是** `$.state.output`（真实 tool part 无该字段）。

### 工具：`/api/tool-error-trend?days=N`

```json
{ "days": 30, "points": [ { "date": "2026-10-31", "toolCalls": 812, "errors": 37, "errorRate": 0.0456 } ] }
```

- 按本地日分桶；缺省 30、clamp 1..366；与 `/api/tool-health` 同源抽取（跨路由 Σ `toolCalls` / Σ `errors` 恒等）。

### 会话：`/api/session-outcomes` —— 失败中断（🟡 推断）

```json
{
  "totalSessions": 1077, "sessionsWithSteps": 804,
  "interruptedSessions": 197, "interruptedShare": 0.2450,
  "byErrorType": [ { "type": "aborted", "count": 84 } ],
  "recentInterrupted": [
    { "sessionId": "ses_…", "title": "…", "errorType": "aborted",
      "errorMessage": "…", "timeUpdated": 1761… }
  ]
}
```

- `byErrorType` 为会话级终局错误类型（Σ `count` == `interruptedSessions`，终局缺 `type` 的会话不计入任何桶但仍计入中断）；排序 count 降序 + type 升序。
- `recentInterrupted` limit 5（`timeUpdated` 降序，`sessionId` 升序决胜）。

### 会话：`/api/session/:id/events`（自带 id，不吃 `?session=`）

```json
{ "events": [ { "seq": 12, "timeCreated": 1761…, "type": "model-switched",
                "detail": "glm-5.3 → claude-4" } ] }
```

- `type ∈ compaction | model-switched | system`；`seq` 升序。`detail`：compaction → reason（缺失 `"unknown"`）；model-switched → `from → to`；system → 文本前缀（截断 200 code point）。
- 未知会话 → 404，存在无事件 → 200 `{events:[]}`。

### 会话：`/api/content-composition`（字符量口径）

```json
{ "totalChars": 0,
  "categories": [ { "key": "assistantText", "chars": 0, "share": 0 } ],
  "toolEstimatedTokens": 0,
  "sessions": 0 }
```

- 六分类 key 白名单恒定出现：`assistantText` / `toolOutput` / `toolInput` / `reasoning` / `userText` / `other`；排序 chars desc + key asc。单位是**字符量**（`length()` code point），**不是 token**。`toolEstimatedTokens` 是全量唯一推算值（只覆盖工具输入 + 输出两类，🟡）。吃 `?session=`。

### 会话：`/api/file-activity?limit=20`

```json
{ "totalFiles": 0, "totalOps": 0,
  "files": [ { "path": "~/a/b.ts", "name": "b.ts", "reads": 3, "edits": 1,
               "writes": 0, "sessions": 2, "lastActiveMs": 1761… } ] }
```

- 只统计 `read` / `edit` / `write`；路径规范化（`\`→`/`、折叠 `//`、去尾 `/`、盘符首字母大写）后**脱敏**（`os.homedir()` → `~`）。排序 ops desc + path asc；`totalFiles` / `totalOps` 为截断前全量。limit 缺省 20、clamp 1..100。吃 `?session=`。

### 模型：`/api/models` 的 `previousTokens`（delta）

- `days>0` 时每个复合行（`modelId + providerId + variant`）带 `previousTokens`（上一等长窗口的 tokens，无基数记 0）；`days=0` / 全历史无上一窗口，恒 0。

### 记账：`/api/token-ledger`（A1）

```json
{
  "totals": { "promptInput": 0, "promptCacheRead": 0, "promptCacheWrite": 0,
              "promptTotal": 0, "output": 0, "reasoning": 0,
              "cacheHitRate": null, "sessions": 0 },
  "conservation": { "anomalies": { "negativeComponents": 0, "cacheReadExceedsPrompt": 0 },
                    "balanced": true },
  "reconciliation": { "residualTokens": 0, "residualRatio": null,
                      "withinTolerance": false, "tolerance": 0.02 },
  "sessions": [ { "sessionId": "ses_…", "messages": 37, "promptInput": 0,
                  "promptCacheRead": 0, "promptCacheWrite": 0, "promptTotal": 0,
                  "output": 0, "reasoning": 0, "cacheHitRate": null,
                  "v2Input": 0, "v2CacheRead": 0, "v2CacheWrite": 0, "v2Output": 0 } ]
}
```

- `conservation` 是**唯一** pass/fail：`balanced = (negativeComponents === 0 && cacheReadExceedsPrompt === 0)`。
- `reconciliation` **仅信息性**——message 侧总量与 `session_v2` 对照总量之差来自 compaction 剪枝（`session_v2` 保留被裁历史），超差是已知差值而非异常。
- `cacheHitRate = promptCacheRead / promptTotal`；`promptTotal === 0 → null`。`sessions` 每会话一行，`promptTotal` desc + `sessionId` asc。吃 `?session=`。

### 血缘：`/api/session-lineage?limit=400`

```json
{ "focusSessionId": null,
  "nodes": [ { "sessionId": "ses_…", "parentSessionId": null, "title": "…",
               "agent": "…", "tokens": 0, "timeCreated": 1761…, "childCount": 0 } ],
  "edges": [ { "parentSessionId": "ses_a", "childSessionId": "ses_b" } ],
  "stats": { "totalSessions": 0, "graphSessions": 0, "rootCount": 0, "childCount": 0,
             "orphanParentCount": 0, "selfParentCount": 0, "cycleCount": 0, "maxDepth": 0 },
  "omittedNodeCount": 0 }
```

- `tokens` = 三列（input + output + cache.read）合计；`limit` 是**节点预算**（缺省 400、clamp 1..1000），预算内按子树大小 desc 的 BFS 入选，`omittedNodeCount = 候选集 − 入选数`；`stats` 恒为结构全量（不截断）。聚焦时候选集 = 焦点 + 祖先 + 后代。
- 查询层恒扫全表 `session_v2`（重建祖先链需完整父指针，**不**吃 `?session=`）；路由仍走共享 `?session=` 存在性 gate（未知 id → 404）。

### 导出：`/api/export/session/:id.svg`（B8）

`image/svg+xml; charset=utf-8`（`Content-Disposition: attachment`）。DOM-free 纯函数渲染，`.md` 与 `.svg` 复用同一数据源（summary + messages + flattened system prompt）；**never throws**（坏行降级为占位符，不 500）。自带 id、不吃 `?session=`；未知会话 / 无消息 → 404（`SESSION_NOT_FOUND_MESSAGE` / `SESSION_EMPTY_MESSAGE`），db 缺 → 503。

---

## 八、已确认的契约风险（结论存档）

| # | 事实 | 处置 |
|---|---|---|
| 1 | `todo` 外键指向旧表 `session` | 已锚定 `session_v2` + 降级路径 |
| 2 | 导出会写出 `session_message.data` 里的明文凭据 | 已脱敏（仅导出面；回放页按要求保持原文） |
| 3 | `todo.priority` 取而不用 | 判定非缺陷（无区分度，排序只会更差） |
| 4 | 插件 5 表读取白名单稳定 | 记录在案，供后续审查引用 |
| 5 | 前端 `fetchRefresh` 请求 `/api/api/refresh` | 已修（前缀重复拼接），页面载入时的两个 404 归零 |

---

## 九、前端数值精度分级与缺数据口径

前端只有一个可信度出口：`src/web/public/precision.js`。它把读数分成四类，判定依据是**数据来源**，不是数字大小：

| 类别 | 判定 | 渲染 |
|---|---|---|
| 实值 | 直接取数据库列，除单位换算外无算术 | 绿点徽标「实值」 |
| 估算 | 由 token 量按公开单价换算，或由多个原始列算术派生 | 琥珀点徽标「估算」 |
| 推断 | 库中无对应列，由消息字段反推 | 琥珀点徽标「推断」 |
| 不可得 | 字段未记录，或分母为 0 | "—" 加原因悬浮，**不折算为 0** |

两条硬规则：

1. **0 与 "—" 不同义。** 0 是真实读数（例如本会话确实没有缓存写入），照实渲染 0；"—" 只表示没有读数。
2. **不可得的原因必须取自 `MISSING_REASON`。** 同一原因在会话列表、模型表、卡片里必须是同一句话，调用点不得自拼文案；新增原因先补目录。

`format.js` 返回的 `"—"` 是纯文本占位，只用于调用方无法判断原因的场景；知道原因的地方一律走 `renderMissingValue`。

已确认的口径差（属于设计选择，不是缺陷）：

| 现象 | 原因 | 结论 |
|---|---|---|
| 会话列表 Cost 列常显示 "—" | 本库 `cost` 字段常为 0，0 与未记录同义 | 按不可得渲染，不显示 `$0` |
| 会话级与消息级 tokens 合计相差约 0.36% | 前者汇总 `session_v2`，后者汇总 `session_message` | 两侧各自自洽，面板副标题已注明口径 |
| `todo.priority` 有列但不展示 | 本库无区分度 | 非缺陷 |

---

## 十、给后续审查的方法

1. **先量化再动手**：拿真实库跑数字，不基于假设改代码。
2. 可疑但不确定的，交独立判断（@oracle），不自己拍板。
3. 改一处只碰一个文件，命名见名知意。
4. 推送前脱敏扫描独立一步，先读输出再推，绝不与 `git push` 写进同一条命令。
5. 数字自相矛盾本身就是信号——先查脚本，再怀疑数据。

> 本文件描述的是**事实**，不是愿望。任何一条与代码不符时，先验证哪一边过时了，再改。

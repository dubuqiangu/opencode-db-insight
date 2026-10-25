# 数据层契约（DATA-CONTRACT）

> 建立于 2026-10。所有表结构来自真实 `opencode.db` 的 `sqlite_master`，行数来自 `COUNT(*)`。
> 本文件回答：**每张表实际被谁读写、外键指向哪里、哪些列真用上了**。审查代码时以本文件为依据，不靠猜。

---

## 一、插件实际读取的表（FROM 白名单）

按源码里的 `FROM` / `JOIN` 逐表统计（每次改动后重新统计，数字变化即为信号）：

| 表 | 读取次数 | 用途 |
|---|---|---|
| `session_v2` | 36 | 会话列表、KPI 汇总、成本/token、行为统计、目录下钻、分布、成员资格 |
| `session_message` | 19 | 消息正文（user/assistant/tool/reasoning）、消息级历史 |
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

- **所有消息扫描**都带 `AND session_id IN (SELECT id FROM session_v2)`，排除旧表孤儿行。
- 会话列表：`FROM session_v2` + `?sort=` 白名单排序 + `?directory=` / `?range=` 过滤。
- 消息级历史：`FROM session_message` + `type` 过滤 + `time_created >= ?`（增量）。
- 侧栏 todo：`FROM todo WHERE session_id = ? AND session_id IN (SELECT id FROM session_v2)`；
  无 `session_v2` 表时降级为不带锚定的版本。
- 系统提示词：`instruction_state.current_values` + `instruction_blob.value`。

---

## 七、已确认的契约风险（结论存档）

| # | 事实 | 处置 |
|---|---|---|
| 1 | `todo` 外键指向旧表 `session` | 已锚定 `session_v2` + 降级路径 |
| 2 | 导出会写出 `session_message.data` 里的明文凭据 | 已脱敏（仅导出面；回放页按要求保持原文） |
| 3 | `todo.priority` 取而不用 | 判定非缺陷（无区分度，排序只会更差） |
| 4 | 插件 5 表读取白名单稳定 | 记录在案，供后续审查引用 |
| 5 | 前端 `fetchRefresh` 请求 `/api/api/refresh` | 已修（前缀重复拼接），页面载入时的两个 404 归零 |

---

## 八、给后续审查的方法

1. **先量化再动手**：拿真实库跑数字，不基于假设改代码。
2. 可疑但不确定的，交独立判断（@oracle），不自己拍板。
3. 改一处只碰一个文件，命名见名知意。
4. 推送前脱敏扫描独立一步，先读输出再推，绝不与 `git push` 写进同一条命令。
5. 数字自相矛盾本身就是信号——先查脚本，再怀疑数据。

> 本文件描述的是**事实**，不是愿望。任何一条与代码不符时，先验证哪一边过时了，再改。


# opencode-db-insight

OpenCode V2 插件：只读分析本地 `opencode.db` 的历史用量——浏览器统计看板、单会话回放、终端面板与 Markdown 导出。

## 快速开始

1. 安装插件：`opencode plugin add github:dubuqiangu/opencode-db-insight`
2. 完整重启 OpenCode（插件只在重启后加载）。
3. 在 OpenCode TUI 的输入框里输入 `/insight`。
4. 浏览器打开看板（默认 `http://127.0.0.1:18789/`，实际端口以 toast 为准）。

## 功能

- **`/insight`** —— 在浏览器打开本地 Web 看板（`http://127.0.0.1:18789/` 起，端口被占用自动 +1）：
  - KPI 总览（今日/累计 token、今日缓存命中率、会话数、步数、费用）
  - 模型排行榜：步数、总量、token 占比、命中率、步均输出、中位/p95 上下文、推理占比；同一 `modelId` 跨 provider / variant 各自成行，并给出相对上一等长窗口的 ▲/▼ 环比角标（可按 7/30/90 天/全部时间窗筛选，限高滚动不占版面）
  - Agent 排行榜（每 agent 会话数 / token 消耗 / 偏好工具）
  - 逐日趋势（token 分项 + 命中率折线，按模型分色的堆叠面积图）与 52 周日历热力图、7×24 时段热力（窗口可选 7/30/90 天/全部）；点日历任一格子可把下方会话列表过滤到该本地日
  - 会话列表（服务端排序，可按项目目录下钻、按 7/30/90 天时间窗筛选，入/出 token 分列）；面板脚注「导出 CSV」把当前过滤视图的**全部会话**下载为 CSV（`GET /api/export/sessions.csv`：九列固定序，RFC 4180 转义 + UTF-8 BOM，Excel 打开中文不乱码，翻页拉全量不截断）
  - 工具调用榜（附错误率色带与全局错误率）、Token 漏斗、按目录统计，以及会话存活 / 压缩事件 / todo 完成率等行为统计卡片
  - 记账守恒卡片：prompt 三分（新输入 / 缓存读 / 缓存写）+ 缓存命中率 + 完整性判定（只报异常计数）；与 `session_v2` 的信息性对照仅供排查（compaction 剪枝致差值，非异常）
  - 按工具 token 归因（🟡 估算）：在工具调用榜下按步内分词估算权重分摊每工具 token（整数守恒）
  - 会话内容构成条（六类**字符量**堆叠，非 token）与文件活动榜（只统计 read/edit/write，路径脱敏）
  - Agent 血缘图：会话父子关系分层树（手写 SVG，零依赖），可点节点深链回放、可聚焦某会话只看其祖先 + 后代
  - 跨会话全文搜索：搜遍全部会话的消息正文 / 工具入出参 / 思考过程，子串或正则两模式，命中行可直接深链到该会话回放
  - 页首目录导航：chip 一键跳转到对应区块
  - 看板自动刷新：页面按固定间隔自动拉取最新统计，无需手动 F5（可在页面开关）
- **单会话回放**（看板内点会话进入）：角色时间线（用户/助手/工具输入输出/系统消息）+ 系统提示词折叠面板 + turn 级成本条 + token 曲线（Total / Delta 切换 + 会话事件标记）+ 页内搜索（输入即搜、命中计数、上一处/下一处导航）+ 头部「导出 Markdown / 导出 SVG」（原生附件下载）
- **`/insight-export [会话ID]`** —— 把任意会话导出为角色分节的 Markdown（无参数时弹出最近 20 个会话供选择）
- **`/insight-refresh`** —— 清空**服务器进程内**的统计缓存，toast 提示清除条数（如「已清除 N 条统计缓存」）；看板页面刷新后即取到最新数据

与 [opencode-usage-meter](https://github.com/dubuqiangu/opencode-usage-meter)（实时指标）互补：它管**实时**，本插件只做**历史**侧分析。

> 最近更新：v0.29.2（2026-11-07）——复审修复收口：模型排行榜下钻失效、CSV 导出忽略 `?day=`、日历日窗口 DST 边界、Markdown 导出 notice 脱敏，并把 README 重写为小白可一键走完的黄金路径；用例补全至 834 例。完整记录见 [CHANGELOG.md](./CHANGELOG.md)。

## 前置条件

- 已在运行 **OpenCode V2**——本插件是它的插件，不能独立运行（TUI 与浏览器看板都在宿主内启动）。
- 宿主运行时需带 `node:sqlite`：OpenCode 自带的 **Bun 1.4+** 或 **Node 24+** 均已实测可用。
- 插件对 `opencode.db` 始终**只读**打开，不写库、不改 schema。

## 安装

> ⚠️ 同一插件只能用**一种**方式安装；混用会导致重复加载或更新失败。安装后都需**完整重启 OpenCode**（见下一节）。

### ① 官方仓库安装（推荐）

普通用户直接执行：

```sh
opencode plugin add github:dubuqiangu/opencode-db-insight
```

它会把 `github:dubuqiangu/opencode-db-insight` 写进全局 `opencode.json` 的插件列表。

### ② 手动 clone（想改源码 / 跟 main）

把仓库克隆到宿主的全局插件目录。**先确认本机是哪种 shell，再用对应的一行命令**（不要用 `&&` 串联，Windows PowerShell 5.1 不支持）：

macOS / Linux（bash、zsh、Git Bash）：

```sh
git clone https://github.com/dubuqiangu/opencode-db-insight ~/.config/opencode/plugins/opencode-db-insight
```

Windows PowerShell：

```powershell
git clone https://github.com/dubuqiangu/opencode-db-insight "$env:USERPROFILE\.config\opencode\plugins\opencode-db-insight"
```

对应的插件目录：Unix 为 `~/.config/opencode/plugins/opencode-db-insight`，Windows 为 `%USERPROFILE%\.config\opencode\plugins\opencode-db-insight`。该目录会被宿主自动发现，**普通用户到此为止**。

> `npm install` **仅开发/测试需要**（仓库唯一的依赖是 devDependency）；普通安装请勿执行，历史上有用户因它安装失败。需要改源码时见下方「开发」。

### ③ 在 opencode.json 里指本地路径（本地开发联调）

编辑全局 `opencode.json`（Windows：`%USERPROFILE%\.config\opencode\opencode.json`），把仓库根目录加进插件**数组**；路径要指向插件**目录**（仓库根），不是单个文件：

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    "file:///D:/path/to/opencode-db-insight"
  ]
}
```

- Windows 用三斜杠 `file:///D:/...` 形式；macOS / Linux 可用 `file:///home/you/opencode-db-insight`，或直接写相对/绝对目录（如 `"./plugins/opencode-db-insight"`）。
- 也可沿用旧的 `"plugin"` 字段名（官方已标记 deprecated，但同样接受字符串数组）——与你现有 `opencode.json` 保持一致即可。

## 重启宿主

安装、更新或改动配置后，**完整重启 OpenCode**（退出当前 TUI 再启动），插件才会被加载。斜杠命令在 **OpenCode TUI 的输入框**里输入（与聊天消息同一个输入框）；`/insight` 必须先重启过宿主才会出现。

## 使用

三条斜杠命令（在 OpenCode TUI 输入框输入）：

- `/insight` —— 打开浏览器看板。
- `/insight-export [会话ID]` —— 导出 Markdown；省略会话 ID 时弹出最近 20 个会话供选择。
- `/insight-refresh` —— 清空看板统计缓存，清完刷新页面生效。

其它：

- 看板地址 `http://127.0.0.1:18789/`，被占用时自动 +1 重试（至多 10 次，端口段 `18789–18798`）；`/insight` 的 toast 显示**实际**端口，也可访问 `GET /api/health` 查看。
- 导出目录：`./insight-exports/`（相对 OpenCode 启动目录），文件名 `<时间戳>-<会话标题>.md`，中文标题保留。看板「导出 CSV」与回放页「导出 Markdown / 导出 SVG」则是浏览器直接下载 `sessions.csv` / `.md` / `.svg` 附件（携带当前过滤或该会话），不落该目录。
- 数据源：只读打开 OpenCode 数据库（Unix：`~/.local/share/opencode/opencode.db`；Windows：`%USERPROFILE%\.local\share\opencode\opencode.db`），路径可在插件 storage 中用 `insight-db-path` 覆盖。
- 右侧栏「Todos」块跟随当前会话，每页 4 条；`in_progress` 恒排首位，已完成 ✓ / 进行中 〜 / 未做 ·。点标题行折叠（折叠态持久化），底部 `‹ n/m ›` 翻页，切会话页码归零；**没有未完成项时整块消失**，写入新 todo 后约 1 秒出现。
- 回放页消息深链：`http://127.0.0.1:18789/#/session/<会话ID>?msg=<消息ID>` 直接滚到并高亮该条消息（2 秒后消隐），目标在 200 条分页区之外时自动加载到它。未知或空的 `msg` 静默忽略。

## 更新 / 验证

```sh
opencode plugin list                       # 应列出 opencode-db-insight
opencode plugin update opencode-db-insight # 更新（更新后需重启 OpenCode 生效）
opencode plugin remove opencode-db-insight # 卸载
```

> 若 `opencode plugin update opencode-db-insight` 报 “not configured”，改用不带参数的 `opencode plugin update`（更新**全部**插件）——这也是随仓库分发的 `scripts/verify-install.ps1` 内置的回退。

从仓库安装（方式 ②/③）时，可用随插件分发的一键自验证脚本；**在仓库根目录**运行，首次会自动 `opencode plugin add`，之后自动 `opencode plugin update`，并逐项打印 PASS/FAIL：

```powershell
pwsh ./scripts/verify-install.ps1
```

脚本依次校验：HEAD 已推送 → 安装/更新落到正确 commit → 磁盘版本号与 `package.json` 一致 → `src`/`test` 文件树镜像 → `opencode.json` 注册。**注意**：它只验证**磁盘安装状态**，运行中的宿主仍需完整重启才会加载新代码。

## 开发

在 clone 出的仓库目录里：

```sh
npm install       # 安装 devDependency（普通安装不需要）
npm test          # 运行测试：node --test --experimental-strip-types "test/*.test.ts"
npm run check     # 类型检查（tsc --noEmit）+ 构建冒烟检查
```

## 排障

> Windows PowerShell 把 `curl` 别名到 `Invoke-WebRequest`；下面用 `curl.exe` 才能按原样发请求。

| 症状 | 原因与处理 |
|---|---|
| `/insight` 提示「看板服务未启动」 | TUI 在 `127.0.0.1:18789-18798` 段逐端口做健康探测（`GET /api/health`，校验响应中的服务标识）均未命中——即 server flavor 没在本会话进程中运行：通常是插件刚安装/更新还没随宿主启动，**重启 OpenCode**；仍不行先 `opencode plugin list` 确认插件已启用，再 `curl.exe http://127.0.0.1:18789/api/health` 看 server 是否存活、端口是否被占用顶到了 +1 段 |
| 面板显示「db-insight: 数据不可用」 | `opencode.db` 不存在（OpenCode 尚未产生历史数据）或运行时缺 `node:sqlite`；用 health 路由 `curl.exe http://127.0.0.1:18789/api/health` 看 `dbStatus` |
| 看板某会话 404「session not found in current tables」 | 2026-09-23 之前的旧表（`part`/`message`）会话**不在**统计与回放范围（避免双计），属预期行为 |
| 某模型命中率恒为 0% | 部分通道（provider 侧）不上报缓存数据，看板模型行已标注，非故障 |
| 更多日志 | OpenCode 日志目录：`~/.local/share/opencode/log/`（Windows：`%USERPROFILE%\.local\share\opencode\log\`）；插件 API 层对 db 缺失/坏参/旧表均有固定错误约定，可先看 `/api/health` |

导出文件包含完整会话内容（可能含敏感信息），分享前请自行检查。

## License

MIT

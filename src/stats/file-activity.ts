/**
 * 文件活动（B5）for GET /api/file-activity. Pure functions, zero IO;
 * style mirrors token-ledger.ts / directory-queries.ts.
 *
 * 口径（冻结，合同 §5.2 点 2/4、§5.3）：
 * - 只统计 `read` / `edit` / `write` 三个工具；`grep` / `glob` / `shell` /
 *   `bash` / `patch` / `ast_grep` 一律排除（查询层 WHERE 已收窄）。不提供
 *   「改动行数 / 文件大小」——DB 里没有这些字段。
 * - 分组键是**服务端规范化后的路径**（查询层 SQL 负责 `\`→`/`、折叠重复
 *   `/`、去尾 `/`、仅盘符首字母大写、其余大小写保留），这里再叠加隐私
 *   脱敏 applyHomeRedaction。
 * - **路径脱敏策略**（合同 §5.2 点 4）：把 `os.homedir()` 前缀替换为 `~`
 *   （`\` 与 `/` 两种写法都替换——查询层已把反斜杠归一成斜杠，故这里只需
 *   处理 `/` 形式；homedir 自身也先经同一规范化）。其余原样。这样同一
 *   目录在 `\` / `/` 两种写法下仍归到同一个 `~` 键。
 * - 排序 ops desc、path asc（ops = reads + edits + writes），确定性；
 *   totalFiles / totalOps 报**截断前**的全量口径。
 * - 后端只返回原始数字，不做四舍五入 / 格式化（精度标签在前端）。
 */

/** 默认条数（与前端 mock 一致；api.ts 用它做 limit 缺省，先夹后 key）。 */
export const DEFAULT_FILE_ACTIVITY_LIMIT = 20

/** limit 上限（保护响应体，DEFAULT/MAX 契约点）。 */
export const MAX_FILE_ACTIVITY_LIMIT = 100

/**
 * 一条已按规范化路径归组的文件活动样本（查询层原样抽出）。
 * path 已脱敏（homedir → `~`）；name 由 stat 侧从 path 派生。
 */
export interface FileActivitySample {
  /** 规范化 + 脱敏后的展示路径（`\`→`/`、折叠 `//`、去尾 `/`、盘符首字母大写、homedir→`~`）。 */
  path: string
  /** read 次数。 */
  reads: number
  /** edit 次数。 */
  edits: number
  /** write 次数。 */
  writes: number
  /** 触及该文件的会话数（COUNT(DISTINCT session_id)）。 */
  sessions: number
  /** 最近一次操作时间（epoch-ms，MAX(time_created)）；缺时戳 → 0。 */
  lastActiveMs: number
}

/** 一条文件活动行 of GET /api/file-activity. */
export interface FileActivityFile {
  path: string
  name: string
  reads: number
  edits: number
  writes: number
  sessions: number
  lastActiveMs: number
}

/** Payload for GET /api/file-activity?limit=20. */
export interface FileActivityStats {
  /** 规范化文件数（截断前全量）。 */
  totalFiles: number
  /** 全部 read+edit+write 次数（截断前全量）。 */
  totalOps: number
  /** 按 ops desc + path asc 排序的文件行（调用方按需截断到 limit）。 */
  files: FileActivityFile[]
}

/**
 * 展示名 = 最后一个非空路径段。`~/a/b.ts` → `b.ts`，
 * `D:/x/y.ts` → `y.ts`；无非空段时回退原串。
 */
export function fileNameFromPath(filePath: string): string {
  const pathSegments = filePath.split(/[\\/]/).filter((pathSegment) => pathSegment !== "")
  return pathSegments.length > 0 ? pathSegments[pathSegments.length - 1] : filePath
}

/**
 * 规范化文件路径键（查询层与脱敏层共用同一形状）：`\`→`/`、折叠重复
 * `/`、去尾 `/`、仅盘符首字母大写、其余大小写保留。空串 / 根 → 返回原值
 * （applyHomeRedaction 的守卫再决定不替换）。
 *
 * 查询层对每条原始路径先调本函数再归组，脱敏层把 homedir 自身也经同一
 * 规范化后比较前缀——两处形状一致，前缀比较才与真实路径键对齐。
 */
export function normalizeFilePath(rawPath: string): string {
  const slashSeparated = rawPath.replace(/\\/g, "/")
  const collapsed = slashSeparated.replace(/\/{2,}/g, "/")
  const trimmed = collapsed.replace(/\/+$/, "")
  return /^[A-Za-z]:/.test(trimmed)
    ? trimmed.slice(0, 1).toUpperCase() + trimmed.slice(1)
    : trimmed
}

/**
 * 隐私脱敏：规范化路径若等于 homedir 或以 homedir + "/" 开头，则把该前缀
 * 替换为 `~`；否则原样返回。大小写敏感（合同 §5.2 点 4：仅盘符首字母大写、
 * 其余大小写保留）。homedir 为空 → 不替换。
 */
export function applyHomeRedaction(normalizedPath: string, homeDirectory: string): string {
  const normalizedHome = normalizeFilePath(homeDirectory)
  if (normalizedHome === "") return normalizedPath
  if (normalizedPath === normalizedHome) return "~"
  if (normalizedPath.startsWith(normalizedHome + "/")) {
    return "~" + normalizedPath.slice(normalizedHome.length)
  }
  return normalizedPath
}

/**
 * 把已归组的文件样本聚合成 { totalFiles, totalOps, files }（纯函数、
 * 确定性）：派生 name、汇总 ops、按 ops desc + path asc 排序。files 返回
 * **全量**排序结果——limit 的截断由查询层按夹紧后的值执行（保持本函数
 * 无 limit 参数、可独立测试）。空输入 → 零总计、空列表。
 */
export function computeFileActivity(samples: FileActivitySample[]): FileActivityStats {
  const files: FileActivityFile[] = samples.map((sample) => ({
    path: sample.path,
    name: fileNameFromPath(sample.path),
    reads: sample.reads,
    edits: sample.edits,
    writes: sample.writes,
    sessions: sample.sessions,
    lastActiveMs: sample.lastActiveMs,
  }))

  let totalOps = 0
  for (const file of files) {
    totalOps += file.reads + file.edits + file.writes
  }

  files.sort((left, right) => {
    const leftOps = left.reads + left.edits + left.writes
    const rightOps = right.reads + right.edits + right.writes
    return rightOps - leftOps || (left.path < right.path ? -1 : left.path > right.path ? 1 : 0)
  })

  return { totalFiles: files.length, totalOps, files }
}

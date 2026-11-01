/**
 * Wave 2A mock 生产者（v0.29.0）：B5 文件活动。
 *
 * 单独成文件（不改 mock-data.js）：形状严格对齐合同 §5.3 的冻结响应体，
 * 供 data-source.js 的 USE_MOCK 分支消费，离线预览能看到文件活动表的完整
 * 路径（可见名 + 完整路径 title + 读/改/写迷你比例条 + 四列计数）。
 *
 *   getMockFileActivity(limit) → GET /api/file-activity?limit=N[&session=]
 *     { totalFiles, totalOps,
 *       files:[{ path, name, reads, edits, writes, sessions, lastActiveMs }] }
 *
 * 口径（合同 §5.2 点 2）：只统计 `read` / `edit` / `write`；`grep` / `glob` /
 * `shell` / `bash` / `patch` / `ast_grep` **一律排除**。路径已按 §5.2 点 4
 * 脱敏：`os.homedir()` 前缀替换为 `~`；这里给的都是脱敏后的展示值。
 * 排序 ops desc、path asc（合同 §5.3）；limit 先夹到 [1, MAX]（同后端）。
 */

/** 服务端默认条数与上限（镜像 stats/file-activity.ts 的常量）。 */
export const MOCK_FILE_ACTIVITY_DEFAULT_LIMIT = 20;
export const MOCK_FILE_ACTIVITY_MAX_LIMIT = 100;

/**
 * 文件活动样本（ops = reads + edits + writes，仅此三者），按 ops desc 摆放。
 * 路径一律用通用占位（`~/projects/...` 同 mock-data.js 的 SESSION_DIRECTORIES
 * 惯例；盘符形式同样给假名），混合 `~` 前缀与盘符两种脱敏后写法，绝不写真实
 * 机器布局。
 */
const MOCK_FILE_ROWS = [
  { path: "~/projects/aicode/opencode-db-insight/src/web/public/app.js", name: "app.js", reads: 128, edits: 42, writes: 9, sessions: 31, lastActiveMs: 1_762_000_000_000 },
  { path: "~/projects/aicode/opencode-db-insight/src/web/public/data-source.js", name: "data-source.js", reads: 96, edits: 37, writes: 6, sessions: 27, lastActiveMs: 1_761_800_000_000 },
  { path: "~/projects/aicode/opencode-db-insight/src/web/router.ts", name: "router.ts", reads: 74, edits: 21, writes: 4, sessions: 19, lastActiveMs: 1_761_500_000_000 },
  { path: "~/projects/aicode/opencode-db-insight/src/stats/token-ledger.ts", name: "token-ledger.ts", reads: 51, edits: 28, writes: 11, sessions: 14, lastActiveMs: 1_761_200_000_000 },
  { path: "~/projects/aicode/opencode-db-insight/src/web/public/components/token-ledger-card.js", name: "token-ledger-card.js", reads: 44, edits: 17, writes: 3, sessions: 12, lastActiveMs: 1_761_000_000_000 },
  { path: "D:/projects/opencode-db-insight/src/db/content-composition-queries.ts", name: "content-composition-queries.ts", reads: 33, edits: 12, writes: 5, sessions: 9, lastActiveMs: 1_760_800_000_000 },
  { path: "~/projects/aicode/opencode-db-insight/test/file-activity.test.ts", name: "file-activity.test.ts", reads: 29, edits: 14, writes: 8, sessions: 8, lastActiveMs: 1_760_500_000_000 },
  { path: "~/projects/aicode/opencode-db-insight/src/web/public/components-extra.css", name: "components-extra.css", reads: 22, edits: 19, writes: 7, sessions: 11, lastActiveMs: 1_760_300_000_000 },
  { path: "~/projects/aicode/opencode-db-insight/package.json", name: "package.json", reads: 18, edits: 6, writes: 2, sessions: 7, lastActiveMs: 1_760_000_000_000 },
  { path: "~/projects/aicode/opencode-db-insight/README.md", name: "README.md", reads: 12, edits: 4, writes: 3, sessions: 5, lastActiveMs: 1_759_600_000_000 },
  { path: "D:/projects/opencode-db-insight/src/web/public/index.html", name: "index.html", reads: 9, edits: 5, writes: 1, sessions: 4, lastActiveMs: 1_759_200_000_000 },
  { path: "~/projects/aicode/opencode-db-insight/src/stats/file-activity.ts", name: "file-activity.ts", reads: 7, edits: 3, writes: 2, sessions: 3, lastActiveMs: 1_758_800_000_000 },
];

/** 单行的操作总数（仅 read / edit / write）。 */
function rowOperationTotal(row) {
  return row.reads + row.edits + row.writes;
}

/** limit 先夹到 [1, MAX]（同后端 clamp 口径，先夹后 key）。 */
function clampLimit(limit) {
  const numericLimit = Number(limit);
  if (!Number.isFinite(numericLimit) || numericLimit <= 0) return MOCK_FILE_ACTIVITY_DEFAULT_LIMIT;
  return Math.min(Math.floor(numericLimit), MOCK_FILE_ACTIVITY_MAX_LIMIT);
}

/**
 * GET /api/file-activity 的 mock 响应体：files 按 ops desc、path asc 排序后
 * 截取前 limit 条；totalFiles / totalOps 报全量（截断前）口径。
 */
export function getMockFileActivity(limit = MOCK_FILE_ACTIVITY_DEFAULT_LIMIT) {
  const sortedRows = [...MOCK_FILE_ROWS].sort(
    (left, right) =>
      rowOperationTotal(right) - rowOperationTotal(left)
      || (left.path < right.path ? -1 : left.path > right.path ? 1 : 0),
  );
  const totalOps = sortedRows.reduce((sum, row) => sum + rowOperationTotal(row), 0);
  const effectiveLimit = clampLimit(limit);
  return {
    totalFiles: sortedRows.length,
    totalOps,
    files: sortedRows.slice(0, effectiveLimit),
  };
}

/**
 * Per-project-directory usage statistics for GET /api/directories
 * (v0.3-A): how many sessions and assistant steps each working
 * directory accumulated, plus its most recent activity timestamp.
 *
 * 口径 notes:
 * - The step count reuses the shared assistant-step predicate from
 *   scan-conventions.ts verbatim (P2-3 single source) — it rides inside
 *   the LEFT JOIN subquery so the unprefixed predicate text stays valid.
 * - The join is PRE-AGGREGATED (v0.15.0 方案 A): the subquery groups by
 *   session_id first, so every session joins exactly one row and the
 *   row fan-out of the old per-step-row join is gone by construction.
 *   That is what makes the token SUMs below safe — under the old shape
 *   SUM(s.tokens_input) would multiply a session's tokens by its step
 *   count. COUNT(DISTINCT s.id) stays as a defensive no-op.
 * - The per-directory token sums read the session_v2 summary columns
 *   (v2 汇总口径): they include the compaction-pruned message-level
 *   history, and differ from the message-level 口径 by ~0.36%
 *   systematically (live-db probe 2026-10-06). Sessions with a NULL or
 *   empty directory column are excluded from every sum, so Σ目录
 *   tokens ≠ the whole-database total by design.
 * - Sessions with a NULL or empty directory column are excluded from
 *   the list AND from both totals (real db carries exactly one such
 *   row, probed 2026-10-06).
 * - No days window: like the models/agents panels this is an
 *   all-time view.
 */

import type { SqliteReadConnection } from "./types.ts"
import { asRecord, coerceNumber, coerceText } from "./rows.ts"
import { ASSISTANT_OBJECT_DATA_PREDICATE } from "./scan-conventions.ts"

/** Default row limit for the directories list (DESIGN v0.3-A contract). */
export const DEFAULT_DIRECTORY_LIMIT = 10

/** Upper clamp for ?limit — protects the response size, P2-6 style. */
export const MAX_DIRECTORY_LIMIT = 50

/** One directory row of the wire payload. */
export interface DirectoryStat {
  /** Full original path, e.g. "D:/projects/example-alpha". */
  directory: string
  /** Display name = last non-empty path segment (see directoryDisplayName). */
  name: string
  /** Sessions whose session_v2.directory equals this value. */
  sessions: number
  /** Assistant steps across those sessions (shared step 口径). */
  steps: number
  /**
   * Σ session_v2.tokens_input of the directory's sessions, coerced
   * value-by-value. v2 汇总口径: includes the compaction-pruned
   * message-level history and differs from the message-level 口径 by
   * ~0.36% systematically. Excluded NULL/empty-directory sessions are
   * not in this sum, so Σ目录 ≠ the whole-database total.
   */
  tokensInput: number
  /** Σ session_v2.tokens_output, same v2 口径 and exclusions as tokensInput. */
  tokensOutput: number
  /** Σ session_v2.tokens_cache_read, same v2 口径 and exclusions as tokensInput. */
  tokensCacheRead: number
  /** MAX(time_updated) of those sessions, epoch-ms; null when absent. */
  lastActiveMs: number | null
}

/** Wire payload for GET /api/directories?limit=10. */
export interface DirectoryStats {
  /** Distinct non-empty directories, unclamped by limit. */
  totalDirectories: number
  /** Sessions with a non-empty directory, unclamped by limit. */
  totalSessions: number
  /** Top directories, sorted steps desc → sessions desc → directory asc. */
  directories: DirectoryStat[]
}

/**
 * Display name for a directory path: the last non-empty segment after
 * splitting on both separators. "C:/Users/example-user" → "example-user",
 * "D:\\projects\\example-beta" → "example-beta". A path with no non-empty
 * segment falls back to the original string.
 */
export function directoryDisplayName(directoryPath: string): string {
  const pathSegments = directoryPath.split(/[\\/]/).filter((pathSegment) => pathSegment !== "")
  return pathSegments.length > 0 ? pathSegments[pathSegments.length - 1] : directoryPath
}

/**
 * Directory stats for GET /api/directories. One grouped scan produces
 * every non-empty directory (single-digit-to-dozens of groups), the JS
 * side derives both totals from that same result — conservation between
 * totalSessions/totalDirectories and the list is guaranteed by
 * construction — then sorts deterministically (steps desc, sessions
 * desc, directory asc) and slices to the clamped limit.
 *
 * The SQL ORDER BY is kept as a pushdown nicety but the wire order is
 * owned by the explicit JS comparator, so the ordering contract cannot
 * depend on storage-engine collation details.
 */
export function queryDirectoryStats(
  db: SqliteReadConnection | null,
  limit: number = DEFAULT_DIRECTORY_LIMIT,
): DirectoryStats | null {
  if (db === null) return null
  const requestedLimit = Number.isFinite(limit) ? Math.floor(limit) : DEFAULT_DIRECTORY_LIMIT
  const boundedLimit = Math.min(Math.max(requestedLimit, 1), MAX_DIRECTORY_LIMIT)

  const rawRows = db
    .prepare(
      `SELECT s.directory AS directory_name,
              COUNT(DISTINCT s.id) AS session_count,
              COALESCE(SUM(step_counts.step_count), 0) AS step_count,
              MAX(s.time_updated) AS last_active_ms,
              -- SQL 侧 SUM 的类型假设（区别于 P1-1 禁令）：overview 禁在 SQL 内加
              -- session_message.data 的 JSON 文本值（TEXT 前缀解析风险）；这三列是
              -- opencode writer 恒写数值的 session_v2 结构列（活库探针 855/855 全
              -- integer），勿把本模式复制到 message 数据上。
              SUM(s.tokens_input) AS tokens_input_sum,
              SUM(s.tokens_output) AS tokens_output_sum,
              SUM(s.tokens_cache_read) AS tokens_cache_read_sum
       FROM session_v2 s
       LEFT JOIN (SELECT session_id, COUNT(*) AS step_count
                  FROM session_message
                  WHERE ${ASSISTANT_OBJECT_DATA_PREDICATE}
                  GROUP BY session_id) step_counts
         ON step_counts.session_id = s.id
       WHERE s.directory IS NOT NULL AND s.directory != ''
       GROUP BY s.directory
       ORDER BY step_count DESC, session_count DESC, directory_name ASC`,
    )
    .all()

  const directoryRows: DirectoryStat[] = []
  let totalSessions = 0
  for (const rawRow of rawRows) {
    const rowRecord = asRecord(rawRow)
    if (rowRecord === null) continue
    const directoryPath = coerceText(rowRecord["directory_name"])
    if (directoryPath === "") continue
    const sessionCount = coerceNumber(rowRecord["session_count"])
    const lastActiveRaw = rowRecord["last_active_ms"]
    totalSessions += sessionCount
    directoryRows.push({
      directory: directoryPath,
      name: directoryDisplayName(directoryPath),
      sessions: sessionCount,
      steps: coerceNumber(rowRecord["step_count"]),
      // SUM over a group whose every joined row is NULL yields SQL NULL
      // — the `?? 0` keeps the zero explicit instead of leaning on
      // coerceNumber's null coercion (same per-column read discipline
      // as parseSessionSummaryRow in queries.ts).
      tokensInput: coerceNumber(rowRecord["tokens_input_sum"] ?? 0),
      tokensOutput: coerceNumber(rowRecord["tokens_output_sum"] ?? 0),
      tokensCacheRead: coerceNumber(rowRecord["tokens_cache_read_sum"] ?? 0),
      lastActiveMs: lastActiveRaw === null || lastActiveRaw === undefined ? null : coerceNumber(lastActiveRaw),
    })
  }

  directoryRows.sort(
    (leftRow, rightRow) =>
      rightRow.steps - leftRow.steps ||
      rightRow.sessions - leftRow.sessions ||
      (leftRow.directory < rightRow.directory ? -1 : leftRow.directory > rightRow.directory ? 1 : 0),
  )

  return {
    totalDirectories: directoryRows.length,
    totalSessions,
    directories: directoryRows.slice(0, boundedLimit),
  }
}

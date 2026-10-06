/**
 * Per-project-directory usage statistics for GET /api/directories
 * (v0.3-A): how many sessions and assistant steps each working
 * directory accumulated, plus its most recent activity timestamp.
 *
 * 口径 notes:
 * - The step count reuses the shared assistant-step predicate from
 *   scan-conventions.ts verbatim (P2-3 single source) — it rides inside
 *   the LEFT JOIN subquery so the unprefixed predicate text stays valid.
 * - COUNT(DISTINCT s.id) shields the session count from the join's
 *   row fan-out (one session joins N step rows).
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
              COUNT(step_messages.session_id) AS step_count,
              MAX(s.time_updated) AS last_active_ms
       FROM session_v2 s
       LEFT JOIN (SELECT session_id FROM session_message
                  WHERE ${ASSISTANT_OBJECT_DATA_PREDICATE}) step_messages
         ON step_messages.session_id = s.id
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

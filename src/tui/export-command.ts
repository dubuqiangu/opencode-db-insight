/**
 * /insight-export command logic (DESIGN.md §8, task T5.2).
 *
 * Talks to the query layer and the markdown renderer directly — the TUI runs
 * in the same process, so there is no reason to round-trip through HTTP.
 *
 * Naming helpers (`buildExportFilename` / `buildExportFilePath`) are pure and
 * unit-tested; the dialog pick, file write and toast side effects are kept in
 * small injected-behavior functions so tests can stub the TUI context.
 *
 * Every access to the TUI context is defensive: the plugin host may not
 * expose `ui.dialog` / `ui.toast`, and any failure must degrade silently
 * instead of breaking the TUI.
 */

import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"

import type { SessionSummary, SqliteReadConnection } from "../db/types.ts"
import {
  openOpencodeDb,
  querySessionList,
  querySessionMessages,
  querySessionSystemPrompt,
} from "../db/queries.ts"
import { renderSessionMarkdown } from "../export/markdown.ts"
import { formatLocalTimestamp } from "../export/format-helpers.ts"
import { buildExportSlug, findSessionSummaryById, flattenSystemPromptForExport } from "../web/api.ts"
import { showInsightToast } from "./tui-context.ts"

/** How many recent sessions the picker dialog offers. */
export const RECENT_SESSION_PICK_COUNT = 20

/** Export documents land in ./insight-exports relative to the TUI cwd. */
export const EXPORT_DIRECTORY_NAME = "insight-exports"

/** Structural shape of `context.ui.dialog.select` we rely on. */
interface DialogSelectFunction {
  (options: {
    title: string
    options: Array<{ title: string; value: string; description?: string }>
  }): Promise<string | undefined>
}

/** Read `context.ui.dialog.select` if it exists; null otherwise. */
function readDialogSelect(context: unknown): DialogSelectFunction | null {
  try {
    const contextRecord = context as
      | { ui?: { dialog?: { select?: unknown } } }
      | null
      | undefined
    const selectCandidate = contextRecord?.ui?.dialog?.select
    return typeof selectCandidate === "function"
      ? (selectCandidate as DialogSelectFunction)
      : null
  } catch {
    return null
  }
}

/**
 * Pure: the export filename `<YYYYMMDD-HHmmss>-<slug>.md` (tasks.md T5.2).
 * Invalid timestamps degrade to an "unknown-time-" prefix instead of throwing.
 */
export function buildExportFilename(sessionTitle: string, exportTimestampMs: number): string {
  const exportMoment = new Date(exportTimestampMs)
  if (Number.isNaN(exportMoment.getTime())) {
    return `unknown-time-${buildExportSlug(sessionTitle)}.md`
  }
  const twoDigits = (value: number) => String(value).padStart(2, "0")
  const timestampStamp =
    `${exportMoment.getFullYear()}${twoDigits(exportMoment.getMonth() + 1)}${twoDigits(exportMoment.getDate())}` +
    `-${twoDigits(exportMoment.getHours())}${twoDigits(exportMoment.getMinutes())}${twoDigits(exportMoment.getSeconds())}`
  return `${timestampStamp}-${buildExportSlug(sessionTitle)}.md`
}

/** Pure: full target path of one export document. */
export function buildExportFilePath(
  exportDirectory: string,
  sessionTitle: string,
  exportTimestampMs: number,
): string {
  return join(exportDirectory, buildExportFilename(sessionTitle, exportTimestampMs))
}

/**
 * Impure: ensure the export directory exists and write the document.
 * Returns the written path; filesystem errors propagate to the caller
 * (runExportCommand turns them into an error toast).
 */
export async function writeSessionExportDocument(
  exportDirectory: string,
  sessionTitle: string,
  markdownDocument: string,
  exportTimestampMs: number = Date.now(),
): Promise<string> {
  await mkdir(exportDirectory, { recursive: true })
  const exportFilePath = buildExportFilePath(exportDirectory, sessionTitle, exportTimestampMs)
  await writeFile(exportFilePath, markdownDocument, "utf8")
  return exportFilePath
}

/**
 * Let the user pick among the RECENT_SESSION_PICK_COUNT most recent sessions.
 * Returns the picked summary, or null on cancel / empty list / missing
 * dialog API — silently (T5.2: cancel is not an error).
 */
export async function pickSessionForExport(
  context: unknown,
  databaseConnection: SqliteReadConnection,
): Promise<SessionSummary | null> {
  const dialogSelect = readDialogSelect(context)
  if (dialogSelect === null) return null

  const recentSessions = querySessionList(databaseConnection, RECENT_SESSION_PICK_COUNT, 0)
  if (recentSessions === null || recentSessions.length === 0) return null

  try {
    const dialogOptions = recentSessions.map((sessionSummary, sessionIndex) => ({
      title:
        sessionSummary.title === ""
          ? `${sessionIndex + 1}. （无标题会话）`
          : `${sessionIndex + 1}. ${sessionSummary.title}`,
      value: sessionSummary.id,
      description: `${formatLocalTimestamp(sessionSummary.timeCreated)} · ${sessionSummary.modelId} · ${sessionSummary.agent}`,
    }))
    const pickedSessionId = await dialogSelect({
      title: "选择要导出的会话（最近 20 个）",
      options: dialogOptions,
    })
    if (typeof pickedSessionId !== "string") return null
    return recentSessions.find((sessionSummary) => sessionSummary.id === pickedSessionId) ?? null
  } catch {
    return null
  }
}

/**
 * Run /insight-export: with an explicit session id export it directly,
 * otherwise open the picker dialog. Writes ./insight-exports/<stamp>-<slug>.md
 * and toasts the result. Returns the exported path or null; never throws.
 *
 * The optional `dependencies` only exist so tests can inject a fake
 * connection and a temp directory; production calls use the defaults.
 */
export interface ExportCommandDependencies {
  /** Read-only db connection; defaults to opening the real opencode.db. */
  databaseConnection?: SqliteReadConnection | null
  /** Where documents land; defaults to ./insight-exports under the cwd. */
  exportDirectory?: string
}

export async function runExportCommand(
  context: unknown,
  explicitSessionId?: string,
  dependencies: ExportCommandDependencies = {},
): Promise<string | null> {
  const databaseConnection =
    dependencies.databaseConnection !== undefined
      ? dependencies.databaseConnection
      : openOpencodeDb()
  const exportDirectory =
    dependencies.exportDirectory ?? join(process.cwd(), EXPORT_DIRECTORY_NAME)
  try {
    if (databaseConnection === null) {
      showInsightToast(context, "db-insight：opencode 数据库不可用，无法导出", "error")
      return null
    }

    let sessionSummary: SessionSummary | null = null
    // The host may pass a non-string argument (or undefined); only a real
    // string counts as an explicit session id (P2-8).
    const requestedSessionId =
      typeof explicitSessionId === "string" ? explicitSessionId.trim() : ""
    if (requestedSessionId !== "") {
      sessionSummary = findSessionSummaryById(databaseConnection, requestedSessionId)
      if (sessionSummary === null) {
        showInsightToast(
          context,
          `db-insight：未找到会话 ${requestedSessionId}（2026-09-23 前的旧表会话不支持导出）`,
          "error",
        )
        return null
      }
    } else {
      sessionSummary = await pickSessionForExport(context, databaseConnection)
      if (sessionSummary === null) return null // cancelled or nothing to offer
    }

    const messageRecords = querySessionMessages(databaseConnection, sessionSummary.id)
    if (messageRecords === null || messageRecords.length === 0) {
      showInsightToast(
        context,
        "db-insight：该会话在新表中没有消息记录（旧表会话不支持导出）",
        "error",
      )
      return null
    }
    const systemPrompt = querySessionSystemPrompt(databaseConnection, sessionSummary.id)

    const markdownDocument = renderSessionMarkdown(
      sessionSummary,
      messageRecords,
      flattenSystemPromptForExport(systemPrompt),
    )
    const exportFilePath = await writeSessionExportDocument(
      exportDirectory,
      sessionSummary.title,
      markdownDocument,
    )
    showInsightToast(context, `db-insight 已导出：${exportFilePath}`, "success")
    return exportFilePath
  } catch (exportError) {
    const failureMessage = exportError instanceof Error ? exportError.message : String(exportError)
    showInsightToast(context, `db-insight 导出失败：${failureMessage}`, "error")
    return null
  } finally {
    databaseConnection?.close()
  }
}

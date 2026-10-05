/**
 * Unit tests for the export filename helpers (T5.1/T5.2):
 * buildExportSlug + buildExportDownloadFilename (src/web/api.ts) and
 * buildExportFilename + buildExportFilePath + writeSessionExportDocument
 * (src/tui/export-command.ts). Pure naming rules + one real temp-dir write.
 *
 * Timestamps are built from LOCAL Date components so the assertions hold in
 * any timezone.
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { buildExportSlug, buildExportDownloadFilename } from "../src/web/api.ts"
import {
  buildExportFilename,
  buildExportFilePath,
  writeSessionExportDocument,
} from "../src/tui/export-command.ts"
import { buildFakeSessionSummary } from "./helpers/fake-insight-db.ts"

test("buildExportSlug keeps CJK and replaces every illegal filename character", () => {
  assert.equal(buildExportSlug("分析会话用量"), "分析会话用量")
  assert.equal(buildExportSlug('a/b\\c:d*e?f"g<h>i|j'), "a-b-c-d-e-f-g-h-i-j")
  assert.equal(buildExportSlug("修复  登录\tbug"), "修复 登录 bug")
})

test("buildExportSlug degrades empty and dot-only titles to untitled-session", () => {
  assert.equal(buildExportSlug(""), "untitled-session")
  assert.equal(buildExportSlug("   "), "untitled-session")
  assert.equal(buildExportSlug("... ..."), "untitled-session")
})

test("buildExportSlug strips trailing dots and spaces but keeps inner punctuation", () => {
  assert.equal(buildExportSlug("会话标题.. "), "会话标题")
  assert.equal(buildExportSlug("修复 bug。"), "修复 bug。")
})

test("buildExportSlug truncates to 60 characters without splitting a surrogate pair", () => {
  const longAsciiTitle = "a".repeat(100)
  assert.equal(buildExportSlug(longAsciiTitle).length, 60)

  // 59 CJK chars + a 2-unit emoji: cutting at 60 would split the emoji,
  // so the slug ends up at 59 characters instead of carrying a lone
  // high surrogate into the filesystem.
  const emojiTitle = "汉".repeat(59) + "🙂"
  const emojiSlug = buildExportSlug(emojiTitle)
  assert.equal(emojiSlug.length, 59)
  assert.ok(!/[\ud800-\udbff]$/.test(emojiSlug), "must not end on a lone high surrogate")

  const longCjkTitle = "字".repeat(100)
  assert.equal(buildExportSlug(longCjkTitle).length, 60)
})

test("buildExportDownloadFilename uses the session-created local date as prefix", () => {
  const sessionSummary = buildFakeSessionSummary({
    title: "看板数据核对",
    timeCreated: new Date(2026, 9, 5, 15, 30).getTime(),
  })
  assert.equal(buildExportDownloadFilename(sessionSummary), "2026-10-05-看板数据核对.md")

  const untitledSummary = buildFakeSessionSummary({ title: "", timeCreated: Number.NaN })
  assert.equal(buildExportDownloadFilename(untitledSummary), "unknown-date-untitled-session.md")
})

test("buildExportFilename stamps the export moment as YYYYMMDD-HHmmss", () => {
  const exportMoment = new Date(2026, 9, 5, 15, 30, 4).getTime()
  assert.equal(buildExportFilename("看板数据核对", exportMoment), "20261005-153004-看板数据核对.md")
  assert.equal(
    buildExportFilename("", Number.NaN),
    "unknown-time-untitled-session.md",
    "invalid export timestamps degrade instead of throwing",
  )
})

test("buildExportFilePath joins the directory and the timestamped filename", () => {
  const exportMoment = new Date(2026, 9, 5, 15, 30, 4).getTime()
  const exportFilePath = buildExportFilePath(join("root", "insight-exports"), "看板数据核对", exportMoment)
  assert.ok(
    /insight-exports[\\/]20261005-153004-看板数据核对\.md$/.test(exportFilePath),
    `unexpected path: ${exportFilePath}`,
  )
})

test("writeSessionExportDocument creates the directory and writes the document", async () => {
  const exportRoot = await mkdtemp(join(tmpdir(), "insight-export-write-"))
  const exportDirectory = join(exportRoot, "insight-exports", "nested")
  try {
    const exportMoment = new Date(2026, 9, 5, 15, 30, 4).getTime()
    const writtenPath = await writeSessionExportDocument(
      exportDirectory,
      "看板数据核对",
      "# 看板数据核对\n\n正文",
      exportMoment,
    )
    assert.ok(writtenPath.endsWith("20261005-153004-看板数据核对.md"))
    const writtenContent = await readFile(writtenPath, "utf8")
    assert.ok(writtenContent.includes("# 看板数据核对"))
  } finally {
    await rm(exportRoot, { recursive: true, force: true })
  }
})

test("writeSessionExportDocument fails loudly when the target path is not a directory", async () => {
  const exportRoot = await mkdtemp(join(tmpdir(), "insight-export-blocked-"))
  try {
    // A file where the export directory should be: mkdir must reject.
    const blockingFilePath = join(exportRoot, "occupied")
    await writeFile(blockingFilePath, "not a directory")
    await assert.rejects(
      writeSessionExportDocument(blockingFilePath, "标题", "# 内容"),
      (error: unknown) => error instanceof Error,
    )
  } finally {
    await rm(exportRoot, { recursive: true, force: true })
  }
})

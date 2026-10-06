/**
 * Tests for the /insight-export TUI command (T5.2): the picker dialog, the
 * full export flow against a fake database and a fake TUI context, the
 * silent-cancel and error-toast paths, and write-failure tolerance.
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  pickSessionForExport,
  runExportCommand,
  type ExportCommandDependencies,
} from "../src/tui/export-command.ts"
import type { SessionSummary } from "../src/db/types.ts"
import {
  buildFakeSessionSummary,
  createFakeInsightDatabase,
  type FakeInsightDatabaseScenario,
} from "./helpers/fake-insight-db.ts"

interface CapturedToast {
  message: string
  variant: string
}

/** A TUI context stub that records toasts and can serve dialog picks. */
function buildCapturingTuiContext(options: {
  pickedSessionId?: string | undefined
  throwFromDialog?: boolean
}) {
  const capturedToasts: CapturedToast[] = []
  const context = {
    ui: {
      dialog: {
        select: async () => {
          if (options.throwFromDialog === true) throw new Error("dialog blew up")
          return options.pickedSessionId
        },
      },
      toast: {
        show: (toastOptions: { message: string; variant: string }) => {
          capturedToasts.push({ message: toastOptions.message, variant: toastOptions.variant })
        },
      },
    },
  }
  return { context, capturedToasts }
}

function buildExportScenario(sessionCount = 2): FakeInsightDatabaseScenario {
  const sessions: SessionSummary[] = Array.from({ length: sessionCount }, (_unused, sessionIndex) =>
    buildFakeSessionSummary({
      id: `ses_pick_${sessionIndex}`,
      title: sessionIndex === 0 ? "看板数据核对" : "",
    }),
  )
  return {
    sessions,
    messagesBySessionId: {
      ses_pick_0: [
        { type: "user", data: { text: "帮我修复登录 bug" } },
        { type: "assistant", data: { agent: "fixer", content: [{ type: "text", text: "已修复。" }] } },
      ],
      ses_pick_1: [{ type: "user", data: { text: "第二条会话" } }],
    },
    systemPromptBySessionId: { ses_pick_0: { "core/environment": "环境提示词" } },
  }
}

test("pickSessionForExport lists numbered recent sessions and returns the pick", async () => {
  const scenario = buildExportScenario(3)
  const fakeDatabase = createFakeInsightDatabase(scenario)
  let capturedDialogOptions: Array<{ title: string; value: string; description?: string }> = []
  const context = {
    ui: {
      dialog: {
        select: async (selectOptions: {
          options: Array<{ title: string; value: string; description?: string }>
        }) => {
          capturedDialogOptions = selectOptions.options
          return "ses_pick_1"
        },
      },
    },
  }

  const pickedSession = await pickSessionForExport(context, fakeDatabase)
  assert.equal(pickedSession?.id, "ses_pick_1")
  assert.equal(capturedDialogOptions.length, 3)
  assert.equal(capturedDialogOptions[0].title, "1. 看板数据核对")
  assert.equal(capturedDialogOptions[1].title, "2. （无标题会话）")
  assert.ok(capturedDialogOptions[0].description?.includes("glm-5.3"))
})

test("pickSessionForExport stays silent on cancel, missing dialogs and empty lists", async () => {
  const fakeDatabase = createFakeInsightDatabase(buildExportScenario(1))

  const cancelledContext = buildCapturingTuiContext({ pickedSessionId: undefined })
  assert.equal(await pickSessionForExport(cancelledContext.context, fakeDatabase), null)

  const contextWithoutDialog = { ui: {} }
  assert.equal(await pickSessionForExport(contextWithoutDialog, fakeDatabase), null)

  const throwingContext = buildCapturingTuiContext({ throwFromDialog: true })
  assert.equal(await pickSessionForExport(throwingContext.context, fakeDatabase), null)

  const emptyDatabase = createFakeInsightDatabase({
    sessions: [],
    messagesBySessionId: {},
    systemPromptBySessionId: {},
  })
  const pickingContext = buildCapturingTuiContext({ pickedSessionId: "ses_any" })
  assert.equal(await pickSessionForExport(pickingContext.context, emptyDatabase), null)
})

test("runExportCommand with a picker writes the document and toasts the path", async () => {
  const exportRoot = await mkdtemp(join(tmpdir(), "insight-export-command-"))
  try {
    const fakeDatabase = createFakeInsightDatabase(buildExportScenario(1))
    const { context, capturedToasts } = buildCapturingTuiContext({ pickedSessionId: "ses_pick_0" })
    const dependencies: ExportCommandDependencies = {
      databaseConnection: fakeDatabase,
      exportDirectory: exportRoot,
    }

    const exportedPath = await runExportCommand(context, undefined, dependencies)
    assert.ok(exportedPath !== null)
    assert.ok(exportedPath.endsWith("-看板数据核对.md"))

    const exportedContent = await readFile(exportedPath, "utf8")
    assert.ok(exportedContent.includes("# 看板数据核对"))
    assert.ok(exportedContent.includes("## 🧑 用户"))
    assert.ok(exportedContent.includes("## 🤖 助手"))
    assert.ok(exportedContent.includes("## 📋 系统提示词"))

    assert.equal(capturedToasts.length, 1)
    assert.equal(capturedToasts[0].variant, "success")
    assert.ok(capturedToasts[0].message.includes(exportedPath!))
  } finally {
    await rm(exportRoot, { recursive: true, force: true })
  }
})

test("runExportCommand with an explicit session id skips the picker", async () => {
  const exportRoot = await mkdtemp(join(tmpdir(), "insight-export-explicit-"))
  try {
    const fakeDatabase = createFakeInsightDatabase(buildExportScenario(2))
    let dialogCallCount = 0
    const context = {
      ui: {
        dialog: { select: async () => { dialogCallCount += 1; return "ses_pick_0" } },
        toast: { show: () => {} },
      },
    }
    const exportedPath = await runExportCommand(context, "ses_pick_0", {
      databaseConnection: fakeDatabase,
      exportDirectory: exportRoot,
    })
    assert.ok(exportedPath !== null)
    assert.equal(dialogCallCount, 0, "explicit ids must not open the picker")
  } finally {
    await rm(exportRoot, { recursive: true, force: true })
  }
})

test("runExportCommand toasts clear errors and returns null on every failure path", async () => {
  const exportRoot = await mkdtemp(join(tmpdir(), "insight-export-failures-"))
  try {
    const fakeDatabase = createFakeInsightDatabase(buildExportScenario(2))

    // db unavailable
    const unavailableContext = buildCapturingTuiContext({})
    assert.equal(await runExportCommand(unavailableContext.context, undefined, {
      databaseConnection: null,
    }), null)
    assert.match(unavailableContext.capturedToasts[0].message, /数据库不可用/)

    // unknown explicit session id
    const unknownIdContext = buildCapturingTuiContext({})
    assert.equal(
      await runExportCommand(unknownIdContext.context, "ses_absent_everywhere", {
        databaseConnection: fakeDatabase,
        exportDirectory: exportRoot,
      }),
      null,
    )
    assert.match(unknownIdContext.capturedToasts[0].message, /未找到会话/)
    assert.match(unknownIdContext.capturedToasts[0].message, /ses_absent_everywhere/)

    // session exists in the list but has no messages in the current tables
    const noMessagesScenario: FakeInsightDatabaseScenario = {
      sessions: [buildFakeSessionSummary({ id: "ses_silent" })],
      messagesBySessionId: {},
      systemPromptBySessionId: {},
    }
    const noMessagesContext = buildCapturingTuiContext({})
    assert.equal(
      await runExportCommand(noMessagesContext.context, "ses_silent", {
        databaseConnection: createFakeInsightDatabase(noMessagesScenario),
        exportDirectory: exportRoot,
      }),
      null,
    )
    assert.match(noMessagesContext.capturedToasts[0].message, /没有消息记录/)

    // silent cancel from the picker: no error toast at all
    const cancelledContext = buildCapturingTuiContext({ pickedSessionId: undefined })
    assert.equal(
      await runExportCommand(cancelledContext.context, undefined, {
        databaseConnection: fakeDatabase,
        exportDirectory: exportRoot,
      }),
      null,
    )
    assert.equal(cancelledContext.capturedToasts.length, 0)
  } finally {
    await rm(exportRoot, { recursive: true, force: true })
  }
})

test("runExportCommand survives a broken export directory with an error toast", async () => {
  const exportRoot = await mkdtemp(join(tmpdir(), "insight-export-broken-dir-"))
  try {
    const fakeDatabase = createFakeInsightDatabase(buildExportScenario(1))
    const blockingFilePath = join(exportRoot, "occupied")
    await writeFile(blockingFilePath, "not a directory")

    const { context, capturedToasts } = buildCapturingTuiContext({ pickedSessionId: "ses_pick_0" })
    const exportedPath = await runExportCommand(context, undefined, {
      databaseConnection: fakeDatabase,
      exportDirectory: blockingFilePath,
    })
    assert.equal(exportedPath, null, "disk/permission failures must not throw out of the command")
    assert.equal(capturedToasts.length, 1)
    assert.equal(capturedToasts[0].variant, "error")
    assert.match(capturedToasts[0].message, /导出失败/)
  } finally {
    await rm(exportRoot, { recursive: true, force: true })
  }
})

test("runExportCommand treats non-string explicit ids as no id and opens the picker (P2-8)", async () => {
  const exportRoot = await mkdtemp(join(tmpdir(), "insight-export-non-string-id-"))
  try {
    const fakeDatabase = createFakeInsightDatabase(buildExportScenario(1))
    let dialogCallCount = 0
    const context = {
      ui: {
        dialog: {
          select: async () => {
            dialogCallCount += 1
            return "ses_pick_0"
          },
        },
        toast: { show: () => {} },
      },
    }

    // The host may pass anything as the command argument; only real
    // non-empty strings count as explicit session ids.
    const nonStringIdArguments: unknown[] = [123, null, true, { id: "ses_pick_0" }, "   "]
    for (const nonStringIdArgument of nonStringIdArguments) {
      const exportedPath = await runExportCommand(
        context,
        nonStringIdArgument as string,
        {
          databaseConnection: fakeDatabase,
          exportDirectory: exportRoot,
        },
      )
      assert.ok(
        exportedPath !== null,
        `argument ${JSON.stringify(nonStringIdArgument)} must fall back to the picker`,
      )
    }
    assert.equal(dialogCallCount, nonStringIdArguments.length)
  } finally {
    await rm(exportRoot, { recursive: true, force: true })
  }
})

test("runExportCommand degrades silently when the context has no ui API at all", async () => {
  const exportRoot = await mkdtemp(join(tmpdir(), "insight-export-no-ui-"))
  try {
    const fakeDatabase = createFakeInsightDatabase(buildExportScenario(1))
    // No dialog → picker returns null; no toast API → nothing to show.
    const exportedPath = await runExportCommand({}, undefined, {
      databaseConnection: fakeDatabase,
      exportDirectory: exportRoot,
    })
    assert.equal(exportedPath, null)
  } finally {
    await rm(exportRoot, { recursive: true, force: true })
  }
})

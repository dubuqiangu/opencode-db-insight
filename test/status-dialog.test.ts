/**
 * Tests for the /insight-status dialog lifecycle (v0.16.0): the one-scan
 * snapshot on open, ui.dialog.show + presentation options, the ESC/r modal
 * keymap layer (enabled only while the dialog lives), connection cleanup,
 * and every degradation path (missing ui.dialog, missing keymap, throwing
 * provider). The fake context mirrors the host shapes documented in
 * node_modules/@opencode/plugin/dist/tui/context.d.ts.
 */

import { test } from "node:test"
import assert from "node:assert/strict"

import type { SqliteReadConnection } from "../src/db/types.ts"
import { createStatusDialog, registerStatusDialogKeymap } from "../src/tui/status-dialog.ts"
import type { StatusDialogSnapshot } from "../src/tui/status-dialog.ts"
import {
  createFakeInsightDatabase,
  type FakeInsightDatabaseScenario,
  type FakeMessageFixture,
} from "./helpers/fake-insight-db.ts"

// ---------------------------------------------------------------------------
// Fake host context.

interface CapturedDialogShow {
  render: () => unknown
  onClose?: () => void
}

interface CapturedToast {
  message: string
  variant: string
}

/** What one fake dialog-capable TUI context captured. */
interface FakeDialogContextHarness {
  context: Record<string, unknown>
  capturedDialogShows: CapturedDialogShow[]
  capturedDialogSetOptions: unknown[]
  dialogClearCallCount: { value: number }
  capturedToasts: CapturedToast[]
  recordedLayerSpecs: unknown[]
}

function buildFakeDialogContext(options: {
  includeDialog?: boolean
  includeToast?: boolean
}): FakeDialogContextHarness {
  const capturedDialogShows: CapturedDialogShow[] = []
  const capturedDialogSetOptions: unknown[] = []
  const dialogClearCallCount = { value: 0 }
  const capturedToasts: CapturedToast[] = []
  const recordedLayerSpecs: unknown[] = []

  const context: Record<string, unknown> = {
    keymap: {
      layer: (buildLayer: () => unknown) => {
        recordedLayerSpecs.push(buildLayer())
        return () => {}
      },
    },
  }
  if (options.includeDialog !== false) {
    context.ui = {
      dialog: {
        show: (render: () => unknown, onClose?: () => void) => {
          capturedDialogShows.push({ render, onClose })
        },
        set: (dialogOptions: unknown) => {
          capturedDialogSetOptions.push(dialogOptions)
        },
        clear: () => {
          dialogClearCallCount.value += 1
        },
      },
    }
  }
  if (options.includeToast !== false) {
    context.ui = {
      ...((context.ui as Record<string, unknown>) ?? {}),
      toast: {
        show: (toastOptions: { message: string; variant: string }) => {
          capturedToasts.push({ message: toastOptions.message, variant: toastOptions.variant })
        },
      },
    }
  }
  return {
    context,
    capturedDialogShows,
    capturedDialogSetOptions,
    dialogClearCallCount,
    capturedToasts,
    recordedLayerSpecs,
  }
}

/** Fake renderer: records every snapshot the host render function reads. */
function buildRecordingRenderer() {
  const renderedSnapshots: StatusDialogSnapshot[] = []
  const renderSnapshot = (readSnapshot: () => StatusDialogSnapshot): unknown => {
    renderedSnapshots.push(readSnapshot())
    return "rendered"
  }
  return { renderedSnapshots, renderSnapshot }
}

// ---------------------------------------------------------------------------
// Fixtures.

/** Live "now" (fix-24 rule: no hardcoded absolute dates in clock-dependent tests). */
const currentNowMs = Date.now()

function buildAssistantMessageFixture(
  modelId: string,
  tokenCounts: { input: number; output: number; cacheRead: number },
  timeCreated: number,
): FakeMessageFixture {
  return {
    type: "assistant",
    timeCreated,
    data: {
      agent: "fixer",
      model: { id: modelId, providerID: "futureppo" },
      tokens: {
        input: tokenCounts.input,
        output: tokenCounts.output,
        reasoning: 0,
        cache: { read: tokenCounts.cacheRead, write: 0 },
      },
      content: [],
    },
  }
}

function buildDialogScenario(): FakeInsightDatabaseScenario {
  return {
    sessions: [],
    messagesBySessionId: {
      ses_today: [
        buildAssistantMessageFixture("glm-5.3", { input: 700, output: 200, cacheRead: 100 }, currentNowMs),
        buildAssistantMessageFixture("glm-5.3", { input: 100, output: 100, cacheRead: 0 }, currentNowMs),
        buildAssistantMessageFixture("claude-opus-5", { input: 100, output: 100, cacheRead: 0 }, currentNowMs),
      ],
    },
    systemPromptBySessionId: {},
  }
}

/** Wrap the fake connection so tests can observe close() calls. */
function buildConnectionClosingSpy(connection: SqliteReadConnection) {
  const closeCallCount = { value: 0 }
  const spiedConnection: SqliteReadConnection = {
    prepare: (sql: string) => connection.prepare(sql),
    close: () => {
      closeCallCount.value += 1
    },
  }
  return { spiedConnection, closeCallCount }
}

// ---------------------------------------------------------------------------
// open / show / presentation.

test("open scans once, shows the dialog and asks for large centered presentation", () => {
  const fakeContext = buildFakeDialogContext({})
  const fakeDatabase = createFakeInsightDatabase(buildDialogScenario())
  const providerCallCount = { value: 0 }
  const { renderedSnapshots, renderSnapshot } = buildRecordingRenderer()

  const statusDialog = createStatusDialog(fakeContext.context, renderSnapshot, {
    databaseProvider: () => {
      providerCallCount.value += 1
      return fakeDatabase
    },
    nowMs: () => currentNowMs,
  })

  assert.equal(statusDialog.isOpen(), false, "dormant before open")
  statusDialog.open()
  assert.equal(providerCallCount.value, 1, "one bounded scan per open")
  assert.equal(statusDialog.isOpen(), true)
  assert.equal(fakeContext.capturedDialogShows.length, 1, "ui.dialog.show called once")
  assert.deepEqual(fakeContext.capturedDialogSetOptions, [
    { size: "large", centered: true },
  ])

  // The host render function reads the ready snapshot reactively.
  const hostRender = fakeContext.capturedDialogShows[0].render
  hostRender()
  assert.equal(renderedSnapshots.length, 1)
  const snapshotLines = renderedSnapshots[0].lines.map((line) => line.text)
  assert.ok(snapshotLines.some((lineText) => lineText.includes("1,400")))
  assert.ok(snapshotLines.some((lineText) => lineText.includes("glm-5.3")))
  assert.ok(snapshotLines.some((lineText) => lineText.includes("10.0%")), "hit rate 100/1000")
})

test("open closes the database connection after the scan", () => {
  const fakeContext = buildFakeDialogContext({})
  const fakeDatabase = createFakeInsightDatabase(buildDialogScenario())
  const { spiedConnection, closeCallCount } = buildConnectionClosingSpy(fakeDatabase)

  const statusDialog = createStatusDialog(fakeContext.context, buildRecordingRenderer().renderSnapshot, {
    databaseProvider: () => spiedConnection,
    nowMs: () => currentNowMs,
  })
  statusDialog.open()
  assert.equal(closeCallCount.value, 1)
  statusDialog.refreshData()
  assert.equal(closeCallCount.value, 2)
})

test("a missing ui.dialog degrades to an error toast instead of throwing", () => {
  const dialoglessContext = buildFakeDialogContext({ includeDialog: false })
  const providerCallCount = { value: 0 }
  const statusDialog = createStatusDialog(dialoglessContext.context, buildRecordingRenderer().renderSnapshot, {
    databaseProvider: () => {
      providerCallCount.value += 1
      return null
    },
    nowMs: () => currentNowMs,
  })
  statusDialog.open()
  assert.equal(statusDialog.isOpen(), false)
  assert.equal(dialoglessContext.capturedDialogShows.length, 0)
  assert.equal(dialoglessContext.capturedToasts.length, 1)
  assert.match(dialoglessContext.capturedToasts[0].message, /不支持弹窗/)
})

test("a throwing provider degrades the dialog to the unavailable copy", () => {
  const fakeContext = buildFakeDialogContext({})
  const { renderedSnapshots, renderSnapshot } = buildRecordingRenderer()
  const statusDialog = createStatusDialog(fakeContext.context, renderSnapshot, {
    databaseProvider: () => {
      throw new Error("provider blew up")
    },
    nowMs: () => currentNowMs,
  })

  statusDialog.open() // must not throw
  assert.equal(statusDialog.isOpen(), true, "the dialog still opens with the degraded copy")
  fakeContext.capturedDialogShows[0].render()
  const snapshotLines = renderedSnapshots[0].lines.map((line) => line.text)
  assert.ok(snapshotLines.some((lineText) => lineText.includes("不可用")))
})

test("a missing database degrades the dialog to the unavailable copy", () => {
  const fakeContext = buildFakeDialogContext({})
  const { renderedSnapshots, renderSnapshot } = buildRecordingRenderer()
  const statusDialog = createStatusDialog(fakeContext.context, renderSnapshot, {
    databaseProvider: () => null,
    nowMs: () => currentNowMs,
  })
  statusDialog.open()
  fakeContext.capturedDialogShows[0].render()
  const snapshotLines = renderedSnapshots[0].lines.map((line) => line.text)
  assert.ok(snapshotLines.some((lineText) => lineText.includes("不可用")))
  assert.ok(!snapshotLines.some((lineText) => lineText.includes("模型 TOP5")))
})

// ---------------------------------------------------------------------------
// Close paths: ESC command, host onClose, dispose.

test("the modal keymap layer is dormant until open and wires escape to close", () => {
  const fakeContext = buildFakeDialogContext({})
  const statusDialog = createStatusDialog(fakeContext.context, buildRecordingRenderer().renderSnapshot, {
    databaseProvider: () => null,
    nowMs: () => currentNowMs,
  })
  const keymapDispose = registerStatusDialogKeymap(fakeContext.context, {
    isActive: statusDialog.isOpen,
    close: statusDialog.close,
    refresh: statusDialog.refreshData,
  })
  assert.ok(keymapDispose !== undefined)

  const layerSpec = fakeContext.recordedLayerSpecs[0] as {
    mode: string
    enabled: () => boolean
    commands: Array<{ bind: string; title?: string; run: () => void }>
  }
  assert.equal(layerSpec.mode, "modal")
  assert.equal(layerSpec.enabled(), false, "dormant while the dialog is closed")

  const escapeCommand = layerSpec.commands.find((command) => command.bind === "escape")
  assert.ok(escapeCommand !== undefined, "escape must be bound")

  statusDialog.open()
  assert.equal(layerSpec.enabled(), true, "active while the dialog is open")

  escapeCommand.run()
  assert.equal(statusDialog.isOpen(), false)
  assert.equal(fakeContext.dialogClearCallCount.value, 1, "escape calls ui.dialog.clear")

  keymapDispose?.()
})

test("the r command refreshes the snapshot behind the open dialog", () => {
  const fakeContext = buildFakeDialogContext({})
  const providerCallCount = { value: 0 }
  const statusDialog = createStatusDialog(fakeContext.context, buildRecordingRenderer().renderSnapshot, {
    databaseProvider: () => {
      providerCallCount.value += 1
      return null
    },
    nowMs: () => currentNowMs,
  })
  registerStatusDialogKeymap(fakeContext.context, {
    isActive: statusDialog.isOpen,
    close: statusDialog.close,
    refresh: statusDialog.refreshData,
  })

  statusDialog.open()
  assert.equal(providerCallCount.value, 1)
  const refreshCommand = (
    fakeContext.recordedLayerSpecs[0] as {
      commands: Array<{ bind: string; run: () => void }>
    }
  ).commands.find((command) => command.bind === "r")
  assert.ok(refreshCommand !== undefined, "r must be bound")
  refreshCommand.run()
  assert.equal(providerCallCount.value, 2, "r recomputes the snapshot")
  assert.equal(statusDialog.isOpen(), true, "refreshing keeps the dialog open")
})

test("the host onClose callback flips the open flag", () => {
  const fakeContext = buildFakeDialogContext({})
  const statusDialog = createStatusDialog(fakeContext.context, buildRecordingRenderer().renderSnapshot, {
    databaseProvider: () => null,
    nowMs: () => currentNowMs,
  })
  registerStatusDialogKeymap(fakeContext.context, {
    isActive: statusDialog.isOpen,
    close: statusDialog.close,
    refresh: statusDialog.refreshData,
  })
  statusDialog.open()
  const { onClose } = fakeContext.capturedDialogShows[0]
  assert.ok(typeof onClose === "function", "dialog.show receives an onClose hook")
  onClose!()
  assert.equal(statusDialog.isOpen(), false)
  // The keymap layer must have gone dormant with it.
  const layerSpec = fakeContext.recordedLayerSpecs[0] as { enabled: () => boolean }
  assert.equal(layerSpec.enabled(), false)
})

test("dispose closes the dialog and clears the host surface", () => {
  const fakeContext = buildFakeDialogContext({})
  const statusDialog = createStatusDialog(fakeContext.context, buildRecordingRenderer().renderSnapshot, {
    databaseProvider: () => null,
    nowMs: () => currentNowMs,
  })
  statusDialog.open()
  statusDialog.dispose()
  assert.equal(statusDialog.isOpen(), false)
  assert.equal(fakeContext.dialogClearCallCount.value, 1)
  // dispose is idempotent — the plugin teardown may run twice on hot reloads.
  // The second run must not clear again: our dialog is already gone and the
  // host contract says ui.dialog.clear() closes *the currently active*
  // dialog, which by then may belong to another plugin.
  statusDialog.dispose()
  assert.equal(fakeContext.dialogClearCallCount.value, 1)
})

test("close and dispose never clear the host dialog while ours is closed", () => {
  const fakeContext = buildFakeDialogContext({})
  const statusDialog = createStatusDialog(fakeContext.context, buildRecordingRenderer().renderSnapshot, {
    databaseProvider: () => null,
    nowMs: () => currentNowMs,
  })

  // Teardown without our dialog ever opening: another plugin's dialog (say
  // the /insight-export select) may be on screen — clear() must not kill it.
  statusDialog.dispose()
  assert.equal(fakeContext.dialogClearCallCount.value, 0)
  statusDialog.close()
  assert.equal(fakeContext.dialogClearCallCount.value, 0)

  // With our dialog alive, close clears exactly once...
  statusDialog.open()
  statusDialog.close()
  assert.equal(fakeContext.dialogClearCallCount.value, 1)
  // ...and a repeated close does not re-clear.
  statusDialog.close()
  assert.equal(fakeContext.dialogClearCallCount.value, 1)

  // Host-initiated close (onClose): our dialog is gone without clear(), so a
  // later dispose during plugin teardown must leave whatever dialog the host
  // is showing now alone.
  statusDialog.open()
  const hostInitiatedClose = fakeContext.capturedDialogShows.at(-1)?.onClose
  assert.ok(typeof hostInitiatedClose === "function")
  hostInitiatedClose!()
  statusDialog.dispose()
  assert.equal(fakeContext.dialogClearCallCount.value, 1)
})

test("open scans nothing when the host has no ui.dialog.show", () => {
  const dialoglessContext = buildFakeDialogContext({ includeDialog: false })
  const providerCallCount = { value: 0 }
  const statusDialog = createStatusDialog(dialoglessContext.context, buildRecordingRenderer().renderSnapshot, {
    databaseProvider: () => {
      providerCallCount.value += 1
      return null
    },
    nowMs: () => currentNowMs,
  })
  statusDialog.open()
  // The host capability check must come first: a host without ui.dialog
  // must not pay for a full-database scan it can never show.
  assert.equal(providerCallCount.value, 0, "no scan before the host capability check")
  assert.equal(statusDialog.isOpen(), false)
  assert.equal(dialoglessContext.capturedToasts.length, 1)
  assert.match(dialoglessContext.capturedToasts[0].message, /不支持弹窗/)
})

test("a throwing host show resets the open flag and reports an error toast", () => {
  const fakeContext = buildFakeDialogContext({})
  const providerCallCount = { value: 0 }
  ;((fakeContext.context.ui as Record<string, unknown>).dialog as Record<string, unknown>) = {
    show: () => {
      throw new Error("host show blew up")
    },
    set: () => {},
    clear: () => {
      fakeContext.dialogClearCallCount.value += 1
    },
  }
  const statusDialog = createStatusDialog(fakeContext.context, buildRecordingRenderer().renderSnapshot, {
    databaseProvider: () => {
      providerCallCount.value += 1
      return null
    },
    nowMs: () => currentNowMs,
  })

  statusDialog.open() // must not throw
  // A show that throws must leave the open flag down: a stuck-true flag
  // would keep the modal keymap layer active with no dialog on screen —
  // r hijacking keys and re-scanning the whole database per keypress.
  assert.equal(statusDialog.isOpen(), false, "the open flag must not stay stuck after a failed show")
  assert.equal(fakeContext.capturedToasts.length, 1)
  assert.match(fakeContext.capturedToasts[0].message, /打开失败/)
  assert.equal(fakeContext.capturedToasts[0].variant, "error")
  // The flag being down keeps the dormant layer out of r's reach.
  assert.equal(providerCallCount.value, 1, "open scanned exactly once, the throw did not retry")
})

test("a void-returning keymap.layer (the real host contract) still tears the dialog down cleanly", () => {
  const fakeContext = buildFakeDialogContext({})
  // The real host keymap.layer returns void, not a dispose function
  // (node_modules/@opencode/plugin/dist/tui/context.d.ts) — mirror that here
  // so the production teardown path (statusKeymapDispose?.() on undefined)
  // gets coverage instead of only the bonus-function fake.
  ;(fakeContext.context.keymap as Record<string, unknown>).layer = (buildLayer: () => unknown) => {
    fakeContext.recordedLayerSpecs.push(buildLayer())
  }

  const statusDialog = createStatusDialog(fakeContext.context, buildRecordingRenderer().renderSnapshot, {
    databaseProvider: () => null,
    nowMs: () => currentNowMs,
  })
  const keymapDispose = registerStatusDialogKeymap(fakeContext.context, {
    isActive: statusDialog.isOpen,
    close: statusDialog.close,
    refresh: statusDialog.refreshData,
  })
  assert.equal(keymapDispose, undefined, "layer() returning void yields no dispose function")

  // The production teardown call on the undefined dispose must be a no-op
  // (not a crash), and the dialog lifecycle still works without it.
  keymapDispose?.()

  statusDialog.open()
  assert.equal(statusDialog.isOpen(), true)
  statusDialog.dispose()
  assert.equal(statusDialog.isOpen(), false)
  assert.equal(fakeContext.dialogClearCallCount.value, 1)
})

test("registerStatusDialogKeymap degrades silently without a keymap", () => {
  const keymaplessDispose = registerStatusDialogKeymap({}, {
    isActive: () => true,
    close: () => {},
    refresh: () => {},
  })
  assert.equal(keymaplessDispose, undefined)
})

test("the modal layer commands pass the host keymap shape validation", () => {
  // Mirror of the host rules (opencode keymap validation): inline commands
  // (no palette/slash) need no id, and any bound key must be non-empty.
  const fakeContext = buildFakeDialogContext({})
  registerStatusDialogKeymap(fakeContext.context, {
    isActive: () => false,
    close: () => {},
    refresh: () => {},
  })
  const layerSpec = fakeContext.recordedLayerSpecs[0] as {
    commands: Array<{ id?: unknown; bind?: unknown }>
  }
  assert.equal(layerSpec.commands.length, 2)
  for (const layerCommand of layerSpec.commands) {
    assert.equal(layerCommand.id, undefined, "inline commands carry no id")
    assert.ok(typeof layerCommand.bind === "string" && layerCommand.bind !== "")
  }
})

/**
 * Smoke tests for the TUI command and slot registration (M6): a fake
 * context captures the keymap layer and the session.panel claim, then the
 * wired commands/renders are driven to verify toast wiring, runner routing,
 * silent degradation on missing host APIs, and dispose behavior.
 */

import { test } from "node:test"
import assert from "node:assert/strict"

import {
  INSIGHT_STATUS_PANEL_NAME,
  registerInsightTuiCommands,
  registerStatusPanelSlot,
  shouldRenderStatusPanel,
} from "../src/tui/command-registry.ts"

interface CapturedToast {
  message: string
  variant: string
}

/** What one fake TUI context captured, for assertions inside tests. */
interface FakeTuiContextHarness {
  context: Record<string, unknown>
  capturedToasts: CapturedToast[]
  recordedPanelOpens: string[]
  recordedLayerSpecs: unknown[]
  recordedSlotClaims: unknown[]
  layerDisposeCallCount: { value: number }
  slotDisposeCallCount: { value: number }
}

/** A fake TUI context with recordable toasts, panel opens and slot claims. */
function buildFakeTuiContext(options: {
  panelOpenResult?: boolean
  includeKeymap?: boolean
  includeSlot?: boolean
}): FakeTuiContextHarness {
  const capturedToasts: CapturedToast[] = []
  const recordedPanelOpens: string[] = []
  const recordedLayerSpecs: unknown[] = []
  const recordedSlotClaims: unknown[] = []
  const layerDisposeCallCount = { value: 0 }
  const slotDisposeCallCount = { value: 0 }

  const context: Record<string, unknown> = {
    keymap:
      options.includeKeymap === false
        ? undefined
        : {
            layer: (buildLayer: () => unknown) => {
              recordedLayerSpecs.push(buildLayer())
              return () => {
                layerDisposeCallCount.value += 1
              }
            },
          },
    ui: {
      toast: {
        show: (toastOptions: { message: string; variant: string }) => {
          capturedToasts.push({ message: toastOptions.message, variant: toastOptions.variant })
        },
      },
      panel: {
        open: (panelName: string) => {
          recordedPanelOpens.push(panelName)
          return options.panelOpenResult !== false
        },
      },
      slot:
        options.includeSlot === false
          ? undefined
          : (claim: unknown) => {
              recordedSlotClaims.push(claim)
              return () => {
                slotDisposeCallCount.value += 1
              }
            },
    },
  }

  return {
    context,
    capturedToasts,
    recordedPanelOpens,
    recordedLayerSpecs,
    recordedSlotClaims,
    layerDisposeCallCount,
    slotDisposeCallCount,
  }
}

test("registerInsightTuiCommands wires four slash commands into the keymap", () => {
  const fakeContext = buildFakeTuiContext({})
  const openDashboardCalls: unknown[][] = []
  const exportCalls: unknown[][] = []
  const refreshCalls: unknown[][] = []

  const commandsDispose = registerInsightTuiCommands(fakeContext.context, {
    runOpenDashboard: async (...openDashboardArguments) => {
      openDashboardCalls.push(openDashboardArguments)
      return true
    },
    runExport: async (...exportArguments) => {
      exportCalls.push(exportArguments)
      return null
    },
    runRefresh: async (...refreshArguments) => {
      refreshCalls.push(refreshArguments)
      return true
    },
  })
  assert.ok(commandsDispose !== undefined)

  const layerSpec = fakeContext.recordedLayerSpecs[0] as {
    mode: string
    commands: Array<{
      id: string
      slash: { name: string; arguments?: boolean }
      run: (commandInput?: string) => unknown
    }>
  }
  assert.equal(layerSpec.mode, "global")
  assert.equal(layerSpec.commands.length, 4)
  assert.deepEqual(
    layerSpec.commands.map((command) => command.slash.name),
    ["insight", "insight-status", "insight-export", "insight-refresh"],
  )
  assert.equal(layerSpec.commands[2].slash.arguments, true, "export receives its argument text")
  assert.equal(
    layerSpec.commands[3].slash.arguments,
    undefined,
    "refresh is a whole-cache clear, it takes no arguments",
  )

  // Run the commands; runners receive the context and (for export) the input.
  layerSpec.commands[0].run()
  layerSpec.commands[2].run("ses_explicit")
  layerSpec.commands[3].run()
  assert.equal(openDashboardCalls.length, 1)
  assert.equal(exportCalls.length, 1)
  assert.equal(exportCalls[0][1], "ses_explicit")
  assert.equal(refreshCalls.length, 1, "the refresh runner receives exactly one call")
  assert.equal(refreshCalls[0].length, 1, "the refresh runner receives only the context")

  commandsDispose?.()
  assert.equal(fakeContext.layerDisposeCallCount.value, 1)
})

test("insight-status opens the panel and toasts when the host refuses it", () => {
  const refusingContext = buildFakeTuiContext({ panelOpenResult: false })
  const commandsDispose = registerInsightTuiCommands(refusingContext.context, {
    runOpenDashboard: async () => true,
    runExport: async () => null,
  })
  const layerSpec = refusingContext.recordedLayerSpecs[0] as {
    commands: Array<{ run: () => void }>
  }
  layerSpec.commands[1].run()
  assert.deepEqual(refusingContext.recordedPanelOpens, [INSIGHT_STATUS_PANEL_NAME])
  assert.equal(refusingContext.capturedToasts.length, 1)
  assert.match(refusingContext.capturedToasts[0].message, /不支持面板/)
  commandsDispose?.()
})

test("insight-status notifies onStatusPanelOpened only when the panel actually opened (P2-13)", () => {
  // Successful open → the panel controller's lazy loop is armed.
  const openedContext = buildFakeTuiContext({ panelOpenResult: true })
  let openedCallbackRuns = 0
  const openedDispose = registerInsightTuiCommands(openedContext.context, {
    runOpenDashboard: async () => true,
    runExport: async () => null,
    onStatusPanelOpened: () => {
      openedCallbackRuns += 1
    },
  })
  ;(openedContext.recordedLayerSpecs[0] as { commands: Array<{ run: () => void }> }).commands[1].run()
  assert.equal(openedCallbackRuns, 1)
  openedDispose?.()

  // Refused open → no callback (and no stray refresh loop).
  const refusedContext = buildFakeTuiContext({ panelOpenResult: false })
  let refusedCallbackRuns = 0
  const refusedDispose = registerInsightTuiCommands(refusedContext.context, {
    runOpenDashboard: async () => true,
    runExport: async () => null,
    onStatusPanelOpened: () => {
      refusedCallbackRuns += 1
    },
  })
  ;(refusedContext.recordedLayerSpecs[0] as { commands: Array<{ run: () => void }> }).commands[1].run()
  assert.equal(refusedCallbackRuns, 0)
  refusedDispose?.()
})

test("registerInsightTuiCommands degrades silently without a keymap", () => {
  const keymaplessContext = buildFakeTuiContext({ includeKeymap: false })
  const commandsDispose = registerInsightTuiCommands(keymaplessContext.context)
  assert.equal(commandsDispose, undefined)
  assert.equal(keymaplessContext.recordedLayerSpecs.length, 0)
  assert.equal(keymaplessContext.capturedToasts.length, 0)
})

test("registerStatusPanelSlot claims session.panel and forwards the render", () => {
  const fakeContext = buildFakeTuiContext({})
  const renderedInputs: unknown[] = []
  const slotDispose = registerStatusPanelSlot(fakeContext.context, (slotInput) => {
    renderedInputs.push(slotInput)
    return `rendered:${JSON.stringify(slotInput)}`
  })
  assert.ok(slotDispose !== undefined)
  assert.equal(fakeContext.recordedSlotClaims.length, 1)

  const slotClaim = fakeContext.recordedSlotClaims[0] as {
    append: string
    render: (slotInput: unknown) => unknown
  }
  assert.equal(slotClaim.append, "session.panel")
  assert.equal(
    slotClaim.render({ name: INSIGHT_STATUS_PANEL_NAME }),
    'rendered:{"name":"insight-status"}',
  )
  assert.equal(renderedInputs.length, 1)

  slotDispose?.()
  assert.equal(fakeContext.slotDisposeCallCount.value, 1)
})

test("registerStatusPanelSlot degrades silently without ui.slot", () => {
  const slotlessContext = buildFakeTuiContext({ includeSlot: false })
  const slotDispose = registerStatusPanelSlot(slotlessContext.context, () => "unused")
  assert.equal(slotDispose, undefined)
  assert.equal(slotlessContext.recordedSlotClaims.length, 0)
})

test("shouldRenderStatusPanel only matches the insight panel name", () => {
  assert.equal(shouldRenderStatusPanel({ name: INSIGHT_STATUS_PANEL_NAME }), true)
  assert.equal(shouldRenderStatusPanel({ name: "usage-meter" }), false)
  assert.equal(shouldRenderStatusPanel({}), false)
  assert.equal(shouldRenderStatusPanel(null), false)
  assert.equal(shouldRenderStatusPanel(undefined), false)
})

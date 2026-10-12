/**
 * Smoke tests for the TUI command registration (M6): a fake context
 * captures the keymap layer, then the wired commands are driven to verify
 * toast wiring, runner routing (including the /insight-status dialog
 * runner), silent degradation on missing host APIs, and dispose behavior.
 */

import { test } from "node:test"
import assert from "node:assert/strict"

import { registerInsightTuiCommands } from "../src/tui/command-registry.ts"

interface CapturedToast {
  message: string
  variant: string
}

/** What one fake TUI context captured, for assertions inside tests. */
interface FakeTuiContextHarness {
  context: Record<string, unknown>
  capturedToasts: CapturedToast[]
  recordedLayerSpecs: unknown[]
  layerDisposeCallCount: { value: number }
}

/** A fake TUI context with recordable toasts. */
function buildFakeTuiContext(options: {
  includeKeymap?: boolean
}): FakeTuiContextHarness {
  const capturedToasts: CapturedToast[] = []
  const recordedLayerSpecs: unknown[] = []
  const layerDisposeCallCount = { value: 0 }

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
    },
  }

  return {
    context,
    capturedToasts,
    recordedLayerSpecs,
    layerDisposeCallCount,
  }
}

test("registerInsightTuiCommands wires four slash commands into the keymap", () => {
  const fakeContext = buildFakeTuiContext({})
  const openDashboardCalls: unknown[][] = []
  const exportCalls: unknown[][] = []
  const refreshCalls: unknown[][] = []
  const statusDialogCalls: unknown[][] = []

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
    runStatusDialog: (...statusDialogArguments) => {
      statusDialogCalls.push(statusDialogArguments)
    },
  })
  assert.ok(commandsDispose !== undefined)

  const layerSpec = fakeContext.recordedLayerSpecs[0] as {
    mode: string
    commands: Array<{
      id: string
      title: string
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
  assert.equal(layerSpec.commands[1].title, "显示 db-insight 用量弹窗")

  // Run the commands; runners receive the context and (for export) the input.
  layerSpec.commands[0].run()
  layerSpec.commands[1].run()
  layerSpec.commands[2].run("ses_explicit")
  layerSpec.commands[3].run()
  assert.equal(openDashboardCalls.length, 1)
  assert.equal(statusDialogCalls.length, 1, "insight-status reaches the dialog runner")
  assert.equal(statusDialogCalls[0].length, 1, "the dialog runner receives the context")
  assert.equal(exportCalls.length, 1)
  assert.equal(exportCalls[0][1], "ses_explicit")
  assert.equal(refreshCalls.length, 1, "the refresh runner receives exactly one call")
  assert.equal(refreshCalls[0].length, 1, "the refresh runner receives only the context")

  commandsDispose?.()
  assert.equal(fakeContext.layerDisposeCallCount.value, 1)
})

test("insight-status without an injected runner toasts instead of silently no-oping", () => {
  const fakeContext = buildFakeTuiContext({})
  const commandsDispose = registerInsightTuiCommands(fakeContext.context, {
    runOpenDashboard: async () => true,
    runExport: async () => null,
  })
  const layerSpec = fakeContext.recordedLayerSpecs[0] as {
    commands: Array<{ run: () => void }>
  }
  layerSpec.commands[1].run()
  assert.equal(fakeContext.capturedToasts.length, 1)
  assert.match(fakeContext.capturedToasts[0].message, /未装配/)
  commandsDispose?.()
})

test("registerInsightTuiCommands degrades silently without a keymap", () => {
  const keymaplessContext = buildFakeTuiContext({ includeKeymap: false })
  const commandsDispose = registerInsightTuiCommands(keymaplessContext.context)
  assert.equal(commandsDispose, undefined)
  assert.equal(keymaplessContext.recordedLayerSpecs.length, 0)
  assert.equal(keymaplessContext.capturedToasts.length, 0)
})

/**
 * A fake keymap.layer that mirrors the real host's groupCommands shape
 * validation (opencode packages/tui/src/context/keymap.tsx): a command with
 * an id whose bind is an empty string must throw, and palette/slash
 * commands must carry a non-empty id. The lenient fake above accepts
 * anything, which is exactly how the bind: "" regression hid for five
 * releases — this harness is the regression lock.
 */
interface HostValidatedLayerCommand {
  id?: unknown
  bind?: unknown
  palette?: unknown
  slash?: unknown
}

interface HostValidatedLayerSpec {
  commands?: unknown
}

function buildHostValidatingKeymapHarness(options: {
  layerCallCount: { value: number }
}): {
  context: Record<string, unknown>
} {
  const validateLayerCommand = (layerCommand: HostValidatedLayerCommand): void => {
    if (layerCommand.palette || layerCommand.slash) {
      if (typeof layerCommand.id !== "string" || layerCommand.id === "") {
        throw new Error("Keymap palette/slash commands must have a non-empty id")
      }
    }
    // Mirror of the host rule that killed every db-insight command since
    // v0.11.0: an id-bearing command with an empty string bind is rejected.
    if (typeof layerCommand.id === "string" && layerCommand.bind === "") {
      throw new Error("Keymap command bindings cannot be empty")
    }
  }

  const context: Record<string, unknown> = {
    keymap: {
      layer: (buildLayer: () => unknown) => {
        options.layerCallCount.value += 1
        const layerSpec = buildLayer() as HostValidatedLayerSpec
        for (const layerCommand of (layerSpec.commands ?? []) as HostValidatedLayerCommand[]) {
          validateLayerCommand(layerCommand)
        }
        return () => {}
      },
    },
  }
  return { context }
}

test("registerInsightTuiCommands passes the host keymap shape validation", () => {
  const layerCallCount = { value: 0 }
  const hostValidatingContext = buildHostValidatingKeymapHarness({ layerCallCount })

  const commandsDispose = registerInsightTuiCommands(hostValidatingContext.context, {
    runOpenDashboard: async () => true,
    runExport: async () => null,
    runRefresh: async () => true,
  })

  // Before the fix, layer() threw on bind: "" and the swallowed error made
  // this registration return undefined — the four commands never appeared.
  assert.ok(typeof commandsDispose === "function", "registration must survive host validation")
  assert.equal(layerCallCount.value, 1, "the host keymap layer must actually be called")
  commandsDispose()
})

test("every registered command binds to undefined or a non-empty key", () => {
  const fakeContext = buildFakeTuiContext({})
  const commandsDispose = registerInsightTuiCommands(fakeContext.context, {
    runOpenDashboard: async () => true,
    runExport: async () => null,
    runRefresh: async () => true,
    runStatusDialog: () => {},
  })
  assert.ok(commandsDispose !== undefined)

  const layerSpec = fakeContext.recordedLayerSpecs[0] as {
    commands: Array<{ id: string; bind?: unknown }>
  }
  assert.equal(layerSpec.commands.length, 4)
  for (const registeredCommand of layerSpec.commands) {
    assert.ok(
      registeredCommand.bind === undefined || (typeof registeredCommand.bind === "string" && registeredCommand.bind !== ""),
      `command ${registeredCommand.id} must omit bind or bind a non-empty key`,
    )
  }
  commandsDispose?.()
})

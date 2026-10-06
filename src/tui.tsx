/** @jsxImportSource @opentui/solid */
/**
 * opencode-db-insight TUI entry (DESIGN.md §8, M6): thin assembly only.
 * Command/slot registration lives in src/tui/command-registry.ts, the
 * panel refresh loop in src/tui/status-panel-controller.ts; this file just
 * wires them together and holds the one JSX render the slot needs.
 */
import { createSignal } from "solid-js"
import { Plugin } from "@opencode/plugin/tui"

import {
  registerInsightTuiCommands,
  registerStatusPanelSlot,
  shouldRenderStatusPanel,
} from "./tui/command-registry.ts"
import { createStatusPanelController } from "./tui/status-panel-controller.ts"

export default Plugin.define({
  id: "opencode-db-insight",
  setup(context: any) {
    // Reactive panel text: the slot render reads the signal, the controller
    // pushes every (re)computed text into it.
    const [statusPanelText, setStatusPanelText] = createSignal("db-insight: 初始化…")
    const statusPanelController = createStatusPanelController({
      onPanelTextChanged: (refreshedPanelText) => {
        setStatusPanelText(refreshedPanelText)
      },
    })

    const commandsDispose = registerInsightTuiCommands(context, {
      // The refresh loop only starts once the panel is actually opened
      // (P2-13) — plugin startup itself stays scan-free.
      onStatusPanelOpened: () => {
        statusPanelController.beginAutoRefresh()
      },
    })
    const slotDispose = registerStatusPanelSlot(context, (slotInput) =>
      shouldRenderStatusPanel(slotInput) ? (
        <box>
          <text>{statusPanelText()}</text>
        </box>
      ) : (
        <box></box>
      ),
    )

    return () => {
      commandsDispose?.()
      slotDispose?.()
      statusPanelController.dispose()
    }
  },
})

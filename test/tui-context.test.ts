/**
 * Tests for the defensive TUI toast helper (src/tui/tui-context.ts).
 *
 * The host TUI may not expose `ui.toast` on every build, so every path here
 * must forward a toast when the API exists and degrade silently otherwise.
 */

import { test } from "node:test"
import assert from "node:assert/strict"

import { showInsightToast } from "../src/tui/tui-context.ts"

interface CapturedToast {
  message: string
  variant: string
}

function buildCapturingToastHost(): { hostContext: unknown; capturedToasts: CapturedToast[] } {
  const capturedToasts: CapturedToast[] = []
  const hostContext = {
    ui: {
      toast: {
        show: (toastOptions: { message: string; variant: string }) => {
          capturedToasts.push({ message: toastOptions.message, variant: toastOptions.variant })
        },
      },
    },
  }
  return { hostContext, capturedToasts }
}

test("showInsightToast forwards the message and variant to the host toast", () => {
  const { hostContext, capturedToasts } = buildCapturingToastHost()
  showInsightToast(hostContext, "看板已打开", "success")
  assert.deepEqual(capturedToasts, [{ message: "看板已打开", variant: "success" }])
})

test("showInsightToast passes each supported variant through unchanged", () => {
  const { hostContext, capturedToasts } = buildCapturingToastHost()
  showInsightToast(hostContext, "info note", "info")
  showInsightToast(hostContext, "error note", "error")
  showInsightToast(hostContext, "success note", "success")
  assert.deepEqual(
    capturedToasts.map((toast) => toast.variant),
    ["info", "error", "success"],
  )
})

test("showInsightToast ignores extra context fields", () => {
  const { capturedToasts } = buildCapturingToastHost()
  const hostContext = {
    unrelated: true,
    ui: {
      dialog: { select: async () => undefined },
      toast: {
        show: (toastOptions: { message: string; variant: string }) => {
          capturedToasts.push({ message: toastOptions.message, variant: toastOptions.variant })
        },
      },
    },
  }
  showInsightToast(hostContext, "menu opened", "info")
  assert.equal(capturedToasts.length, 1)
  assert.deepEqual(capturedToasts[0], { message: "menu opened", variant: "info" })
})

test("showInsightToast degrades silently when the context is null or undefined", () => {
  assert.doesNotThrow(() => showInsightToast(null, "no host", "error"))
  assert.doesNotThrow(() => showInsightToast(undefined, "no host", "error"))
})

test("showInsightToast degrades silently when the host lacks a toast API", () => {
  const hostContextsWithoutToast = [{}, { ui: {} }, { ui: { toast: {} } }, { ui: { toast: { show: undefined } } }]
  for (const hostContext of hostContextsWithoutToast) {
    assert.doesNotThrow(() => showInsightToast(hostContext, "no toast api", "info"))
  }
})

test("showInsightToast swallows an exception thrown by the host toast", () => {
  const throwingHost = {
    ui: {
      toast: {
        show: () => {
          throw new Error("host toast blew up")
        },
      },
    },
  }
  assert.doesNotThrow(() => showInsightToast(throwingHost, "still safe", "error"))
})

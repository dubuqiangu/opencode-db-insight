/**
 * Unit tests for the /insight open-dashboard command (T6.1): the pure
 * platform/command matrix, and the command flow with an injected probe
 * fetch (port discovery) plus an injected browser-open executor — no
 * real socket, no real spawn.
 *
 * Red-anchor discipline (P0): the fake TUI context below mirrors the REAL
 * host shape — storage only has store/memory, no get reader. The previous
 * storage-based port lookup could therefore never find a port in here
 * (nor in the real TUI), and these probe-driven cases fail against that
 * old implementation: it never probed any port at all.
 */

import { test } from "node:test"
import assert from "node:assert/strict"

import {
  buildDashboardUrl,
  buildOpenBrowserCommand,
  detectBrowserOpenPlatform,
  runOpenDashboardCommand,
} from "../src/tui/open-dashboard-command.ts"
import {
  buildRecordingDashboardProbeFetch,
  buildValidInsightHealthBody,
} from "./helpers/fake-dashboard-probe.ts"

test("detectBrowserOpenPlatform maps the three platform families", () => {
  assert.equal(detectBrowserOpenPlatform("win32"), "windows")
  assert.equal(detectBrowserOpenPlatform("darwin"), "darwin")
  assert.equal(detectBrowserOpenPlatform("linux"), "xdg")
  assert.equal(detectBrowserOpenPlatform("freebsd"), "xdg")
  assert.equal(detectBrowserOpenPlatform(""), "xdg")
})

test("buildOpenBrowserCommand builds the right opener per platform", () => {
  const dashboardUrl = buildDashboardUrl(18789)
  assert.equal(dashboardUrl, "http://127.0.0.1:18789/")

  assert.deepEqual(buildOpenBrowserCommand("windows", dashboardUrl), {
    command: "cmd",
    args: ["/c", "start", "", dashboardUrl],
  })
  assert.deepEqual(buildOpenBrowserCommand("darwin", dashboardUrl), {
    command: "open",
    args: [dashboardUrl],
  })
  assert.deepEqual(buildOpenBrowserCommand("xdg", dashboardUrl), {
    command: "xdg-open",
    args: [dashboardUrl],
  })
})

test("buildOpenBrowserCommand refuses unknown platforms and non-loopback urls", () => {
  assert.equal(buildOpenBrowserCommand("windows", ""), null)
  assert.equal(buildOpenBrowserCommand("windows", "not a url"), null)
  assert.equal(buildOpenBrowserCommand("windows", "ftp://127.0.0.1:18789/"), null)
  assert.equal(buildOpenBrowserCommand("windows", "http://evil.example.com/"), null)

  // localhost is a valid loopback dashboard host.
  const localhostOpenCommand = buildOpenBrowserCommand("xdg", "http://localhost:18789/")
  assert.deepEqual(localhostOpenCommand, {
    command: "xdg-open",
    args: ["http://localhost:18789/"],
  })
})

interface CapturedToast {
  message: string
  variant: string
}

/**
 * Fake TUI context mirroring the REAL host shape
 * (node_modules/@opencode/plugin/dist/tui/context.d.ts): storage exposes
 * only store/memory key-value stores — there is no get reader. This is
 * exactly the surface whose absence made /insight always report
 * 「看板服务未启动」before probe-based port discovery landed.
 */
function buildCapturingToastContext() {
  const capturedToasts: CapturedToast[] = []
  const context = {
    storage: {
      store: () => [{}, async () => {}],
      memory: () => [{}, () => {}],
    },
    ui: {
      toast: {
        show: (toastOptions: { message: string; variant: string }) => {
          capturedToasts.push({ message: toastOptions.message, variant: toastOptions.variant })
        },
      },
    },
  }
  return { context, capturedToasts }
}

/** Probe fixture: only 18791 answers as the insight server. */
function buildSingleHitProbeFetch() {
  return buildRecordingDashboardProbeFetch({ 18791: buildValidInsightHealthBody() })
}

test("runOpenDashboardCommand opens the discovered port and toasts the url on success", async () => {
  const { context, capturedToasts } = buildCapturingToastContext()
  const { probeFetch } = buildSingleHitProbeFetch()
  const openedCommands: string[][] = []
  const succeeded = await runOpenDashboardCommand(context, {
    platformValue: "win32",
    probeFetch,
    executeCommand: async (openCommand) => {
      openedCommands.push(openCommand.args)
    },
  })
  assert.equal(succeeded, true)
  assert.deepEqual(openedCommands, [["/c", "start", "", "http://127.0.0.1:18791/"]])
  assert.equal(capturedToasts.length, 1)
  assert.equal(capturedToasts[0].variant, "success")
  assert.equal(capturedToasts[0].message, "看板: http://127.0.0.1:18791/")
})

test("runOpenDashboardCommand reports the probed range when every probe is refused", async () => {
  const { context, capturedToasts } = buildCapturingToastContext()
  const { probeFetch } = buildRecordingDashboardProbeFetch({})
  const succeeded = await runOpenDashboardCommand(context, {
    platformValue: "win32",
    probeFetch,
    executeCommand: async () => {},
  })
  assert.equal(succeeded, false)
  assert.equal(capturedToasts.length, 1)
  assert.equal(capturedToasts[0].variant, "error")
  assert.match(capturedToasts[0].message, /看板服务未启动/)
  assert.match(capturedToasts[0].message, /127\.0\.0\.1:18789-18798 无健康响应/)
})

test("runOpenDashboardCommand skips foreign answers in the range and opens the real insight port", async () => {
  const { context, capturedToasts } = buildCapturingToastContext()
  // 18789/18790 are other processes answering in the probe range; only
  // 18791 carries the insight service identity.
  const { probeFetch } = buildRecordingDashboardProbeFetch({
    18789: { status: "ok" }, // no service field
    18790: { service: "some-other-dashboard", status: "ok" }, // foreign service
    18791: buildValidInsightHealthBody(),
  })
  const openedCommands: string[][] = []
  const succeeded = await runOpenDashboardCommand(context, {
    platformValue: "win32",
    probeFetch,
    executeCommand: async (openCommand) => {
      openedCommands.push(openCommand.args)
    },
  })
  assert.equal(succeeded, true)
  assert.deepEqual(openedCommands, [["/c", "start", "", "http://127.0.0.1:18791/"]])
  assert.equal(capturedToasts.length, 1)
  assert.equal(capturedToasts[0].variant, "success")
})

test("runOpenDashboardCommand falls back to a manual-open toast when exec fails", async () => {
  const { context, capturedToasts } = buildCapturingToastContext()
  const { probeFetch } = buildSingleHitProbeFetch()
  const succeeded = await runOpenDashboardCommand(context, {
    platformValue: "darwin",
    probeFetch,
    executeCommand: async () => {
      throw new Error("no browser here")
    },
  })
  assert.equal(succeeded, false)
  assert.equal(capturedToasts.length, 1)
  assert.equal(capturedToasts[0].variant, "error")
  assert.match(capturedToasts[0].message, /手动访问 http:\/\/127\.0\.0\.1:18791\//)
})

test("runOpenDashboardCommand never throws, even on hostile contexts", async () => {
  const { probeFetch } = buildSingleHitProbeFetch()

  // Null context: toast goes nowhere, but discovery does not touch the
  // context at all anymore, so the command still completes its flow.
  assert.equal(
    await runOpenDashboardCommand(null, {
      probeFetch,
      executeCommand: async () => {},
    }),
    true,
  )

  // An exploding storage getter must not take the command down (the old
  // storage-based lookup would have hit it during port reading).
  const explodingContext = {
    get storage() {
      throw new Error("storage exploded")
    },
  }
  assert.equal(
    await runOpenDashboardCommand(explodingContext, {
      probeFetch,
      executeCommand: async () => {},
    }),
    true,
  )

  // A rejecting probe fetch degrades to the not-running toast, not a throw.
  const { context: quietContext, capturedToasts } = buildCapturingToastContext()
  const { probeFetch: refusingProbeFetch } = buildRecordingDashboardProbeFetch({})
  assert.equal(
    await runOpenDashboardCommand(quietContext, {
      probeFetch: refusingProbeFetch,
      executeCommand: async () => {},
    }),
    false,
  )
  assert.equal(capturedToasts.length, 1)
  assert.equal(capturedToasts[0].variant, "error")
})

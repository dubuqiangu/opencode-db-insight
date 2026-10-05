/**
 * Unit tests for the /insight open-dashboard command (T6.1): the pure
 * platform/command matrix, the defensive storage port read, and the
 * command flow with an injected browser-open executor (no real spawn).
 */

import { test } from "node:test"
import assert from "node:assert/strict"

import {
  buildDashboardUrl,
  buildOpenBrowserCommand,
  detectBrowserOpenPlatform,
  runOpenDashboardCommand,
} from "../src/tui/open-dashboard-command.ts"
import { readInsightServerPort } from "../src/tui/tui-context.ts"

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

test("readInsightServerPort accepts sync and async storage.get shapes", async () => {
  assert.equal(
    await readInsightServerPort({ storage: { get: () => 18789 } }),
    18789,
  )
  assert.equal(
    await readInsightServerPort({ storage: { get: () => Promise.resolve("18790") } }),
    18790,
  )
})

test("readInsightServerPort degrades to null on missing/throwing/invalid storage", async () => {
  assert.equal(await readInsightServerPort({}), null)
  assert.equal(await readInsightServerPort({ storage: {} }), null)
  assert.equal(await readInsightServerPort(null), null)
  assert.equal(
    await readInsightServerPort({ storage: { get: () => { throw new Error("boom") } } }),
    null,
  )
  for (const invalidPort of [0, -1, 65536, "abc", null, {}, Number.NaN]) {
    assert.equal(await readInsightServerPort({ storage: { get: () => invalidPort } }), null)
  }
})

interface CapturedToast {
  message: string
  variant: string
}

function buildCapturingToastContext(storageGet?: () => unknown) {
  const capturedToasts: CapturedToast[] = []
  const context = {
    storage: storageGet === undefined ? {} : { get: storageGet },
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

test("runOpenDashboardCommand toasts the url on success", async () => {
  const { context, capturedToasts } = buildCapturingToastContext(() => 18789)
  const openedCommands: string[][] = []
  const succeeded = await runOpenDashboardCommand(context, {
    platformValue: "win32",
    executeCommand: async (openCommand) => {
      openedCommands.push(openCommand.args)
    },
  })
  assert.equal(succeeded, true)
  assert.deepEqual(openedCommands, [["/c", "start", "", "http://127.0.0.1:18789/"]])
  assert.equal(capturedToasts.length, 1)
  assert.equal(capturedToasts[0].variant, "success")
  assert.equal(capturedToasts[0].message, "看板: http://127.0.0.1:18789/")
})

test("runOpenDashboardCommand toasts 看板服务未启动 when no port is published", async () => {
  const { context, capturedToasts } = buildCapturingToastContext()
  const succeeded = await runOpenDashboardCommand(context, {
    platformValue: "win32",
    executeCommand: async () => {},
  })
  assert.equal(succeeded, false)
  assert.equal(capturedToasts.length, 1)
  assert.equal(capturedToasts[0].variant, "error")
  assert.match(capturedToasts[0].message, /看板服务未启动/)
})

test("runOpenDashboardCommand falls back to a manual-open toast when exec fails", async () => {
  const { context, capturedToasts } = buildCapturingToastContext(() => 18789)
  const succeeded = await runOpenDashboardCommand(context, {
    platformValue: "darwin",
    executeCommand: async () => {
      throw new Error("no browser here")
    },
  })
  assert.equal(succeeded, false)
  assert.equal(capturedToasts.length, 1)
  assert.equal(capturedToasts[0].variant, "error")
  assert.match(capturedToasts[0].message, /手动访问 http:\/\/127\.0\.0\.1:18789\//)
})

test("runOpenDashboardCommand never throws, even on hostile contexts", async () => {
  assert.equal(await runOpenDashboardCommand(null), false)

  const explodingContext = {
    get storage() {
      throw new Error("storage exploded")
    },
  }
  assert.equal(await runOpenDashboardCommand(explodingContext), false)
})

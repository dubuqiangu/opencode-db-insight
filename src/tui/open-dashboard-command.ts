/**
 * /insight command logic (DESIGN.md §8, task T6.1): read the port the server
 * plugin published in storage, open the dashboard in the platform browser,
 * and toast the URL (or a manual-open hint when anything fails).
 *
 * `buildOpenBrowserCommand` is pure and unit-tested; the exec/toast side
 * effects are injectable so tests never spawn a real browser.
 */

import { execFile } from "node:child_process"
import { promisify } from "node:util"

import { readInsightServerPort, showInsightToast } from "./tui-context.ts"

/** Host platform categories with a distinct "open a URL" convention. */
export type BrowserOpenPlatform = "windows" | "darwin" | "xdg"

/** Map a process.platform value onto the browser-open convention. */
export function detectBrowserOpenPlatform(platformValue: string): BrowserOpenPlatform {
  if (platformValue === "win32") return "windows"
  if (platformValue === "darwin") return "darwin"
  // linux / freebsd / anything else: the xdg-open convention.
  return "xdg"
}

/** A platform-specific command that opens the OS browser at a URL. */
export interface BrowserOpenCommand {
  command: string
  args: string[]
}

/** Dashboard URL for one bound insight server port. */
export function buildDashboardUrl(serverPort: number): string {
  return `http://127.0.0.1:${serverPort}/`
}

/** Only loopback dashboard URLs may be handed to the OS opener. */
function isLoopbackHttpUrl(url: string): boolean {
  let parsedUrl: URL
  try {
    parsedUrl = new URL(url)
  } catch {
    return false
  }
  return (
    parsedUrl.protocol === "http:" &&
    (parsedUrl.hostname === "127.0.0.1" || parsedUrl.hostname === "localhost")
  )
}

/**
 * Pure: platform → command/args that opens the browser at `url`.
 * Returns null for unknown platforms or non-loopback URLs.
 */
export function buildOpenBrowserCommand(
  osPlatform: BrowserOpenPlatform,
  url: string,
): BrowserOpenCommand | null {
  if (!isLoopbackHttpUrl(url)) return null
  if (osPlatform === "windows") {
    // `start` is a cmd.exe builtin; the empty title argument keeps cmd from
    // treating a quoted URL as the window title.
    return { command: "cmd", args: ["/c", "start", "", url] }
  }
  if (osPlatform === "darwin") return { command: "open", args: [url] }
  if (osPlatform === "xdg") return { command: "xdg-open", args: [url] }
  return null
}

/** Execute one browser-open command; default spawns the real process. */
async function executeBrowserOpenCommand(openCommand: BrowserOpenCommand): Promise<void> {
  const execFileAsync = promisify(execFile)
  await execFileAsync(openCommand.command, openCommand.args)
}

/** Injectable knobs for tests; production calls use the defaults. */
export interface OpenDashboardCommandDependencies {
  /** Override the detected process.platform (tests pass a matrix value). */
  platformValue?: string
  /** Override the actual process spawn (tests stub). */
  executeCommand?: (openCommand: BrowserOpenCommand) => Promise<void>
}

/**
 * Run /insight: read the published port, open the dashboard, toast the URL.
 * Returns true when the browser command succeeded; every failure path toasts
 * a hint and returns false — the command never throws.
 */
export async function runOpenDashboardCommand(
  context: unknown,
  dependencies: OpenDashboardCommandDependencies = {},
): Promise<boolean> {
  try {
    const serverPort = await readInsightServerPort(context)
    if (serverPort === null) {
      showInsightToast(context, "db-insight: 看板服务未启动（storage 中无端口记录）", "error")
      return false
    }

    const dashboardUrl = buildDashboardUrl(serverPort)
    const executeCommand = dependencies.executeCommand ?? executeBrowserOpenCommand
    const openCommand = buildOpenBrowserCommand(
      detectBrowserOpenPlatform(dependencies.platformValue ?? process.platform),
      dashboardUrl,
    )
    if (openCommand === null) {
      showInsightToast(context, `db-insight: 请手动访问看板：${dashboardUrl}`, "info")
      return false
    }

    try {
      await executeCommand(openCommand)
      showInsightToast(context, `看板: ${dashboardUrl}`, "success")
      return true
    } catch (execError) {
      showInsightToast(
        context,
        `db-insight: 无法自动打开浏览器，请手动访问 ${dashboardUrl}`,
        "error",
      )
      return false
    }
  } catch (commandError) {
    showInsightToast(
      context,
      `db-insight: 打开看板失败：${commandError instanceof Error ? commandError.message : String(commandError)}`,
      "error",
    )
    return false
  }
}

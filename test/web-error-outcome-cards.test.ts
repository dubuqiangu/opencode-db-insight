/** Component-level contracts with a deliberately small DOM/uPlot shim. */
import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { MISSING_REASON } from "../src/web/public/precision.js"

type EventListener = (event?: unknown) => void

class TestElement {
  className = ""
  dataset: Record<string, string> = {}
  attributes = new Map<string, string>()
  style: Record<string, string> = {}
  hidden = true
  clientWidth = 740
  private markup = ""
  private children: TestElement[] = []
  private listeners = new Map<string, Set<EventListener>>()

  set innerHTML(html: string) {
    this.markup = html
    this.children = [...html.matchAll(/<([a-z][a-z0-9]*)\b([^>]*)>/gi)].map((match) => {
      const child = new TestElement()
      child.attributes.set("tagName", match[1].toLowerCase())
      for (const attribute of match[2].matchAll(/([\w-]+)="([^"]*)"/g)) {
        child.attributes.set(attribute[1], attribute[2])
        if (attribute[1] === "class") child.className = attribute[2]
        if (attribute[1].startsWith("data-")) {
          const key = attribute[1].slice(5).replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase())
          child.dataset[key] = attribute[2]
        }
      }
      return child
    })
  }
  get innerHTML() { return this.markup }
  querySelectorAll(selector: string): TestElement[] {
    const attributeSelector = selector.match(/\[([\w-]+)\]$/)
    const [tag, ...classes] = selector.replace(/\[[^\]]+\]$/, "").split(".")
    return this.children.filter((element) => (!tag || element.attributes.get("tagName") === tag) &&
      classes.every((className) => element.className.split(/\s+/).includes(className)) &&
      (!attributeSelector || element.attributes.has(attributeSelector[1])))
  }
  querySelector(selector: string): TestElement | null { return this.querySelectorAll(selector)[0] ?? null }
  addEventListener(event: string, listener: EventListener) {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set())
    this.listeners.get(event)!.add(listener)
  }
  removeEventListener(event: string, listener: EventListener) { this.listeners.get(event)?.delete(listener) }
  emit(event: string) { for (const listener of this.listeners.get(event) ?? []) listener() }
  setAttribute(name: string, value: string) { this.attributes.set(name, value) }
  classList = {
    toggle: (className: string, enabled: boolean) => {
      const tokens = this.className.split(/\s+/).filter(Boolean).filter((token) => token !== className)
      if (enabled) tokens.push(className)
      this.className = tokens.join(" ")
    },
  }
  getBoundingClientRect() { return { left: 0, top: 0, width: this.clientWidth, height: 340 } }
}

interface RecordedPlot {
  options: Record<string, unknown>
  data: number[][]
  mount: TestElement
  sizeChanges: Array<{ width: number; height: number }>
  seriesChanges: Array<{ index: number; show: boolean }>
  destroyed: boolean
}

const plots: RecordedPlot[] = []
let disconnectedObservers = 0

class FakePlot {
  private record: RecordedPlot
  constructor(options: Record<string, unknown>, data: number[][], mount: TestElement) {
    this.record = { options, data, mount, sizeChanges: [], seriesChanges: [], destroyed: false }
    plots.push(this.record)
  }
  setSize(size: { width: number; height: number }) { this.record.sizeChanges.push(size) }
  setSeries(index: number, change: { show: boolean }) { this.record.seriesChanges.push({ index, show: change.show }) }
  destroy() { this.record.destroyed = true }
}

class FakeResizeObserver {
  private callback: () => void
  constructor(callback: () => void) { this.callback = callback }
  observe() { this.callback() }
  disconnect() { disconnectedObservers += 1 }
}

const tooltipElement = new TestElement()
const documentStub = {
  documentElement: new TestElement(),
  getElementById: (elementId: string) => elementId === "tooltip" ? tooltipElement : null,
}
globalThis.document = documentStub as unknown as Document
globalThis.getComputedStyle = (() => ({ getPropertyValue: (name: string) => `var(${name})` })) as unknown as typeof getComputedStyle
globalThis.window = { innerWidth: 1280, innerHeight: 800 } as Window & typeof globalThis
globalThis.uPlot = FakePlot as unknown as typeof uPlot
globalThis.ResizeObserver = FakeResizeObserver as unknown as typeof ResizeObserver

test("tool error chart keeps counts on the left, rates on the right, and cleans up", async () => {
  const { renderToolErrorTrendCard } = await import("../src/web/public/components/tool-error-trend-card.js")
  const container = new TestElement()
  const requestedDays: number[] = []
  const cleanup = renderToolErrorTrendCard(container as unknown as HTMLElement, {
    days: 90,
    points: [
      { date: "2026-10-01", toolCalls: 10, errors: 1, errorRate: 0.1 },
      { date: "2026-10-02", toolCalls: 20, errors: 3, errorRate: 0.15 },
    ],
  }, { onDaysChange: (days: number) => requestedDays.push(days) })
  assert.equal(container.querySelectorAll("button[data-tool-error-days]").length, 3)
  assert.match(container.innerHTML, /data-tool-error-days="90" class="active" aria-pressed="true"/)
  const dayButtons = container.querySelectorAll("button")
  dayButtons[0].emit("click")
  dayButtons[1].emit("click")
  dayButtons[2].emit("click")
  assert.deepEqual(requestedDays, [30, 90, 366])
  const plot = plots.at(-1)!
  assert.deepEqual(plot.data.slice(1), [[1, 3], [10, 15]])
  const axes = plot.options.axes as Array<Record<string, unknown>>
  assert.deepEqual((axes[1].splits as () => number[])(), [0, 1, 2, 3])
  assert.equal(axes[2].scale, "errorRate")
  assert.equal((plot.options.series as Array<Record<string, unknown>>)[2].dash?.toString(), "6,4")
  const content = container.querySelector(".tool-error-content")!
  const toggle = content.querySelector(".tool-error-rate-toggle")!
  const cursorHook = (plot.options.hooks as { setCursor: Array<(chart: unknown) => void> }).setCursor[0]
  cursorHook({ cursor: { idx: 1, left: 24, top: 36 } })
  assert.match(tooltipElement.innerHTML, /2026-10-02/)
  assert.match(tooltipElement.innerHTML, /工具调用[\s\S]*20/)
  assert.match(tooltipElement.innerHTML, /错误数[\s\S]*3/)
  assert.match(tooltipElement.innerHTML, /错误率[\s\S]*15\.0%/)
  assert.equal(tooltipElement.hidden, false)
  toggle.emit("click")
  assert.deepEqual(plot.seriesChanges, [{ index: 2, show: false }])
  assert.equal(toggle.attributes.get("aria-pressed"), "false")
  cursorHook({ cursor: { idx: 1, left: 24, top: 36 } })
  assert.doesNotMatch(tooltipElement.innerHTML, /错误率/)
  assert.match(content.innerHTML, /查看每日错误与调用明细/)
  const observerCountBeforeCleanup = disconnectedObservers
  cleanup()
  assert.equal(plot.destroyed, true)
  assert.equal(disconnectedObservers, observerCountBeforeCleanup + 1)
  assert.equal(tooltipElement.hidden, true)

  // The switch is module-level state: refresh and range changes must not reset it.
  const refreshedContainer = new TestElement()
  const refreshedCleanup = renderToolErrorTrendCard(refreshedContainer as unknown as HTMLElement, {
    days: 30,
    points: [
      { date: "2026-10-01", toolCalls: 10, errors: 1, errorRate: 0.1 },
      { date: "2026-10-02", toolCalls: 20, errors: 3, errorRate: 0.15 },
    ],
  })
  const refreshedContent = refreshedContainer.querySelector(".tool-error-content")!
  const refreshedToggle = refreshedContent.querySelector(".tool-error-rate-toggle")!
  assert.equal(refreshedToggle.attributes.get("aria-pressed"), "false")
  assert.ok(refreshedToggle.className.includes("off"))
  assert.deepEqual(plots.at(-1)!.seriesChanges, [{ index: 2, show: false }])
  refreshedToggle.emit("click") // Restore the default for the next independent test.
  refreshedCleanup()
})

test("range selector requests the previously rendered window again while a new request is in flight", async () => {
  const { renderToolErrorTrendCard } = await import("../src/web/public/components/tool-error-trend-card.js")
  const container = new TestElement()
  const requestedDays: number[] = []
  const cleanup = renderToolErrorTrendCard(container as unknown as HTMLElement, {
    days: 30,
    points: [
      { date: "2026-10-01", toolCalls: 10, errors: 1, errorRate: 0.1 },
      { date: "2026-10-02", toolCalls: 20, errors: 2, errorRate: 0.1 },
    ],
  }, { onDaysChange: (days: number) => requestedDays.push(days) })
  const dayButtons = container.querySelectorAll("button[data-tool-error-days]")
  dayButtons[1].emit("click") // Request 90d; no new payload/render yet.
  dayButtons[1].emit("click") // Duplicate pending request is ignored.
  dayButtons[0].emit("click") // Return to the last rendered 30d during the pending request.
  assert.deepEqual(requestedDays, [90, 30])
  cleanup()
})

test("trend drops invalid local dates and keeps large-count axes readable", async () => {
  const { renderToolErrorTrendCard } = await import("../src/web/public/components/tool-error-trend-card.js")
  const container = new TestElement()
  const cleanup = renderToolErrorTrendCard(container as unknown as HTMLElement, {
    days: 30,
    points: [
      { date: "bad-date", toolCalls: 500, errors: 500, errorRate: 1 },
      { date: "2026-10-01", toolCalls: 15000, errors: 12000, errorRate: 0.8 },
      { date: "2026-10-02", toolCalls: 800, errors: 300, errorRate: 0.375 },
      { date: "2026-xx-03", toolCalls: 100, errors: 70, errorRate: 0.7 },
      { date: "2026-13-03", toolCalls: 100, errors: 70, errorRate: 0.7 },
    ],
  })
  const plot = plots.at(-1)!
  assert.equal(plot.data[0].length, 2)
  assert.ok(plot.data[0].every(Number.isFinite))
  assert.deepEqual(plot.data.slice(1), [[12000, 300], [80, 37.5]])
  assert.doesNotMatch(container.querySelector(".tool-error-content")!.innerHTML, /bad-date|2026-xx-03|2026-13-03/)
  const leftAxis = (plot.options.axes as Array<Record<string, unknown>>)[1]
  const ticks = (leftAxis.splits as () => number[])()
  assert.ok(ticks.length >= 2 && ticks.every(Number.isInteger))
  assert.ok(ticks.length <= 6)
  const labels = (leftAxis.values as (chart: unknown, ticks: number[]) => string[])(null, ticks)
  assert.ok(labels.some((label) => label.endsWith("K")))
  cleanup()
})

test("tool error card handles empty, unreachable, and no failures without starting a plot", async () => {
  const { renderToolErrorTrendCard } = await import("../src/web/public/components/tool-error-trend-card.js")
  const container = new TestElement()
  const initialPlotCount = plots.length
  assert.equal(typeof renderToolErrorTrendCard(container as unknown as HTMLElement, null), "function")
  assert.match(container.innerHTML, /这块数据没加载出来/)
  const cleanup = renderToolErrorTrendCard(container as unknown as HTMLElement, {
    days: 30,
    points: [
      { date: "2026-10-01", toolCalls: 100, errors: 0, errorRate: 0 },
      { date: "2026-10-02", toolCalls: 120, errors: 0, errorRate: 0 },
    ],
  })
  assert.match(container.querySelector(".tool-error-content")!.innerHTML, /没有工具错误趋势/)
  assert.match(container.innerHTML, /data-tool-error-days="30" class="active"/)
  assert.equal(plots.length, initialPlotCount)
  cleanup()
})

test("outcome card escapes external text, links to replay, and distinguishes empty states", async () => {
  const { renderSessionOutcomeCard } = await import("../src/web/public/components/session-outcome-card.js")
  const container = new TestElement()
  assert.equal(typeof renderSessionOutcomeCard(container as unknown as HTMLElement, null), "function")
  assert.match(container.innerHTML, /这块数据没加载出来/)
  renderSessionOutcomeCard(container as unknown as HTMLElement, {
    totalSessions: 0, sessionsWithSteps: 0, cleanSessions: 0,
    interruptedSessions: 0, interruptedShare: 0, byErrorType: [], recentInterrupted: [],
  })
  assert.match(container.innerHTML, /还没有会话结局数据/)
  const cleanup = renderSessionOutcomeCard(container as unknown as HTMLElement, {
    totalSessions: 12, sessionsWithSteps: 10, cleanSessions: 8,
    interruptedSessions: 2, interruptedShare: 0.2,
    byErrorType: [{ type: "Parse <error>", count: 2 }, { type: "Timeout", count: 1 }],
    recentInterrupted: [{
      sessionId: "ses/a?b#c", title: "Danger <script>", errorType: "Parse <error>",
      errorMessage: "bad \"input\" <img>", timeUpdated: 1_700_000_000_000,
    }],
  })
  assert.match(container.innerHTML, /以错误收尾的会话/)
  assert.match(container.innerHTML, /20\.0%/)
  assert.match(container.innerHTML, /最后一条 assistant 消息带 error/)
  assert.match(container.innerHTML, /width:100\.0%/)
  assert.match(container.innerHTML, /width:50\.0%/)
  assert.match(container.innerHTML, /条宽相对榜首/)
  assert.match(container.innerHTML, /href="#\/session\/ses%2Fa%3Fb%23c"/)
  assert.match(container.innerHTML, /Danger &lt;script&gt;/)
  assert.match(container.innerHTML, /Parse &lt;error&gt;/)
  assert.match(container.innerHTML, /bad &quot;input&quot; &lt;img&gt;/)
  assert.doesNotMatch(container.innerHTML, /<script>|<img>/)
  assert.equal(typeof cleanup, "function")
  cleanup()
})

test("outcome card degrades inconsistent interrupted counts and shares together", async () => {
  const { renderSessionOutcomeCard } = await import("../src/web/public/components/session-outcome-card.js")
  const container = new TestElement()
  renderSessionOutcomeCard(container as unknown as HTMLElement, {
    totalSessions: 10, sessionsWithSteps: 3, cleanSessions: 0,
    interruptedSessions: 5, interruptedShare: 5 / 3,
    byErrorType: [], recentInterrupted: [],
  })
  assert.ok(
    container.innerHTML.includes(
      `session-outcome-hero-number num"><span class="missing-value" title="${MISSING_REASON.inconsistentCount}">—</span></div>`,
    ),
    "inconsistent interrupted count degrades with the shared reason",
  )
  assert.ok(
    container.innerHTML.includes(
      `session-outcome-share-value num"><span class="missing-value" title="${MISSING_REASON.zeroDenominator}">—</span></span>`,
    ),
    "an undefined share degrades with the shared reason",
  )
  assert.doesNotMatch(container.innerHTML, /100\.0%/)
})

test("new panels and navigation anchors stay synchronized", () => {
  const index = readFileSync(new URL("../src/web/public/index.html", import.meta.url), "utf8")
  for (const [panelId, mountId] of [
    ["panel-tool-error-trend", "session-tool-error-trend"],
    ["panel-session-outcomes", "session-outcomes"],
  ]) {
    assert.match(index, new RegExp(`data-toc-target="${panelId}"`))
    assert.match(index, new RegExp(`id="${panelId}"[\\s\\S]*?id="${mountId}"`))
  }
  assert.match(index, /按本地日 · 错误数 \+ 错误率 · 全部会话<\/p>/)
  assert.match(index, /会话失败与中断[\s\S]*?🟡 推断/)
  assert.match(index, /🟡 推断\/估算 = 由消息字段推断或由 token 换算，仅作参考/)
})

/**
 * Tests for the v0.2-A web components (src/web/public/components/*.js),
 * runnable under node:test via a thin DOM shim.
 *
 * The component modules never touch the DOM at import time, so the shim
 * only needs: innerHTML string capture with flat tag parsing (class +
 * data-* + generic attributes), class-token queries, appendChild and
 * no-op event listeners. These assertions previously lived only in
 * session-level probes — here they become part of npm test.
 *
 * src/web/public is owned by the frontend track: this file imports the
 * components read-only and never edits them.
 *
 * Also locks the strict-hit-rate mirror (盲区①): the same token fixtures
 * must produce identical values from the backend strictHitRate
 * (src/stats/hit-rate.ts) and the frontend summarizeStrictHitRate
 * (replay-timeline.js) — if either 口径 drifts, this test goes red.
 */

import { test } from "node:test"
import assert from "node:assert/strict"

import { strictHitRate } from "../src/stats/hit-rate.ts"
import { directoryDisplayName } from "../src/db/directory-queries.ts"

/* ------------------------- thin DOM shim ------------------------- */

/**
 * Minimal element stub. `innerHTML` stores the assigned markup and parses
 * a flat list of opening tags (class / data-* / every other attribute);
 * queries walk that list recursively so nested and appended elements are
 * both reachable. Render-time addEventListener bindings are captured so
 * interaction tests can fire them via click(); assigning innerHTML again
 * drops them, like a real re-render.
 */
class StubElement {
  tagName: string
  className = ""
  attributes = new Map<string, string>()
  dataset: Record<string, string> = {}
  style: Record<string, string> = {}
  textContent = ""
  title = ""
  hidden = false
  /** Form control value (the v0.10.0 replay search input is the first user). */
  value = ""
  private innerHtmlText = ""
  private stubChildren: StubElement[] = []
  private eventListeners = new Map<string, Array<(eventPayload?: unknown) => void>>()

  constructor(tagName: string) {
    this.tagName = tagName
  }

  /**
   * Minimal classList (the v0.10.0 replay search paints node-level hit
   * classes). Backed by the className field, variadic add/remove like the
   * real DOMTokenList.
   */
  classList = {
    add: (...classTokens: string[]) => {
      for (const classToken of classTokens) {
        if (!this.classTokenList().includes(classToken)) {
          this.className = `${this.className} ${classToken}`.trim()
        }
      }
    },
    remove: (...classTokens: string[]) => {
      this.className = this.classTokenList()
        .filter((classToken) => !classTokens.includes(classToken))
        .join(" ")
    },
    contains: (classToken: string) => this.classTokenList().includes(classToken),
  }

  set innerHTML(htmlText: string) {
    this.innerHtmlText = htmlText
    this.stubChildren = parseStubChildren(htmlText)
    // innerHTML replaces the subtree: listeners registered on the previous
    // subtree's elements are gone with it — exactly like a real re-render.
    this.eventListeners.clear()
  }

  get innerHTML(): string {
    return this.innerHtmlText
  }

  appendChild(childElement: StubElement): StubElement {
    // Real-DOM semantics: appending a DocumentFragment appends its children.
    if (childElement.tagName === "#document-fragment") {
      for (const fragmentChild of childElement.stubChildren) {
        this.stubChildren.push(fragmentChild)
      }
      childElement.stubChildren = []
      return childElement
    }
    this.stubChildren.push(childElement)
    return childElement
  }

  addEventListener(eventType: string, listener: (eventPayload?: unknown) => void): void {
    const typedListeners = this.eventListeners.get(eventType) ?? []
    typedListeners.push(listener)
    this.eventListeners.set(eventType, typedListeners)
  }

  /** Fire all listeners registered for an event type (render-time bindings). */
  fire(eventType: string, eventPayload?: unknown): void {
    for (const eventListener of this.eventListeners.get(eventType) ?? []) {
      eventListener(eventPayload)
    }
  }

  /** Fire all listeners registered for "click" (render-time bindings only). */
  click(): void {
    this.fire("click")
  }

  /**
   * Fixed 200×60 box for tooltip.js moveTooltip's edge-flip math — the
   * only render-time getBoundingClientRect consumer in the tested module
   * set; real geometry is irrelevant to the contracts under test.
   */
  getBoundingClientRect(): { width: number; height: number } {
    return { width: 200, height: 60 }
  }

  classTokenList(): string[] {
    return this.className.split(/\s+/).filter((classToken) => classToken !== "")
  }

  /** Real-DOM Element.children semantics (replay-timeline.nodeAt indexes it). */
  get children(): StubElement[] {
    return this.stubChildren
  }

  /**
   * Class-token query supporting ".class", "tag.class" and multi-class
   * ".a.b" compounds (components combine state classes, e.g. the v0.7.0
   * drill-down rows ".directory-row.selectable") plus bare "tag" selectors.
   */
  querySelectorAll(elementSelector: string): StubElement[] {
    const selectorParts = elementSelector.split(".")
    const wantedTagName = /^[a-zA-Z][a-zA-Z0-9]*$/.test(selectorParts[0])
      ? selectorParts[0]
      : null
    const wantedClassTokens = (wantedTagName === null ? selectorParts : selectorParts.slice(1))
      .filter((classToken) => classToken !== "")
    const matchedElements: StubElement[] = []
    const walkChildren = (parentElement: StubElement): void => {
      for (const childElement of parentElement.stubChildren) {
        const elementClassTokens = childElement.classTokenList()
        const classNameMatches = wantedClassTokens
          .every((classToken) => elementClassTokens.includes(classToken))
        const tagNameMatches = wantedTagName === null
          || childElement.tagName.toLowerCase() === wantedTagName.toLowerCase()
        if (classNameMatches && tagNameMatches) {
          matchedElements.push(childElement)
        }
        walkChildren(childElement)
      }
    }
    walkChildren(this)
    return matchedElements
  }

  querySelector(classSelector: string): StubElement | null {
    return this.querySelectorAll(classSelector)[0] ?? null
  }
}

const OPENING_TAG_PATTERN = /<([a-zA-Z][a-zA-Z0-9]*)\b([^>]*)>/g
const NAMED_ATTRIBUTE_PATTERN = /\b([a-zA-Z-]+)="([^"]*)"/g

/** data-cell-index → dataset.cellIndex (kebab → camel). */
function toCamelCase(kebabName: string): string {
  return kebabName
    .split("-")
    .map((namePart, partIndex) =>
      partIndex === 0 ? namePart : namePart[0].toUpperCase() + namePart.slice(1),
    )
    .join("")
}

function parseStubChildren(htmlText: string): StubElement[] {
  const stubElements: StubElement[] = []
  for (const openingTagMatch of htmlText.matchAll(OPENING_TAG_PATTERN)) {
    const [, tagName, attributeText] = openingTagMatch
    const stubElement = new StubElement(tagName)
    for (const attributeMatch of attributeText.matchAll(NAMED_ATTRIBUTE_PATTERN)) {
      const attributeName = attributeMatch[1]
      const attributeValue = attributeMatch[2]
      stubElement.attributes.set(attributeName, attributeValue)
      if (attributeName === "class") stubElement.className = attributeValue
      if (attributeName.startsWith("data-")) {
        stubElement.dataset[toCamelCase(attributeName.slice("data-".length))] = attributeValue
      }
    }
    stubElements.push(stubElement)
  }
  return stubElements
}

function installDomShim(): void {
  const documentStub = {
    documentElement: new StubElement("html"),
    createElement: (tagName: string) => new StubElement(tagName),
    createElementNS: (_namespaceUri: string, tagName: string) => new StubElement(tagName),
    createDocumentFragment: () => new StubElement("#document-fragment"),
    getElementById: () => null,
  }
  globalThis.document = documentStub as unknown as Document
  globalThis.getComputedStyle = (() => ({
    getPropertyValue: (variableName: string) => `stub-css(${variableName})`,
  })) as unknown as typeof getComputedStyle
  globalThis.window = {
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    innerWidth: 1920,
    innerHeight: 1080,
  } as unknown as Window & typeof globalThis
}

installDomShim()

/** Fresh render container per test. */
function freshContainer(): StubElement {
  return new StubElement("div")
}

/* --------------------- hour-heatmap component --------------------- */

/** 168-item zero-filled wire array with a few cells overridden. */
function buildHeatmapWire(overrides: Array<{ weekday: number; hour: number; steps: number }>) {
  const heatmapCells: Array<{ weekday: number; hour: number; steps: number }> = []
  for (let weekday = 0; weekday < 7; weekday += 1) {
    for (let hour = 0; hour < 24; hour += 1) {
      heatmapCells.push({ weekday, hour, steps: 0 })
    }
  }
  for (const overrideCell of overrides) {
    heatmapCells[overrideCell.weekday * 24 + overrideCell.hour] = overrideCell
  }
  return heatmapCells
}

test("renderHourHeatmap renders all 168 cells with meta totals and themed zero fill", async () => {
  const { renderHourHeatmap } = await import("../src/web/public/components/hour-heatmap.js")
  const container = freshContainer()

  renderHourHeatmap(
    container,
    buildHeatmapWire([
      { weekday: 1, hour: 14, steps: 7 },
      { weekday: 2, hour: 3, steps: 3 },
    ]),
  )

  const renderedCells = container.querySelectorAll(".hour-heatmap-cell")
  assert.equal(renderedCells.length, 168, "the 7×24 grid must render exactly 168 rects")

  const cellIndexes = renderedCells.map((cell) => Number(cell.dataset.cellIndex))
  cellIndexes.sort((left, right) => left - right)
  assert.equal(cellIndexes[0], 0)
  assert.equal(cellIndexes[167], 167)
  assert.equal(new Set(cellIndexes).size, 168, "cell indexes cover 0..167 exactly once")

  // Zero cells take the --heat-0 theme slot through cssVar().
  const zeroCell = renderedCells.find((cell) => cell.dataset.cellIndex === "0")!
  assert.equal(zeroCell.attributes.get("fill"), "stub-css(--heat-0)")

  assert.match(
    container.innerHTML,
    /总计 <b class="num">10<\/b> 步/,
    "meta line must format the 7+3 step total",
  )
  assert.match(container.innerHTML, /活跃时段 <b class="num">2<\/b>\/168/)
})

test("renderHourHeatmap degrades null and all-zero data to the empty placeholder", async () => {
  const { renderHourHeatmap } = await import("../src/web/public/components/hour-heatmap.js")

  const nullContainer = freshContainer()
  renderHourHeatmap(nullContainer, null)
  assert.match(nullContainer.innerHTML, /没有活动时段数据/)

  const zeroContainer = freshContainer()
  renderHourHeatmap(zeroContainer, buildHeatmapWire([]))
  assert.match(zeroContainer.innerHTML, /没有活动时段数据/)
  assert.equal(zeroContainer.querySelectorAll(".hour-heatmap-cell").length, 0)
})

/* ------------------ session-survival-card component ------------------ */

test("renderSessionSurvivalCard formats the median duration, share and escaped outcome rows", async () => {
  const { renderSessionSurvivalCard } = await import(
    "../src/web/public/components/session-survival-card.js"
  )
  const { escapeHtml } = await import("../src/web/public/format.js")
  const container = freshContainer()

  renderSessionSurvivalCard(container, {
    totalSessions: 4,
    medianDurationSeconds: 3725,
    shortLivedShare: 0.5,
    idleOutcomeCounts: { "<img>": 1, succeeded: 3 },
  })

  const renderedHtml = container.innerHTML
  assert.match(renderedHtml, /1 小时 2 分/, "3725s formats as 1 小时 2 分")
  assert.match(renderedHtml, /50\.0%/, "shortLivedShare 0.5 formats as 50.0%")
  assert.match(renderedHtml, /共 <span class="num">4<\/span> 个会话/)
  // Outcome names are external data: escaped everywhere, never raw.
  const escapedOutcomeKey = escapeHtml("<img>")
  assert.ok(renderedHtml.includes(escapedOutcomeKey), "the hostile outcome key must be escaped")
  assert.ok(!renderedHtml.includes("<img>"), "no raw hostile key may reach the DOM")
  // Distribution bar widths: succeeded 3/3 → 100%, <img> 1/3 → 33.3%.
  assert.ok(renderedHtml.includes("width:100.0%"))
  assert.ok(renderedHtml.includes("width:33.3%"))
})

test("renderSessionSurvivalCard degrades null and zero-session data to the empty placeholder", async () => {
  const { renderSessionSurvivalCard } = await import(
    "../src/web/public/components/session-survival-card.js"
  )

  const nullContainer = freshContainer()
  renderSessionSurvivalCard(nullContainer, null)
  assert.match(nullContainer.innerHTML, /还没有会话存活数据/)

  const emptyContainer = freshContainer()
  renderSessionSurvivalCard(emptyContainer, {
    totalSessions: 0,
    medianDurationSeconds: 0,
    shortLivedShare: 0,
    idleOutcomeCounts: {},
  })
  assert.match(emptyContainer.innerHTML, /还没有会话存活数据/)
})

/* --------------------- compaction-panel component --------------------- */

test("renderCompactionPanel escapes reason and session ids and builds the session href", async () => {
  const { renderCompactionPanel } = await import(
    "../src/web/public/components/compaction-panel.js"
  )
  const { escapeHtml } = await import("../src/web/public/format.js")
  const container = freshContainer()

  const hostileSessionId = 'ses_evil"><img>'
  renderCompactionPanel(container, {
    total: 3,
    byReason: { "<script>alert(1)</script>": 2, auto: 1 },
    recentDaily: [
      { dateKey: "2026-10-05", count: 6 },
      { dateKey: "2026-10-06", count: 11 },
    ],
    topSessions: [{ sessionId: hostileSessionId, count: 15 }],
  })

  const renderedHtml = container.innerHTML
  assert.match(renderedHtml, /共 <b class="num">3<\/b> 次压缩/)

  // Hostile reason key: escaped, never raw.
  const escapedReasonKey = escapeHtml("<script>alert(1)</script>")
  assert.ok(renderedHtml.includes(escapedReasonKey))
  assert.ok(!renderedHtml.includes("<script>alert(1)</script>"))
  // Reason bars: 2 (max) → 100%, 1 → 50%.
  assert.ok(renderedHtml.includes("width:100.0%"))
  assert.ok(renderedHtml.includes("width:50.0%"))

  // Session href is percent-encoded; the data attribute is html-escaped;
  // the visible <code> shows the first 8 characters + ellipsis.
  assert.ok(
    renderedHtml.includes(`href="#/session/${encodeURIComponent(hostileSessionId)}"`),
    "the href must percent-encode the session id",
  )
  assert.ok(
    renderedHtml.includes(`data-session-id="${escapeHtml(hostileSessionId)}"`),
    "the data attribute must be html-escaped",
  )
  assert.ok(renderedHtml.includes("<code>ses_evil…</code>"), "8-character short display")
  assert.match(renderedHtml, /15 次/, "the top-session count is rendered")

  // Mini trend bars: two days scaled against the max of 11.
  const trendBars = container.querySelectorAll(".compaction-trend-bar")
  assert.equal(trendBars.length, 2)
  assert.equal(trendBars[0].attributes.get("data-day-index"), "0")
  assert.equal(trendBars[0].attributes.get("height"), "25", "round(6/11 × 46)")
  assert.equal(trendBars[0].attributes.get("y"), "31", "56 − 25")
  assert.equal(trendBars[1].attributes.get("height"), "46", "the max day fills the peak")
})

test("renderCompactionPanel degrades zero-total data to the empty placeholder", async () => {
  const { renderCompactionPanel } = await import(
    "../src/web/public/components/compaction-panel.js"
  )

  const nullContainer = freshContainer()
  renderCompactionPanel(nullContainer, null)
  assert.match(nullContainer.innerHTML, /还没有上下文压缩事件/)

  const emptyContainer = freshContainer()
  renderCompactionPanel(emptyContainer, {
    total: 0,
    byReason: {},
    recentDaily: [],
    topSessions: [],
  })
  assert.match(emptyContainer.innerHTML, /还没有上下文压缩事件/)
})

/* ------------------------ todo-card component ------------------------ */

test("renderTodoCard segment widths sum to exactly 100 percent", async () => {
  const { renderTodoCard } = await import("../src/web/public/components/todo-card.js")
  const container = freshContainer()

  renderTodoCard(container, { total: 10, completed: 4, pending: 3, inProgress: 2 })

  assert.match(container.innerHTML, /40\.0%/, "4/10 completion rate")
  assert.match(container.innerHTML, /<span class="num">4<\/span>\/<span class="num">10<\/span> 项/)

  const segmentElements = container.querySelectorAll(".todo-seg")
  assert.equal(segmentElements.length, 4, "done/active/pending/other segments")
  const segmentWidths = segmentElements.map(
    (segmentElement) => Number(segmentElement.style.width.replace(/%$/, "")),
  )
  assert.deepEqual(segmentWidths, [40, 20, 30, 10])
  const widthSum = segmentWidths.reduce((widthAccumulator, widthPercent) => widthAccumulator + widthPercent, 0)
  assert.equal(widthSum, 100)
  assert.match(container.innerHTML, /其他 1/, "the cancelled/other remainder is labeled")
})

test("renderTodoCard omits the other segment when the three known states cover the total", async () => {
  const { renderTodoCard } = await import("../src/web/public/components/todo-card.js")
  const container = freshContainer()

  renderTodoCard(container, { total: 9, completed: 3, pending: 3, inProgress: 3 })

  const segmentElements = container.querySelectorAll(".todo-seg")
  assert.equal(segmentElements.length, 3, "no 'other' segment when the remainder is 0")
  const segmentWidths = segmentElements.map(
    (segmentElement) => Number(segmentElement.style.width.replace(/%$/, "")),
  )
  // Each segment is toFixed(2)-rounded: 3×(3/9) → 3×33.33, which sums to
  // 99.99, not 100 — the component's own rounding, locked as-is.
  assert.deepEqual(segmentWidths, [33.33, 33.33, 33.33])
  assert.ok(!container.innerHTML.includes("其他"), "no other-count label")
})

test("renderTodoCard degrades null and zero-total data to the empty placeholder", async () => {
  const { renderTodoCard } = await import("../src/web/public/components/todo-card.js")

  const nullContainer = freshContainer()
  renderTodoCard(nullContainer, null)
  assert.match(nullContainer.innerHTML, /还没有 todo 记录/)

  const emptyContainer = freshContainer()
  renderTodoCard(emptyContainer, { total: 0, completed: 0, pending: 0, inProgress: 0 })
  assert.match(emptyContainer.innerHTML, /还没有 todo 记录/)
})

/* --------------- strict hit-rate mirror (backend ↔ frontend) --------------- */

interface WireTokenFixtureMessage {
  type: string
  timeCreated: number
  seq: number
  id: string
  sessionId: string
  data: unknown
}

function assistantMessageWithTokens(
  tokenInput: number,
  tokenOutput: number,
  cacheRead: number,
  cacheWrite: number,
): WireTokenFixtureMessage {
  return {
    type: "assistant",
    timeCreated: 1000,
    seq: 0,
    id: "msg_fixture",
    sessionId: "ses_fixture",
    data: { tokens: { input: tokenInput, output: tokenOutput, cache: { read: cacheRead, write: cacheWrite } } },
  }
}

function userTextMessage(): WireTokenFixtureMessage {
  return {
    type: "user",
    timeCreated: 900,
    seq: 0,
    id: "msg_user_fixture",
    sessionId: "ses_fixture",
    data: { text: "hello" },
  }
}

test("summarizeStrictHitRate mirrors the backend strictHitRate value for value", async () => {
  const { summarizeStrictHitRate } = await import(
    "../src/web/public/components/replay-timeline.js"
  )

  const mirrorFixtures: Array<{
    fixtureName: string
    messageRecords: WireTokenFixtureMessage[]
  }> = [
    {
      fixtureName: "mixed cache read / write / input across two steps",
      messageRecords: [
        assistantMessageWithTokens(100, 500, 900, 50),
        userTextMessage(),
        assistantMessageWithTokens(200, 300, 100, 0),
      ],
    },
    {
      fixtureName: "no cache writes",
      messageRecords: [assistantMessageWithTokens(50, 10, 950, 0)],
    },
    {
      fixtureName: "assistant step without a tokens block contributes nothing",
      messageRecords: [
        {
          type: "assistant",
          timeCreated: 1000,
          seq: 1,
          id: "msg_no_tokens",
          sessionId: "ses_fixture",
          data: { text: "no tokens here" },
        },
        assistantMessageWithTokens(10, 5, 30, 10),
      ],
    },
  ]

  for (const mirrorFixture of mirrorFixtures) {
    let cacheReadTotal = 0
    let paidInputTotal = 0
    let cacheWriteTotal = 0
    for (const fixtureMessage of mirrorFixture.messageRecords) {
      if (fixtureMessage.type !== "assistant") continue
      const fixtureData = fixtureMessage.data as Record<string, unknown>
      const tokensRecord = fixtureData?.tokens as Record<string, number> | undefined
      const cacheRecord = tokensRecord?.cache as Record<string, number> | undefined
      cacheReadTotal += cacheRecord?.read ?? 0
      paidInputTotal += tokensRecord?.input ?? 0
      cacheWriteTotal += cacheRecord?.write ?? 0
    }

    assert.equal(
      summarizeStrictHitRate(mirrorFixture.messageRecords),
      strictHitRate(cacheReadTotal, paidInputTotal, cacheWriteTotal),
      `fixture "${mirrorFixture.fixtureName}" must agree on both sides of the mirror`,
    )
  }

  // Boundary: an empty token stream. The frontend returns null (the
  // caller omits the metric); the backend formula answers 0. Both are
  // "no usage" — locked explicitly so a future change on either side
  // cannot silently diverge.
  assert.equal(summarizeStrictHitRate([userTextMessage()]), null)
  assert.equal(strictHitRate(0, 0, 0), 0)
})

/* --------------------- directory-panel component --------------------- */

test("renderDirectoryPanel escapes the directory and display name at both the text and title insertion points", async () => {
  const { renderDirectoryPanel } = await import(
    "../src/web/public/components/directory-panel.js"
  )
  const { escapeHtml, pathLastSegment } = await import("../src/web/public/format.js")
  const container = freshContainer()

  const hostileDirectoryPath = 'D:/evil"><script>alert(1)</script>'
  const hostileDisplayName = "<img onerror=alert(2)>"
  renderDirectoryPanel(container, {
    totalDirectories: 2,
    totalSessions: 3,
    directories: [
      {
        directory: hostileDirectoryPath,
        name: hostileDisplayName,
        sessions: 2,
        steps: 4,
        lastActiveMs: 1791297715295,
      },
      {
        // Empty name falls back to the frontend's own pathLastSegment.
        directory: "D:/fallback/example-fallback",
        name: "",
        sessions: 1,
        steps: 0,
        lastActiveMs: null,
      },
    ],
  })

  const renderedHtml = container.innerHTML
  // title attribute insertion point: the full hostile path, escaped.
  assert.ok(
    renderedHtml.includes(`title="${escapeHtml(hostileDirectoryPath)}"`),
    "the title attribute must carry the html-escaped directory path",
  )
  // Text insertion points: display name and full path, escaped.
  assert.ok(
    renderedHtml.includes(`>${escapeHtml(hostileDisplayName)}</span>`),
    "the display-name span must carry the html-escaped name",
  )
  assert.ok(renderedHtml.includes(escapeHtml(hostileDirectoryPath)))
  // Raw payloads never reach the DOM.
  assert.ok(!renderedHtml.includes("<script>alert(1)</script>"))
  assert.ok(!renderedHtml.includes("<img onerror=alert(2)>"))
  // Empty name → pathLastSegment fallback, rendered in the name span.
  assert.ok(
    renderedHtml.includes(
      `>${escapeHtml(pathLastSegment("D:/fallback/example-fallback"))}</span>`,
    ),
    "a missing name falls back to the frontend's own last-segment derivation",
  )
  // Bar widths: top row fills the track; the zero-step row keeps the 2% floor.
  assert.ok(renderedHtml.includes("width:100.0%"))
  assert.ok(renderedHtml.includes("width:2.0%"))
  assert.match(
    renderedHtml,
    /共 <b class="num">2<\/b> 个目录 · <b class="num">3<\/b> 个会话/,
  )
})

test("renderDirectoryPanel degrades null and empty listings to the empty placeholder", async () => {
  const { renderDirectoryPanel } = await import(
    "../src/web/public/components/directory-panel.js"
  )

  const nullContainer = freshContainer()
  renderDirectoryPanel(nullContainer, null)
  assert.match(nullContainer.innerHTML, /还没有目录统计/)

  const emptyContainer = freshContainer()
  renderDirectoryPanel(emptyContainer, {
    totalDirectories: 0,
    totalSessions: 0,
    directories: [],
  })
  assert.match(emptyContainer.innerHTML, /还没有目录统计/)

  // A non-zero total with an empty list still degrades — the listing
  // drives the placeholder, not the totals.
  const ghostTotalContainer = freshContainer()
  renderDirectoryPanel(ghostTotalContainer, {
    totalDirectories: 3,
    totalSessions: 5,
    directories: [],
  })
  assert.match(ghostTotalContainer.innerHTML, /还没有目录统计/)
})

test("renderDirectoryPanel renders the v0.15.0 入/出 columns with KPI-aligned titles and the cross-calibration caveat", async () => {
  const { renderDirectoryPanel } = await import(
    "../src/web/public/components/directory-panel.js"
  )
  const container = freshContainer()

  renderDirectoryPanel(container, {
    totalDirectories: 2,
    totalSessions: 3,
    directories: [
      {
        directory: "D:/projects/example-alpha",
        name: "example-alpha",
        sessions: 2,
        steps: 4,
        tokensInput: 2_400_000,
        tokensOutput: 120_000,
        tokensCacheRead: 4_800_000,
        lastActiveMs: null,
      },
      {
        // Zero-token directory: honest "0" in both new columns — token zero
        // is real data, not a "not recorded" degradation.
        directory: "D:/projects/example-beta",
        name: "example-beta",
        sessions: 1,
        steps: 0,
        tokensInput: 0,
        tokensOutput: 0,
        tokensCacheRead: 0,
        lastActiveMs: null,
      },
    ],
  })

  const renderedHtml = container.innerHTML
  // Column order: the 入/出 pair sits between 步骤 and 最近活跃 — the same
  // token-metrics grouping as the v0.13.0 session-list columns.
  assert.match(
    renderedHtml,
    /步骤<\/span>[\s\S]*?>入<\/span>[\s\S]*?>出<\/span>[\s\S]*?<span>最近活跃<\/span>/,
    "the head row must order 目录/会话/步骤/入/出/最近活跃",
  )
  // Head tooltips: calibration mirrors the session-list wording, plus the
  // directory-specific reconciliation caveat (session-level aggregation,
  // ~0.36% system gap, empty-directory sessions excluded → Σ ≠ 全库 KPI).
  assert.ok(
    renderedHtml.includes('title="入 = 纯输入 tokens.input（不含 cache.read，与 KPI 卡「入」同口径）· 目录聚合为会话级汇总，与消息级统计存在约 0.36% 系统差 · 无目录的会话不计入，各目录相加不等于全库">入</span>'),
    "the 入 header states the pure-input calibration and the cross-calibration caveat",
  )
  assert.ok(
    renderedHtml.includes('title="出 = tokens.output（与 KPI 卡「出」同口径）· 目录聚合为会话级汇总（v2）">出</span>'),
    "the 出 header states the output calibration",
  )
  // Cells: formatTokens on the raw values in the .num slot; cache.read is
  // reported as the breakdown hint inside the 入 cell title (not folded in).
  assert.ok(
    renderedHtml.includes('<span class="directory-count num" title="入 = 纯输入 tokens.input · cache.read 4.8M 另计 · 与 KPI 卡「入」同口径">2.4M</span>'),
    "the 入 cell renders formatTokens(tokensInput) with the cache.read breakdown in its title",
  )
  assert.ok(
    renderedHtml.includes('<span class="directory-count num" title="出 = tokens.output · 与 KPI 卡「出」同口径">120K</span>'),
    "the 出 cell renders formatTokens(tokensOutput) with the KPI-alignment title",
  )
  assert.ok(
    renderedHtml.includes('<span class="directory-count num" title="入 = 纯输入 tokens.input · cache.read 0 另计 · 与 KPI 卡「入」同口径">0</span>'),
    "a zero-token directory renders an honest 0 in the 入 column",
  )
})

test("renderDirectoryPanel falls back to 0 for wire rows missing the three token fields (v0.15.0 window)", async () => {
  const { renderDirectoryPanel } = await import(
    "../src/web/public/components/directory-panel.js"
  )
  const container = freshContainer()

  // Old wire (pre-v0.15.0 hosts) serves rows without the token fields: the
  // render must not crash, and both new columns read an honest 0. The 入 cell
  // title must not fabricate a cache.read value it does not know.
  renderDirectoryPanel(container, {
    totalDirectories: 1,
    totalSessions: 2,
    directories: [
      { directory: "D:/projects/example-alpha", name: "example-alpha", sessions: 2, steps: 4, lastActiveMs: null },
    ],
  })

  const renderedHtml = container.innerHTML
  assert.ok(
    renderedHtml.includes('<span class="directory-count num" title="入 = 纯输入 tokens.input · cache.read 另计 · 与 KPI 卡「入」同口径">0</span>'),
    "missing tokensInput falls back to 0 and the title drops the unknown cache.read value",
  )
  assert.ok(
    renderedHtml.includes('<span class="directory-count num" title="出 = tokens.output · 与 KPI 卡「出」同口径">0</span>'),
    "missing tokensOutput falls back to an honest 0",
  )
  assert.ok(
    !renderedHtml.includes("cache.read 0 另计"),
    "an unknown cache.read must not be presented as a known 0",
  )
  // The drill-down interaction stays intact on the fallback wire.
  const selectionEvents: Array<string | null> = []
  renderDirectoryPanel(container, {
    totalDirectories: 1,
    totalSessions: 2,
    directories: [
      { directory: "D:/projects/example-alpha", name: "example-alpha", sessions: 2, steps: 4, lastActiveMs: null },
    ],
  }, null, (directoryPath) => selectionEvents.push(directoryPath))
  assert.ok(container.querySelectorAll(".directory-row.selectable").length > 0)
  assert.equal(container.querySelectorAll(".directory-row").length, 1)
})

test("getMockDirectoryStats mirrors the v0.15.0 three-part token wire with cross-view conservation", async () => {
  const { getMockDirectoryStats, getMockTrend, CALENDAR_DAYS } = await import(
    "../src/web/public/mock-data.js"
  )

  const directoryPage = getMockDirectoryStats()
  assert.ok(directoryPage.directories.length > 0, "the mock directory pool must be non-empty")

  for (const directoryEntry of directoryPage.directories) {
    for (const partValue of [
      directoryEntry.tokensInput as number,
      directoryEntry.tokensOutput as number,
      directoryEntry.tokensCacheRead as number,
    ]) {
      assert.ok(
        Number.isInteger(partValue) && partValue >= 0,
        `token parts must be non-negative integers for ${directoryEntry.directory}`,
      )
    }
    // Largest-remainder allocation never produces negative output rebates.
    assert.ok(
      (directoryEntry.tokensOutput as number) >= 0,
      `output must never be negative for ${directoryEntry.directory}`,
    )
  }

  // Cross-view conservation (hour-heatmap discipline): each part summed over
  // the directories must equal the same part summed over the daily series
  // that getMockTrend(366) serves — per-day largest-remainder allocation
  // conserves exactly, so the totals match to the token.
  const trendPoints = getMockTrend(CALENDAR_DAYS) as Array<{ input: number; read: number; output: number }>
  const trendPartTotals = trendPoints.reduce(
    (partTotals, trendPoint) => ({
      input: partTotals.input + trendPoint.input,
      read: partTotals.read + trendPoint.read,
      output: partTotals.output + trendPoint.output,
    }),
    { input: 0, read: 0, output: 0 },
  )
  const directoryPartTotals = directoryPage.directories.reduce(
    (partTotals, directoryEntry) => ({
      input: partTotals.input + (directoryEntry.tokensInput as number),
      read: partTotals.read + (directoryEntry.tokensCacheRead as number),
      output: partTotals.output + (directoryEntry.tokensOutput as number),
    }),
    { input: 0, read: 0, output: 0 },
  )
  assert.equal(directoryPartTotals.input, trendPartTotals.input, "Σ directories tokensInput must equal the trend input total")
  assert.equal(directoryPartTotals.read, trendPartTotals.read, "Σ directories tokensCacheRead must equal the trend cache-read total")
  assert.equal(directoryPartTotals.output, trendPartTotals.output, "Σ directories tokensOutput must equal the trend output total")
})

test("pathLastSegment mirrors the backend directoryDisplayName value for value", async () => {
  const { pathLastSegment } = await import("../src/web/public/format.js")

  // Fixed samples spanning every derivation face: drive-root style,
  // trailing separator, both separators mixed, backslash-only, no
  // extractable segment (fallback to the original), and the empty path.
  const paritySamples: Array<{ directoryPath: string; expectedName: string }> = [
    { directoryPath: "C:/Users/example-user", expectedName: "example-user" },
    { directoryPath: "D:/work/", expectedName: "work" },
    { directoryPath: "D:/mixed\\path/parts", expectedName: "parts" },
    { directoryPath: "D:\\projects\\example-beta", expectedName: "example-beta" },
    { directoryPath: "///", expectedName: "///" },
    { directoryPath: "", expectedName: "" },
  ]

  for (const paritySample of paritySamples) {
    assert.equal(
      pathLastSegment(paritySample.directoryPath),
      directoryDisplayName(paritySample.directoryPath),
      `frontend and backend must agree on "${paritySample.directoryPath}"`,
    )
    // Hardcoded anchors: a silent co-drift of both implementations
    // still fails against the expected values.
    assert.equal(
      directoryDisplayName(paritySample.directoryPath),
      paritySample.expectedName,
      `backend derivation of "${paritySample.directoryPath}"`,
    )
  }
})

/* --------------------- session-list component --------------------- */

/**
 * Session-list header sorting (v0.5.0 wiring of the v0.2-B server-side
 * sort contract). Fixture summaries are fictional placeholders from the
 * example-alpha series (发布清单 #3) — total: null is the real-source
 * shape (normalizeSessionPage), which is what drives the sort footnote.
 */
interface SessionListFixtureSummary {
  id: string
  title: string
  modelId: string
  agent: string
  directory: string
  timeCreated: number
  timeUpdated: number
  tokens: number
  cost: number
  /** v0.13.0 三分指标：可选以覆盖宿主更新窗口期的旧 wire（缺字段 → 0 兜底）。 */
  tokensInput?: number
  tokensOutput?: number
  tokensCacheRead?: number
  /**
   * v0.19.0 下钻口径：会话内 step 级出现过的模型 id 集合。可选以模拟
   * 旧宿主 wire（缺字段 → 组件回退 modelId 启动模型精确匹配）。
   */
  modelIds?: string[]
}

function sessionSortFixturePayload(): { total: null; sessions: SessionListFixtureSummary[] } {
  return {
    total: null,
    sessions: [
      { id: "ses_example_alpha", title: "alpha fixture", modelId: "glm-5.3", agent: "build", directory: "D:/projects/example-alpha", timeCreated: 1000, timeUpdated: 5000, tokens: 1500, cost: 1.0 },
      { id: "ses_example_bravo", title: "bravo fixture", modelId: "glm-5.3", agent: "plan", directory: "D:/projects/example-alpha", timeCreated: 2000, timeUpdated: 9000, tokens: 600, cost: 2.5 },
      { id: "ses_example_charlie", title: "charlie fixture", modelId: "claude-sonnet-4.6", agent: "build", directory: "D:/projects/example-alpha", timeCreated: 3000, timeUpdated: 7000, tokens: 900, cost: 0.5 },
    ],
  }
}

test("renderSessionList renders sortable headers, keeps wire order and states the active sort in the footnote", async () => {
  const { renderSessionList } = await import("../src/web/public/components/session-list.js")
  const container = freshContainer()

  // Default state (time_updated desc — the wire default). Since v0.6.0 the
  // default key has its own visible column (更新时间), so the initial
  // render marks that header sorted with the desc arrow; the footnote
  // still names the server sort as plain text (no reset entry).
  const noopSortChange = () => {}
  renderSessionList(container, sessionSortFixturePayload(), null, "time_updated", "desc", noopSortChange)
  const sortableHeaders = container.querySelectorAll("th.sortable")
  assert.equal(sortableHeaders.length, 5, "title / created-time / updated-time / tokens / cost columns are sortable")
  assert.deepEqual(
    sortableHeaders.map((headerCell) => headerCell.dataset.sortKey),
    ["title", "time_created", "time_updated", "tokens", "cost"],
    "every backend ?sort= whitelist key maps to exactly one visible column header",
  )
  const defaultSortedHeaders = container.querySelectorAll("th.sorted")
  assert.equal(defaultSortedHeaders.length, 1, "the default sort marks exactly its own column")
  assert.equal(defaultSortedHeaders[0].dataset.sortKey, "time_updated")
  assert.match(container.innerHTML, /更新时间\s*<span class="sort-arrow">▼<\/span>/)
  assert.match(container.innerHTML, /按最近更新时间倒序/)
  // No client-side re-sorting: rows render in the payload (server) order.
  assert.deepEqual(
    container.querySelectorAll("tr.session-row").map((row) => row.dataset.sessionId),
    ["ses_example_alpha", "ses_example_bravo", "ses_example_charlie"],
  )

  // tokens desc: the tokens header carries the sorted marker and arrow.
  renderSessionList(container, sessionSortFixturePayload(), null, "tokens", "desc", noopSortChange)
  const tokensHeader = container
    .querySelectorAll("th.sorted")
    .find((headerCell) => headerCell.dataset.sortKey === "tokens")!
  assert.ok(tokensHeader.classTokenList().includes("sortable"), "the sorted column is a sortable header")
  assert.match(container.innerHTML, /Tokens\s*<span class="sort-arrow">▼<\/span>/)
  assert.match(container.innerHTML, /按token 用量倒序/)

  // title asc: the arrow flips and the footnote follows.
  renderSessionList(container, sessionSortFixturePayload(), null, "title", "asc", noopSortChange)
  assert.match(container.innerHTML, /标题\s*<span class="sort-arrow">▲<\/span>/)
  assert.match(container.innerHTML, /按标题正序/)
})

test("renderSessionList renders the updated-time and cost cells and routes their header clicks (v0.6.0 columns)", async () => {
  const { renderSessionList } = await import("../src/web/public/components/session-list.js")
  const { formatDateTime, formatRelative } = await import("../src/web/public/format.js")
  const container = freshContainer()
  const sortChangeCalls: Array<{ sortKey: string; sortOrder: string }> = []
  const captureSortChange = (nextSortKey: string, nextSortOrder: string) => {
    sortChangeCalls.push({ sortKey: nextSortKey, sortOrder: nextSortOrder })
  }

  // Three rows with distinct epochs and cost faces: a real cost, the
  // DB-typical zero cost (DESIGN §5: cost is usually 0 → degraded "—"),
  // and a sub-cent cost that rounds to zero (0.6.0 review P2-1: must
  // degrade like exact zero instead of rendering "$0").
  const newColumnPayload = {
    total: null as const,
    sessions: [
      { id: "ses_example_delta", title: "delta fixture", modelId: "glm-5.3", agent: "build", directory: "D:/projects/example-alpha", timeCreated: 1000, timeUpdated: 61_000, tokens: 900, cost: 2.5 },
      { id: "ses_example_echo", title: "echo fixture", modelId: "glm-5.3", agent: "plan", directory: "D:/projects/example-alpha", timeCreated: 2000, timeUpdated: 130_000, tokens: 300, cost: 0 },
      { id: "ses_example_foxtrot", title: "foxtrot fixture", modelId: "glm-5.3", agent: "plan", directory: "D:/projects/example-alpha", timeCreated: 3000, timeUpdated: 150_000, tokens: 500, cost: 0.004 },
    ],
  }

  renderSessionList(container, newColumnPayload, null, "time_updated", "desc", captureSortChange)

  // Updated-time cell: same formatting contract as the created-time column —
  // relative display + full datetime title. The 1970 epochs are far older
  // than a day, so formatRelative degrades to the deterministic MM-dd form.
  assert.ok(
    container.innerHTML.includes(
      `<td class="num" title="${formatDateTime(61_000)}">${formatRelative(61_000)}</td>`,
    ),
    "the updated-time cell must mirror the created-time formatting exactly",
  )

  // Cost cell: KPI-card convention ($ + raw value) for a real cost, and the
  // hitRateCell-style "—" degradation with an explanatory title for 0.
  assert.ok(container.innerHTML.includes("<td class=\"num\">$2.5</td>"), "a real cost renders as $ + raw value")
  assert.ok(
    container.innerHTML.includes("无成本记录（本库 cost 字段常为 0，DESIGN §5）"),
    "zero cost degrades to — with the not-recorded explanation",
  )
  assert.ok(
    container.innerHTML.includes("<td class=\"num\"><span title=\"无成本记录（本库 cost 字段常为 0，DESIGN §5）\">—</span></td>"),
    "the degraded cost cell keeps its numeric alignment slot",
  )
  assert.ok(
    !container.innerHTML.includes("$0"),
    "a sub-cent cost (0.004) rounds to zero and degrades like exact zero — never \"$0\" (0.6.0 review P2-1)",
  )

  // Header clicks on the two new columns:
  // - time_updated is the default-sorted column, so its first click flips
  //   the direction (same-key toggle contract);
  // - cost is a fresh column, so its first click starts at desc.
  const clickHeader = (sortKeyValue: string) => {
    const headerCell = container
      .querySelectorAll("th.sortable")
      .find((sortableHeader) => sortableHeader.dataset.sortKey === sortKeyValue)!
    headerCell.click()
  }
  clickHeader("time_updated")
  clickHeader("cost")
  assert.deepEqual(sortChangeCalls, [
    { sortKey: "time_updated", sortOrder: "asc" },
    { sortKey: "cost", sortOrder: "desc" },
  ])
})

test("renderSessionList renders the v0.13.0 入/出 columns beside the folded Tokens total (KPI-aligned, non-sortable)", async () => {
  const { renderSessionList } = await import("../src/web/public/components/session-list.js")
  const container = freshContainer()
  const noopSortChange = () => {}

  // KPI-aligned breakdown: 入 = pure paid input (tokens.input, cache.read
  // excluded), 出 = tokens.output, folded total = 入 + 出 + cache.read.
  const breakdownPayload = {
    total: null as const,
    sessions: [
      {
        id: "ses_example_golf", title: "golf fixture", modelId: "glm-5.3", agent: "build",
        directory: "D:/projects/example-alpha", timeCreated: 1000, timeUpdated: 5000,
        tokens: 900, cost: 1.0, tokensInput: 90, tokensOutput: 45, tokensCacheRead: 765,
      },
    ],
  }

  renderSessionList(container, breakdownPayload, null, "time_updated", "desc", noopSortChange)

  // Nine headers total; the sortable set is still exactly the five backend
  // whitelist keys — the new columns join the non-sortable display columns.
  assert.equal(container.querySelectorAll("th").length, 9, "the session table now has nine columns")
  assert.deepEqual(
    container.querySelectorAll("th.sortable").map((headerCell) => headerCell.dataset.sortKey),
    ["title", "time_created", "time_updated", "tokens", "cost"],
    "the 入/出 columns must not add server-sort keys (whitelist unchanged)",
  )

  // Column order: the 入/出 pair sits between 更新时间 and the folded Tokens
  // total — parts adjacent to their sum, Cost stays last.
  assert.match(
    container.innerHTML,
    /更新时间[\s\S]*?>\s*入\s*<\/th>[\s\S]*?>\s*出\s*<\/th>[\s\S]*?>\s*Tokens\s*<\/th>[\s\S]*?>\s*Cost\s*<\/th>/,
    "入/出 must render between the updated-time column and the folded Tokens total",
  )

  // Non-sortable headers carry the calibration tooltip instead of 点击排序.
  const inputHeader = container.querySelectorAll("th").find(
    (headerCell) => (headerCell.attributes.get("title") ?? "").startsWith("入 = "),
  )!
  const outputHeader = container.querySelectorAll("th").find(
    (headerCell) => (headerCell.attributes.get("title") ?? "").startsWith("出 = "),
  )!
  assert.ok(!("sortKey" in inputHeader.dataset), "the 入 header must not carry a sort key")
  assert.ok(!("sortKey" in outputHeader.dataset), "the 出 header must not carry a sort key")
  assert.match(inputHeader.attributes.get("title") ?? "", /不含 cache\.read/, "the 入 header states the pure-input calibration")
  assert.match(outputHeader.attributes.get("title") ?? "", /tokens\.output/, "the 出 header states the output calibration")

  // Cells: formatTokens on the raw values, aligned to the .num slot.
  assert.ok(
    container.innerHTML.includes('<td class="num" title="入 = 纯输入 tokens.input · cache.read 另计 · 与 KPI 卡「入」同口径">90</td>'),
    "the 入 cell renders formatTokens(tokensInput) with the KPI-alignment tooltip",
  )
  assert.ok(
    container.innerHTML.includes('<td class="num" title="出 = tokens.output · 与 KPI 卡「出」同口径">45</td>'),
    "the 出 cell renders formatTokens(tokensOutput) with the KPI-alignment tooltip",
  )
  // The folded total stays the .primary column; cache.read is reported as the
  // breakdown hint in its title (not folded into 入).
  assert.ok(
    container.innerHTML.includes('<td class="num primary" title="总量 = 入 + 出 + cache.read（本会话 cache.read 765）">900</td>'),
    "the Tokens total keeps its folded value and reports cache.read in its title",
  )
})

test("renderSessionList falls back to 0 for window-period wire missing the three token fields (v0.13.0)", async () => {
  const { renderSessionList } = await import("../src/web/public/components/session-list.js")
  const container = freshContainer()

  // v0.13.0 ship window: hosts may serve the old wire without the three
  // fields — render must not crash and must show an honest 0. A tokens=0
  // session renders "0" in every token column: token zero is real data, not
  // the cost column's "not recorded" degradation.
  const legacyWirePayload = {
    total: null as const,
    sessions: [
      { id: "ses_example_hotel", title: "hotel fixture", modelId: "glm-5.3", agent: "build", directory: "D:/projects/example-alpha", timeCreated: 1000, timeUpdated: 5000, tokens: 1200, cost: 1.0 },
      { id: "ses_example_india", title: "india fixture", modelId: "glm-5.3", agent: "plan", directory: "D:/projects/example-alpha", timeCreated: 2000, timeUpdated: 9000, tokens: 0, cost: 0 },
    ],
  }

  renderSessionList(container, legacyWirePayload, null, "time_updated", "desc", null)

  assert.ok(
    container.innerHTML.includes('<td class="num" title="入 = 纯输入 tokens.input · cache.read 另计 · 与 KPI 卡「入」同口径">0</td>'),
    "missing tokensInput falls back to an honest 0 in the 入 column",
  )
  assert.ok(
    container.innerHTML.includes('<td class="num" title="出 = tokens.output · 与 KPI 卡「出」同口径">0</td>'),
    "missing tokensOutput falls back to an honest 0 in the 出 column",
  )
  // Unknown cache.read: the total title states the formula without a
  // fabricated per-session value.
  assert.ok(
    container.innerHTML.includes('<td class="num primary" title="总量 = 入 + 出 + cache.read">0</td>'),
    "a tokens=0 session renders an honest 0 total (no cost-style — degradation)",
  )
  assert.ok(
    container.innerHTML.includes('<td class="num primary" title="总量 = 入 + 出 + cache.read">1.2K</td>'),
    "the legacy row keeps its folded total while the new columns read 0",
  )
})

test("getMockSessions mirrors the v0.13.0 three-field breakdown with parts summing to the folded total", async () => {
  const { getMockSessions } = await import("../src/web/public/mock-data.js")

  const unfilteredPage = getMockSessions()
  assert.ok(unfilteredPage.sessions.length > 0, "the mock session pool must be non-empty")
  for (const sessionSummary of unfilteredPage.sessions) {
    const partValues = [
      sessionSummary.tokensInput as number,
      sessionSummary.tokensOutput as number,
      sessionSummary.tokensCacheRead as number,
    ]
    for (const partValue of partValues) {
      assert.ok(
        Number.isInteger(partValue) && partValue >= 0,
        `token parts must be non-negative integers for ${sessionSummary.id}`,
      )
    }
    assert.ok(
      partValues[0] + partValues[1] + partValues[2] === sessionSummary.tokens,
      `入 + 出 + cache.read must equal the folded total for ${sessionSummary.id} (tokenShare-style conservation)`,
    )
    // KPI-aligned shape: cache.read carries the bulk, paid input is the
    // cache-excluded remainder — mirrors the daily-series generation law.
    assert.ok(
      sessionSummary.tokensCacheRead > sessionSummary.tokensInput,
      `cache.read should dominate over paid input for ${sessionSummary.id}`,
    )
  }

  // Filtered pages serve the same objects → the same discipline holds there.
  const firstDirectory = unfilteredPage.sessions[0].directory as string
  const filteredPage = getMockSessions("time_updated", "desc", firstDirectory)
  for (const sessionSummary of filteredPage.sessions) {
    assert.ok(
      (sessionSummary.tokensInput as number) + (sessionSummary.tokensOutput as number)
        + (sessionSummary.tokensCacheRead as number) === sessionSummary.tokens,
      `filtered pages keep the parts-sum conservation for ${sessionSummary.id}`,
    )
  }
})

test("getMockSessions tokensOutput never goes negative and keeps the loose conservation bound under the clamp", async () => {
  const { getMockSessions } = await import("../src/web/public/mock-data.js")

  // The session-side three-part derivation clamps output at 0 (ora-7 P2:
  // Math.round double-half rounding can push the remainder negative —
  // unreachable under the current deterministic SEED, never fixed until
  // the clamp). Mock semantics under the clamp: output ≥ 0, and because
  // a clamped output no longer absorbs the rounding overshoot, the parts
  // may sum to LESS than the folded total — the loose bound
  // input+output+cacheRead ≤ tokens. Under the current SEED the clamp
  // never fires, so the strict equality locked by the test above still
  // holds; this test pins the looser invariant so a SEED change cannot
  // smuggle a negative output back in under the name of conservation.
  const unfilteredPage = getMockSessions()
  for (const sessionSummary of unfilteredPage.sessions) {
    const tokensOutputValue = sessionSummary.tokensOutput as number
    const partsTotal = (sessionSummary.tokensInput as number) + tokensOutputValue
      + (sessionSummary.tokensCacheRead as number)
    assert.ok(
      tokensOutputValue >= 0,
      `tokensOutput must never be negative for ${sessionSummary.id}`,
    )
    assert.ok(
      partsTotal <= sessionSummary.tokens,
      `input + output + cache.read must never exceed the folded total for ${sessionSummary.id}`,
    )
  }
})

test("renderSessionList header clicks emit the server-sort callback and flip direction on repeat", async () => {
  const { renderSessionList } = await import("../src/web/public/components/session-list.js")
  const container = freshContainer()
  const sortChangeCalls: Array<{ sortKey: string; sortOrder: string }> = []
  const captureSortChange = (nextSortKey: string, nextSortOrder: string) => {
    sortChangeCalls.push({ sortKey: nextSortKey, sortOrder: nextSortOrder })
  }

  const clickHeader = (sortKeyValue: string) => {
    const headerCell = container
      .querySelectorAll("th.sortable")
      .find((sortableHeader) => sortableHeader.dataset.sortKey === sortKeyValue)!
    headerCell.click()
  }

  // From the default state, a new column starts at desc (model-table contract).
  renderSessionList(container, sessionSortFixturePayload(), null, "time_updated", "desc", captureSortChange)
  clickHeader("tokens")

  // The app re-renders with the new sort before the next click; a repeat
  // click on the same column flips the direction.
  renderSessionList(container, sessionSortFixturePayload(), null, "tokens", "desc", captureSortChange)
  clickHeader("tokens")
  renderSessionList(container, sessionSortFixturePayload(), null, "tokens", "asc", captureSortChange)
  clickHeader("tokens")

  // Switching to a different column while sorted on another starts at desc.
  renderSessionList(container, sessionSortFixturePayload(), null, "tokens", "asc", captureSortChange)
  clickHeader("title")

  assert.deepEqual(sortChangeCalls, [
    { sortKey: "tokens", sortOrder: "desc" },
    { sortKey: "tokens", sortOrder: "asc" },
    { sortKey: "tokens", sortOrder: "desc" },
    { sortKey: "title", sortOrder: "desc" },
  ])

  // Without a callback the headers stay inert — render must not throw and
  // no interaction class is bound (pure display usage).
  const displayOnlyContainer = freshContainer()
  renderSessionList(displayOnlyContainer, sessionSortFixturePayload(), null)
  assert.equal(displayOnlyContainer.querySelectorAll("th.sortable").length, 0)
})

test("getMockSessions mirrors the backend sort whitelist, fallback and id ASC tie-break", async () => {
  const { getMockSessions } = await import("../src/web/public/mock-data.js")

  const sessionIds = (sortKeyValue?: string, sortOrderValue?: string) =>
    getMockSessions(sortKeyValue, sortOrderValue).sessions.map((sessionSummary) => sessionSummary.id)
  const sessionSummaries = (sortKeyValue?: string, sortOrderValue?: string) =>
    getMockSessions(sortKeyValue, sortOrderValue).sessions

  // The mock's own default must be the contract default: time_updated desc.
  const defaultSummaries = sessionSummaries()
  const defaultIds = defaultSummaries.map((sessionSummary) => sessionSummary.id)
  for (let sessionIndex = 1; sessionIndex < defaultSummaries.length; sessionIndex += 1) {
    assert.ok(
      defaultSummaries[sessionIndex - 1].timeUpdated >= defaultSummaries[sessionIndex].timeUpdated,
      "the mock default must order by time_updated desc",
    )
  }

  // Degrade-not-reject: non-whitelisted, hostile and prototype-chain keys
  // all fall back to the default order (mirrors resolveSessionSortKey).
  for (const hostileSortValue of [
    "unknown_sort_key",
    "; DROP TABLE session_v2 --",
    "toString",
    "__proto__",
    "constructor",
  ]) {
    assert.deepEqual(
      sessionSummaries(hostileSortValue, "upside-down"),
      defaultSummaries,
      `${hostileSortValue} must degrade to the default mock order`,
    )
  }
  assert.deepEqual(sessionSummaries(undefined, undefined), defaultSummaries)

  // Whitelisted combinations really change the order and follow direction.
  assert.notDeepEqual(sessionIds("time_created", "asc"), defaultIds)
  const tokensDescSummaries = sessionSummaries("tokens", "desc")
  for (let sessionIndex = 1; sessionIndex < tokensDescSummaries.length; sessionIndex += 1) {
    assert.ok(
      tokensDescSummaries[sessionIndex - 1].tokens >= tokensDescSummaries[sessionIndex].tokens,
      "tokens desc must be non-increasing",
    )
  }

  // title asc orders by code-unit comparison (≈ SQLite BINARY), and the
  // repeated pool titles (48 sessions over 30 titles) tie-break by id ASC
  // exactly like the backend's ORDER BY …, id ASC.
  const titleAscSummaries = sessionSummaries("title", "asc")
  for (let sessionIndex = 1; sessionIndex < titleAscSummaries.length; sessionIndex += 1) {
    assert.ok(
      titleAscSummaries[sessionIndex - 1].title <= titleAscSummaries[sessionIndex].title,
      "title asc must be code-unit non-decreasing",
    )
    if (titleAscSummaries[sessionIndex - 1].title === titleAscSummaries[sessionIndex].title) {
      assert.ok(
        titleAscSummaries[sessionIndex - 1].id < titleAscSummaries[sessionIndex].id,
        "title ties must break by id ASC like the backend",
      )
    }
  }

  // Sorting works on a copy: the shared base payload keeps its order
  // (compaction topSessions and the id lookup reuse it).
  const firstRequestSummaries = getMockSessions("tokens", "asc").sessions
  const secondRequestSummaries = getMockSessions("title", "desc").sessions
  assert.ok(
    firstRequestSummaries !== secondRequestSummaries,
    "each request must return its own sorted copy",
  )
  assert.deepEqual(getMockSessions("tokens", "asc").sessions, firstRequestSummaries)
})

test("renderSessionList falls back to the default sort label for prototype-chain sort keys (P2-1)", async () => {
  const { renderSessionList } = await import("../src/web/public/components/session-list.js")

  // The component is an exported function — sortKey cannot be assumed to
  // come from the whitelist. A plain ?? lookup resolves prototype-chain
  // keys ("toString" etc.) to an inherited function and would stringify
  // it into the footnote. hasOwn must gate the label lookup.
  for (const hostileSortKey of ["toString", "__proto__", "constructor"]) {
    const hostileContainer = freshContainer()
    renderSessionList(hostileContainer, sessionSortFixturePayload(), null, hostileSortKey, "desc", null)
    assert.match(
      hostileContainer.innerHTML,
      /按最近更新时间倒序/,
      `${hostileSortKey} must render the default sort label`,
    )
    assert.ok(
      !hostileContainer.innerHTML.includes("[native code]"),
      `${hostileSortKey} must never stringify an inherited function into the footnote`,
    )
    assert.equal(
      hostileContainer.querySelectorAll("th.sorted").length,
      0,
      `${hostileSortKey} matches no visible column, so no sorted marker`,
    )
  }
})

test("the footnote sort description doubles as a reset entry back to the default sort (P2-3)", async () => {
  const { renderSessionList } = await import("../src/web/public/components/session-list.js")
  const sortChangeCalls: Array<{ sortKey: string; sortOrder: string }> = []
  const captureSortChange = (nextSortKey: string, nextSortOrder: string) => {
    sortChangeCalls.push({ sortKey: nextSortKey, sortOrder: nextSortOrder })
  }

  // Non-default sort with an interactive callback → clickable reset entry.
  const sortedContainer = freshContainer()
  renderSessionList(sortedContainer, sessionSortFixturePayload(), null, "tokens", "desc", captureSortChange)
  assert.match(sortedContainer.innerHTML, /按token 用量倒序/)
  const resetEntry = sortedContainer.querySelector(".sort-reset")
  assert.notEqual(resetEntry, null, "a non-default sort exposes a reset entry in the footnote")
  resetEntry!.click()
  assert.deepEqual(sortChangeCalls, [
    { sortKey: "time_updated", sortOrder: "desc" },
  ], "clicking reset must emit the default sort combination through the shared callback")

  // Default state → the description stays plain text, no reset affordance.
  const defaultContainer = freshContainer()
  renderSessionList(defaultContainer, sessionSortFixturePayload(), null, "time_updated", "desc", captureSortChange)
  assert.match(defaultContainer.innerHTML, /按最近更新时间倒序/)
  assert.equal(
    defaultContainer.querySelector(".sort-reset"),
    null,
    "the default view must not show a reset entry",
  )

  // Display-only usage (no callback): a non-default sort shows the plain
  // description — never a styled, dead-end reset affordance.
  const displayOnlyContainer = freshContainer()
  renderSessionList(displayOnlyContainer, sessionSortFixturePayload(), null, "tokens", "desc", null)
  assert.match(displayOnlyContainer.innerHTML, /按token 用量倒序/)
  assert.equal(displayOnlyContainer.querySelector(".sort-reset"), null)
})

/* ------------- session-sort-controller race conditions (P2-2) ------------- */

/**
 * Deferred page-request harness: every fetchSessionsPage call parks in a
 * queue the test settles by hand, so response arrival order is fully
 * scripted. Payloads use fictional example-series fixtures only.
 * v0.7.0: requests carry the directory dimension of the cache key.
 * v0.9.0: requests carry the range dimension too.
 */
interface DeferredSessionPageRequest {
  sortKey: string
  sortOrder: string
  directory: string | null
  range: string
  resolve: (sessionPayload: { total: null; sessions: SessionListFixtureSummary[] }) => void
  reject: (error: Error) => void
}

function createDeferredSessionPageHarness() {
  const pendingRequests: DeferredSessionPageRequest[] = []
  const fetchSessionsPage = (sortKey: string, sortOrder: string, directory: string | null, range: string) =>
    new Promise<{ total: null; sessions: SessionListFixtureSummary[] }>((resolve, reject) => {
      pendingRequests.push({ sortKey, sortOrder, directory, range, resolve, reject })
    })
  return {
    fetchSessionsPage,
    pendingRequests,
    /** Settle request #index with a payload whose rows carry the marker title. */
    settleWithMarker: (requestIndex: number, markerTitle: string) => {
      pendingRequests[requestIndex].resolve({
        total: null,
        sessions: [{ ...sessionSortFixturePayload().sessions[0], title: markerTitle }],
      })
    },
    rejectWith: (requestIndex: number, errorMessage: string) => {
      pendingRequests[requestIndex].reject(new Error(errorMessage))
    },
  }
}

/** Let the controller's promise continuations (microtasks) drain before asserting. */
async function flushControllerMicrotasks() {
  await new Promise<void>((resolveFlush) => {
    setTimeout(resolveFlush, 0)
  })
}

test("session-sort-controller: a late response misses the DOM but still lands in its own cache slot", async () => {
  const { createSessionSortController } = await import(
    "../src/web/public/components/session-sort-controller.js"
  )
  const container = freshContainer()
  const harness = createDeferredSessionPageHarness()
  const sectionOutcomes: boolean[] = []
  const controller = createSessionSortController({
    containerElement: container,
    fetchSessionsPage: harness.fetchSessionsPage,
    getModelFilter: () => null,
    markSectionSucceeded: () => sectionOutcomes.push(true),
    markSectionFailed: () => sectionOutcomes.push(false),
  })

  controller.load() // request 0: time_updated desc
  controller.changeSort("tokens", "desc") // skeleton + request 1
  assert.equal(harness.pendingRequests.length, 2)

  // The stale request resolves first — its token no longer matches, so it
  // must not render, but its payload still enters the cache for its own
  // sort combination.
  harness.settleWithMarker(0, "late default marker")
  await flushControllerMicrotasks()
  assert.ok(
    !container.innerHTML.includes("late default marker"),
    "a late response for a superseded sort must not reach the DOM",
  )
  assert.equal(sectionOutcomes.length, 0, "the stale request must not report success")

  harness.settleWithMarker(1, "fresh tokens marker")
  await flushControllerMicrotasks()
  assert.ok(container.innerHTML.includes("fresh tokens marker"))
  assert.deepEqual(sectionOutcomes, [true], "only the fresh request reports success")

  // Cache proof: switching back to the default sort renders the parked
  // stale payload immediately — no third request is issued.
  controller.changeSort("time_updated", "desc")
  assert.equal(harness.pendingRequests.length, 2, "cache hit must not issue a new request")
  assert.ok(container.innerHTML.includes("late default marker"))
  assert.ok(!container.innerHTML.includes("fresh tokens marker"))
})

test("session-sort-controller: overlapping requests for the same sort keep only the latest token's render", async () => {
  const { createSessionSortController } = await import(
    "../src/web/public/components/session-sort-controller.js"
  )
  const container = freshContainer()
  const harness = createDeferredSessionPageHarness()
  const controller = createSessionSortController({
    containerElement: container,
    fetchSessionsPage: harness.fetchSessionsPage,
    getModelFilter: () => null,
  })

  controller.load() // request 0 (time_updated desc)
  controller.load() // request 1 — same sort combination, newer token
  assert.equal(harness.pendingRequests.length, 2)

  harness.settleWithMarker(0, "older duplicate marker")
  await flushControllerMicrotasks()
  assert.ok(!container.innerHTML.includes("older duplicate marker"))

  harness.settleWithMarker(1, "newer duplicate marker")
  await flushControllerMicrotasks()
  assert.ok(container.innerHTML.includes("newer duplicate marker"))
  assert.ok(!container.innerHTML.includes("older duplicate marker"))
})

test("session-sort-controller: a stale rejection is dropped, a fresh one renders the error state with retry", async () => {
  const { createSessionSortController } = await import(
    "../src/web/public/components/session-sort-controller.js"
  )
  const container = freshContainer()
  const harness = createDeferredSessionPageHarness()
  const sectionOutcomes: boolean[] = []
  const controller = createSessionSortController({
    containerElement: container,
    fetchSessionsPage: harness.fetchSessionsPage,
    getModelFilter: () => null,
    markSectionSucceeded: () => sectionOutcomes.push(true),
    markSectionFailed: () => sectionOutcomes.push(false),
  })

  controller.load() // request 0
  controller.changeSort("tokens", "desc") // request 1

  // The superseded request fails — dropped silently, no error state shown.
  harness.rejectWith(0, "stale request blew up")
  await flushControllerMicrotasks()
  assert.ok(!container.innerHTML.includes("stale request blew up"))
  assert.equal(sectionOutcomes.length, 0, "a stale rejection must not mark the section failed")

  // The current request fails — error state with a retry button appears.
  harness.rejectWith(1, "fresh request blew up")
  await flushControllerMicrotasks()
  assert.ok(container.innerHTML.includes("fresh request blew up"))
  assert.match(container.innerHTML, /这块数据没加载出来/)
  assert.deepEqual(sectionOutcomes, [false])

  const retryButton = container.querySelector(".retry-button")
  assert.notEqual(retryButton, null, "the error state exposes a retry button")
  retryButton!.click()
  const retryRequest = harness.pendingRequests[2]!
  assert.equal(harness.pendingRequests.length, 3, "retry re-issues the load for the current sort")
  assert.deepEqual(
    { sortKey: retryRequest.sortKey, sortOrder: retryRequest.sortOrder },
    { sortKey: "tokens", sortOrder: "desc" },
    "the retry requests the sort that was on screen when the error hit",
  )
})

/* ------------- directory drill-down (v0.7.0) ------------- */

test("session-sort-controller: directory drill-down gets its own cache slot and the guard validates the directory snapshot", async () => {
  const { createSessionSortController } = await import(
    "../src/web/public/components/session-sort-controller.js"
  )
  const container = freshContainer()
  const harness = createDeferredSessionPageHarness()
  const controller = createSessionSortController({
    containerElement: container,
    fetchSessionsPage: harness.fetchSessionsPage,
    getModelFilter: () => null,
  })

  controller.load() // request 0: time_updated desc, no directory
  controller.changeDirectory("D:/projects/example-alpha") // skeleton + request 1
  assert.equal(harness.pendingRequests.length, 2)
  assert.deepEqual(
    { sortKey: harness.pendingRequests[1]!.sortKey, sortOrder: harness.pendingRequests[1]!.sortOrder },
    { sortKey: "time_updated", sortOrder: "desc" },
    "drilling into a directory must keep the current sort (filters are orthogonal)",
  )
  assert.equal(harness.pendingRequests[1]!.directory, "D:/projects/example-alpha")

  // The stale no-directory response resolves first — dropped by its token,
  // but parked in its own cache slot.
  harness.settleWithMarker(0, "unfiltered late marker")
  await flushControllerMicrotasks()
  assert.ok(!container.innerHTML.includes("unfiltered late marker"))

  // Back to no directory is a pure cache hit (the slot was just filled), so
  // no new request and the load token does not move.
  controller.changeDirectory(null)
  assert.equal(harness.pendingRequests.length, 2, "cache hit must not issue a new request")
  assert.ok(container.innerHTML.includes("unfiltered late marker"))

  // Directory-snapshot guard beyond the token: request 1 settles while its
  // token is STILL the latest (the cache hit above never issued a load), but
  // the view has moved back — only the (sort, order, directory) snapshot
  // comparison can drop it. Its payload still parks in its own slot.
  harness.settleWithMarker(1, "directory marker")
  await flushControllerMicrotasks()
  assert.ok(
    !container.innerHTML.includes("directory marker"),
    "a response whose directory snapshot no longer matches must not render even on a fresh token",
  )

  // Cache separation proof: re-entering the directory renders the parked
  // payload with no third request.
  controller.changeDirectory("D:/projects/example-alpha")
  assert.equal(harness.pendingRequests.length, 2)
  assert.ok(container.innerHTML.includes("directory marker"))
  assert.ok(!container.innerHTML.includes("unfiltered late marker"))
})

test("renderDirectoryPanel drill-down: rows toggle the directory filter and the empty-string row stays non-interactive", async () => {
  const { renderDirectoryPanel } = await import(
    "../src/web/public/components/directory-panel.js"
  )
  const container = freshContainer()
  const directoryStats = {
    totalDirectories: 3,
    totalSessions: 40,
    directories: [
      { directory: "D:/projects/example-alpha", name: "example-alpha", sessions: 20, steps: 900, lastActiveMs: null },
      { directory: "D:/projects/example-beta", name: "example-beta", sessions: 15, steps: 400, lastActiveMs: null },
      { directory: "", name: null, sessions: 5, steps: 100, lastActiveMs: null },
    ],
  }
  const selectionEvents: Array<string | null> = []
  const captureDirectorySelect = (directoryPath: string | null) => {
    selectionEvents.push(directoryPath)
  }

  // Pure display usage (no callback): nothing is selectable.
  renderDirectoryPanel(container, directoryStats)
  assert.equal(
    container.querySelectorAll(".directory-row.selectable").length,
    0,
    "without a callback the panel must stay a pure listing",
  )

  renderDirectoryPanel(container, directoryStats, null, captureDirectorySelect)
  const selectableRows = container.querySelectorAll(".directory-row.selectable")
  assert.equal(selectableRows.length, 2, "the empty-string directory row must not be drillable")
  assert.equal(container.querySelector(".directory-row.selected"), null, "nothing is selected initially")

  // 0.7.0 review P2-1: selectable rows must keep the hover-to-read-full-path
  // affordance — the name cell carries the path title on every row, drillable
  // or not (the row-level click hint is additive, never a replacement).
  // NOTE: the DOM shim flattens parsed tags, so query from the container.
  const nameCells = container.querySelectorAll(".directory-name-cell")
  assert.equal(nameCells.length, 3, "every directory row renders a name cell")
  assert.equal(
    nameCells[0]!.attributes.get("title"),
    "D:/projects/example-alpha",
    "the drillable row's name cell keeps the full-path title",
  )

  selectableRows[0]!.click()
  assert.deepEqual(selectionEvents, ["D:/projects/example-alpha"], "a row click reports its directory")

  // Re-render with that directory selected: the row gains .selected and a
  // repeat click toggles the filter off (same toggle contract as the model
  // table).
  renderDirectoryPanel(container, directoryStats, "D:/projects/example-alpha", captureDirectorySelect)
  const selectedRow = container.querySelector(".directory-row.selected")
  assert.notEqual(selectedRow, null, "the active filter's row is highlighted")
  assert.equal(selectedRow!.dataset.directory, "D:/projects/example-alpha")
  selectedRow!.click()
  assert.deepEqual(
    selectionEvents,
    ["D:/projects/example-alpha", null],
    "clicking the selected row toggles the filter off",
  )
})

test("renderSessionList labels the directory filter in the footnote and explains empty results per filter combination", async () => {
  const { renderSessionList } = await import(
    "../src/web/public/components/session-list.js"
  )
  const container = freshContainer()

  // Non-empty filtered view: the footnote names the directory before the
  // sort description; row order stays the payload order (filtering happened
  // server-side).
  renderSessionList(container, sessionSortFixturePayload(), null, "time_updated", "desc", null, "D:/projects/example-alpha")
  assert.match(container.innerHTML, /目录：D:\/projects\/example-alpha/)
  assert.match(container.innerHTML, /按最近更新时间倒序/)
  const renderedRowIds = container
    .querySelectorAll("tr.session-row")
    .map((sessionRow) => sessionRow.dataset.sessionId)
  assert.deepEqual(
    renderedRowIds,
    ["ses_example_alpha", "ses_example_bravo", "ses_example_charlie"],
    "the directory filter is a server-side concern — rows arrive pre-filtered",
  )

  // Stacking: directory (server-side) and model (client-side) filters both
  // appear in the footnote.
  renderSessionList(container, sessionSortFixturePayload(), "glm-5.3", "time_updated", "desc", null, "D:/projects/example-alpha")
  assert.match(container.innerHTML, /目录：D:\/projects\/example-alpha/)
  assert.match(container.innerHTML, /已过滤掉 1 条非 glm-5\.3 会话/)

  // Empty under a directory filter: directory-flavored empty state.
  renderSessionList(container, { total: null, sessions: [] }, null, "time_updated", "desc", null, "D:/projects/example-gamma")
  assert.match(container.innerHTML, /该目录没有会话记录/)

  // Empty under both filters: the stacked message says which knobs to try.
  renderSessionList(container, { total: null, sessions: [] }, "glm-5.3", "time_updated", "desc", null, "D:/projects/example-gamma")
  assert.match(container.innerHTML, /没有 glm-5\.3 在该目录下的会话/)
})

test("renderSessionList model filter hits step-level modelIds and degrades to modelId on legacy wire (v0.19.0)", async () => {
  const { renderSessionList } = await import(
    "../src/web/public/components/session-list.js"
  )
  const container = freshContainer()

  // 下钻口径回归锁（v0.19.0 修复「模型有使用，session 却是空的」）：
  // 排行榜行来自 step 级 $.model.id——charlie 的启动模型是
  // claude-sonnet-4.6，但它的 step 里用过 glm-5.3，点 glm-5.3 行必须
  // 命中 charlie；按旧口径（modelId 精确匹配）charlie 会被漏掉。
  const stepModelPayload = {
    total: null as const,
    sessions: [
      {
        id: "ses_example_alpha", title: "alpha fixture", modelId: "glm-5.3",
        modelIds: ["glm-5.3"], agent: "build", directory: "D:/projects/example-alpha",
        timeCreated: 1000, timeUpdated: 5000, tokens: 1500, cost: 1.0,
      },
      {
        id: "ses_example_charlie", title: "charlie fixture", modelId: "claude-sonnet-4.6",
        modelIds: ["claude-sonnet-4.6", "glm-5.3"], agent: "build", directory: "D:/projects/example-alpha",
        timeCreated: 3000, timeUpdated: 7000, tokens: 900, cost: 0.5,
      },
    ],
  }

  renderSessionList(container, stepModelPayload, "glm-5.3", "time_updated", "desc", null)
  assert.deepEqual(
    container.querySelectorAll("tr.session-row").map((sessionRow) => sessionRow.dataset.sessionId),
    ["ses_example_alpha", "ses_example_charlie"],
    "modelIds 命中过滤：step 里用过该模型的会话必须留下（含启动模型不同的）",
  )

  // modelIds 不含该模型 → 过滤掉（delta 只用过 claude-opus-5）。
  const stepModelMissPayload = {
    total: null as const,
    sessions: [
      {
        id: "ses_example_delta", title: "delta fixture", modelId: "glm-5.3",
        modelIds: ["glm-5.3", "glm-5.3-flash"], agent: "build", directory: "D:/projects/example-alpha",
        timeCreated: 1000, timeUpdated: 5000, tokens: 900, cost: 2.5,
      },
    ],
  }
  renderSessionList(container, stepModelMissPayload, "claude-opus-5", "time_updated", "desc", null)
  assert.match(container.innerHTML, /没有 claude-opus-5 的会话/, "a model absent from every modelIds set yields the model-flavored empty state")

  // 旧宿主 wire 缺 modelIds → 回退启动模型精确匹配（行为不劣于修复前）。
  const legacyWirePayload = {
    total: null as const,
    sessions: [
      { id: "ses_example_echo", title: "echo fixture", modelId: "glm-5.3", agent: "plan", directory: "D:/projects/example-alpha", timeCreated: 1000, timeUpdated: 5000, tokens: 600, cost: 1.0 },
      { id: "ses_example_foxtrot", title: "foxtrot fixture", modelId: "claude-sonnet-4.6", agent: "plan", directory: "D:/projects/example-alpha", timeCreated: 2000, timeUpdated: 9000, tokens: 300, cost: 0 },
    ],
  }
  renderSessionList(container, legacyWirePayload, "glm-5.3", "time_updated", "desc", null)
  assert.deepEqual(
    container.querySelectorAll("tr.session-row").map((sessionRow) => sessionRow.dataset.sessionId),
    ["ses_example_echo"],
    "legacy wire without modelIds falls back to the modelId exact match",
  )
})

test("getMockSessions mirrors the backend directory filter contract: exact match, miss = empty, absent/empty = no filter", async () => {
  const { getMockSessions } = await import("../src/web/public/mock-data.js")
  const unfilteredPage = getMockSessions()
  const firstDirectory = unfilteredPage.sessions[0]!.directory
  assert.ok(firstDirectory !== "", "fixture sessions must carry a non-empty directory for this test")

  // null / "" are both "no filter" — identical to the unfiltered call.
  assert.deepEqual(getMockSessions("time_updated", "desc", null), unfilteredPage)
  assert.deepEqual(getMockSessions("time_updated", "desc", ""), unfilteredPage)

  // Exact match: every returned session lives in that directory.
  const filteredPage = getMockSessions("time_updated", "desc", firstDirectory)
  assert.ok(filteredPage.sessions.length > 0)
  assert.ok(filteredPage.sessions.every((session) => session.directory === firstDirectory))
  assert.equal(
    filteredPage.total,
    null,
    "a filtered page carries no total — the global mock count would mislabel it, and the real source is a bare array",
  )

  // No match = empty result (filter semantics, a legal 200 — not an error).
  assert.deepEqual(
    getMockSessions("time_updated", "desc", "D:/projects/example-no-such-directory"),
    { total: null, sessions: [] },
  )

  // Sorting still applies within the filtered set (tokens desc → descending).
  const tokensDescendingPage = getMockSessions("tokens", "desc", firstDirectory)
  const tokenCounts = tokensDescendingPage.sessions.map((session) => session.tokens)
  assert.deepEqual(tokenCounts, [...tokenCounts].sort((leftCount, rightCount) => rightCount - leftCount))
})

/* ------------- CSV export entry (v0.8.0) ------------- */

test("sessionsExportCsvPath is the single construction point for the CSV export URL", async () => {
  const { sessionsExportCsvPath } = await import("../src/web/public/data-source.js")

  // No filter: bare path, byte-identical to the no-filter request contract.
  assert.equal(sessionsExportCsvPath(null), "/api/export/sessions.csv")
  assert.equal(
    sessionsExportCsvPath(""),
    "/api/export/sessions.csv",
    "empty string is no-filter by contract — same bare path as absent",
  )

  // Filtered: the directory param is encoded exactly once, same convention
  // as fetchSessions' request path (both go through the shared helper).
  assert.equal(
    sessionsExportCsvPath("D:/projects/example-alpha"),
    "/api/export/sessions.csv?directory=D%3A%2Fprojects%2Fexample-alpha",
  )
})

test("sessionsCsvExportEntryHtml renders per availability mode with the scoped download href", async () => {
  const { sessionsCsvExportEntryHtml } = await import(
    "../src/web/public/components/session-csv-export.js"
  )

  // Available + filtered: native anchor carrying the encoded directory href.
  const filteredEntryHtml = sessionsCsvExportEntryHtml("D:/projects/example-alpha", "", true)
  assert.ok(
    filteredEntryHtml.includes('href="/api/export/sessions.csv?directory=D%3A%2Fprojects%2Fexample-alpha"'),
    "the entry href reuses the data-source URL single point",
  )
  assert.ok(filteredEntryHtml.includes('download="sessions.csv"'))
  assert.match(filteredEntryHtml, /导出 CSV/)

  // Available + unfiltered: bare path.
  const unfilteredEntryHtml = sessionsCsvExportEntryHtml(null, "", true)
  assert.ok(unfilteredEntryHtml.includes('href="/api/export/sessions.csv"'))

  // Unavailable (mock preview): no entry at all — availability is decided at
  // render time, so there is nothing to show first and hide later.
  assert.equal(
    sessionsCsvExportEntryHtml("D:/projects/example-alpha", "", false),
    "",
    "mock mode renders no entry — no flash of a route that does not exist",
  )
})

test("renderSessionList appends the export entry whose href follows the controller's directory filter", async () => {
  const { renderSessionList } = await import(
    "../src/web/public/components/session-list.js"
  )
  const container = freshContainer()

  // Real-mode wiring: SESSIONS_CSV_EXPORT_AVAILABLE is !USE_MOCK, true in the
  // integrated environment — if this ever fails, USE_MOCK was flipped back on
  // and the entry is (correctly) gone; the mock-mode branch itself is covered
  // by the entry-builder test above.
  renderSessionList(container, sessionSortFixturePayload(), null, "time_updated", "desc", null, null)
  assert.ok(
    container.innerHTML.includes('href="/api/export/sessions.csv"'),
    "no filter → bare export path in the footnote entry",
  )
  assert.ok(!container.innerHTML.includes("directory="), "no directory param without an active filter")

  // Directory filter → the entry href carries it, encoded.
  renderSessionList(container, sessionSortFixturePayload(), null, "time_updated", "desc", null, "D:/projects/example-alpha")
  assert.ok(
    container.innerHTML.includes('href="/api/export/sessions.csv?directory=D%3A%2Fprojects%2Fexample-alpha"'),
  )

  // The filter changed → a re-render swaps the href; the stale one is gone.
  renderSessionList(container, sessionSortFixturePayload(), null, "time_updated", "desc", null, "D:/projects/example-beta")
  assert.ok(container.innerHTML.includes('href="/api/export/sessions.csv?directory=D%3A%2Fprojects%2Fexample-beta"'))
  assert.ok(
    !container.innerHTML.includes("directory=D%3A%2Fprojects%2Fexample-alpha"),
    "the export href must track the current filter, not accumulate stale ones",
  )
})

/* ------------- session time-range filter (v0.9.0) ------------- */

test("renderSessionList renders the range switch, keeps it across states and routes its clicks", async () => {
  const { renderSessionList } = await import(
    "../src/web/public/components/session-list.js"
  )
  const container = freshContainer()
  const rangeChangeEvents: string[] = []
  const captureRangeChange = (nextRange: string) => {
    rangeChangeEvents.push(nextRange)
  }

  // Pure display (no callback) → no switch at all.
  renderSessionList(container, sessionSortFixturePayload(), null, "time_updated", "desc", null, null)
  assert.equal(
    container.querySelectorAll("button.session-range-button").length,
    0,
    "without a callback the panel shows no range switch",
  )

  // Default state: four preset buttons, exactly one active — All ("").
  renderSessionList(container, sessionSortFixturePayload(), null, "time_updated", "desc", null, null, "", captureRangeChange)
  const rangeButtons = container.querySelectorAll("button.session-range-button")
  assert.equal(rangeButtons.length, 4, "7d / 30d / 90d / All presets")
  assert.ok(
    container.innerHTML.includes('class="session-range-button active" data-session-range=""'),
    "the default All preset is the active one",
  )

  // Clicks route through the callback with the wire vocabulary.
  const clickRangePreset = (presetValue: string) => {
    rangeButtons
      .find((rangeButton) => rangeButton.dataset.sessionRange === presetValue)!
      .click()
  }
  clickRangePreset("7d")
  clickRangePreset("")
  clickRangePreset("30d")
  clickRangePreset("90d")
  assert.deepEqual(rangeChangeEvents, ["7d", "", "30d", "90d"])

  // Re-render with an active range moves the active pill to 30d.
  renderSessionList(container, sessionSortFixturePayload(), null, "time_updated", "desc", null, null, "30d", captureRangeChange)
  assert.ok(
    container.innerHTML.includes('class="session-range-button active" data-session-range="30d"'),
  )
  assert.ok(
    !container.innerHTML.includes('class="session-range-button active" data-session-range=""'),
    "exactly one preset carries the active state",
  )

  // The switch survives the loading skeleton and empty results — an empty
  // range must never lock the user out of widening it back.
  renderSessionList(container, null, null, "time_updated", "desc", null, null, "7d", captureRangeChange)
  assert.equal(container.querySelectorAll("button.session-range-button").length, 4, "the switch stays up during loading")
  renderSessionList(container, { total: null, sessions: [] }, null, "time_updated", "desc", null, null, "7d", captureRangeChange)
  assert.equal(container.querySelectorAll("button.session-range-button").length, 4, "the switch stays up on empty results")
  assert.match(container.innerHTML, /最近 7d没有会话更新/)
})

test("session-sort-controller: range switches keep the other filters and reuse their dimension untouched", async () => {
  const { createSessionSortController } = await import(
    "../src/web/public/components/session-sort-controller.js"
  )
  const container = freshContainer()
  const harness = createDeferredSessionPageHarness()
  const controller = createSessionSortController({
    containerElement: container,
    fetchSessionsPage: harness.fetchSessionsPage,
    getModelFilter: () => null,
  })

  controller.load() // request 0: (time_updated, desc, no directory, 全部)
  controller.changeRange("7d") // request 1
  assert.deepEqual(
    {
      sortKey: harness.pendingRequests[1]!.sortKey,
      directory: harness.pendingRequests[1]!.directory,
      range: harness.pendingRequests[1]!.range,
    },
    { sortKey: "time_updated", directory: null, range: "7d" },
    "a range switch keeps the current sort and directory (filters stack, never clear each other)",
  )

  // Same value twice → early return, no request.
  controller.changeRange("7d")
  assert.equal(harness.pendingRequests.length, 2, "a no-op range switch must not fetch")

  // Directory drill keeps the range; sort click keeps both.
  controller.changeDirectory("D:/projects/example-alpha") // request 2
  assert.equal(harness.pendingRequests[2]!.range, "7d", "drilling into a directory keeps the range")
  controller.changeSort("tokens", "desc") // request 3
  assert.deepEqual(
    {
      directory: harness.pendingRequests[3]!.directory,
      range: harness.pendingRequests[3]!.range,
    },
    { directory: "D:/projects/example-alpha", range: "7d" },
    "a sort click keeps the directory and range — all three dimensions stack",
  )

  harness.settleWithMarker(3, "stacked filters marker")
  await flushControllerMicrotasks()
  assert.ok(container.innerHTML.includes("stacked filters marker"))
})

test("session-sort-controller: stable 全部 views keep exact cache hits while time-window re-entry always re-requests", async () => {
  const { createSessionSortController } = await import(
    "../src/web/public/components/session-sort-controller.js"
  )
  const container = freshContainer()
  const harness = createDeferredSessionPageHarness()
  const controller = createSessionSortController({
    containerElement: container,
    fetchSessionsPage: harness.fetchSessionsPage,
    getModelFilter: () => null,
  })

  controller.load() // request 0: 全部 range
  controller.changeRange("7d") // request 1
  assert.equal(harness.pendingRequests.length, 2)

  // The stale all-range response resolves first — dropped by its token, but
  // parked in its own ("" range) cache slot.
  harness.settleWithMarker(0, "all-range late marker")
  await flushControllerMicrotasks()
  assert.ok(!container.innerHTML.includes("all-range late marker"))

  // Back to 全部 is a pure cache hit — no new request, token unmoved. Empty
  // range is a stable dimension: this zero-request behavior is the part of
  // the cache that v0.9.1 keeps.
  controller.changeRange("")
  assert.equal(harness.pendingRequests.length, 2, "a stable 全部 view must still hit the cache without a request")
  assert.ok(container.innerHTML.includes("all-range late marker"))

  // Range-snapshot guard beyond the token: the in-flight 7d request settles
  // while its token is still latest, but the view moved back to 全部 — only
  // the four-dimension snapshot comparison drops it. Under v0.9.1 semantics
  // it is also NOT parked (time-window entries never enter the cache).
  harness.settleWithMarker(1, "7d marker")
  await flushControllerMicrotasks()
  assert.ok(
    !container.innerHTML.includes("7d marker"),
    "a response whose range snapshot no longer matches must not render even on a fresh token",
  )

  // Re-entering the time window must RE-REQUEST (ora-5 P2): the 7d payload
  // resolved moments ago is deliberately not in the cache — same key no
  // longer means same answer once the wall clock moves. If the old
  // cache-hit behavior leaked back, this count would stay at 2.
  controller.changeRange("7d")
  assert.equal(harness.pendingRequests.length, 3, "time-window re-entry must issue a fresh request, never a cache hit")

  harness.settleWithMarker(2, "7d fresh marker")
  await flushControllerMicrotasks()
  assert.ok(container.innerHTML.includes("7d fresh marker"))
  assert.ok(!container.innerHTML.includes("all-range late marker"))
  assert.ok(!container.innerHTML.includes("7d marker"), "the pre-fix parked 7d payload must not exist to be rendered")

  // Behavioral key-absence proof: leave and re-enter the same window once
  // more — a fourth request appears. Had the 7d entry ever been written,
  // this would be a zero-request cache hit.
  controller.changeRange("")
  assert.equal(harness.pendingRequests.length, 3)
  controller.changeRange("7d")
  assert.equal(harness.pendingRequests.length, 4, "no time-window entry ever lands in the cache map")
})

test("session-sort-controller: inside a time-window view every dimension switch re-requests — the bypass is judged by the view, not the action (ora-5 P2)", async () => {
  const { createSessionSortController } = await import(
    "../src/web/public/components/session-sort-controller.js"
  )
  const container = freshContainer()
  const harness = createDeferredSessionPageHarness()
  const controller = createSessionSortController({
    containerElement: container,
    fetchSessionsPage: harness.fetchSessionsPage,
    getModelFilter: () => null,
  })

  controller.load() // request 0: 全部 range
  controller.changeRange("7d") // request 1 — enter the time-window view
  harness.settleWithMarker(1, "7d first marker")
  await flushControllerMicrotasks()
  assert.ok(container.innerHTML.includes("7d first marker"))

  // A sort click — a perfectly cacheable dimension in a stable view — must
  // re-request here, because the VIEW still contains a time window.
  controller.changeSort("tokens", "desc") // request 2
  assert.equal(harness.pendingRequests.length, 3, "a sort switch inside a range view must re-request")
  assert.equal(harness.pendingRequests[2]!.range, "7d")

  // Switching back to the exact combination that is currently rendered must
  // STILL re-request: the same key stopped meaning the same answer the
  // moment the wall clock moved.
  controller.changeSort("time_updated", "desc") // request 3
  assert.equal(harness.pendingRequests.length, 4, "even an identical sort combination re-requests inside a range view")
  assert.equal(harness.pendingRequests[3]!.range, "7d")

  // Same for a directory switch inside the window.
  controller.changeDirectory("D:/projects/example-alpha") // request 4
  assert.equal(harness.pendingRequests.length, 5)
  assert.equal(harness.pendingRequests[4]!.range, "7d", "a directory switch inside a range view re-requests with the window intact")
  assert.equal(harness.pendingRequests[4]!.directory, "D:/projects/example-alpha")

  // renderCurrent (the app.js model-filter path) must not hit a silent
  // skeleton in a range view either — it re-requests, per the view property.
  controller.renderCurrent() // request 5
  assert.equal(harness.pendingRequests.length, 6, "renderCurrent inside a range view re-requests instead of rendering a stuck skeleton")
  assert.equal(harness.pendingRequests[5]!.range, "7d")

  harness.settleWithMarker(5, "model filter in range marker")
  await flushControllerMicrotasks()
  assert.ok(container.innerHTML.includes("model filter in range marker"))
})

/* ------------- replay in-session search (v0.10.0) ------------- */

/** Fictional SessionMessageRecord fixture (example-alpha series only). */
function replayMessageRecord(recordSeq: number, recordType: string, recordData: Record<string, unknown>) {
  const timeCreated = 1_700_000_000_000 + recordSeq * 60_000
  return {
    id: `msg_example_alpha_${String(recordSeq).padStart(4, "0")}`,
    sessionId: "ses_example_alpha",
    type: recordType,
    seq: recordSeq,
    timeCreated,
    timeUpdated: timeCreated + 1_000,
    data: recordData,
  }
}

const replaySleep = (delayMs: number) => new Promise<void>((resolve) => setTimeout(resolve, delayMs))

test("buildReplaySearchIndex extracts exactly the rendered search scope, case-insensitively, and skips unrendered types", async () => {
  const { buildReplaySearchIndex } = await import(
    "../src/web/public/components/replay-message-text.js"
  )
  const searchRecords = [
    replayMessageRecord(0, "user", { text: "user 正文里埋了 needle-user 一词" }),
    replayMessageRecord(1, "assistant", {
      model: { id: "glm-5.3" },
      content: [
        { type: "reasoning", text: "思考段里埋了 needle-reason" },
        { type: "tool", name: "needle-tool", state: { status: "completed", input: { command: "grep needle-input ./src/example" }, metadata: { output: "输出里埋了 needle-output" } } },
        { type: "text", text: "第一段正文没有目标词" },
        { type: "text", text: "第二段正文才有 needle-text" },
      ],
    }),
    replayMessageRecord(2, "idle", { duration: 300_000, text: "idle 里的 needle 不可搜（不渲染）" }),
    replayMessageRecord(3, "synthetic", { text: "synthetic 里的 needle 不可搜" }),
    replayMessageRecord(4, "system", { text: "system 提示词里的 needle 不可搜（截断渲染）" }),
    replayMessageRecord(5, "compaction", { status: "completed", reason: "auto", summary: "压缩摘要里的 needle 不可搜" }),
    replayMessageRecord(6, "user", { text: "这条完全没有目标词" }),
  ]

  // idle/synthetic drop out of the index (they drop out of the timeline too);
  // notices stay indexed (they render) but carry an empty haystack — the six
  // contract categories are the only searchable text.
  const searchIndex = buildReplaySearchIndex(searchRecords)
  assert.equal(searchIndex.length, 5, "user / assistant / system / compaction / user — same filter as renderTimeline")
  assert.equal(searchIndex[2]!.haystack, "", "system notices are not in the search scope")
  assert.equal(searchIndex[3]!.haystack, "", "compaction notices are not in the search scope")

  const matchingIndexesFor = (query: string) => searchIndex
    .map((indexEntry, recordIndex) => (indexEntry.haystack.includes(query.toLowerCase()) ? recordIndex : -1))
    .filter((recordIndex) => recordIndex !== -1)

  // The six searchable categories, one distinct needle each.
  assert.deepEqual(matchingIndexesFor("needle-user"), [0], "user body text is searchable")
  assert.deepEqual(matchingIndexesFor("needle-reason"), [1], "assistant reasoning part is searchable")
  assert.deepEqual(matchingIndexesFor("needle-tool"), [1], "tool name is searchable")
  assert.deepEqual(matchingIndexesFor("needle-input"), [1], "tool input is searchable — the probe-found gap (rendered params pre, previously invisible to search)")
  assert.deepEqual(matchingIndexesFor("needle-output"), [1], "tool output is searchable")
  assert.deepEqual(matchingIndexesFor("needle-text"), [1], "assistant text parts are searchable — multi-part content is joined into one view")
  assert.deepEqual(matchingIndexesFor("needle-不存在"), [], "no haystack match → empty hit list")

  // Case-insensitivity is "both sides lowercased": the haystack is stored
  // lowercase, the caller lowercases the query (mirrors replay-search.js).
  assert.ok(searchIndex[0]!.haystack.includes("NEEDLE-USER".toLowerCase()))
  assert.ok(!searchIndex[0]!.haystack.includes("NEEDLE-USER"), "haystack itself must be pre-lowercased")
})

test("readToolInput mirrors the rendered tool-params display string exactly", async () => {
  const { readToolInput } = await import("../src/web/public/components/replay-message-text.js")

  // Object input: the params <pre> renders JSON.stringify(input, null, 2) —
  // the haystack must carry that same serialized form.
  const objectInput = { command: "grep example", path: "~/projects/example-alpha" }
  assert.equal(
    readToolInput({ input: objectInput }),
    JSON.stringify(objectInput, null, 2),
    "object input is the pretty-printed JSON the params block shows",
  )

  // String input: the render quotes it (JSON literal), not the bare string.
  assert.equal(readToolInput({ input: "bash -c echo example" }), '"bash -c echo example"')
  assert.equal(readToolInput({ input: 42 }), "42", "scalar inputs follow the same JSON.stringify rule")

  // Missing input: the render skips the params pre entirely → empty string.
  assert.equal(readToolInput({ status: "completed" }), "", "absent input renders no params block")
  assert.equal(readToolInput({ input: null }), "", "null input renders no params block")
  assert.equal(readToolInput({ input: undefined }), "", "undefined input renders no params block")
  assert.equal(readToolInput(null), "", "absent state renders no params block")
})

test("the rendered tool-params block text is contained verbatim in the search haystack (structural render→search lock)", async () => {
  const { renderTimeline } = await import("../src/web/public/components/replay-timeline.js")
  const { buildReplaySearchIndex } = await import(
    "../src/web/public/components/replay-message-text.js"
  )

  const container = freshContainer()
  const toolInput = { command: "grep structural-lock ./src/example", count: 3 }
  const searchRecords = [
    replayMessageRecord(0, "assistant", {
      model: { id: "glm-5.3" },
      content: [
        { type: "tool", name: "bash", state: { status: "completed", input: toolInput, metadata: { output: "done" } } },
      ],
    }),
  ]

  renderTimeline(container, searchRecords, 200)

  // Read back what the user actually sees in the tool-params <pre>.
  const paramsBlocks = container.querySelectorAll("pre.replay-code.lang-json")
  assert.equal(paramsBlocks.length, 1, "the tool input renders exactly one params block")
  const paramsDisplayText = paramsBlocks[0]!.textContent
  assert.ok(
    paramsDisplayText.includes('"command": "grep structural-lock ./src/example"'),
    "the params block shows the pretty-printed JSON form",
  )

  // One-way containment: whatever the params block renders, the haystack for
  // that message must carry it (lowercased). If someone re-inlines a different
  // serialization into buildToolPartElement, this containment breaks loudly
  // instead of the "rendered but unsearchable" regression passing silently.
  const searchIndex = buildReplaySearchIndex(searchRecords)
  assert.ok(
    searchIndex[0]!.haystack.includes(paramsDisplayText.toLowerCase()),
    "the params display text is part of the search haystack — display-form drift must fail here",
  )
})

test("buildReplaySearchBar renders the find bar, counts hits across all messages, navigates and clears state", async () => {
  const { renderTimeline } = await import("../src/web/public/components/replay-timeline.js")
  const { buildReplaySearchBar, REPLAY_SEARCH_DEBOUNCE_MS } = await import(
    "../src/web/public/components/replay-search.js"
  )
  assert.equal(REPLAY_SEARCH_DEBOUNCE_MS, 200, "production debounce stays at 200ms unless deliberately changed")

  const container = freshContainer()
  const searchRecords = [0, 1, 2, 3, 4].map((recordSeq) =>
    replayMessageRecord(recordSeq, "user", {
      text: recordSeq % 2 === 0 ? `needle 第 ${recordSeq} 处正文` : `普通正文 ${recordSeq}`,
    }),
  )
  const paginationController = renderTimeline(container, searchRecords, 200)
  const replaySearch = buildReplaySearchBar({
    paginationController,
    messageRecords: searchRecords,
    debounceMs: 5,
  })
  container.appendChild(replaySearch.element)

  const searchInput = container.querySelectorAll("input.replay-search-input")[0]!
  const navButtons = container.querySelectorAll("button.replay-search-nav")
  const hitCountLabel = container.querySelectorAll("span.replay-search-count")[0]!
  assert.equal(navButtons.length, 2, "prev / next navigation buttons")
  assert.equal(hitCountLabel.textContent, "", "no count before the first search")

  // Type-to-search through the debounced input path; the query is uppercase
  // to pin case-insensitivity end to end.
  searchInput.value = "NEEDLE"
  searchInput.fire("input")
  await replaySleep(20)
  assert.equal(hitCountLabel.textContent, "3 处命中 · 第 1 处", "count spans all messages, not just the visible page")
  assert.equal(container.querySelectorAll(".replay-hit").length, 3)
  assert.equal(container.querySelectorAll(".replay-hit-current").length, 1)
  assert.ok(paginationController.nodeAt(0)!.classTokenList().includes("replay-hit-current"))
  assert.ok(paginationController.nodeAt(2)!.classTokenList().includes("replay-hit"))
  assert.ok(!paginationController.nodeAt(1)!.classTokenList().includes("replay-hit"))

  // Next / prev buttons step the current marker (and wrap around the ends).
  navButtons[1]!.click()
  assert.equal(hitCountLabel.textContent, "3 处命中 · 第 2 处")
  assert.ok(paginationController.nodeAt(2)!.classTokenList().includes("replay-hit-current"))
  assert.ok(!paginationController.nodeAt(0)!.classTokenList().includes("replay-hit-current"))
  navButtons[0]!.click()
  assert.ok(paginationController.nodeAt(0)!.classTokenList().includes("replay-hit-current"))

  // Enter / Shift+Enter keyboard stepping, Escape exits the search state.
  searchInput.fire("keydown", { key: "Enter" })
  assert.ok(paginationController.nodeAt(2)!.classTokenList().includes("replay-hit-current"))
  searchInput.fire("keydown", { key: "Enter", shiftKey: true })
  assert.ok(paginationController.nodeAt(0)!.classTokenList().includes("replay-hit-current"))
  searchInput.fire("keydown", { key: "Escape" })
  assert.equal(searchInput.value, "", "Escape clears the input")
  assert.equal(container.querySelectorAll(".replay-hit").length, 0, "all highlights cleared")
  assert.equal(hitCountLabel.textContent, "", "count hidden after exit")

  // Whitespace-only input is also "exit the search state" (contract).
  searchInput.value = "needle"
  searchInput.fire("input")
  await replaySleep(20)
  assert.equal(container.querySelectorAll(".replay-hit").length, 3)
  searchInput.value = "   "
  searchInput.fire("input")
  await replaySleep(20)
  assert.equal(container.querySelectorAll(".replay-hit").length, 0, "whitespace-only input restores the full view")
  assert.equal(hitCountLabel.textContent, "")

  // No-hit query states itself plainly and navigation no-ops.
  searchInput.value = "不存在的词"
  searchInput.fire("input")
  await replaySleep(20)
  assert.equal(hitCountLabel.textContent, "无命中")
  navButtons[1]!.click()
  assert.equal(hitCountLabel.textContent, "无命中")
})

test("a hit beyond the rendered pagination window is counted and navigation appends the timeline to reach it", async () => {
  const { renderTimeline } = await import("../src/web/public/components/replay-timeline.js")
  const { buildReplaySearchBar } = await import("../src/web/public/components/replay-search.js")

  const container = freshContainer()
  const searchRecords = []
  for (let recordSeq = 0; recordSeq < 210; recordSeq += 1) {
    searchRecords.push(replayMessageRecord(recordSeq, "user", {
      text: recordSeq === 205 ? "分页区外的 deep-needle 命中" : `普通填充行 ${recordSeq}`,
    }))
  }
  const paginationController = renderTimeline(container, searchRecords, 200)
  assert.equal(paginationController.renderedCount, 200)
  assert.equal(paginationController.hasMore, true)

  const replaySearch = buildReplaySearchBar({
    paginationController,
    messageRecords: searchRecords,
    debounceMs: 5,
  })
  container.appendChild(replaySearch.element)
  const searchInput = container.querySelectorAll("input.replay-search-input")[0]!
  const hitCountLabel = container.querySelectorAll("span.replay-search-count")[0]!

  searchInput.value = "deep-needle"
  searchInput.fire("input")
  await replaySleep(20)

  // The hit lives at visible index 205 — beyond the first 200-node page —
  // yet it is counted (index-based, independent of the rendered window) and
  // the navigation drove appendNextChunk() through it.
  assert.equal(hitCountLabel.textContent, "1 处命中 · 第 1 处")
  assert.equal(paginationController.renderedCount, 210, "navigation appended chunks until the target node exists")
  assert.equal(paginationController.hasMore, false)
  assert.equal(container.querySelectorAll(".replay-node").length, 210)
  assert.ok(paginationController.nodeAt(205)!.classTokenList().includes("replay-hit"))
  assert.ok(paginationController.nodeAt(205)!.classTokenList().includes("replay-hit-current"))
  assert.equal(container.querySelectorAll(".replay-hit").length, 1)
})

test("renderSessionReplay mounts the search bar and a session switch leaves no stale search state behind", async () => {
  const { renderSessionReplay } = await import(
    "../src/web/public/components/session-replay.js"
  )

  const alphaRecords = [
    replayMessageRecord(0, "user", { text: "alpha 会话里的 needle 正文" }),
    replayMessageRecord(1, "assistant", { model: { id: "glm-5.3" }, content: [{ type: "text", text: "alpha 回复正文" }] }),
  ]
  const betaRecords = [
    replayMessageRecord(0, "user", { text: "beta 会话正文，没有目标词" }),
  ]

  const savedFetch = globalThis.fetch
  globalThis.fetch = (async (fetchInput: unknown) => {
    const requestUrl = String(fetchInput)
    if (!requestUrl.includes("/messages")) {
      // system-prompt / summary degrade to 404 → omitted panel / fallback title
      return { ok: false, status: 404, json: async () => ({}) }
    }
    const messageRecords = requestUrl.includes("ses_example_alpha") ? alphaRecords : betaRecords
    return { ok: true, status: 200, json: async () => messageRecords }
  }) as unknown as typeof fetch

  try {
    const container = freshContainer()
    await renderSessionReplay(container, "ses_example_alpha")
    assert.equal(container.querySelectorAll("input.replay-search-input").length, 1, "the find bar is mounted in the replay page")

    const searchInput = container.querySelectorAll("input.replay-search-input")[0]!
    const hitCountLabel = container.querySelectorAll("span.replay-search-count")[0]!
    searchInput.value = "needle"
    searchInput.fire("input")
    await replaySleep(300) // production debounce path (200ms) through the page-level wiring
    assert.equal(hitCountLabel.textContent, "1 处命中 · 第 1 处")
    assert.equal(container.querySelectorAll(".replay-hit").length, 1)

    // Switching sessions re-renders the whole view: the previous session's
    // search state (needle, highlights, count) must not survive.
    await renderSessionReplay(container, "ses_example_beta")
    assert.equal(container.querySelectorAll(".replay-hit").length, 0, "no stale highlights from the previous session")
    assert.equal(container.querySelectorAll(".replay-hit-current").length, 0)
    const freshCountLabel = container.querySelectorAll("span.replay-search-count")[0]!
    const freshSearchInput = container.querySelectorAll("input.replay-search-input")[0]!
    assert.equal(freshCountLabel.textContent, "", "the fresh session starts with a clean search bar")
    assert.equal(freshSearchInput.value, "", "the fresh session starts with an empty input")
  } finally {
    globalThis.fetch = savedFetch
  }
})

test("the mock replay fixture drives the search end to end, including hits beyond the first page", async () => {
  const { getMockSessionMessages } = await import("../src/web/public/mock-replay-data.js")
  const { renderTimeline } = await import("../src/web/public/components/replay-timeline.js")
  const { buildReplaySearchBar } = await import("../src/web/public/components/replay-search.js")

  const container = freshContainer()
  const mockRecords = getMockSessionMessages("ses_example_replay_mock")
  const paginationController = renderTimeline(container, mockRecords, 200)
  const replaySearch = buildReplaySearchBar({
    paginationController,
    messageRecords: mockRecords,
    debounceMs: 5,
  })
  container.appendChild(replaySearch.element)

  const searchInput = container.querySelectorAll("input.replay-search-input")[0]!
  const navButtons = container.querySelectorAll("button.replay-search-nav")
  const hitCountLabel = container.querySelectorAll("span.replay-search-count")[0]!

  // Direct fixture facts (no extraction reuse): user prompts carrying 时区
  // repeat at every 15th message — 16 user-body hits across the 228-message
  // fixture. Reasoning passages carry more (「本地时区为东八区」), so the
  // total comes off the count label itself and the walk below is generic.
  const userHitsWithTimeZone = mockRecords.filter(
    (mockRecord) => mockRecord.type === "user" && String(mockRecord.data?.text ?? "").includes("时区"),
  ).length
  assert.equal(userHitsWithTimeZone, 16, "fixture shape pin: USER_PROMPTS[0] recurs at every 15th user slot")

  searchInput.value = "时区"
  searchInput.fire("input")
  await replaySleep(20)
  const firstCountMatch = hitCountLabel.textContent.match(/^(\d+) 处命中 · 第 1 处$/)
  assert.ok(firstCountMatch !== null, `mock mode previews the full search semantics: ${hitCountLabel.textContent}`)
  const totalHitCount = Number(firstCountMatch![1])
  assert.ok(totalHitCount >= 16, "user-body hits are counted; reasoning passages add the rest")
  assert.ok(paginationController.renderedCount < paginationController.visibleCount, "first hit is early — the tail stays unrendered until navigation reaches it")

  // Walk to the last hit (a tail assistant reasoning record): navigation
  // must keep appending chunks as the current marker moves into the
  // unrendered region, and every appended hit picks up its highlight.
  for (let stepIndex = 0; stepIndex < totalHitCount - 1; stepIndex += 1) {
    navButtons[1]!.click()
  }
  assert.equal(hitCountLabel.textContent, `${totalHitCount} 处命中 · 第 ${totalHitCount} 处`)
  assert.equal(paginationController.renderedCount, paginationController.visibleCount, "reaching the tail hit appended the remaining chunks")
  assert.equal(paginationController.hasMore, false)
  assert.equal(container.querySelectorAll(".replay-hit").length, totalHitCount)
  assert.equal(container.querySelectorAll(".replay-hit-current").length, 1)
})

/* ------------- trend byModel real-data wiring (v0.11.0) ------------- */

/** Fictional DailyTrendPoint fixture (example dates, example model ids). */
function dailyTrendPointFixture(dateKey: string, inputTokens: number, readTokens: number, outputTokens: number) {
  return {
    date: dateKey,
    steps: 10,
    input: inputTokens,
    read: readTokens,
    output: outputTokens,
    hitRate: 0.9,
  }
}

test("normalizeTrendPayload pivots the v0.11.0 bare-array wire (per-point byModel Records) into aligned per-model series", async () => {
  const { normalizeTrendPayload } = await import("../src/web/public/data-source.js")
  const { getMockTrend } = await import("../src/web/public/mock-data.js")

  // The mock mirrors the real wire: a bare DailyTrendPoint[] where every
  // point carries a point-level byModel Record, dense (the same model set
  // on every day, zero-filled on inactive days) with the pinned key order
  // (window total desc + modelId asc).
  const mockTrendPoints = getMockTrend(7)
  assert.ok(Array.isArray(mockTrendPoints), "the mock mirrors the bare-array wire — no object envelope")
  assert.equal(mockTrendPoints.length, 7)
  const mockDayKeySets = mockTrendPoints.map((trendPoint) => Object.keys(trendPoint.byModel).join(","))
  assert.ok(
    new Set(mockDayKeySets).size === 1 && mockDayKeySets[0] !== "",
    "the mock byModel is dense: the same model set appears on every day of the window",
  )
  for (const trendPoint of mockTrendPoints) {
    for (const dayTokens of Object.values(trendPoint.byModel)) {
      assert.ok(
        typeof dayTokens === "number" && Number.isFinite(dayTokens) && dayTokens >= 0,
        "point-level byModel values are non-negative finite numbers",
      )
    }
  }

  const normalizedMock = normalizeTrendPayload(mockTrendPoints)
  assert.equal(normalizedMock.points.length, 7)
  assert.ok(normalizedMock.byModel.length > 0, "the mock pivot yields at least one model series")
  for (const modelSeries of normalizedMock.byModel) {
    assert.equal(modelSeries.values.length, 7, "values align per-day with points")
    assert.ok(
      mockDayKeySets[0].split(",").includes(modelSeries.modelId),
      "the model list comes from the Record key union",
    )
  }
  // The pivot conserves the per-day mass: Σ series values === Σ Record values.
  for (let dayIndex = 0; dayIndex < 7; dayIndex += 1) {
    const pivotDaySum = normalizedMock.byModel.reduce(
      (dayAccumulator, modelSeries) => dayAccumulator + modelSeries.values[dayIndex],
      0,
    )
    const recordDaySum = Object.values(mockTrendPoints[dayIndex].byModel).reduce(
      (dayAccumulator, dayTokens) => dayAccumulator + dayTokens,
      0,
    )
    assert.equal(pivotDaySum, recordDaySum)
  }

  // Hand fixture: multi-model multi-day Records → series with per-value
  // day alignment. Pinned pivot order = window total desc (beta 1420 >
  // alpha 700); day 3 keeps alpha as a dense zero layer. The day-2 Record
  // deliberately lists its keys in the opposite insertion order — the
  // pivot must be identical either way (determinism).
  const wireTrendPoints = [
    { ...dailyTrendPointFixture("2026-10-01", 100, 400, 50), byModel: { "model-example-alpha": 300, "model-example-beta": 250 } },
    { ...dailyTrendPointFixture("2026-10-02", 120, 480, 60), byModel: { "model-example-beta": 400, "model-example-alpha": 400 } },
    { ...dailyTrendPointFixture("2026-10-03", 140, 560, 70), byModel: { "model-example-alpha": 0, "model-example-beta": 770 } },
  ]
  const expectedPivot = {
    points: wireTrendPoints,
    byModel: [
      { modelId: "model-example-beta", values: [250, 400, 770] },
      { modelId: "model-example-alpha", values: [300, 400, 0] },
    ],
  }
  assert.deepEqual(normalizeTrendPayload(wireTrendPoints), expectedPivot)
  assert.deepEqual(
    normalizeTrendPayload(wireTrendPoints.map((trendPoint) => ({
      ...trendPoint,
      byModel: Object.fromEntries(Object.entries(trendPoint.byModel).reverse()),
    }))),
    expectedPivot,
    "Record key insertion order must not change the pivot (deterministic order)",
  )

  // Equal window totals tie-break by modelId ascending — the same pinned
  // rule as the backend daily-buckets ordering.
  const tiedTotalsPoints = [
    { ...dailyTrendPointFixture("2026-10-04", 5, 0, 0), byModel: { "model-example-delta": 5, "model-example-charlie": 5 } },
  ]
  assert.deepEqual(
    normalizeTrendPayload(tiedTotalsPoints).byModel.map((modelSeries) => modelSeries.modelId),
    ["model-example-charlie", "model-example-delta"],
    "equal window totals tie-break by modelId ascending lexicographic",
  )

  // A key absent from one day's Record is zero-filled at that dayIndex.
  const sparseDayPoints = [
    { ...dailyTrendPointFixture("2026-10-05", 1, 0, 0), byModel: { "model-example-alpha": 10 } },
    { ...dailyTrendPointFixture("2026-10-06", 1, 0, 0), byModel: { "model-example-beta": 5 } },
  ]
  assert.deepEqual(
    normalizeTrendPayload(sparseDayPoints).byModel,
    [
      { modelId: "model-example-alpha", values: [10, 0] },
      { modelId: "model-example-beta", values: [0, 5] },
    ],
    "a sparse key is zero-filled on its missing days (alpha total 10 > beta 5)",
  )
})

test("normalizeTrendPayload keeps the old-wire degradation and defends point-level byModel garbage", async () => {
  const { normalizeTrendPayload } = await import("../src/web/public/data-source.js")

  // Old wire (pre-v0.11.0 bare array, no byModel): points passthrough,
  // byModel [] → the chart keeps its「总量」single-layer degradation.
  const legacyPoints = [
    dailyTrendPointFixture("2026-10-01", 100, 400, 50),
    dailyTrendPointFixture("2026-10-02", 120, 480, 60),
  ]
  assert.deepEqual(normalizeTrendPayload(legacyPoints), { points: legacyPoints, byModel: [] })

  // Point-level byModel missing / null / non-object / array → that day
  // carries no model data; surviving days still pivot with the broken
  // days zero-filled (trend-chart consumes by dayIndex — gaps would NaN
  // the stack, so they are neutralized at the entry point).
  const mixedDefensePoints = [
    { ...dailyTrendPointFixture("2026-10-01", 100, 400, 50) },                  // byModel absent
    { ...dailyTrendPointFixture("2026-10-02", 120, 480, 60), byModel: null },
    { ...dailyTrendPointFixture("2026-10-03", 140, 560, 70), byModel: "not-an-object" },
    { ...dailyTrendPointFixture("2026-10-04", 140, 560, 70), byModel: [1, 2] }, // an array is not a Record
    { ...dailyTrendPointFixture("2026-10-05", 140, 560, 70), byModel: { "model-example-alpha": 9, "": 4 } }, // empty id never becomes a layer
    { ...dailyTrendPointFixture("2026-10-06", 140, 560, 70), byModel: { "model-example-beta": "garbage" } }, // non-number → 0
  ]
  assert.deepEqual(
    normalizeTrendPayload(mixedDefensePoints).byModel,
    [
      { modelId: "model-example-alpha", values: [0, 0, 0, 0, 9, 0] },
      { modelId: "model-example-beta", values: [0, 0, 0, 0, 0, 0] },
    ],
    "broken days contribute zeros; the empty-string key never becomes a layer; a non-number value sanitizes to 0",
  )

  // Every day broken → the full [] degradation, same as the old wire.
  const allBrokenPoints = [
    { ...dailyTrendPointFixture("2026-10-01", 100, 400, 50) },
    { ...dailyTrendPointFixture("2026-10-02", 120, 480, 60), byModel: "garbage" },
  ]
  assert.deepEqual(normalizeTrendPayload(allBrokenPoints), { points: allBrokenPoints, byModel: [] })

  // The pre-release object envelope ({ points, byModel: [{ modelId,
  // values }] }) was removed as dead code once the real wire turned out to
  // be a bare array (YAGNI): it is no longer honored and degrades to empty
  // data like every other non-array payload.
  const removedEnvelopePayload = {
    points: legacyPoints,
    byModel: [{ modelId: "model-example-alpha", values: [100, 90] }],
  }
  assert.deepEqual(normalizeTrendPayload(removedEnvelopePayload), { points: [], byModel: [] })

  // Garbage payloads degrade to empty data (the chart renders its empty state).
  assert.deepEqual(normalizeTrendPayload(null), { points: [], byModel: [] })
  assert.deepEqual(normalizeTrendPayload("garbage"), { points: [], byModel: [] })
})

test("rankModels stacks real byModel: desc by window total, top-7 cap with 其他 residual, total-layer fallback", async () => {
  // The render body needs the uPlot runtime (canvas) and stays covered by the
  // real-path probes; rankModels is the pure series-builder layer and the only
  // offline-testable seam of trend-chart — exported for exactly that.
  const { rankModels } = await import("../src/web/public/components/trend-chart.js")

  const wirePoints = [
    dailyTrendPointFixture("2026-10-01", 100, 400, 50),
    dailyTrendPointFixture("2026-10-02", 120, 480, 60),
    dailyTrendPointFixture("2026-10-03", 140, 560, 70),
  ]

  // Ranking: the frontend re-sorts by window total regardless of the wire's
  // order — feed the series shuffled and assert desc stacking order.
  const shuffledTrendData = {
    points: wirePoints,
    byModel: [
      { modelId: "model-example-gamma", values: [10, 20, 30] },
      { modelId: "model-example-alpha", values: [100, 100, 100] },
      { modelId: "model-example-beta", values: [50, 50, 50] },
    ],
  }
  const rankedLayers = rankModels(shuffledTrendData)
  assert.deepEqual(
    rankedLayers.map((layer: { modelId: string }) => layer.modelId),
    ["model-example-alpha", "model-example-beta", "model-example-gamma"],
    "layers stack in window-total desc order",
  )
  assert.equal(rankedLayers[0]!.total, 300)
  assert.equal(rankedLayers[0]!.values.length, 3, "per-model values stay per-day aligned with points")

  // Degradation: empty byModel (old wire) → single「总量」layer of day totals.
  const fallbackLayers = rankModels({ points: wirePoints, byModel: [] })
  assert.deepEqual(
    fallbackLayers.map((layer: { modelId: string }) => layer.modelId),
    ["总量"],
  )
  assert.deepEqual(fallbackLayers[0]!.values, [550, 660, 770], "day totals = input + read + output per point")

  // Top-7 cap: nine models → seven named layers + 「其他」 carrying the
  // per-day residual (day total − named sum, clamped at 0).
  const nineModelTrendData = {
    points: [dailyTrendPointFixture("2026-10-01", 45, 0, 0), dailyTrendPointFixture("2026-10-02", 45, 0, 0)],
    byModel: Array.from({ length: 9 }, (_, modelIndex: number) => ({
      modelId: `model-example-${String(modelIndex + 1).padStart(2, "0")}`,
      values: [modelIndex + 1, modelIndex + 1],
    })),
  }
  const cappedLayers = rankModels(nineModelTrendData)
  assert.equal(cappedLayers.length, 8, "7 named layers + 1 其他")
  assert.equal(cappedLayers[0]!.modelId, "model-example-09")
  assert.equal(cappedLayers[7]!.modelId, "其他")
  assert.deepEqual(cappedLayers[7]!.values, [3, 3], "residual = day total − named sum (45 − 42)")
  assert.equal(cappedLayers[7]!.total, 6)
})

test("fetchOverview keeps deriving KPI fields from the v0.11.0 bare-array /trend wire", async () => {
  // /api/trend has a second consumer: the KPI cards derive today/yesterday
  // splits from the same endpoint. When the wire grew point-level byModel,
  // a normalize that mistook the new bare array for the old one would hand
  // back [] and every derived field would degrade to —. This locks the
  // end-to-end path: bare-array wire (with per-point byModel Records) →
  // normalizeTrendPayload().points → deriveOverviewExtension.
  const { fetchOverview } = await import("../src/web/public/data-source.js")

  const overviewBodyFixture = {
    todayTokens: 90,
    totalTokens: 1_000,
    totalCost: 0,
    sessionCount: 5,
    stepCount: 42,
    todayHitRate: 0.9,
  }
  const trendPointsFixture = [
    dailyTrendPointFixture("2026-10-01", 100, 400, 50),
    dailyTrendPointFixture("2026-10-02", 120, 480, 60),
    dailyTrendPointFixture("2026-10-03", 140, 560, 70),
  ]
  // The real wire: a bare array whose points carry point-level byModel
  // Records (the v0.11.0 shape the probe observed on the live route).
  const trendWireFixture = trendPointsFixture.map((trendPoint, pointIndex) => ({
    ...trendPoint,
    byModel: { "model-example-alpha": 100 + pointIndex * 10, "model-example-beta": 90 - pointIndex * 10 },
  }))

  const savedFetch = globalThis.fetch
  globalThis.fetch = (async (fetchInput: unknown) => {
    const requestUrl = String(fetchInput)
    if (requestUrl.includes("/overview")) {
      return { ok: true, status: 200, json: async () => overviewBodyFixture }
    }
    if (requestUrl.includes("/trend")) {
      return { ok: true, status: 200, json: async () => trendWireFixture }
    }
    return { ok: false, status: 404, json: async () => ({}) }
  }) as unknown as typeof fetch

  try {
    const overviewExtension = await fetchOverview()
    const lastPoint = trendPointsFixture[2]!
    const previousPoint = trendPointsFixture[1]!
    assert.equal(overviewExtension.todayInput, lastPoint.input, "today split derives from the last trend point")
    assert.equal(overviewExtension.todayOutput, lastPoint.output)
    assert.equal(overviewExtension.todaySteps, lastPoint.steps)
    assert.equal(overviewExtension.yesterdayHitRate, previousPoint.hitRate)
    assert.equal(overviewExtension.yesterdaySteps, previousPoint.steps)
    assert.deepEqual(overviewExtension.sparklineTokens, [550, 660, 770], "the sparkline window derives from the same trend payload")
    assert.equal(overviewExtension.sessionCount, 5, "overview-body fields still pass through")
  } finally {
    globalThis.fetch = savedFetch
  }
})

test("sessionsExportCsvPath and the export entry carry the range alongside the directory", async () => {
  const { sessionsExportCsvPath } = await import("../src/web/public/data-source.js")
  const { sessionsCsvExportEntryHtml } = await import(
    "../src/web/public/components/session-csv-export.js"
  )

  // Single construction point: both params in one query string, directory
  // first, range second; empty/absent dims never emit their segment.
  assert.equal(sessionsExportCsvPath(null, "7d"), "/api/export/sessions.csv?range=7d")
  assert.equal(
    sessionsExportCsvPath("D:/projects/example-alpha", "30d"),
    "/api/export/sessions.csv?directory=D%3A%2Fprojects%2Fexample-alpha&range=30d",
  )
  assert.equal(
    sessionsExportCsvPath("D:/projects/example-alpha", ""),
    "/api/export/sessions.csv?directory=D%3A%2Fprojects%2Fexample-alpha",
  )
  assert.equal(sessionsExportCsvPath(null, ""), "/api/export/sessions.csv")

  // The entry's title explains the export scope per filter combination.
  // The ampersand inside the rendered href is attribute-escaped (escapeHtml
  // defense-in-depth on the href insertion point); it is assembled at
  // runtime below so the source carries no literal "&" run.
  const escapedAmpersand = "&" + "amp;"
  const bothFiltersEntryHtml = sessionsCsvExportEntryHtml("D:/projects/example-alpha", "30d", true)
  assert.ok(
    bothFiltersEntryHtml.includes(`href="/api/export/sessions.csv?directory=D%3A%2Fprojects%2Fexample-alpha${escapedAmpersand}range=30d"`),
  )
  assert.match(bothFiltersEntryHtml, /导出当前目录下最近 30d有更新的会话/)
  const rangeOnlyEntryHtml = sessionsCsvExportEntryHtml(null, "7d", true)
  assert.ok(rangeOnlyEntryHtml.includes('href="/api/export/sessions.csv?range=7d"'))
  assert.match(rangeOnlyEntryHtml, /导出最近 7d有更新的会话/)
  const unfilteredEntryHtml = sessionsCsvExportEntryHtml(null, "", true)
  assert.ok(unfilteredEntryHtml.includes('href="/api/export/sessions.csv"'))
  assert.match(unfilteredEntryHtml, /导出全部会话/)
})

test("renderSessionList states the active range in the footnote and threads it into the export href", async () => {
  const { renderSessionList } = await import(
    "../src/web/public/components/session-list.js"
  )
  const container = freshContainer()

  // Directory + range stack in the footnote language; the export href
  // carries both params.
  renderSessionList(container, sessionSortFixturePayload(), null, "time_updated", "desc", null, "D:/projects/example-alpha", "7d")
  assert.match(container.innerHTML, /目录：D:\/projects\/example-alpha · 最近 7d/)
  assert.ok(
    // Attribute-escaped ampersand in the anchor href (same escapeHtml
    // insertion point as every other external string); assembled at
    // runtime to keep the source free of a literal "&" run.
    container.innerHTML.includes(`href="/api/export/sessions.csv?directory=D%3A%2Fprojects%2Fexample-alpha${"&" + "amp;"}range=7d"`),
    "the export href threads the range through the same single point",
  )

  // Default range (All) → no range part in the footnote, bare-ish export path.
  renderSessionList(container, sessionSortFixturePayload(), null, "time_updated", "desc", null, null, "")
  assert.ok(!container.innerHTML.includes("最近 7d"), "no range part without an active range")
  assert.ok(container.innerHTML.includes('href="/api/export/sessions.csv"'))
})

test("getMockSessions mirrors the backend range contract: whitelist filter on timeUpdated, absent/empty = all, unknown non-empty throws", async () => {
  const { getMockSessions } = await import("../src/web/public/mock-data.js")
  const unfilteredPage = getMockSessions()

  // null / "" are both "no filter" — identical to the unfiltered call.
  assert.deepEqual(getMockSessions("time_updated", "desc", null, ""), unfilteredPage)
  assert.deepEqual(getMockSessions("time_updated", "desc", null, null), unfilteredPage)

  // 7d: keeps only recently updated sessions. Boundary assertions are
  // two-sided around the mock's internal now(): cutoffBefore taken before
  // the call, cutoffAfter after — the kept set is pinned between them with
  // no millisecond-race window (deterministic, unlike a single equality).
  const cutoffBeforeMs = Date.now() - 7 * 86_400_000
  const filteredByWeekPage = getMockSessions("time_updated", "desc", null, "7d")
  const cutoffAfterMs = Date.now() - 7 * 86_400_000
  assert.ok(
    filteredByWeekPage.sessions.every((session) => session.timeUpdated >= cutoffBeforeMs),
    "every kept session was updated within the last 7 days",
  )
  const keptIds = new Set(filteredByWeekPage.sessions.map((session) => session.id))
  for (const unfilteredSession of unfilteredPage.sessions) {
    if (unfilteredSession.timeUpdated >= cutoffAfterMs) {
      assert.ok(
        keptIds.has(unfilteredSession.id),
        "a session updated within the window must not be dropped by the 7d filter",
      )
    }
  }
  assert.equal(
    filteredByWeekPage.total,
    null,
    "a range-filtered page carries no total — same degradation as the directory filter",
  )

  // The fixture spans roughly the last 8 days, so wider ranges keep all.
  assert.equal(getMockSessions("time_updated", "desc", null, "30d").sessions.length, unfilteredPage.sessions.length)
  assert.equal(getMockSessions("time_updated", "desc", null, "90d").sessions.length, unfilteredPage.sessions.length)

  // Range stacks with the directory filter (AND).
  const firstDirectory = unfilteredPage.sessions[0]!.directory
  const stackedPage = getMockSessions("time_updated", "desc", firstDirectory, "90d")
  assert.ok(stackedPage.sessions.length > 0)
  assert.ok(stackedPage.sessions.every((session) => session.directory === firstDirectory))
  assert.equal(stackedPage.total, null)

  // Unknown non-empty range mirrors the backend 400 — mock refuses to
  // serve dirty data for a value outside the wire vocabulary.
  assert.throws(
    () => getMockSessions("time_updated", "desc", null, "14d"),
    /unknown range/,
  )
})

/* ------------- model-table token 占比 column (v0.12.0) ------------- */

/** Fictional ModelMetric fixture (example ids only). tokenShare is deliberately
 * NOT defaulted: a fixture without the field is exactly the old wire. */
function modelMetricFixture(overrides: Record<string, unknown>) {
  return {
    modelId: "model-example-alpha",
    providerId: "provider-example",
    steps: 120,
    tokens: 10_000,
    hitRate: 0.95,
    outputPerStep: 800,
    contextMedian: 64_000,
    contextP95: 128_000,
    reasoningShare: 0.2,
    firstSeen: 1_700_000_000_000,
    lastSeen: 1_760_000_000_000,
    ...overrides,
  }
}

type ModelMetricFixture = ReturnType<typeof modelMetricFixture>

const noopModelSelect = () => {}

function clickModelColumnHeader(container: StubElement, columnKey: string): void {
  const headerCell = container
    .querySelectorAll("th.sortable")
    .find((sortableHeader) => sortableHeader.dataset.key === columnKey)!
  headerCell.click()
}

/** Body-row model ids in DOM order. The shim parses opening tags flat in
 * document order, so "tr" + data-model filtering yields the rendered sort
 * order (thead tr carries no data-model and drops out). */
function modelBodyRowOrder(container: StubElement): Array<string | undefined> {
  return container
    .querySelectorAll("tr")
    .filter((rowElement) => rowElement.dataset.model !== undefined)
    .map((rowElement) => rowElement.dataset.model)
}

/**
 * 模块级 sortKey/sortDirection 跨测试残留（model-table 既有隐患）——每个
 * 用例先把排序态定态到自证状态再断言：点击目标列后 sortKey 必落在该列，
 * 方向未知（可能是残留翻转态），按渲染出的箭头方向补一次点击钉死。无论
 * 进入用例时的残留是什么、其他测试以何种顺序执行，返回后状态必为
 * (columnKey, wantedDirection)。
 */
async function pinModelSortState(
  modelMetrics: ModelMetricFixture[],
  columnKey: string,
  wantedDirection: "asc" | "desc",
): Promise<void> {
  const { renderModelTable } = await import("../src/web/public/components/model-table.js")
  const stateContainer = freshContainer()
  renderModelTable(stateContainer, modelMetrics, null, noopModelSelect)
  clickModelColumnHeader(stateContainer, columnKey)
  // 点击后唯一的 sort-arrow 在目标列上（sortKey 已落定），▲ 即 asc。
  const isAscendingAfterFirstClick = stateContainer.innerHTML.includes("▲")
  if ((wantedDirection === "asc") !== isAscendingAfterFirstClick) {
    clickModelColumnHeader(stateContainer, columnKey)
  }
}

test("renderModelTable renders the v0.12.0 token 占比 column next to 总 token", async () => {
  const { renderModelTable } = await import("../src/web/public/components/model-table.js")
  // 先把模块级排序态定态到默认态（tokens desc），下述「默认渲染」断言才自证。
  await pinModelSortState(
    [
      modelMetricFixture({ modelId: "model-example-alpha", tokens: 4270, tokenShare: 0.427 }),
      modelMetricFixture({ modelId: "model-example-bravo", tokens: 3010, tokenShare: 0.301 }),
      modelMetricFixture({ modelId: "model-example-charlie", tokens: 2720, tokenShare: 0.272 }),
    ],
    "tokens",
    "desc",
  )

  const container = freshContainer()
  renderModelTable(container, [
    modelMetricFixture({ modelId: "model-example-alpha", tokens: 4270, tokenShare: 0.427 }),
    modelMetricFixture({ modelId: "model-example-bravo", tokens: 3010, tokenShare: 0.301 }),
    modelMetricFixture({ modelId: "model-example-charlie", tokens: 2720, tokenShare: 0.272 }),
  ], null, noopModelSelect)

  const sortableHeaders = container.querySelectorAll("th.sortable")
  assert.equal(sortableHeaders.length, 11, "the v0.12.0 table carries 11 sortable columns")
  assert.deepEqual(
    sortableHeaders.map((headerCell) => headerCell.dataset.key),
    [
      "modelId", "providerId", "steps", "tokens", "tokenShare",
      "hitRate", "outputPerStep", "contextMedian", "contextP95", "reasoningShare", "seenRange",
    ],
    "tokenShare sits immediately after tokens — a share reads against its absolute base",
  )
  // The new column is numeric: right-aligned via the num class like every other metric.
  const tokenShareHeader = sortableHeaders
    .find((headerCell) => headerCell.dataset.key === "tokenShare")!
  assert.ok(tokenShareHeader.classTokenList().includes("num"))

  // Share cells render as bare 2-decimal percents. 2 digits (not 1, and not
  // the 推理占比 column's 0 digits) is the v0.12.1 display ruling: a live
  // 85-model window rendered 55 rows as a useless "0.0%" at 1 digit — the
  // second decimal keeps the 0.05%–1% long tail readable.
  assert.ok(container.innerHTML.includes('<td class="num">42.70%</td>'), "0.427 renders as 42.70%")
  assert.ok(container.innerHTML.includes('<td class="num">30.10%</td>'))
  assert.ok(container.innerHTML.includes('<td class="num">27.20%</td>'))

  // Default sort state (pinned above): exactly the tokens column sorted desc.
  const sortedHeaders = container.querySelectorAll("th.sorted")
  assert.equal(sortedHeaders.length, 1)
  assert.equal(sortedHeaders[0]!.dataset.key, "tokens")
  assert.match(container.innerHTML, /总 token\s*<span class="sort-arrow">▼<\/span>/)
})

test("renderModelTable tokenShare header: first click desc (new-column contract), repeat click flips asc", async () => {
  const { renderModelTable } = await import("../src/web/public/components/model-table.js")
  // Shares deliberately NOT proportional to tokens: proves the comparator
  // reads tokenShare itself (an accidental tokens sort would keep row order).
  const shareSortMetrics = [
    modelMetricFixture({ modelId: "model-example-alpha", tokens: 400, tokenShare: 0.4 }),
    modelMetricFixture({ modelId: "model-example-bravo", tokens: 300, tokenShare: 0.5 }),
    modelMetricFixture({ modelId: "model-example-charlie", tokens: 200, tokenShare: 0.1 }),
  ]

  // 先定态到 tokens desc：「新列首点 desc」契约必须在任意残留态下成立，
  // 而不是只在默认态下碰巧成立。
  await pinModelSortState(shareSortMetrics, "tokens", "desc")
  const container = freshContainer()
  renderModelTable(container, shareSortMetrics, null, noopModelSelect)
  assert.deepEqual(
    modelBodyRowOrder(container),
    ["model-example-alpha", "model-example-bravo", "model-example-charlie"],
    "tokens desc ranking before the interaction",
  )

  // First click on the fresh column → desc (the pinned model-table contract).
  clickModelColumnHeader(container, "tokenShare")
  assert.match(container.innerHTML, /token 占比\s*<span class="sort-arrow">▼<\/span>/)
  assert.deepEqual(
    modelBodyRowOrder(container),
    ["model-example-bravo", "model-example-alpha", "model-example-charlie"],
    "share desc: bravo 0.5 > alpha 0.4 > charlie 0.1 — reorders against the tokens ranking",
  )

  // Repeat click on the same column flips the direction.
  clickModelColumnHeader(container, "tokenShare")
  assert.match(container.innerHTML, /token 占比\s*<span class="sort-arrow">▲<\/span>/)
  assert.deepEqual(
    modelBodyRowOrder(container),
    ["model-example-charlie", "model-example-alpha", "model-example-bravo"],
    "share asc flips the ranking",
  )
})

test("renderModelTable degrades absent and NaN tokenShare (old-wire window) without crashing", async () => {
  const { renderModelTable } = await import("../src/web/public/components/model-table.js")
  // Old wire (pre-v0.12.0 host: field absent) + a dirty NaN + an honest zero
  // (the denominator-0 wire sends real zeros — those must render, not degrade).
  const oldWireMetrics = [
    modelMetricFixture({ modelId: "model-example-alpha", tokens: 900 }),                    // field absent
    modelMetricFixture({ modelId: "model-example-bravo", tokens: 500, tokenShare: 0 }),     // honest zero
    modelMetricFixture({ modelId: "model-example-charlie", tokens: 100, tokenShare: NaN }), // dirty value
  ]

  const container = freshContainer()
  renderModelTable(container, oldWireMetrics, null, noopModelSelect)

  // Absent and NaN both degrade to —; a missing share must never pose as a
  // real "0.00%" (the top-ranked model claiming zero share is a lie).
  assert.equal(
    (container.innerHTML.match(/<td class="num">—<\/td>/g) ?? []).length,
    2,
    "absent (old wire) and NaN shares degrade to —",
  )
  assert.ok(
    container.innerHTML.includes('<td class="num">0.00%</td>'),
    "a finite zero share is a real value and renders as 0.00%",
  )
  // The hitRate stays healthy in the fixture — proves the — cells belong to
  // the share column, not a degraded hitRate cell.
  assert.ok(container.innerHTML.includes("95.0%"))

  // Sorting interaction survives the old wire: every share falls back to
  // ?? 0 in the comparator (NaN compares as +0 per spec) → all-tie → the
  // stable sort keeps the wire order, whatever direction residue holds.
  assert.doesNotThrow(() => clickModelColumnHeader(container, "tokenShare"))
  assert.match(container.innerHTML, /token 占比\s*<span class="sort-arrow">[▼▲]<\/span>/)
  assert.deepEqual(
    modelBodyRowOrder(container),
    ["model-example-alpha", "model-example-bravo", "model-example-charlie"],
    "all-tie share sort keeps the wire order (stable sort)",
  )
})

test("getMockModelMetrics mirrors the v0.12.0 tokenShare wire: per-model tokens/Σtokens, Σ shares = 1", async () => {
  const { getMockModelMetrics } = await import("../src/web/public/mock-data.js")
  const { renderModelTable } = await import("../src/web/public/components/model-table.js")

  const mockMetrics = getMockModelMetrics()
  const totalMockTokens = mockMetrics.reduce((sum, metric) => sum + metric.tokens, 0)
  assert.ok(totalMockTokens > 0, "the mock window carries tokens, so the denominator is real")

  // Wire shape: raw 0..1 fractions on every model — same form the backend sends.
  assert.ok(mockMetrics.every((metric) =>
    Number.isFinite(metric.tokenShare) && metric.tokenShare >= 0 && metric.tokenShare <= 1))

  // Self-consistency: Σ shares = 1 and each share is the model's own fraction
  // of the same window the tokens ranking reads.
  const shareSum = mockMetrics.reduce((sum, metric) => sum + metric.tokenShare, 0)
  assert.ok(Math.abs(shareSum - 1) < 1e-9, "share denominators cover the full window")
  assert.ok(mockMetrics.every((metric) =>
    Math.abs(metric.tokenShare * totalMockTokens - metric.tokens) < 1e-6),
    "tokenShare = tokens / Σ tokens per model",
  )

  // The mock path renders share cells in place: every model row carries a
  // bare 2-decimal percent cell (the only such bare td — hitRate is span-
  // wrapped and 推理占比 renders 0-digit integers).
  const container = freshContainer()
  renderModelTable(container, mockMetrics, null, noopModelSelect)
  const shareCellMatches = container.innerHTML.match(/<td class="num">\d+\.\d{2}%<\/td>/g) ?? []
  assert.equal(shareCellMatches.length, mockMetrics.length, "every model row renders its tokenShare cell")
  assert.ok(
    !container.innerHTML.includes('<td class="num">—</td>'),
    "no share degrades on the mock path — all shares are real numbers",
  )
})

/* ------------- tooltip XSS regression lock (v0.1.1 P0-2) ------------- */

/**
 * The v0.1.1 P0-2 fix (hostile MCP tool names / modelId flowing into
 * tooltip.innerHTML unescaped) was verified once by a throwaway smoke
 * script that never entered the repo — removing the escaping kept all
 * 347 tests green. This section turns that smoke into a durable
 * regression lock: the P0 payload shapes must reach the DOM as text,
 * never as markup. The shim's flat-tag parser carries the structural
 * half: an unescaped "<img …>" becomes a real parsed <img> tag here,
 * so "no img/script/svg tag in the tooltip subtree" goes loudly red
 * the moment the escaping regresses.
 */

/** The single #tooltip stub: tooltip.js caches it after its first lookup. */
const sharedTooltipElement = new StubElement("div")

// tooltip.js is the only render-time getElementById consumer among the
// tested modules (app.js is not imported here), so serving the #tooltip
// stub — and null for everything else — cannot leak into other tests.
globalThis.document.getElementById = ((elementId: string) =>
  elementId === "tooltip" ? sharedTooltipElement : null) as unknown as Document["getElementById"]

test("showTooltip renders the P0 payload shapes as text and hideTooltip closes the tooltip", async () => {
  const { showTooltip, hideTooltip } = await import("../src/web/public/tooltip.js")
  const { escapeHtml } = await import("../src/web/public/format.js")

  // The original P0 injection sources in their smoke shapes: a hostile
  // MCP tool name and a hostile modelId.
  const hostileToolName = '<img src=x onerror=alert(1)>'
  const hostileModelId = '"><script>alert(2)</script>'

  showTooltip({
    title: hostileModelId,
    rows: [
      // Hostile swatch: the color whitelist (v0.2.1 P2-5) must reject it
      // outright — it may not reach the style attribute in any form.
      { swatch: '"><svg onload=alert(3)>', label: hostileToolName, value: "42,000" },
      { swatch: "var(--blue)", label: "example-tool-benign", value: "1,000" },
    ],
    clientX: 100,
    clientY: 100,
  })

  assert.equal(sharedTooltipElement.hidden, false, "showTooltip reveals the tooltip")
  const renderedTooltipHtml = sharedTooltipElement.innerHTML
  // Every external string reaches the DOM html-escaped…
  assert.ok(
    renderedTooltipHtml.includes(escapeHtml(hostileModelId)),
    "the hostile modelId must reach the title as escaped text",
  )
  assert.ok(
    renderedTooltipHtml.includes(escapeHtml(hostileToolName)),
    "the hostile tool name must reach the row label as escaped text",
  )
  // …and never raw.
  assert.ok(!renderedTooltipHtml.includes(hostileToolName), "no raw tool name may reach the DOM")
  assert.ok(!renderedTooltipHtml.includes(hostileModelId), "no raw modelId may reach the DOM")
  // Structural proof: had the escaping regressed, the shim would have
  // parsed the payloads into real img / script / svg elements.
  assert.equal(
    sharedTooltipElement.querySelectorAll("img").length,
    0,
    "no <img> tag may parse out of the tool name",
  )
  assert.equal(
    sharedTooltipElement.querySelectorAll("script").length,
    0,
    "no <script> tag may parse out of the modelId",
  )
  assert.equal(
    sharedTooltipElement.querySelectorAll("svg").length,
    0,
    "no <svg> tag may parse out of the hostile swatch",
  )
  // The hostile swatch is whitelist-rejected (no second color dot);
  // exactly the whitelisted var(--blue) swatch renders.
  assert.equal(
    sharedTooltipElement.querySelectorAll("span.swatch").length,
    1,
    "only the whitelisted swatch renders a color dot",
  )

  hideTooltip()
  assert.equal(sharedTooltipElement.hidden, true, "hideTooltip hides the tooltip again")
})

test("bindHoverTooltip routes payloadBuilder output through the same escaping and a null payload never shows the tooltip", async () => {
  const { bindHoverTooltip } = await import("../src/web/public/tooltip.js")
  const { escapeHtml } = await import("../src/web/public/format.js")

  const hostileToolName = '<img src=x onerror=alert(1)>'
  const hostileModelId = '"><script>alert(2)</script>'
  const hoverHostElement = freshContainer()

  let nextHoverPayload: unknown = {
    title: hostileModelId,
    rows: [{ label: hostileToolName, value: "7,500" }],
    clientX: 50,
    clientY: 70,
  }
  bindHoverTooltip(hoverHostElement, () => nextHoverPayload)

  // mouseenter → show through the payloadBuilder path, escaped exactly
  // like the direct showTooltip entry.
  hoverHostElement.fire("mouseenter")
  assert.equal(sharedTooltipElement.hidden, false, "the hover payload reveals the tooltip")
  assert.ok(
    sharedTooltipElement.innerHTML.includes(escapeHtml(hostileToolName)),
    "the builder-supplied tool name must be escaped",
  )
  assert.equal(
    sharedTooltipElement.querySelectorAll("img").length,
    0,
    "no <img> tag may parse out of the builder payload",
  )

  // mousemove with a live payload only repositions the tooltip.
  hoverHostElement.fire("mousemove", { clientX: 300, clientY: 200 })
  assert.equal(sharedTooltipElement.style.left, "314px", "moveTooltip tracks the mouse (300 + 14 margin)")
  assert.equal(sharedTooltipElement.style.top, "214px", "moveTooltip tracks the mouse (200 + 14 margin)")

  // mouseleave hides; a later null payload must not resurrect it.
  hoverHostElement.fire("mouseleave")
  assert.equal(sharedTooltipElement.hidden, true, "mouseleave hides the tooltip")
  nextHoverPayload = null
  hoverHostElement.fire("mouseenter")
  assert.equal(
    sharedTooltipElement.hidden,
    true,
    "a null payload from the builder must never (re-)show the tooltip",
  )
})

/* --------------------- kpi-card component --------------------- */

/** Fictional KPI overview fixture (example values only). */
function kpiOverviewFixture(overrides: Record<string, unknown> = {}) {
  return {
    todayTokens: 500_000,
    yesterdayTokens: 400_000,
    todayInput: 50_000,
    todayOutput: 25_000,
    todayHitRate: 0.97,
    yesterdayHitRate: 0.95,
    todaySteps: 120,
    yesterdaySteps: 100,
    totalTokens: 12_000_000,
    totalCost: 0,
    sessionCount: 480,
    stepCount: 9_600,
    todayCostEstimateUsd: 0.07,
    sparklineTokens: [400_000, 500_000, 450_000, 500_000],
    sparklineHitRate: [0.95, 0.96, 0.97, 0.97],
    sparklineSteps: [80, 90, 110, 120],
    sparklineSessions: [3, 4, 5, 6],
    ...overrides,
  }
}

test("renderKpiRow renders the four cards with precision badges, delta directions and the sparkline data entry", async () => {
  const { renderKpiRow } = await import("../src/web/public/components/kpi-card.js")
  const container = freshContainer()

  renderKpiRow(container, kpiOverviewFixture())

  // Four cards in the fixed tone order.
  const cardElements = container.querySelectorAll("article.kpi-card")
  assert.equal(cardElements.length, 4, "the KPI row renders exactly four cards")
  assert.deepEqual(
    cardElements.map((cardElement) => cardElement.attributes.get("data-tone")),
    ["tokens", "hitrate", "steps", "sessions"],
    "card order: tokens / hitrate / steps / sessions",
  )

  const renderedHtml = container.innerHTML
  // Precision calibration: every card head claims 实值 (raw DB counts), and
  // only the cost-estimate line inside the tokens card claims 估算.
  assert.equal(
    container.querySelectorAll("span.precision.exact").length,
    4,
    "every card head carries an exact precision badge",
  )
  assert.equal(
    container.querySelectorAll("span.precision.estimate").length,
    1,
    "exactly the cost-estimate line carries an estimate badge",
  )
  assert.ok(renderedHtml.includes(">实值</span>"), "exact badges read 实值")
  assert.ok(renderedHtml.includes(">估算</span>"), "the estimate badge reads 估算")

  // Delta direction and wording per comparison face: ratio deltas carry
  // % and the hit-rate point delta carries pp — each with the ▲ up arrow.
  assert.ok(
    renderedHtml.includes('<span class="delta up">▲ 25.0%</span>'),
    "tokens delta: 500K vs 400K → up ratio 25.0%",
  )
  assert.ok(
    renderedHtml.includes('<span class="delta up">▲ 2.0pp</span>'),
    "hit-rate delta: 0.97 vs 0.95 → up point delta 2.0pp",
  )
  assert.ok(
    renderedHtml.includes('<span class="delta up">▲ 20.0%</span>'),
    "steps delta: 120 vs 100 → up ratio 20.0%",
  )
  assert.ok(!renderedHtml.includes("持平"), "no flat badge when every metric moved")
  assert.ok(!renderedHtml.includes("— 环比"), "no missing-base badge in a full fixture")

  // The sessions card is cumulative — no delta badge, its sub line reports
  // the 14-day daily average: round((3+4+5+6)/4) = 5.
  assert.ok(renderedHtml.includes("近 14 日均"), "the sessions sub states the 14-day window")
  assert.ok(renderedHtml.includes('<span class="num">5</span> 个/天'))

  // Sparkline data entry: four window values → four polyline anchors on
  // the 0..100 x grid, closing at x=100; every card renders one spark.
  const sparkPolylineElements = container.querySelectorAll("polyline")
  assert.equal(sparkPolylineElements.length, 4, "every card renders its sparkline")
  const tokensSparkAnchors = (sparkPolylineElements[0]!.attributes.get("points") ?? "").split(" ")
  assert.equal(tokensSparkAnchors.length, 4, "4 window values → 4 polyline anchors")
  assert.ok(
    tokensSparkAnchors[3]!.startsWith("100.00,"),
    "the last anchor closes the x grid at 100 (data length drives the grid)",
  )
})

test("renderKpiRow degrades flat and missing deltas, handles degenerate sparklines and skeletons a null overview", async () => {
  const { renderKpiRow } = await import("../src/web/public/components/kpi-card.js")
  const container = freshContainer()

  // Flat delta (steps unchanged), missing comparison base (yesterdayTokens
  // absent → "— 环比"), a constant sparkline (the max===min degenerate
  // branch must not NaN) and a one-point sparkline (below the 2-value
  // floor → the spark is omitted entirely).
  renderKpiRow(container, kpiOverviewFixture({
    yesterdayTokens: undefined,
    yesterdaySteps: 120,
    sparklineTokens: [5, 5, 5],
    sparklineSessions: [4],
  }))

  const renderedHtml = container.innerHTML
  assert.ok(
    renderedHtml.includes('<span class="delta flat">— 环比</span>'),
    "a missing comparison base degrades to the — 环比 badge",
  )
  assert.ok(
    renderedHtml.includes('<span class="delta flat">持平</span>'),
    "an unchanged metric renders the 持平 badge",
  )

  // Constant sparkline: three identical anchors, NaN-free. With min=max
  // the branch widens the range by +1 before the 12% padding, so every
  // anchor lands at y=27.10 on the 30-high grid.
  assert.ok(!renderedHtml.includes("NaN"), "the degenerate max===min sparkline must not NaN")
  assert.equal(
    container.querySelectorAll("polyline")[0]!.attributes.get("points"),
    "0.00,27.10 50.00,27.10 100.00,27.10",
    "the constant sparkline renders three finite anchors",
  )
  // The one-point sessions sparkline is below sparklineSvg's 2-value floor:
  // three sparks remain, the sessions card keeps its text sub only.
  assert.equal(
    container.querySelectorAll("svg.kpi-spark").length,
    3,
    "a sparkline with fewer than 2 values renders no svg at all",
  )

  // overview null → single-block loading skeleton (app.js re-calls later).
  const nullOverviewContainer = freshContainer()
  renderKpiRow(nullOverviewContainer, null)
  assert.equal(
    nullOverviewContainer.querySelectorAll(".skeleton-block").length,
    1,
    "a null overview renders the one-block loading skeleton",
  )
  assert.ok(nullOverviewContainer.innerHTML.includes('aria-busy="true"'))
})

/* ------- v0.1.0 legacy panels: audit ⚠#2 test-surface backfill -------
 *
 * The "new frontend panels must enter web-components.test.ts" rule
 * shipped in v0.3.1, leaving the v0.1.0 panels permanently untested here
 * (tooltip + kpi-card were backfilled in 0.15.2; this section covers the
 * rest: calendar-heatmap, token-funnel, tool-bars, state-views,
 * replay-turn-bar, theme — plus one more real seam on trend-chart).
 * Same DOM shim, same flat-tag parser, same shared #tooltip stub as the
 * sections above; fixtures stay in the example series (no real paths,
 * user names or model ids).
 */

/* ------------- calendar-heatmap panel (v0.1.0) ------------- */

/**
 * Fictional daily trend points for the calendar fixtures: consecutive
 * calendar days starting at firstDateKey, the given per-day token totals
 * (all in input) and a distinguishable per-day step count.
 */
function calendarTrendFixture(dailyTotals: number[], firstDateKey: string) {
  const [startYear, startMonth, startDay] = firstDateKey.split("-").map(Number)
  return dailyTotals.map((dayTotal, dayIndex) => {
    const calendarDate = new Date(startYear, startMonth - 1, startDay + dayIndex)
    const dateKey = `${calendarDate.getFullYear()}-${String(calendarDate.getMonth() + 1).padStart(2, "0")}-${String(calendarDate.getDate()).padStart(2, "0")}`
    return {
      date: dateKey,
      steps: dayIndex + 1,
      input: dayTotal,
      read: 0,
      output: 0,
      hitRate: 0.9,
    }
  })
}

test("renderCalendarHeatmap renders one themed cell per data day with Monday alignment and quantile color levels", async () => {
  const { renderCalendarHeatmap } = await import("../src/web/public/components/calendar-heatmap.js")
  const container = freshContainer()

  // Seven days starting Wednesday 2026-01-07 with totals 100..700:
  // quantile thresholds [200, 400, 600, 700] → levels 1,1,2,2,3,3,4.
  renderCalendarHeatmap(container, { points: calendarTrendFixture([100, 200, 300, 400, 500, 600, 700], "2026-01-07") })

  const cellElements = container.querySelectorAll("rect.heatmap-cell")
  assert.equal(cellElements.length, 7, "exactly one cell renders per data day (no padding cells)")
  assert.deepEqual(
    cellElements.map((cell) => cell.dataset.dateIndex),
    ["0", "1", "2", "3", "4", "5", "6"],
    "cells carry the day index of their trend point",
  )

  // Level mapping: value quantiles drive the --heat-1..4 slots through cssVar.
  assert.equal(cellElements[0]!.attributes.get("fill"), "stub-css(--heat-1)", "100 → level 1")
  assert.equal(cellElements[2]!.attributes.get("fill"), "stub-css(--heat-2)", "300 → level 2")
  assert.equal(cellElements[4]!.attributes.get("fill"), "stub-css(--heat-3)", "500 → level 3")
  assert.equal(cellElements[6]!.attributes.get("fill"), "stub-css(--heat-4)", "700 → level 4")

  // Monday alignment: a Wednesday start lands on the third weekday row of
  // the first week column; 2026-01-12 (Monday) opens the next column.
  assert.equal(cellElements[0]!.attributes.get("x"), "30", "week-0 column starts after the label gutter")
  assert.equal(cellElements[0]!.attributes.get("y"), "48", "Wednesday = weekday row 2 (18 + 2×15)")
  assert.equal(cellElements[5]!.attributes.get("x"), "45", "2026-01-12 rolls into the week-1 column")
  assert.equal(cellElements[5]!.attributes.get("y"), "18", "Monday = first weekday row")

  const renderedHtml = container.innerHTML
  assert.ok(
    renderedHtml.includes('过去一年 <b class="num">2.8K</b> tokens · 活跃 <b class="num">7</b> 天'),
    "the meta line reports the year total (2800 → 2.8K) and the active-day count",
  )
  assert.equal(
    container.querySelectorAll(".cell-sample").length,
    5,
    "the scale legend renders the zero slot plus the four level slots",
  )
  // Weekday row labels 一/三/五, and the month label appears once (the
  // pre-range Monday padding days never reach the month-label branch).
  assert.ok(renderedHtml.includes(">一<") && renderedHtml.includes(">三<") && renderedHtml.includes(">五<"))
  assert.equal((renderedHtml.match(/>1月</g) ?? []).length, 1)
})

test("renderCalendarHeatmap labels the month when a week column first enters it", async () => {
  const { renderCalendarHeatmap } = await import("../src/web/public/components/calendar-heatmap.js")
  const container = freshContainer()

  // Monday 2026-01-26 → Monday 2026-02-02 spans a month change inside
  // the data range: week 0 opens with 1月, week 1 opens with 2月.
  renderCalendarHeatmap(container, { points: calendarTrendFixture([10, 20, 30, 40, 50, 60, 70, 80], "2026-01-26") })

  assert.equal(container.querySelectorAll("rect.heatmap-cell").length, 8)
  const renderedHtml = container.innerHTML
  assert.equal((renderedHtml.match(/>1月</g) ?? []).length, 1, "1月 is labeled exactly once")
  assert.equal((renderedHtml.match(/>2月</g) ?? []).length, 1, "2月 is labeled exactly once")
})

test("renderCalendarHeatmap degrades null and empty points to the empty placeholder", async () => {
  const { renderCalendarHeatmap } = await import("../src/web/public/components/calendar-heatmap.js")

  const nullContainer = freshContainer()
  renderCalendarHeatmap(nullContainer, null)
  assert.match(nullContainer.innerHTML, /没有历史日历数据/)
  assert.equal(nullContainer.querySelectorAll("rect.heatmap-cell").length, 0)

  const emptyPointsContainer = freshContainer()
  renderCalendarHeatmap(emptyPointsContainer, { points: [] })
  assert.match(emptyPointsContainer.innerHTML, /没有历史日历数据/)
  assert.equal(emptyPointsContainer.querySelectorAll("rect.heatmap-cell").length, 0)
})

test("renderCalendarHeatmap keeps a zero-activity window on the --heat-0 slot instead of vanishing", async () => {
  const { renderCalendarHeatmap } = await import("../src/web/public/components/calendar-heatmap.js")
  const container = freshContainer()

  // All-zero days: no quantile thresholds exist, but the days still render.
  renderCalendarHeatmap(container, { points: calendarTrendFixture([0, 0, 0], "2026-02-09") })

  const zeroCellElements = container.querySelectorAll("rect.heatmap-cell")
  assert.equal(zeroCellElements.length, 3, "zero-activity days still render their cells")
  for (const zeroCell of zeroCellElements) {
    assert.equal(zeroCell.attributes.get("fill"), "stub-css(--heat-0)")
  }
  assert.ok(container.innerHTML.includes('活跃 <b class="num">0</b> 天'), "the meta line reports zero active days")
  assert.ok(container.innerHTML.includes('<b class="num">0</b> tokens'), "the year total degrades to 0")
})

test("renderCalendarHeatmap wires per-cell hover tooltips with date, token total and step count", async () => {
  const { renderCalendarHeatmap } = await import("../src/web/public/components/calendar-heatmap.js")
  const container = freshContainer()
  renderCalendarHeatmap(container, { points: calendarTrendFixture([100, 200, 300, 400, 500, 600, 700], "2026-01-07") })

  const lastDayCell = container.querySelectorAll("rect.heatmap-cell")[6]!
  lastDayCell.fire("mouseenter")
  assert.equal(sharedTooltipElement.hidden, false, "hovering a cell reveals the shared tooltip")
  const tooltipHtml = sharedTooltipElement.innerHTML
  assert.ok(tooltipHtml.includes("2026-01-13"), "the tooltip title carries the hovered date")
  assert.ok(tooltipHtml.includes("token 总量"))
  assert.ok(tooltipHtml.includes(">700</span>"), "the day token total is formatted into the tooltip")
  assert.ok(tooltipHtml.includes("步骤数"))
  assert.ok(tooltipHtml.includes(">7</span>"), "the day step count is formatted into the tooltip")
  lastDayCell.fire("mouseleave")
  assert.equal(sharedTooltipElement.hidden, true, "leaving the cell hides the tooltip again")
})

/* ------------- token-funnel panel (v0.1.0) ------------- */

/** Single-day trend payload for the funnel fixtures (example date). */
function funnelTrendFixture(inputTokens: number, readTokens: number, outputTokens: number) {
  return { points: [dailyTrendPointFixture("2026-10-01", inputTokens, readTokens, outputTokens)] }
}

/** Top-edge width of a funnel polygon (the proportional narrative point). */
function funnelPolygonTopWidth(polygonElement: StubElement): number {
  const pointsText = polygonElement.attributes.get("points") ?? ""
  const [topLeftPoint, topRightPoint] = pointsText.split(" ")
  return Number(topRightPoint.split(",")[0]) - Number(topLeftPoint.split(",")[0])
}

test("renderTokenFunnel renders the four proportional layers and returns the window summary", async () => {
  const { renderTokenFunnel } = await import("../src/web/public/components/token-funnel.js")
  const container = freshContainer()

  const funnelSummary = renderTokenFunnel(container, funnelTrendFixture(100, 300, 50))
  assert.deepEqual(funnelSummary, { windowHitRate: 0.75, supply: 400, cached: 300, paid: 100, output: 50 })

  const layerElements = container.querySelectorAll("g.funnel-layer")
  assert.equal(layerElements.length, 4)
  assert.deepEqual(
    layerElements.map((layerElement) => layerElement.dataset.layer),
    ["supply", "cached", "paid", "output"],
    "layer order follows the fixed funnel narrative",
  )
  assert.deepEqual(
    layerElements.map((layerElement) => layerElement.dataset.value),
    ["400", "300", "100", "50"],
    "each layer carries its window-summed token value",
  )
  assert.deepEqual(
    layerElements.map((layerElement) => layerElement.dataset.share),
    ["100.0", "75.0", "25.0", "12.5"],
    "each layer carries its share of the supply layer",
  )

  // Layer widths scale with the values: with supply 400 / cached 300 /
  // paid 100 / output 50 the top edges must keep the exact ratios.
  const polygonElements = container.querySelectorAll("polygon")
  assert.equal(polygonElements.length, 4, "every layer renders its trapezoid")
  const paidTopWidth = funnelPolygonTopWidth(polygonElements[2]!)
  assert.equal(funnelPolygonTopWidth(polygonElements[0]!), 4 * paidTopWidth, "supply width ∝ 400")
  assert.equal(funnelPolygonTopWidth(polygonElements[1]!), 3 * paidTopWidth, "cached width ∝ 300")
  assert.equal(funnelPolygonTopWidth(polygonElements[3]!), paidTopWidth / 2, "output width ∝ 50")

  assert.ok(container.innerHTML.includes("300 · 75.0%"), "the cached layer text shows value · share")
  assert.ok(container.innerHTML.includes("50 · 12.5%"), "the output layer text shows value · share")
})

test("renderTokenFunnel keeps a hairline for a zero-value layer instead of collapsing it", async () => {
  const { renderTokenFunnel } = await import("../src/web/public/components/token-funnel.js")
  const container = freshContainer()

  const funnelSummary = renderTokenFunnel(container, funnelTrendFixture(100, 300, 0))
  assert.equal((funnelSummary as { output: number }).output, 0)

  const layerElements = container.querySelectorAll("g.funnel-layer")
  assert.equal(layerElements.length, 4, "a zero output still renders all four layers")
  assert.equal(layerElements[3]!.dataset.value, "0")
  assert.equal(layerElements[3]!.dataset.share, "0.0")
  const outputTopWidth = funnelPolygonTopWidth(container.querySelectorAll("polygon")[3]!)
  assert.ok(
    outputTopWidth > 0 && outputTopWidth < 2,
    `the zero layer keeps a sub-pixel hairline, got ${outputTopWidth}`,
  )
})

test("renderTokenFunnel degrades null, empty and all-zero windows to the empty placeholder and returns null", async () => {
  const { renderTokenFunnel } = await import("../src/web/public/components/token-funnel.js")

  const nullContainer = freshContainer()
  assert.equal(renderTokenFunnel(nullContainer, null), null)
  assert.match(nullContainer.innerHTML, /这段范围内没有 token 流水/)

  const emptyPointsContainer = freshContainer()
  assert.equal(renderTokenFunnel(emptyPointsContainer, { points: [] }), null)
  assert.match(emptyPointsContainer.innerHTML, /这段范围内没有 token 流水/)

  const allZeroContainer = freshContainer()
  assert.equal(renderTokenFunnel(allZeroContainer, funnelTrendFixture(0, 0, 0)), null)
  assert.match(allZeroContainer.innerHTML, /这段范围内没有 token 流水/)
  assert.equal(allZeroContainer.querySelectorAll("g.funnel-layer").length, 0)
})

test("renderTokenFunnel wires per-layer hover tooltips with the token amount and supply share", async () => {
  const { renderTokenFunnel } = await import("../src/web/public/components/token-funnel.js")
  const container = freshContainer()
  renderTokenFunnel(container, funnelTrendFixture(100, 300, 50))

  const cachedLayer = container.querySelectorAll("g.funnel-layer")[1]!
  cachedLayer.fire("mouseenter")
  assert.equal(sharedTooltipElement.hidden, false, "hovering a layer reveals the shared tooltip")
  const tooltipHtml = sharedTooltipElement.innerHTML
  assert.ok(tooltipHtml.includes("缓存命中"), "the tooltip title names the layer")
  assert.ok(tooltipHtml.includes("token 量"))
  assert.ok(tooltipHtml.includes(">300</span>"), "the layer value is formatted into the tooltip")
  assert.ok(tooltipHtml.includes("占供给"))
  assert.ok(tooltipHtml.includes("75.0%"), "the supply share is formatted into the tooltip")
  cachedLayer.fire("mouseleave")
  assert.equal(sharedTooltipElement.hidden, true)
})

/* ------------- tool-bars panel (v0.1.0) ------------- */

/** Two agents sharing one tool name: aggregation must sum across agents. */
function toolBarsAgentStatsFixture() {
  return [
    { toolFingerprint: { "example-tool-read": 30, "example-tool-write": 20, "example-tool-short": 5 } },
    { toolFingerprint: { "example-tool-read": 10, "example-tool-other": 4 } },
  ]
}

test("renderToolBars aggregates tool counts across agents into descending bars with shares and the accent top row", async () => {
  const { renderToolBars } = await import("../src/web/public/components/tool-bars.js")
  const container = freshContainer()

  renderToolBars(container, toolBarsAgentStatsFixture())

  const rowElements = container.querySelectorAll("g.toolbar-row")
  assert.equal(rowElements.length, 4)
  assert.deepEqual(
    rowElements.map((rowElement) => rowElement.dataset.tool),
    ["example-tool-read", "example-tool-write", "example-tool-short", "example-tool-other"],
    "example-tool-read sums 30+10 across agents and ranks first",
  )
  assert.deepEqual(
    rowElements.map((rowElement) => rowElement.dataset.count),
    ["40", "20", "5", "4"],
  )
  assert.deepEqual(
    rowElements.map((rowElement) => rowElement.dataset.share),
    ["58.0", "29.0", "7.2", "5.8"],
    "shares are relative to the TOP10 total of 69",
  )

  // The flat parser lists every rect in document order; per row the markup
  // emits [track, bar], so bar of row i sits at 2i+1.
  const rectElements = container.querySelectorAll("rect")
  assert.equal(rectElements.length, 8, "each row renders its track plus its bar")
  const barWidths = rowElements.map(
    (_, rowIndex) => Number(rectElements[2 * rowIndex + 1]!.attributes.get("width")),
  )
  assert.equal(
    barWidths[0],
    Number(rectElements[0]!.attributes.get("width")),
    "the top row's bar saturates its track",
  )
  for (let rowIndex = 1; rowIndex < barWidths.length; rowIndex += 1) {
    assert.ok(
      barWidths[rowIndex]! < barWidths[rowIndex - 1]!,
      "bar widths strictly descend with the counts",
    )
  }
  assert.equal(rectElements[1]!.attributes.get("fill"), "stub-css(--accent)", "the top row takes the accent color")
  assert.equal(rectElements[3]!.attributes.get("fill"), "stub-css(--blue)", "lower rows take the regular bar color")
  assert.ok(container.innerHTML.includes(">40</text>"), "the raw call count is rendered")
  assert.ok(container.innerHTML.includes('aria-label="工具调用次数 TOP10"'))
})

test("renderToolBars caps the ranking at ten rows and clips long tool names for display", async () => {
  const { renderToolBars } = await import("../src/web/public/components/tool-bars.js")
  const container = freshContainer()

  const longToolName = "example-tool-with-a-very-long-name"
  const toolFingerprint: Record<string, number> = { [longToolName]: 200 }
  for (let rankIndex = 1; rankIndex <= 11; rankIndex += 1) {
    toolFingerprint[`example-t-${String(rankIndex).padStart(2, "0")}`] = 100 - rankIndex
  }

  renderToolBars(container, [{ toolFingerprint }])

  const rowElements = container.querySelectorAll("g.toolbar-row")
  assert.equal(rowElements.length, 10, "only the TOP10 render no matter how many tools exist")
  assert.equal(rowElements[0]!.dataset.tool, longToolName, "the ranking stays ordered by count desc")
  assert.equal(rowElements[0]!.dataset.count, "200")
  assert.equal(rowElements[1]!.dataset.tool, "example-t-01", "the runner-up is the second-highest count")
  assert.equal(rowElements[9]!.dataset.tool, "example-t-09", "the cut happens after the tenth row")
  assert.ok(
    container.innerHTML.includes(">example-tool…</text>"),
    "names longer than 13 characters clip to 12 characters plus an ellipsis for display",
  )
})

test("renderToolBars degrades null, empty and fingerprint-less agent stats to the empty placeholder", async () => {
  const { renderToolBars } = await import("../src/web/public/components/tool-bars.js")

  const nullContainer = freshContainer()
  renderToolBars(nullContainer, null)
  assert.match(nullContainer.innerHTML, /没有工具调用记录/)
  assert.ok(nullContainer.innerHTML.includes("数据库里还没有带 tool part 的 assistant 消息"))

  const emptyArrayContainer = freshContainer()
  renderToolBars(emptyArrayContainer, [])
  assert.match(emptyArrayContainer.innerHTML, /没有工具调用记录/)

  const fingerprintLessContainer = freshContainer()
  renderToolBars(fingerprintLessContainer, [{}, { toolFingerprint: {} }])
  assert.match(fingerprintLessContainer.innerHTML, /没有工具调用记录/)
  assert.equal(fingerprintLessContainer.querySelectorAll("g.toolbar-row").length, 0)
})

test("renderToolBars wires per-row hover tooltips with the call count and TOP10 share", async () => {
  const { renderToolBars } = await import("../src/web/public/components/tool-bars.js")
  const container = freshContainer()
  renderToolBars(container, toolBarsAgentStatsFixture())

  const topRow = container.querySelectorAll("g.toolbar-row")[0]!
  topRow.fire("mouseenter")
  assert.equal(sharedTooltipElement.hidden, false, "hovering a row reveals the shared tooltip")
  const tooltipHtml = sharedTooltipElement.innerHTML
  assert.ok(tooltipHtml.includes("example-tool-read"), "the tooltip title carries the full tool name")
  assert.ok(tooltipHtml.includes("调用次数"))
  assert.ok(tooltipHtml.includes(">40</span>"))
  assert.ok(tooltipHtml.includes("TOP10 占比"))
  assert.ok(tooltipHtml.includes("58.0%"))
  topRow.fire("mouseleave")
  assert.equal(sharedTooltipElement.hidden, true)
})

/* ------------- state-views panel (v0.1.0) ------------- */

test("renderLoading skeletons the tapering block widths and buildLoadingHtml mirrors it", async () => {
  const { renderLoading, buildLoadingHtml } = await import("../src/web/public/components/state-views.js")
  const container = freshContainer()

  renderLoading(container)
  const blockElements = container.querySelectorAll(".skeleton-block")
  assert.equal(blockElements.length, 3, "the default skeleton renders three blocks")
  assert.deepEqual(
    blockElements.map((blockElement) => blockElement.attributes.get("style")),
    ["width:88%", "width:76%", "width:55%"],
    "block widths taper 88 → 76 → 55 percent",
  )
  assert.ok(container.innerHTML.includes('aria-busy="true"'), "the skeleton marks itself aria-busy")

  const wideContainer = freshContainer()
  renderLoading(wideContainer, 4)
  assert.deepEqual(
    wideContainer.querySelectorAll(".skeleton-block").map((blockElement) => blockElement.attributes.get("style")),
    ["width:88%", "width:76%", "width:64%", "width:55%"],
    "a custom block count keeps the taper and ends at 55 percent",
  )
  assert.equal(wideContainer.innerHTML, buildLoadingHtml(4), "renderLoading is buildLoadingHtml into the container")
  assert.equal(
    buildLoadingHtml(1),
    '<div aria-busy="true"><div class="skeleton-block skeleton-text" style="width:55%"></div></div>',
    "a single-block skeleton renders exactly one 55 percent block",
  )
})

test("renderEmpty keeps the default copy, the rich-HTML message contract and the optional hint", async () => {
  const { renderEmpty, buildEmptyHtml } = await import("../src/web/public/components/state-views.js")

  const defaultContainer = freshContainer()
  renderEmpty(defaultContainer)
  assert.ok(defaultContainer.innerHTML.includes("这段范围内没有数据"), "no-arg calls use the default copy")
  assert.ok(!defaultContainer.innerHTML.includes("state-hint"), "no hint element renders without a hint")

  // Documented contract: message/hint are caller-owned HTML — the caller
  // may pass <b>-style rich text, exactly like app.js does.
  const richContainer = freshContainer()
  renderEmpty(richContainer, "<b>example-empty</b> 没有记录", "example-hint-text")
  assert.ok(richContainer.innerHTML.includes("<b>example-empty</b> 没有记录"))
  assert.ok(richContainer.innerHTML.includes('<div class="state-hint">example-hint-text</div>'))
  assert.equal(
    richContainer.innerHTML,
    buildEmptyHtml("<b>example-empty</b> 没有记录", "example-hint-text"),
    "renderEmpty is buildEmptyHtml into the container",
  )
  assert.equal(richContainer.querySelectorAll(".state-view").length, 1)
})

test("renderError escapes the message, degrades non-Error values and routes the retry click", async () => {
  const { renderError } = await import("../src/web/public/components/state-views.js")
  const { escapeHtml } = await import("../src/web/public/format.js")

  const hostileMessage = '<img src=x onerror=alert(1)>'
  const container = freshContainer()
  let retryClickCount = 0
  renderError(container, new Error(hostileMessage), () => {
    retryClickCount += 1
  })

  const renderedHtml = container.innerHTML
  assert.ok(renderedHtml.includes("这块数据没加载出来"), "the error state keeps its fixed headline")
  assert.ok(renderedHtml.includes(escapeHtml(hostileMessage)), "the message reaches the hint escaped")
  assert.ok(!renderedHtml.includes(hostileMessage), "the raw message never reaches the DOM")
  assert.equal(container.querySelectorAll("img").length, 0, "no <img> tag parses out of the message")
  container.querySelector(".retry-button")!.click()
  assert.equal(retryClickCount, 1, "the retry button routes the caller's onRetry")

  const nonErrorContainer = freshContainer()
  renderError(nonErrorContainer, 42, () => {})
  assert.ok(
    nonErrorContainer.innerHTML.includes(">42</div>"),
    "non-Error values degrade to String(value) in the hint",
  )
  assert.equal(nonErrorContainer.querySelectorAll(".retry-button").length, 1)
})

/* ------------- replay-turn-bar panel (v0.1.0) ------------- */

test("buildTurnCostBarElement splits the bar into proportional positive segments with a formatted total", async () => {
  const { buildTurnCostBarElement } = await import("../src/web/public/components/replay-turn-bar.js")

  const rowElement = buildTurnCostBarElement({ input: 100, output: 300, cache: { read: 100 } }, "model-example-alpha", false)
  assert.ok(rowElement !== null, "a positive token bar always renders")
  assert.ok(rowElement.classList.contains("turn-bar-row"))

  const segmentElements = rowElement.querySelectorAll(".turn-seg")
  assert.equal(segmentElements.length, 3, "read + input + output each render a segment")
  assert.deepEqual(
    segmentElements.map((segmentElement) => segmentElement.className),
    ["turn-seg seg-read", "turn-seg seg-input", "turn-seg seg-output"],
    "segments render in the fixed cache-read / paid-input / output order",
  )
  assert.deepEqual(
    segmentElements.map((segmentElement) => segmentElement.style.width),
    ["max(2px, 20.00%)", "max(2px, 20.00%)", "max(2px, 60.00%)"],
    "segment widths follow the token shares (100/100/300 of 500)",
  )

  const totalLabelElement = rowElement.querySelector(".turn-bar-total")
  assert.ok(totalLabelElement.classList.contains("num"))
  assert.equal(totalLabelElement.textContent, "500", "the total label formats input+output+cache.read")
  assert.equal(totalLabelElement.title, "该步总量 = input + output + cache.read")
})

test("buildTurnCostBarElement omits zero segments, flags model switches and returns null for token-less steps", async () => {
  const { buildTurnCostBarElement } = await import("../src/web/public/components/replay-turn-bar.js")

  // Zero-value segments are omitted entirely, not zero-width.
  const singleSegmentRow = buildTurnCostBarElement({ input: 0, output: 400, cache: { read: 0 } }, "", false)!
  const onlySegment = singleSegmentRow.querySelector(".turn-seg")!
  assert.ok(onlySegment.classList.contains("seg-output"), "only the positive output segment renders")
  assert.equal(onlySegment.style.width, "max(2px, 100.00%)")

  // A model switch renders the ⚑ marker; an empty model id does not.
  const switchedRow = buildTurnCostBarElement({ input: 10, output: 0, cache: { read: 0 } }, "model-example-beta", true)!
  const markerElement = switchedRow.querySelector(".turn-model-marker")
  assert.equal(markerElement.textContent, "⚑ model-example-beta")
  assert.equal(markerElement.title, "此步骤发生了模型切换")
  const emptyModelIdRow = buildTurnCostBarElement({ input: 10, output: 0, cache: { read: 0 } }, "", true)!
  assert.equal(emptyModelIdRow.querySelectorAll(".turn-model-marker").length, 0)

  // Wire robustness: anything without a positive field sum yields null.
  assert.equal(
    buildTurnCostBarElement({ input: 0, output: 0, cache: { read: 0 } }, "", false),
    null,
    "all-zero tokens render no cost bar",
  )
  assert.equal(buildTurnCostBarElement(null, "", false), null, "a null tokens JSON renders no cost bar")
  assert.equal(buildTurnCostBarElement("garbage", "", false), null, "a non-object tokens JSON renders no cost bar")
  assert.equal(
    buildTurnCostBarElement({ input: -5, output: 0, cache: { read: 0 } }, "", false),
    null,
    "negative fields degrade to zero → no cost bar",
  )
  // A null cache object still reads the flat input field.
  const nullCacheRow = buildTurnCostBarElement({ input: 100, output: 0, cache: null }, "", false)!
  assert.equal(nullCacheRow.querySelectorAll(".turn-seg").length, 1)
  assert.ok(nullCacheRow.querySelector(".turn-seg")!.classList.contains("seg-input"))
})

test("buildTurnCostBarElement wires per-segment hover tooltips with the token amount and step share", async () => {
  const { buildTurnCostBarElement } = await import("../src/web/public/components/replay-turn-bar.js")

  const rowElement = buildTurnCostBarElement({ input: 100, output: 300, cache: { read: 100 } }, "", false)!
  const readSegment = rowElement.querySelectorAll(".turn-seg")[0]!
  readSegment.fire("mouseenter")
  assert.equal(sharedTooltipElement.hidden, false, "hovering a segment reveals the shared tooltip")
  const tooltipHtml = sharedTooltipElement.innerHTML
  assert.ok(tooltipHtml.includes("缓存读"), "the tooltip title names the segment")
  assert.ok(tooltipHtml.includes("token"))
  assert.ok(tooltipHtml.includes(">100</span>"))
  assert.ok(tooltipHtml.includes("占该步"))
  assert.ok(tooltipHtml.includes("20.0%"), "the tooltip carries the within-step share")
  readSegment.fire("mouseleave")
  assert.equal(sharedTooltipElement.hidden, true)
})

/* ------------- theme panel (v0.1.0) ------------- */

test("cssVar reads live computed values and the chart-facing theme maps mirror the CSS slots", async () => {
  const { cssVar, modelPalette, chartTheme } = await import("../src/web/public/theme.js")

  assert.equal(cssVar("--accent"), "stub-css(--accent)")

  assert.deepEqual(modelPalette(), [
    "stub-css(--m1)", "stub-css(--m2)", "stub-css(--m3)", "stub-css(--m4)",
    "stub-css(--m5)", "stub-css(--m6)", "stub-css(--m7)", "stub-css(--m8)",
    "stub-css(--m9)", "stub-css(--m10)", "stub-css(--m11)", "stub-css(--m12)",
  ], "the model palette covers all twelve model color slots")

  assert.deepEqual(chartTheme(), {
    stroke: "stub-css(--text-dim)",
    grid: "stub-css(--grid-line)",
    tick: "stub-css(--text-faint)",
    accent: "stub-css(--accent)",
    blue: "stub-css(--blue)",
    amber: "stub-css(--amber)",
    red: "stub-css(--red)",
  }, "chartTheme maps every chart slot to its live themed color")
})

test("prefersDark follows the live scheme query and onSchemeChange routes change events until unsubscribed", async () => {
  const { prefersDark, onSchemeChange } = await import("../src/web/public/theme.js")

  // The shim's default media query reports a light scheme.
  assert.equal(prefersDark(), false)

  const windowWithSwappableMatchMedia = globalThis.window as unknown as {
    matchMedia: unknown
  }
  const originalMatchMedia = windowWithSwappableMatchMedia.matchMedia
  try {
    const capturedMediaQueryTexts: string[] = []
    const schemeChangeListeners = new Set<(schemeChangeEvent: { matches: boolean }) => void>()
    const receivedSchemeMatches: boolean[] = []
    windowWithSwappableMatchMedia.matchMedia = (mediaQueryText: string) => {
      capturedMediaQueryTexts.push(mediaQueryText)
      return {
        matches: true,
        addEventListener: (_eventType: string, listener: (schemeChangeEvent: { matches: boolean }) => void) => {
          schemeChangeListeners.add(listener)
        },
        removeEventListener: (_eventType: string, listener: (schemeChangeEvent: { matches: boolean }) => void) => {
          schemeChangeListeners.delete(listener)
        },
      }
    }

    assert.equal(prefersDark(), true, "prefersDark follows the live matchMedia result")
    assert.ok(
      capturedMediaQueryTexts.includes("(prefers-color-scheme: dark)"),
      "the scheme query is the prefers-color-scheme media feature",
    )

    const unsubscribe = onSchemeChange((prefersDarkNow) => {
      receivedSchemeMatches.push(prefersDarkNow)
    })
    assert.equal(schemeChangeListeners.size, 1, "subscribing registers exactly one media listener")
    for (const schemeChangeListener of schemeChangeListeners) {
      schemeChangeListener({ matches: true })
    }
    assert.deepEqual(receivedSchemeMatches, [true], "a scheme change routes matches through the callback")

    unsubscribe()
    assert.equal(schemeChangeListeners.size, 0, "unsubscribing removes the registered listener")
    assert.deepEqual(
      receivedSchemeMatches,
      [true],
      "after unsubscribing no further scheme events reach the callback",
    )
  } finally {
    windowWithSwappableMatchMedia.matchMedia = originalMatchMedia
  }
})

/* ------------- trend-chart: degradation seam (v0.1.0) ------------- */

test("renderTrendChart degrades null and single-point windows to the empty placeholder and clears the legend", async () => {
  const { renderTrendChart } = await import("../src/web/public/components/trend-chart.js")

  const nullContainer = freshContainer()
  const staleLegendContainer = freshContainer()
  staleLegendContainer.innerHTML = "<span>example-stale-legend</span>"
  const nullCleanup = renderTrendChart(nullContainer, staleLegendContainer, null)
  assert.match(nullContainer.innerHTML, /这段范围内没有逐日数据/)
  assert.ok(nullContainer.innerHTML.includes("换个时间范围"), "the placeholder keeps its range hint")
  assert.equal(staleLegendContainer.innerHTML, "", "a degraded chart clears stale legend chips")
  assert.equal(nullCleanup !== null && typeof nullCleanup, "function", "the render still returns a cleanup")
  nullCleanup()

  // One point cannot draw a trend: same degradation, no chart instantiated.
  const singlePointContainer = freshContainer()
  const singlePointCleanup = renderTrendChart(singlePointContainer, null, {
    points: [dailyTrendPointFixture("2026-10-01", 100, 400, 50)],
  })
  assert.match(
    singlePointContainer.innerHTML,
    /这段范围内没有逐日数据/,
    "a single data point degrades exactly like a null window",
  )
  assert.equal(singlePointContainer.querySelectorAll("canvas").length, 0, "no chart is built on the degradation path")
  singlePointCleanup()
})

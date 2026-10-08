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

  // Default state: four preset buttons, exactly one active — 全部 ("").
  renderSessionList(container, sessionSortFixturePayload(), null, "time_updated", "desc", null, null, "", captureRangeChange)
  const rangeButtons = container.querySelectorAll("button.session-range-button")
  assert.equal(rangeButtons.length, 4, "全部 / 7 天 / 30 天 / 90 天 presets")
  assert.ok(
    container.innerHTML.includes('class="session-range-button active" data-session-range=""'),
    "the default 全部 preset is the active one",
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

  // Re-render with an active range moves the active pill to 30 天.
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
  assert.match(container.innerHTML, /最近 7 天没有会话更新/)
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
  assert.match(bothFiltersEntryHtml, /导出当前目录下最近 30 天有更新的会话/)
  const rangeOnlyEntryHtml = sessionsCsvExportEntryHtml(null, "7d", true)
  assert.ok(rangeOnlyEntryHtml.includes('href="/api/export/sessions.csv?range=7d"'))
  assert.match(rangeOnlyEntryHtml, /导出最近 7 天有更新的会话/)
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
  assert.match(container.innerHTML, /目录：D:\/projects\/example-alpha · 最近 7 天/)
  assert.ok(
    // Attribute-escaped ampersand in the anchor href (same escapeHtml
    // insertion point as every other external string); assembled at
    // runtime to keep the source free of a literal "&" run.
    container.innerHTML.includes(`href="/api/export/sessions.csv?directory=D%3A%2Fprojects%2Fexample-alpha${"&" + "amp;"}range=7d"`),
    "the export href threads the range through the same single point",
  )

  // Default range (全部) → no range part in the footnote, bare-ish export path.
  renderSessionList(container, sessionSortFixturePayload(), null, "time_updated", "desc", null, null, "")
  assert.ok(!container.innerHTML.includes("最近 7 天"), "no range part without an active range")
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

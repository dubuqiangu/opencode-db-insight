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
  private innerHtmlText = ""
  private stubChildren: StubElement[] = []
  private eventListeners = new Map<string, Array<() => void>>()

  constructor(tagName: string) {
    this.tagName = tagName
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
    this.stubChildren.push(childElement)
    return childElement
  }

  addEventListener(eventType: string, listener: () => void): void {
    const typedListeners = this.eventListeners.get(eventType) ?? []
    typedListeners.push(listener)
    this.eventListeners.set(eventType, typedListeners)
  }

  /** Fire all listeners registered for "click" (render-time bindings only). */
  click(): void {
    for (const clickListener of this.eventListeners.get("click") ?? []) {
      clickListener()
    }
  }

  classTokenList(): string[] {
    return this.className.split(/\s+/).filter((classToken) => classToken !== "")
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

test("session-sort-controller: range gets its own cache dimension and the guard validates the range snapshot", async () => {
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

  // Back to 全部 is a pure cache hit — no new request, token unmoved.
  controller.changeRange("")
  assert.equal(harness.pendingRequests.length, 2, "cache hit must not issue a new request")
  assert.ok(container.innerHTML.includes("all-range late marker"))

  // Range-snapshot guard beyond the token: the in-flight 7d request settles
  // while its token is still latest, but the view moved back to 全部 — only
  // the four-dimension snapshot comparison drops it; its payload parks in
  // the 7d slot.
  harness.settleWithMarker(1, "7d marker")
  await flushControllerMicrotasks()
  assert.ok(
    !container.innerHTML.includes("7d marker"),
    "a response whose range snapshot no longer matches must not render even on a fresh token",
  )

  // Re-entering the range renders the parked payload — different range,
  // different cache slot, still no third request.
  controller.changeRange("7d")
  assert.equal(harness.pendingRequests.length, 2)
  assert.ok(container.innerHTML.includes("7d marker"))
  assert.ok(!container.innerHTML.includes("all-range late marker"))
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

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
   * Class-token query supporting both ".class" and "tag.class" selectors
   * (components use the compound form, e.g. "th.sortable" / "tr.session-row").
   */
  querySelectorAll(elementSelector: string): StubElement[] {
    const compoundSelectorMatch = /^([a-zA-Z][a-zA-Z0-9]*)\.(.+)$/.exec(elementSelector)
    const wantedTagName = compoundSelectorMatch !== null ? compoundSelectorMatch[1] : null
    const wantedClassName = compoundSelectorMatch !== null
      ? compoundSelectorMatch[2]
      : elementSelector.replace(/^\./, "")
    const matchedElements: StubElement[] = []
    const walkChildren = (parentElement: StubElement): void => {
      for (const childElement of parentElement.stubChildren) {
        const classNameMatches = childElement.classTokenList().includes(wantedClassName)
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

  // Default state (time_updated desc — the wire default). It has no
  // matching visible column (the list shows created time), so no header
  // carries the sorted marker; the footnote names the server sort.
  const noopSortChange = () => {}
  renderSessionList(container, sessionSortFixturePayload(), null, "time_updated", "desc", noopSortChange)
  const sortableHeaders = container.querySelectorAll("th.sortable")
  assert.equal(sortableHeaders.length, 3, "title / created-time / tokens columns are sortable")
  assert.deepEqual(
    sortableHeaders.map((headerCell) => headerCell.dataset.sortKey),
    ["title", "time_created", "tokens"],
    "column → sort-key mapping must match the backend ?sort= whitelist",
  )
  assert.equal(
    container.querySelectorAll("th.sorted").length,
    0,
    "the default time_updated sort has no visible column to mark",
  )
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

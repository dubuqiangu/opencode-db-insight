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

/* ------------------------- thin DOM shim ------------------------- */

/**
 * Minimal element stub. `innerHTML` stores the assigned markup and parses
 * a flat list of opening tags (class / data-* / every other attribute);
 * queries walk that list recursively so nested and appended elements are
 * both reachable.
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

  constructor(tagName: string) {
    this.tagName = tagName
  }

  set innerHTML(htmlText: string) {
    this.innerHtmlText = htmlText
    this.stubChildren = parseStubChildren(htmlText)
  }

  get innerHTML(): string {
    return this.innerHtmlText
  }

  appendChild(childElement: StubElement): StubElement {
    this.stubChildren.push(childElement)
    return childElement
  }

  addEventListener(): void {
    // Hover tooltips only fire on real pointer events; render-time
    // binding just needs the call to exist.
  }

  classTokenList(): string[] {
    return this.className.split(/\s+/).filter((classToken) => classToken !== "")
  }

  querySelectorAll(classSelector: string): StubElement[] {
    const wantedClassName = classSelector.replace(/^\./, "")
    const matchedElements: StubElement[] = []
    const walkChildren = (parentElement: StubElement): void => {
      for (const childElement of parentElement.stubChildren) {
        if (childElement.classTokenList().includes(wantedClassName)) {
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

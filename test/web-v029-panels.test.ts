/**
 * v0.29.0 前端面板测试（Wave 1–3）：记账守恒 / 内容构成 / 文件活动 / 会话血缘 /
 * 导出动作，外加 v0.18 起一直缺测的 agent-table，以及这四个 Wave 的 mock
 * 生产者。
 *
 * 为什么单独成文件：这些面板体量大、各自的契约面独立（浮点占比、SVG 布局、
 * 事件委托、跨源对照），塞进 4800 行的 web-components.test.ts 只会让它更难读。
 * 复用 test/helpers/web-dom-shim.ts（与 web-session-scope / web-replay-token-curve
 * 同款 DOM shim）；夹具一律虚构、中性占位。
 *
 * 断言的面：
 * - 纯渲染器不 fetch、不抛错；外部文本（分类 key / 标题 / agent / 路径 / 会话 id）
 *   一律 escapeHtml，绝不原样落 DOM；
 * - 每个 `.data-table` 必带 `<colgroup>`（仓库硬规矩）；
 * - 缺值走 precision.js 的 renderMissingValue（`missing-value` + 原因 title），
 *   绝不折算成 0；
 * - 空/脏载荷走 state-views.js 的空态；
 * - 挂了监听的渲染器必须返回可调用的 cleanup（血缘图的事件委托）；
 * - mock 生产者的形状与真 wire 对齐（字段齐全、排序确定、渲染进组件不落空态）。
 */

import { test } from "node:test"
import assert from "node:assert/strict"

import { installDomShim, freshContainer, StubElement } from "./helpers/web-dom-shim.ts"
import { MISSING_REASON } from "../src/web/public/precision.js"

installDomShim()

/* ---------------------------- 共享断言工具 ---------------------------- */

/**
 * 仓库硬规矩：每个 `class="… data-table …"` 的表都必须恰好带一个 `<colgroup>`。
 * 用字符串扫比逐个 querySelector 简单，且覆盖同一 innerHTML 里的多张表。
 */
function assertEveryDataTableHasColgroup(renderedHtml: string, label: string): void {
  const tableCount = (renderedHtml.match(/class="[^"]*data-table/g) ?? []).length
  const colgroupCount = (renderedHtml.match(/<colgroup>/g) ?? []).length
  assert.ok(tableCount > 0, `${label}: expected at least one .data-table in the output`)
  assert.equal(colgroupCount, tableCount, `${label}: every .data-table must emit exactly one <colgroup>`)
}

/** `renderMissingValue` 的期望串（原因 title 必须是 precision.js 的那一句）。 */
function missingValueHtml(reasonText: string): string {
  return `<span class="missing-value" title="${reasonText}">—</span>`
}

/**
 * 容器扩展：血缘图的事件委托在 cleanup 里调 container.removeEventListener，
 * 而共享 shim 只捕获 addEventListener。这里补上并把移除记录下来，便于断言
 * cleanup 确实摘掉了两个监听。
 */
class ListenerTrackingContainer extends StubElement {
  removedEventTypes: string[] = []
  removeEventListener(eventType: string): void {
    this.removedEventTypes.push(eventType)
  }
}

/* ====================================================================== */
/* 1. content-composition-card.js                                          */
/* ====================================================================== */

test("renderContentCompositionCard renders head, stacked bar, legend table and the estimate row", async () => {
  const { renderContentCompositionCard } = await import(
    "../src/web/public/components/content-composition-card.js"
  )
  const container = freshContainer()

  renderContentCompositionCard(container, {
    totalChars: 100,
    // Wire share is deliberately wrong (0.99): the component must recompute
    // the share from chars / total, never trust the wire field.
    categories: [
      { key: "userText", chars: 25, share: 0.99 },
      { key: "assistantText", chars: 75, share: 0.01 },
    ],
    toolEstimatedTokens: 1200,
    sessions: 7,
  })

  const renderedHtml = container.innerHTML
  assert.ok(renderedHtml.includes("content-composition-bar"), "the stacked bar renders")
  assert.ok(renderedHtml.includes("content-composition-table"), "the legend table renders")
  assert.ok(renderedHtml.includes("用户文本"), "known categories use their Chinese label")
  assert.ok(renderedHtml.includes("工具 token 估算"), "the estimate row renders")
  assert.ok(renderedHtml.includes('class="precision estimate"'), "the estimate row carries the 🟡 badge")
  // Shares are recomputed from chars / total: 25% and 75%, never 99%.
  assert.ok(renderedHtml.includes("25.0%"), "the user row share is chars / total")
  assert.ok(renderedHtml.includes("75.0%"), "the assistant row share is chars / total")
  assert.ok(!renderedHtml.includes("99.0%"), "the wire share field is not trusted")
  assertEveryDataTableHasColgroup(renderedHtml, "content-composition")
})

test("renderContentCompositionCard escapes an unknown (hostile) category key everywhere it is shown", async () => {
  const { renderContentCompositionCard } = await import(
    "../src/web/public/components/content-composition-card.js"
  )
  const container = freshContainer()

  renderContentCompositionCard(container, {
    totalChars: 40,
    categories: [{ key: "<img src=x>", chars: 40 }],
    toolEstimatedTokens: 0,
    sessions: 1,
  })

  const renderedHtml = container.innerHTML
  assert.ok(!renderedHtml.includes("<img src=x>"), "a hostile unknown key never reaches the DOM raw")
  assert.ok(renderedHtml.includes("&lt;img src=x&gt;"), "the unknown key is escaped as its own label")
})

test("renderContentCompositionCard degrades null / empty / all-zero and uses renderMissingValue for missing counts", async () => {
  const { renderContentCompositionCard } = await import(
    "../src/web/public/components/content-composition-card.js"
  )

  const nullContainer = freshContainer()
  renderContentCompositionCard(nullContainer, null)
  assert.match(nullContainer.innerHTML, /还没有内容构成数据/)

  const emptyContainer = freshContainer()
  renderContentCompositionCard(emptyContainer, { totalChars: 0, categories: [], toolEstimatedTokens: 0, sessions: 0 })
  assert.match(emptyContainer.innerHTML, /还没有内容构成数据/)

  // Present categories but a non-finite sessions / estimate → placeholders, not 0.
  const missingContainer = freshContainer()
  renderContentCompositionCard(missingContainer, {
    totalChars: 10,
    categories: [{ key: "other", chars: 10 }],
    toolEstimatedTokens: undefined,
    sessions: undefined,
  })
  const missingHtml = missingContainer.innerHTML
  assert.ok(missingHtml.includes(missingValueHtml(MISSING_REASON.notRecorded)), "a missing session count uses renderMissingValue")
  assert.ok(missingHtml.includes(missingValueHtml(MISSING_REASON.noSamples)), "a missing tool-token estimate uses renderMissingValue")
})

/* ====================================================================== */
/* 2. token-ledger-card.js                                                 */
/* ====================================================================== */

function ledgerFixture(overrides: Record<string, unknown> = {}) {
  return {
    totals: {
      promptInput: 100,
      promptCacheRead: 300,
      promptCacheWrite: 50,
      output: 200,
      reasoning: 40,
      cacheHitRate: 0.75,
      sessions: 1,
    },
    conservation: { anomalies: { negativeComponents: 0, cacheReadExceedsPrompt: 0 }, balanced: true },
    reconciliation: { residualTokens: 120, residualRatio: 0.05, withinTolerance: true, tolerance: 0.1 },
    sessions: [
      {
        sessionId: "ses_alpha",
        messages: 10,
        promptInput: 100,
        promptCacheRead: 300,
        promptCacheWrite: 50,
        output: 200,
        reasoning: 40,
        v2Input: 110,
        v2CacheRead: 310,
        v2CacheWrite: 55,
        v2Output: 200,
      },
    ],
    ...overrides,
  }
}

test("renderTokenLedgerCard renders the balanced verdict, prompt split, metrics, reconciliation and the sessions table", async () => {
  const { renderTokenLedgerCard } = await import(
    "../src/web/public/components/token-ledger-card.js"
  )
  const container = freshContainer()

  renderTokenLedgerCard(container, ledgerFixture())

  const renderedHtml = container.innerHTML
  assert.ok(renderedHtml.includes("ledger-card"), "the card shell renders")
  assert.ok(renderedHtml.includes("记账完整"), "a balanced ledger shows the 记账完整 verdict")
  assert.ok(renderedHtml.includes("ledger-verdict-balanced"), "the balanced tone class is applied")
  assert.ok(renderedHtml.includes("prompt 供给三分"), "the prompt split renders")
  assert.ok(renderedHtml.includes("缓存命中率"), "the cache hit rate renders")
  assert.ok(renderedHtml.includes("ledger-metrics"), "the key-metrics grid renders")
  assert.ok(renderedHtml.includes("与 session_v2 对照"), "the neutral cross-source reconciliation row renders")
  assert.ok(!renderedHtml.includes("记账偏差"), "the reconciliation row is never labelled as an error")
  assert.ok(renderedHtml.includes("逐会话对照"), "the per-session details render")
  assert.ok(renderedHtml.includes("ses_alpha"), "the session id is shown")
  assertEveryDataTableHasColgroup(renderedHtml, "token-ledger")
})

test("renderTokenLedgerCard shows the 记账异常 verdict from the anomaly counts and escapes a hostile session id", async () => {
  const { renderTokenLedgerCard } = await import(
    "../src/web/public/components/token-ledger-card.js"
  )
  const container = freshContainer()

  renderTokenLedgerCard(container, ledgerFixture({
    conservation: { anomalies: { negativeComponents: 2, cacheReadExceedsPrompt: 1 }, balanced: false },
    sessions: [
      {
        sessionId: 'ses_evil"><script>',
        messages: 1, promptInput: 1, promptCacheRead: 1, promptCacheWrite: 0,
        output: 1, reasoning: 0, v2Input: 1, v2CacheRead: 1, v2CacheWrite: 0, v2Output: 1,
      },
    ],
  }))

  const renderedHtml = container.innerHTML
  assert.ok(renderedHtml.includes("记账异常"), "a non-balanced ledger shows the 记账异常 verdict")
  assert.ok(renderedHtml.includes("负分项"), "the negative-component anomaly is itemised")
  assert.ok(renderedHtml.includes("缓存读超 prompt"), "the cache-read anomaly is itemised")
  assert.ok(!renderedHtml.includes("<script>"), "a hostile session id is never raw in the DOM")
  assert.ok(renderedHtml.includes("&lt;script&gt;"), "the hostile session id is escaped")
})

test("renderTokenLedgerCard degrades null / empty and renders renderMissingValue for a missing hit rate", async () => {
  const { renderTokenLedgerCard } = await import(
    "../src/web/public/components/token-ledger-card.js"
  )

  const nullContainer = freshContainer()
  renderTokenLedgerCard(nullContainer, null)
  assert.match(nullContainer.innerHTML, /还没有记账数据/)

  const emptyContainer = freshContainer()
  renderTokenLedgerCard(emptyContainer, {
    totals: { promptInput: 0, promptCacheRead: 0, promptCacheWrite: 0, output: 0, reasoning: 0, cacheHitRate: null, sessions: 0 },
    conservation: null,
    reconciliation: null,
    sessions: [],
  })
  assert.match(emptyContainer.innerHTML, /还没有记账数据/)

  // A non-finite hit rate → the zero-denominator placeholder, never NaN.
  const missingContainer = freshContainer()
  renderTokenLedgerCard(missingContainer, ledgerFixture({
    totals: { promptInput: 100, promptCacheRead: 300, promptCacheWrite: 50, output: 0, reasoning: 0, cacheHitRate: Number.NaN, sessions: 1 },
  }))
  const missingHtml = missingContainer.innerHTML
  assert.ok(!missingHtml.includes("NaN"), "a NaN hit rate never renders as NaN")
  assert.ok(
    missingHtml.includes(missingValueHtml(MISSING_REASON.zeroDenominator)),
    "a missing hit rate uses the zero-denominator placeholder",
  )
})

/* ====================================================================== */
/* 3. file-activity-table.js                                               */
/* ====================================================================== */

test("renderFileActivityTable renders the path title, name, mini bar, counts and the truncation footnote", async () => {
  const { renderFileActivityTable } = await import(
    "../src/web/public/components/file-activity-table.js"
  )
  const container = freshContainer()

  renderFileActivityTable(container, {
    totalFiles: 5,
    totalOps: 30,
    files: [
      { path: "~/projects/x/app.js", name: "app.js", reads: 10, edits: 5, writes: 2, sessions: 4, lastActiveMs: 1 },
      { path: "~/projects/x/data.js", name: "data.js", reads: 6, edits: 3, writes: 1, sessions: 2, lastActiveMs: 2 },
    ],
  })

  const renderedHtml = container.innerHTML
  assert.ok(renderedHtml.includes("file-activity-table"), "the activity table renders")
  assert.ok(renderedHtml.includes("app.js"), "the visible name renders")
  assert.ok(renderedHtml.includes('title="~/projects/x/app.js"'), "the full path goes in the title")
  assert.ok(renderedHtml.includes("file-activity-bar"), "the read/edit/write mini bar renders")
  assert.ok(renderedHtml.includes("读 / 改 / 写"), "the mini-bar column header renders")
  assert.ok(renderedHtml.includes("显示前 2 个"), "a truncated table footnotes how many of the total are shown")
  assertEveryDataTableHasColgroup(renderedHtml, "file-activity")
})

test("renderFileActivityTable escapes a hostile path/name and falls back to the path's last segment when name is absent", async () => {
  const { renderFileActivityTable } = await import(
    "../src/web/public/components/file-activity-table.js"
  )
  const container = freshContainer()

  renderFileActivityTable(container, {
    totalFiles: 1,
    totalOps: 3,
    files: [
      { path: '~/p/<img src=x>.js', name: "<b>name</b>", reads: 1, edits: 1, writes: 1, sessions: 1 },
      // No name → the component derives it from the path's last segment.
      { path: "~/p/derived-name.js", reads: 1, edits: 0, writes: 0, sessions: 1 },
    ],
  })

  const renderedHtml = container.innerHTML
  assert.ok(!renderedHtml.includes("<img src=x>"), "a hostile path never reaches the DOM raw")
  assert.ok(!renderedHtml.includes("<b>name</b>"), "a hostile name never reaches the DOM raw")
  assert.ok(renderedHtml.includes("&lt;b&gt;name&lt;/b&gt;"), "the hostile name is escaped")
  assert.ok(renderedHtml.includes("derived-name.js"), "a missing name falls back to the path's last segment")
})

test("renderFileActivityTable degrades null / empty and uses renderMissingValue for missing summary counts", async () => {
  const { renderFileActivityTable } = await import(
    "../src/web/public/components/file-activity-table.js"
  )

  const nullContainer = freshContainer()
  renderFileActivityTable(nullContainer, null)
  assert.match(nullContainer.innerHTML, /还没有文件活动/)

  const emptyContainer = freshContainer()
  renderFileActivityTable(emptyContainer, { totalFiles: 0, totalOps: 0, files: [] })
  assert.match(emptyContainer.innerHTML, /还没有文件活动/)

  const missingContainer = freshContainer()
  renderFileActivityTable(missingContainer, {
    totalFiles: undefined,
    totalOps: undefined,
    files: [{ path: "~/a/b.js", name: "b.js", reads: 1, edits: 0, writes: 0, sessions: 1 }],
  })
  assert.ok(
    missingContainer.innerHTML.includes(missingValueHtml(MISSING_REASON.notRecorded)),
    "a missing totalFiles / totalOps uses the not-recorded placeholder",
  )
})

/* ====================================================================== */
/* 4. session-lineage-graph.js                                             */
/* ====================================================================== */

function lineageNode(sessionId: string, parentSessionId: string | null, extra: Record<string, unknown> = {}) {
  return {
    sessionId,
    parentSessionId,
    title: `会话 ${sessionId}`,
    agent: "build",
    tokens: 1000,
    timeCreated: 1_700_000_000_000,
    childCount: 0,
    ...extra,
  }
}

function lineagePayload(nodes: Array<Record<string, unknown>>, edges: Array<Record<string, string>>, overrides: Record<string, unknown> = {}) {
  return {
    focusSessionId: null,
    nodes,
    edges,
    stats: {
      totalSessions: nodes.length,
      graphSessions: nodes.length,
      rootCount: nodes.length - edges.length,
      childCount: edges.length,
      orphanParentCount: 0,
      selfParentCount: 0,
      cycleCount: 0,
      maxDepth: 1,
    },
    omittedNodeCount: 0,
    ...overrides,
  }
}

test("renderSessionLineageGraph draws nodes + edges, escapes external text and encodes the session href", async () => {
  const { renderSessionLineageGraph } = await import(
    "../src/web/public/components/session-lineage-graph.js"
  )
  const container = new ListenerTrackingContainer("div")

  const cleanup = renderSessionLineageGraph(container, lineagePayload(
    [
      lineageNode("ses_root", null, { title: "<script>alert(1)</script>", agent: "" }),
      lineageNode("ses child/x", "ses_root", { tokens: 500 }),
    ],
    [{ parentSessionId: "ses_root", childSessionId: "ses child/x" }],
  ))

  const renderedHtml = container.innerHTML
  assert.ok(renderedHtml.includes("session-lineage-svg"), "the lineage SVG renders")
  assert.ok(renderedHtml.includes("lineage-edge"), "the parent→child edge renders")
  assert.ok(renderedHtml.includes("(未知 agent)"), "a missing agent uses the neutral placeholder")
  assert.ok(!renderedHtml.includes("<script>alert(1)</script>"), "a hostile title never reaches the DOM raw")
  assert.ok(renderedHtml.includes("&lt;script&gt;"), "the hostile title is escaped")
  assert.ok(
    renderedHtml.includes('href="#/session/ses%20child%2Fx"'),
    "a hostile session id is URL-encoded into the node href",
  )
  assert.equal(typeof cleanup, "function", "the lineage renderer returns a cleanup")
})

test("renderSessionLineageGraph wires focus / exit-focus via event delegation and the cleanup removes both listeners", async () => {
  const { renderSessionLineageGraph } = await import(
    "../src/web/public/components/session-lineage-graph.js"
  )
  const container = new ListenerTrackingContainer("div")

  const focusedParentIds: string[] = []
  let exitCount = 0
  const cleanup = renderSessionLineageGraph(
    container,
    lineagePayload(
      [lineageNode("ses_root", null), lineageNode("ses_leaf", "ses_root")],
      [{ parentSessionId: "ses_root", childSessionId: "ses_leaf" }],
      { focusSessionId: "ses_root" },
    ),
    {
      onFocusSession: (parentSessionId: string) => focusedParentIds.push(parentSessionId),
      onExitFocus: () => { exitCount += 1 },
    },
  )

  assert.ok(container.innerHTML.includes("聚焦模式"), "the focus bar renders when focusSessionId is set")
  assert.ok(
    container.innerHTML.includes("data-lineage-exit-focus"),
    "the exit-focus button renders in focus mode",
  )

  // Click the "+N 更多" target through the delegated handler.
  const focusTarget = {
    closest: (selector: string) => (selector === "[data-focus-session-id]"
      ? { getAttribute: (name: string) => (name === "data-focus-session-id" ? "ses_root" : null) }
      : null),
  }
  container.fire("click", { target: focusTarget })
  assert.deepEqual(focusedParentIds, ["ses_root"], "clicking a focus target calls onFocusSession with the parent id")

  // Click the exit-focus button (the focus selector misses, the exit selector hits).
  const exitTarget = {
    closest: (selector: string) => (selector === "[data-lineage-exit-focus]" ? {} : null),
  }
  container.fire("click", { target: exitTarget })
  assert.equal(exitCount, 1, "clicking exit calls onExitFocus once")

  cleanup()
  assert.deepEqual(
    [...container.removedEventTypes].sort(),
    ["click", "keydown"],
    "the cleanup removes both delegated listeners",
  )
})

test("renderSessionLineageGraph folds >12 children behind a +N 更多 node and degrades empty payloads", async () => {
  const { renderSessionLineageGraph } = await import(
    "../src/web/public/components/session-lineage-graph.js"
  )

  // 15 children on one parent → 12 real nodes + one 「+N 更多」 entry.
  const wideNodes = [lineageNode("ses_root", null)]
  const wideEdges: Array<Record<string, string>> = []
  for (let childIndex = 0; childIndex < 15; childIndex += 1) {
    const childId = `ses_child_${String(childIndex).padStart(2, "0")}`
    wideNodes.push(lineageNode(childId, "ses_root", { tokens: 100 - childIndex }))
    wideEdges.push({ parentSessionId: "ses_root", childSessionId: childId })
  }
  const wideContainer = new ListenerTrackingContainer("div")
  const wideCleanup = renderSessionLineageGraph(wideContainer, lineagePayload(wideNodes, wideEdges))
  assert.ok(wideContainer.innerHTML.includes("lineage-more"), "the fold node renders when a parent has >12 children")
  assert.ok(wideContainer.innerHTML.includes("+3 更多"), "the fold node reports the omitted child count")
  wideCleanup()

  // Null payload and a nodes-without-edges payload both degrade to the empty state.
  const nullContainer = new ListenerTrackingContainer("div")
  assert.equal(typeof renderSessionLineageGraph(nullContainer, null), "function", "the empty path still returns a cleanup")
  assert.match(nullContainer.innerHTML, /还没有血缘数据/)

  const noEdgeContainer = new ListenerTrackingContainer("div")
  renderSessionLineageGraph(noEdgeContainer, lineagePayload([lineageNode("ses_solo", null)], []))
  assert.match(noEdgeContainer.innerHTML, /还没有父子血缘/)
})

/* ====================================================================== */
/* 5. session-export-links.js                                              */
/* ====================================================================== */

test("sessionExportLinksHtml emits md + svg attachment anchors and is empty when unavailable", async () => {
  const { sessionExportLinksHtml } = await import(
    "../src/web/public/components/session-export-links.js"
  )

  const availableHtml = sessionExportLinksHtml("ses_alpha", true)
  assert.ok(
    availableHtml.includes('href="/api/export/session/ses_alpha.md"'),
    "the Markdown export points at the .md route",
  )
  assert.ok(
    availableHtml.includes('href="/api/export/session/ses_alpha.svg"'),
    "the SVG export points at the .svg route",
  )
  assert.ok(availableHtml.includes('download="session.md"'), "the Markdown anchor carries a download filename")
  assert.ok(availableHtml.includes("导出 Markdown"), "the Markdown anchor is labelled")
  assert.ok(availableHtml.includes("导出 SVG"), "the SVG anchor is labelled")

  assert.equal(sessionExportLinksHtml("ses_alpha", false), "", "an unavailable export renders nothing (caller skips it)")
})

test("sessionExportLinksHtml URL-encodes a hostile session id into the href", async () => {
  const { sessionExportLinksHtml } = await import(
    "../src/web/public/components/session-export-links.js"
  )

  const renderedHtml = sessionExportLinksHtml("ses bad/x", true)
  assert.ok(
    renderedHtml.includes("/api/export/session/ses%20bad%2Fx.md"),
    "the session id is URL-encoded into the export href",
  )
  assert.ok(!renderedHtml.includes("ses bad/x"), "the raw hostile session id never reaches the href")
})

/* ====================================================================== */
/* 6. agent-table.js (v0.18, previously untested)                          */
/* ====================================================================== */

test("renderAgentTable renders the Chinese headers, sorts by tokens desc and escapes the agent name", async () => {
  const { renderAgentTable } = await import("../src/web/public/components/agent-table.js")
  const container = freshContainer()

  renderAgentTable(container, [
    { agent: "low", sessions: 1, tokens: 100, toolFingerprint: { read: 2, edit: 1 } },
    { agent: "high", sessions: 3, tokens: 900, toolFingerprint: { bash: 5, read: 4, grep: 1, glob: 1 } },
    { agent: '<img src=x>', sessions: 1, tokens: 500, toolFingerprint: { write: 1 } },
  ])

  const renderedHtml = container.innerHTML
  assert.ok(renderedHtml.includes("agent-table"), "the agent table renders")
  assert.ok(renderedHtml.includes(">会话<"), "the Chinese 会话 header renders")
  assert.ok(renderedHtml.includes(">总 token<"), "the Chinese 总 token header renders")
  assert.ok(renderedHtml.includes(">常用工具<"), "the Chinese 常用工具 header renders")
  assert.equal(container.querySelectorAll("tr").length, 4, "one header row + three agent rows")
  // Descending by tokens: high (900) before hostile (500) before low (100).
  // The shim parses tags flat (no element text), so assert on the string order.
  assert.ok(
    renderedHtml.indexOf(">high<") < renderedHtml.indexOf(">low<"),
    "the highest-token agent is first",
  )
  assert.ok(!renderedHtml.includes("<img src=x>"), "a hostile agent name never reaches the DOM raw")
  assert.ok(renderedHtml.includes("&lt;img src=x&gt;"), "the hostile agent name is escaped")
  // Top tools are capped at three chips.
  assert.ok(renderedHtml.includes("agent-tool-chip"), "preferred-tool chips render")
  assertEveryDataTableHasColgroup(renderedHtml, "agent-table")
})

test("renderAgentTable degrades null → loading skeleton, empty → empty state, and uses renderMissingValue for no tool calls", async () => {
  const { renderAgentTable } = await import("../src/web/public/components/agent-table.js")

  const loadingContainer = freshContainer()
  renderAgentTable(loadingContainer, null)
  assert.match(loadingContainer.innerHTML, /aria-busy="true"/, "a null agentStats renders the loading skeleton")

  const emptyContainer = freshContainer()
  renderAgentTable(emptyContainer, [])
  assert.match(emptyContainer.innerHTML, /还没有 agent 记录/, "an empty list renders the Chinese empty state")

  const noToolsContainer = freshContainer()
  renderAgentTable(noToolsContainer, [{ agent: "quiet", sessions: 1, tokens: 10, toolFingerprint: null }])
  assert.ok(
    noToolsContainer.innerHTML.includes(missingValueHtml(MISSING_REASON.noToolCalls)),
    "an agent without tool calls shows the no-tool-calls placeholder, not a bare dash",
  )
})

/* ====================================================================== */
/* 7. mock 生产者：形状与真 wire 对齐                                      */
/* ====================================================================== */

test("getMockContentComposition returns the frozen wire shape with recomputable shares", async () => {
  const { getMockContentComposition } = await import("../src/web/public/mock-content-composition.js")

  const composition = getMockContentComposition()
  assert.ok(composition.categories.length > 0, "the mock carries categories")
  const summedChars = composition.categories.reduce((sum: number, category: { chars: number }) => sum + category.chars, 0)
  assert.equal(composition.totalChars, summedChars, "totalChars is the sum of the category chars")
  for (let index = 1; index < composition.categories.length; index += 1) {
    assert.ok(
      composition.categories[index - 1].chars >= composition.categories[index].chars,
      "categories are sorted by chars descending",
    )
  }
  for (const category of composition.categories) {
    assert.ok(typeof category.key === "string" && category.key !== "", "every category has a non-empty key")
    assert.ok(
      Math.abs(category.share - category.chars / composition.totalChars) < 1e-9,
      "every share equals chars / totalChars",
    )
  }
  assert.ok(composition.toolEstimatedTokens > 0, "the tool-token estimate is a positive number")
  assert.ok(Number.isFinite(composition.sessions), "sessions is a finite number")
})

test("getMockFileActivity keeps the wire shape, sorts by ops desc and clamps the limit", async () => {
  const { getMockFileActivity, MOCK_FILE_ACTIVITY_DEFAULT_LIMIT, MOCK_FILE_ACTIVITY_MAX_LIMIT } = await import(
    "../src/web/public/mock-file-activity.js"
  )

  const activity = getMockFileActivity()
  assert.ok(activity.files.length > 0, "the mock materialises at least one file row")
  assert.ok(
    activity.files.length <= MOCK_FILE_ACTIVITY_DEFAULT_LIMIT,
    "the default limit bounds the rows",
  )
  assert.ok(activity.totalFiles >= activity.files.length, "totalFiles is the full (pre-truncation) count")
  assert.ok(activity.totalOps > 0, "totalOps is positive")
  for (const file of activity.files) {
    assert.equal(typeof file.path, "string", "every file has a path")
    assert.equal(typeof file.name, "string", "every file has a name")
    for (const countField of ["reads", "edits", "writes", "sessions", "lastActiveMs"]) {
      assert.ok(Number.isFinite(file[countField]), `every file has a finite ${countField}`)
    }
  }
  for (let index = 1; index < activity.files.length; index += 1) {
    const previousOps = activity.files[index - 1].reads + activity.files[index - 1].edits + activity.files[index - 1].writes
    const currentOps = activity.files[index].reads + activity.files[index].edits + activity.files[index].writes
    assert.ok(previousOps >= currentOps, "files are sorted by read+edit+write descending")
  }
  // limit clamps to [1, MAX]; an over-limit request is capped.
  const capped = getMockFileActivity(MOCK_FILE_ACTIVITY_MAX_LIMIT + 500)
  assert.ok(capped.files.length <= MOCK_FILE_ACTIVITY_MAX_LIMIT, "the limit is capped at the wire maximum")
})

test("getMockTokenLedger keeps the wire shape, recomputes totals and reports balanced conservation", async () => {
  const { getMockTokenLedger } = await import("../src/web/public/mock-token-ledger.js")

  const ledger = getMockTokenLedger()
  const { totals, conservation, reconciliation, sessions } = ledger
  assert.equal(
    totals.promptTotal,
    totals.promptInput + totals.promptCacheRead + totals.promptCacheWrite,
    "promptTotal is the sum of the three prompt components",
  )
  assert.equal(typeof conservation.balanced, "boolean", "conservation carries a balanced flag")
  assert.ok(
    conservation.anomalies.negativeComponents >= 0 && conservation.anomalies.cacheReadExceedsPrompt >= 0,
    "the anomaly counters are non-negative",
  )
  assert.ok(Number.isFinite(reconciliation.residualTokens), "reconciliation carries a finite residual")
  assert.ok(sessions.length > 0, "at least one session row")
  for (const session of sessions) {
    assert.equal(typeof session.sessionId, "string", "every ledger session has a string id")
    for (const tokenField of ["promptInput", "promptCacheRead", "promptCacheWrite", "output", "reasoning", "v2Input", "v2CacheRead", "v2CacheWrite", "v2Output"]) {
      assert.ok(Number.isFinite(session[tokenField]), `every ledger session has a finite ${tokenField}`)
    }
  }
  // Sessions are sorted by message-side prompt total descending.
  for (let index = 1; index < sessions.length; index += 1) {
    const previousTotal = sessions[index - 1].promptInput + sessions[index - 1].promptCacheRead + sessions[index - 1].promptCacheWrite
    const currentTotal = sessions[index].promptInput + sessions[index].promptCacheRead + sessions[index].promptCacheWrite
    assert.ok(previousTotal >= currentTotal, "ledger sessions are sorted by prompt total descending")
  }
})

test("getMockSessionEvents returns seq-ascending whitelisted events and null for a missing legacy session", async () => {
  const { getMockSessionEvents, getMockTokenLedger } = await import("../src/web/public/mock-token-ledger.js")
  const { getMockSessionMessages } = await import("../src/web/public/mock-replay-data.js")

  // Derive a real session id from the ledger/messages fixtures rather than hard-coding one.
  const sampleSession = getMockTokenLedger().sessions[0]
  const directMessages = getMockSessionMessages(sampleSession.sessionId)
  if (directMessages !== null) {
    const eventsPayload = getMockSessionEvents(sampleSession.sessionId)
    if (eventsPayload !== null) {
      for (const event of eventsPayload.events) {
        assert.ok(
          ["compaction", "model-switched", "system"].includes(event.type),
          "only the whitelisted event types survive",
        )
      }
      for (let index = 1; index < eventsPayload.events.length; index += 1) {
        assert.ok(eventsPayload.events[index - 1].seq <= eventsPayload.events[index].seq, "events are seq ascending")
      }
    }
  }
  // legacy_ prefix mirrors the real 404 (data-source turns null into SessionNotFoundError).
  assert.equal(getMockSessionEvents("legacy_missing_session"), null, "a legacy session yields null events")
})

test("getMockSessionLineage keeps the wire shape, keeps edges within the node set and focuses a known session", async () => {
  const { getMockSessionLineage } = await import("../src/web/public/mock-session-lineage.js")

  const lineage = getMockSessionLineage()
  assert.equal(lineage.focusSessionId, null, "an unfocused request has a null focusSessionId")
  assert.ok(lineage.nodes.length > 0, "the mock materialises nodes")
  assert.ok(lineage.edges.length > 0, "the mock materialises edges")
  const nodeIds = new Set(lineage.nodes.map((node: { sessionId: string }) => node.sessionId))
  for (const edge of lineage.edges) {
    assert.ok(nodeIds.has(edge.parentSessionId), "every edge parent is in the node set")
    assert.ok(nodeIds.has(edge.childSessionId), "every edge child is in the node set")
  }
  for (const node of lineage.nodes) {
    assert.equal(typeof node.sessionId, "string", "every node has a string id")
    assert.ok(node.parentSessionId === null || typeof node.parentSessionId === "string", "parentSessionId is string or null")
    for (const field of ["title", "agent"]) {
      assert.equal(typeof node[field], "string", `every node has a string ${field}`)
    }
    for (const field of ["tokens", "timeCreated", "childCount"]) {
      assert.ok(Number.isFinite(node[field]), `every node has a finite ${field}`)
    }
  }
  assert.ok(Number.isFinite(lineage.stats.totalSessions), "stats carries a finite totalSessions")
  assert.ok(lineage.omittedNodeCount >= 0, "omittedNodeCount is non-negative")

  // Focusing a known node echoes it back as focusSessionId.
  const focusTargetId = lineage.nodes[0].sessionId
  const focused = getMockSessionLineage(focusTargetId)
  assert.equal(focused.focusSessionId, focusTargetId, "focusing a known session echoes its id")
})

test("every v0.29 mock feeds its component without falling back to the empty state", async () => {
  const { renderContentCompositionCard } = await import("../src/web/public/components/content-composition-card.js")
  const { renderTokenLedgerCard } = await import("../src/web/public/components/token-ledger-card.js")
  const { renderFileActivityTable } = await import("../src/web/public/components/file-activity-table.js")
  const { renderSessionLineageGraph } = await import("../src/web/public/components/session-lineage-graph.js")
  const { renderAgentTable } = await import("../src/web/public/components/agent-table.js")
  const { getMockContentComposition } = await import("../src/web/public/mock-content-composition.js")
  const { getMockTokenLedger } = await import("../src/web/public/mock-token-ledger.js")
  const { getMockFileActivity } = await import("../src/web/public/mock-file-activity.js")
  const { getMockSessionLineage } = await import("../src/web/public/mock-session-lineage.js")
  const { getMockAgentStats } = await import("../src/web/public/mock-data.js")

  const contentContainer = freshContainer()
  renderContentCompositionCard(contentContainer, getMockContentComposition())
  assert.ok(contentContainer.innerHTML.includes("content-composition-bar"), "content mock renders the real panel")
  assert.ok(!contentContainer.innerHTML.includes("state-view"), "content mock does not hit the empty state")

  const ledgerContainer = freshContainer()
  renderTokenLedgerCard(ledgerContainer, getMockTokenLedger())
  assert.ok(ledgerContainer.innerHTML.includes("ledger-card"), "ledger mock renders the real panel")
  assert.ok(!ledgerContainer.innerHTML.includes("state-view"), "ledger mock does not hit the empty state")

  const fileContainer = freshContainer()
  renderFileActivityTable(fileContainer, getMockFileActivity())
  assert.ok(fileContainer.innerHTML.includes("file-activity-table"), "file mock renders the real panel")
  assert.ok(!fileContainer.innerHTML.includes("state-view"), "file mock does not hit the empty state")

  const lineageContainer = new ListenerTrackingContainer("div")
  const lineageCleanup = renderSessionLineageGraph(lineageContainer, getMockSessionLineage())
  assert.ok(lineageContainer.innerHTML.includes("session-lineage-svg"), "lineage mock renders the real panel")
  assert.ok(!lineageContainer.innerHTML.includes("state-view"), "lineage mock does not hit the empty state")
  lineageCleanup()

  const agentContainer = freshContainer()
  renderAgentTable(agentContainer, getMockAgentStats())
  assert.ok(agentContainer.innerHTML.includes("agent-table"), "agent mock renders the real panel")
  assert.ok(!agentContainer.innerHTML.includes("state-view"), "agent mock does not hit the empty state")
})

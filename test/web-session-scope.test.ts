/**
 * v0.20.0 会话作用域接线测试（fix-35 收口）。
 *
 * 这是接线 lane 原计划建立、却停在「实现已落盘、测试尚未创建」临界点的那份
 * 测试：复用 test/helpers/web-dom-shim.ts 的 DOM shim，锁定七类行为——
 *   1. data-source：scope 激活时 URL 追加 session 参数（无 query 用 ?、有
 *      query 用 &），scope 为空时路径与旧版逐字节一致；带 session 的 404
 *      + 契约 body 翻译成 SessionScopeNotFoundError，其余 404 维持通用错误；
 *   2. session-sort-controller：缓存键按 scope 分离（切 scope 不吃另一口径
 *      的陈旧缓存）；作用域 404 经 onSessionScopeVanished 上抛且不落错误卡；
 *      锁定视图只渲染单会话行、排序/范围/导出/行内按钮一并收起；
 *   3. session-sort-controller → session-list 链路：行内「只看此会话」把
 *      (id,title) 上抛并 stopPropagation（不与进回放页同时触发）；
 *   4. session-list：v0.20.0 三根新列（命中率/Reasoning/步数）按富化字段
 *      计算、旧 wire 缺字段降级为「—」且绝不出 NaN、子代理徽标两形态；
 *   5. session-scope-chip：激活填充 / 退出清空落回 hidden / 404 轻提示限时
 *      恢复 + 提示期间真实 chip 入场不被闪掉；
 *   6. session-scope-visibility：隐藏区/保留区清单互斥，scope 激活时隐藏区
 *      hidden、保留区不 hidden，退出全恢复；
 *   7. session-scope-visibility 清单与 index.html 锚点/TOC 按钮对齐。
 *
 * app.js 本体在 import 期即执行 init()（触碰 window 事件与常驻锚点），DOM
 * shim 无法承载，因此顶栏 chip 与面板显隐的**应用**分别以 chip 模块与
 * 显隐映射模块为断言对象；映射与 index.html 的锚点对齐由第 7 组兜底。
 * 夹具一律用虚构的 example 系列占位符（发布清单 #3）。
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

import { installDomShim, freshContainer, sleep } from "./helpers/web-dom-shim.ts"
import { MISSING_REASON } from "../src/web/public/precision.js"

installDomShim()

/* ---------------- 共享夹具 ---------------- */

/**
 * 会话列表行夹具（与 web-components.test.ts 的 SessionListFixtureSummary
 * 同形，另加 v0.20.0 富化字段）。全部字段可选，以模拟旧/新两种 wire。
 */
interface ScopeFixtureSummary {
  id: string
  title: string
  modelId: string
  agent: string
  directory: string
  timeCreated: number
  timeUpdated: number
  tokens: number
  cost: number
  tokensInput?: number
  tokensOutput?: number
  tokensCacheRead?: number
  tokensCacheWrite?: number
  tokensReasoning?: number
  stepCount?: number
  parentSessionId?: string | null
  childSessionCount?: number
  childTokensTotal?: number
}

function scopeFixtureSession(
  id: string,
  title: string,
  overrides: Partial<ScopeFixtureSummary> = {},
): ScopeFixtureSummary {
  return {
    id,
    title,
    modelId: "glm-5.3",
    agent: "build",
    directory: "D:/projects/example-alpha",
    timeCreated: 1000,
    timeUpdated: 5000,
    tokens: 900,
    cost: 1.0,
    ...overrides,
  }
}

/** Let the controller's promise continuations (microtasks) drain before asserting. */
async function flushControllerMicrotasks(): Promise<void> {
  await new Promise<void>((resolveFlush) => {
    setTimeout(resolveFlush, 0)
  })
}

/* ---------------- 第 1 组：data-source 作用域 URL / 404 翻译 ---------------- */

interface StubFetchResponseSpec {
  ok: boolean
  status: number
  json: () => Promise<unknown>
}

/** Install a capturing fetch stub; caller must call restore() in a finally. */
function installStubFetch(
  respond: (requestUrl: string) => StubFetchResponseSpec,
): { capturedUrls: string[]; restore: () => void } {
  const savedFetch = globalThis.fetch
  const capturedUrls: string[] = []
  globalThis.fetch = (async (fetchInput: unknown) => {
    const requestUrl = String(fetchInput)
    capturedUrls.push(requestUrl)
    const responseSpec = respond(requestUrl)
    return { ok: responseSpec.ok, status: responseSpec.status, json: responseSpec.json }
  }) as unknown as typeof fetch
  return {
    capturedUrls,
    restore: () => {
      globalThis.fetch = savedFetch
    },
  }
}

/** A per-path 200 body that satisfies every scoped fetch's shape guard. */
function okJsonBody(requestUrl: string): unknown {
  if (requestUrl.includes("/overview")) return { todayTokens: 1 }
  if (
    requestUrl.includes("/session-survival")
    || requestUrl.includes("/compaction")
    || requestUrl.includes("/todo")
    || requestUrl.includes("/directories")
  ) {
    return {}
  }
  if (requestUrl.includes("/session-distribution")) {
    return { totalSessions: 0, buckets: [], percentiles: { p50: 0, p90: 0, p99: 0 }, mean: 0, max: 0 }
  }
  // trend / models / agents / tool-health / hour-heatmap all consume arrays.
  return []
}

test("data-source: fetchRefresh requests /api/refresh exactly, never /api/api/refresh", async () => {
  const { fetchRefresh } = await import("../src/web/public/data-source.js")
  const stub = installStubFetch(() => ({ ok: true, status: 200, json: async () => ({}) }))
  try {
    await fetchRefresh()
  } finally {
    stub.restore()
  }
  // fetchWithTimeout prefixes API_BASE ("/api") itself, so the path argument
  // must be the relative segment. Writing "/api/refresh" produced
  // "/api/api/refresh" → 404 on every page load, silently disabling the
  // cache-busting call (the page then fell back to the 60s TTL and F5 could
  // show data up to a minute old). Live browser run showed exactly two such
  // 404s per load.
  assert.deepEqual(stub.capturedUrls, ["/api/refresh"], "the refresh call must hit the single-prefix endpoint")
})

test("data-source: every ?session= endpoint appends the scope param, and a null scope keeps the legacy path", async () => {
  const dataSource = await import("../src/web/public/data-source.js")
  const scopeId = "ses_example_scope"
  const stub = installStubFetch((requestUrl) => ({
    ok: true,
    status: 200,
    json: async () => okJsonBody(requestUrl),
  }))
  try {
    await dataSource.fetchOverview(scopeId)
    await dataSource.fetchTrend(30, scopeId)
    await dataSource.fetchModels(null, scopeId)
    await dataSource.fetchAgents(scopeId)
    await dataSource.fetchToolHealth(scopeId)
    await dataSource.fetchHourHeatmap(90, scopeId)
    await dataSource.fetchSessionSurvival(scopeId)
    await dataSource.fetchCompaction(scopeId)
    await dataSource.fetchTodo(scopeId)
    await dataSource.fetchDirectoryStats(10, scopeId)

    for (const requestUrl of stub.capturedUrls) {
      assert.ok(requestUrl.startsWith("/api/"), `every request stays on the /api base: ${requestUrl}`)
      assert.ok(
        requestUrl.includes(`session=${scopeId}`),
        `a scoped request must carry the session param: ${requestUrl}`,
      )
    }
    // appendQuerySegment: no existing query → "?", an existing query → "&".
    assert.ok(stub.capturedUrls.includes(`/api/overview?session=${scopeId}`))
    assert.ok(stub.capturedUrls.includes(`/api/trend?days=30&session=${scopeId}`))
    assert.ok(stub.capturedUrls.includes(`/api/directories?limit=10&session=${scopeId}`))
    assert.ok(stub.capturedUrls.includes(`/api/hour-heatmap?days=90&session=${scopeId}`))
    assert.ok(stub.capturedUrls.includes(`/api/models?session=${scopeId}`))

    // scope 缺省（null）时请求路径与旧版逐字节一致。
    stub.capturedUrls.length = 0
    await dataSource.fetchAgents()
    await dataSource.fetchTrend(30)
    await dataSource.fetchModels(null)
    assert.deepEqual(
      stub.capturedUrls,
      ["/api/agents", "/api/trend?days=30", "/api/models"],
      "a null scope must not append any session segment",
    )
  } finally {
    stub.restore()
  }
})

test("data-source: a scoped 404 with the session-not-found body becomes SessionScopeNotFoundError; other 404s stay generic", async () => {
  const dataSource = await import("../src/web/public/data-source.js")
  const { SessionScopeNotFoundError } = dataSource

  // 带 session 参数 + 契约 body → 作用域错误（app 层据此自动退出）。
  const contractStub = installStubFetch(() => ({
    ok: false,
    status: 404,
    json: async () => ({ error: "session not found" }),
  }))
  try {
    await assert.rejects(
      dataSource.fetchOverview("ses_example_gone"),
      (error: unknown) => error instanceof SessionScopeNotFoundError,
      "a scoped 404 carrying the contract body must surface as SessionScopeNotFoundError",
    )
  } finally {
    contractStub.restore()
  }

  // 无 session 参数的 404 是路由层问题，不得冒充「会话已删」。
  const unscopedStub = installStubFetch(() => ({
    ok: false,
    status: 404,
    json: async () => ({ error: "session not found" }),
  }))
  try {
    await assert.rejects(
      dataSource.fetchOverview(null),
      (error: unknown) =>
        !(error instanceof SessionScopeNotFoundError)
        && /返回 404/.test((error as Error).message),
      "an unscoped 404 must keep the generic error semantics",
    )
  } finally {
    unscopedStub.restore()
  }

  // 带 session 参数但 body 不是契约消息：同样不翻译成作用域错误。
  const wrongBodyStub = installStubFetch(() => ({
    ok: false,
    status: 404,
    json: async () => ({ error: "some other failure" }),
  }))
  try {
    await assert.rejects(
      dataSource.fetchOverview("ses_example_gone"),
      (error: unknown) => !(error instanceof SessionScopeNotFoundError),
      "only the exact contract body may become a scope error",
    )
  } finally {
    wrongBodyStub.restore()
  }
})

/* ---------------- 第 2 组：session-sort-controller 作用域缓存/锁定 ---------------- */

interface ScopedPageRequest {
  sortKey: string
  sortOrder: string
  directory: string | null
  range: string
  day: string | null
  sessionScopeId: string | null
  resolve: (payload: { total: null; sessions: ScopeFixtureSummary[] }) => void
  reject: (error: Error) => void
}

/** Deferred page-request harness carrying the day (5th) and scope (6th) args. */
function createScopedPageHarness() {
  const pendingRequests: ScopedPageRequest[] = []
  const fetchSessionsPage = (
    sortKey: string,
    sortOrder: string,
    directory: string | null,
    range: string,
    day: string | null,
    sessionScopeId: string | null,
  ) =>
    new Promise<{ total: null; sessions: ScopeFixtureSummary[] }>((resolve, reject) => {
      pendingRequests.push({ sortKey, sortOrder, directory, range, day, sessionScopeId, resolve, reject })
    })
  return {
    fetchSessionsPage,
    pendingRequests,
    settleWith: (requestIndex: number, markerTitle: string, id = "ses_example_alpha") => {
      pendingRequests[requestIndex].resolve({
        total: null,
        sessions: [scopeFixtureSession(id, markerTitle)],
      })
    },
    rejectWith: (requestIndex: number, error: Error) => {
      pendingRequests[requestIndex].reject(error)
    },
  }
}

test("session-sort-controller: scope switch re-requests and the two scopes keep separate cache slots (no cross-scope stale payload)", async () => {
  const { createSessionSortController } = await import(
    "../src/web/public/components/session-sort-controller.js"
  )
  const container = freshContainer()
  const harness = createScopedPageHarness()
  const controller = createSessionSortController({
    containerElement: container,
    fetchSessionsPage: harness.fetchSessionsPage,
    getModelFilter: () => null,
  })

  controller.load() // request 0: scope null
  assert.equal(harness.pendingRequests[0]!.sessionScopeId, null, "the default view requests without a scope")
  harness.settleWith(0, "all-scope marker")
  await flushControllerMicrotasks()
  assert.ok(container.innerHTML.includes("all-scope marker"))

  controller.changeSessionScope("ses_example_scope") // request 1: scope set
  assert.equal(harness.pendingRequests.length, 2, "entering a scope must issue a request (its slot is empty)")
  assert.equal(
    harness.pendingRequests[1]!.sessionScopeId,
    "ses_example_scope",
    "the scoped view requests with the scope id",
  )
  harness.settleWith(1, "scoped marker", "ses_example_scope")
  await flushControllerMicrotasks()
  assert.ok(container.innerHTML.includes("scoped marker"))

  // 退出作用域：无作用域槽位此前已填，直接命中，不得发新请求、不得落到作用域载荷。
  controller.changeSessionScope(null)
  assert.equal(harness.pendingRequests.length, 2, "leaving a scope is a cache hit on the unscoped slot")
  assert.ok(container.innerHTML.includes("all-scope marker"), "the unscoped slot still serves its own payload")
  assert.ok(!container.innerHTML.includes("scoped marker"), "the scoped payload must not leak into the unscoped view")

  // 切回作用域：命中作用域槽位（两槽互不污染）。
  controller.changeSessionScope("ses_example_scope")
  assert.equal(harness.pendingRequests.length, 2, "re-entering the scope is a cache hit on the scoped slot")
  assert.ok(container.innerHTML.includes("scoped marker"))
  assert.ok(!container.innerHTML.includes("all-scope marker"))
})

test("session-sort-controller: a scoped SessionScopeNotFoundError routes through onSessionScopeVanished without an error card", async () => {
  const { createSessionSortController } = await import(
    "../src/web/public/components/session-sort-controller.js"
  )
  const { SessionScopeNotFoundError } = await import("../src/web/public/data-source.js")
  const container = freshContainer()
  const harness = createScopedPageHarness()
  let vanishedCount = 0
  let failedCount = 0
  const controller = createSessionSortController({
    containerElement: container,
    fetchSessionsPage: harness.fetchSessionsPage,
    getModelFilter: () => null,
    onSessionScopeVanished: () => {
      vanishedCount += 1
    },
    markSectionFailed: () => {
      failedCount += 1
    },
  })

  controller.changeSessionScope("ses_example_gone")
  assert.equal(harness.pendingRequests.length, 1)
  harness.rejectWith(0, new SessionScopeNotFoundError())
  await flushControllerMicrotasks()

  assert.equal(vanishedCount, 1, "the deleted-session error must surface once through the vanish hook")
  assert.equal(failedCount, 0, "the scope error must not be counted as a section failure")
  assert.ok(
    !container.innerHTML.includes("这块数据没加载出来"),
    "the vanished session must not render the block error card",
  )
  assert.equal(container.querySelectorAll(".retry-button").length, 0, "no retry button for the auto-exit case")
})

test("session-sort-controller: the scope-locked single-session view drops sort headers, range switch, export entry and the row scope button", async () => {
  const { createSessionSortController } = await import(
    "../src/web/public/components/session-sort-controller.js"
  )
  const container = freshContainer()
  const harness = createScopedPageHarness()
  const controller = createSessionSortController({
    containerElement: container,
    fetchSessionsPage: harness.fetchSessionsPage,
    getModelFilter: () => null,
    onSessionScopeChange: () => {},
  })

  controller.changeSessionScope("ses_example_scope")
  harness.settleWith(0, "locked view marker", "ses_example_scope")
  await flushControllerMicrotasks()

  assert.equal(container.querySelectorAll("tr.session-row").length, 1, "the locked view is a single-session list")
  assert.equal(container.querySelectorAll("th.sortable").length, 0, "sorting is locked in the scope view")
  assert.equal(
    container.querySelectorAll(".session-range-button").length,
    0,
    "the range switch is not rendered when the view is locked",
  )
  assert.equal(
    container.querySelectorAll("a.export-csv").length,
    0,
    "the CSV export entry is not rendered when locked (its endpoint does not consume ?session=)",
  )
  assert.equal(
    container.querySelectorAll("button.session-scope-button").length,
    0,
    "the row scope button is not re-rendered inside the active scope",
  )
  assert.match(container.innerHTML, /只看此会话 · 排序与导出已锁定/, "the footnote explains the locked scope view")
  assert.ok(container.innerHTML.includes("locked view marker"))
})

test("session-sort-controller→session-list: clicking 只看此会话 threads (id,title) to onSessionScopeChange and stops the row-click bubble", async () => {
  const { createSessionSortController } = await import(
    "../src/web/public/components/session-sort-controller.js"
  )
  const container = freshContainer()
  const harness = createScopedPageHarness()
  const scopeSelections: Array<{ sessionId: string; sessionTitle: string }> = []
  const controller = createSessionSortController({
    containerElement: container,
    fetchSessionsPage: harness.fetchSessionsPage,
    getModelFilter: () => null,
    onSessionScopeChange: (sessionId: string, sessionTitle: string) => {
      scopeSelections.push({ sessionId, sessionTitle })
    },
  })

  controller.load()
  harness.pendingRequests[0]!.resolve({
    total: null,
    sessions: [
      scopeFixtureSession("ses_example_alpha", "alpha fixture"),
      scopeFixtureSession("ses_example_bravo", "bravo fixture"),
    ],
  })
  await flushControllerMicrotasks()

  const scopeButtons = container.querySelectorAll("button.session-scope-button")
  assert.equal(scopeButtons.length, 2, "every row carries its own 只看此会话 action")
  assert.equal(scopeButtons[0]!.dataset.sessionScopeId, "ses_example_alpha")
  assert.equal(scopeButtons[0]!.dataset.sessionScopeTitle, "alpha fixture")

  // 真实点击带 stopPropagation：行本体点击（进回放页）不得与进入作用域同时触发。
  let stopPropagationCalls = 0
  scopeButtons[1]!.click({
    stopPropagation: () => {
      stopPropagationCalls += 1
    },
  })
  assert.equal(stopPropagationCalls, 1, "the scope action must stop the bubble before it reaches the row")
  assert.deepEqual(scopeSelections, [{ sessionId: "ses_example_bravo", sessionTitle: "bravo fixture" }])

  // 事件对象缺失的降级环境仍要上抛（不影响回放路由的既有行为）。
  scopeButtons[0]!.click()
  assert.equal(scopeSelections.length, 2, "the action still fires when the event object is absent")
  assert.deepEqual(scopeSelections[1], { sessionId: "ses_example_alpha", sessionTitle: "alpha fixture" })
})

/* ---------------- 第 3 组：session-list 三根新列 + 降级 + 子代理徽标 ---------------- */

test("session-list: the v0.20.0 命中率/Reasoning/步数 cells compute from the enriched wire", async () => {
  const { renderSessionList } = await import("../src/web/public/components/session-list.js")
  const { formatPercent, formatTokens, formatCount } = await import("../src/web/public/format.js")
  const container = freshContainer()

  const cacheRead = 765
  const paidInput = 90
  const cacheWrite = 45
  const reasoning = 4000
  const stepCount = 27

  renderSessionList(
    container,
    {
      total: null,
      sessions: [
        scopeFixtureSession("ses_example_golf", "golf fixture", {
          tokens: 900,
          tokensInput: paidInput,
          tokensOutput: 45,
          tokensCacheRead: cacheRead,
          tokensCacheWrite: cacheWrite,
          tokensReasoning: reasoning,
          stepCount,
        }),
      ],
    },
    null,
    "time_updated",
    "desc",
    () => {},
  )

  assert.ok(
    container.innerHTML.includes(
      `<td class="num">${formatPercent(cacheRead / (cacheRead + paidInput + cacheWrite))}</td>`,
    ),
    "命中率 = cache.read / (input + cache.read + cache.write)",
  )
  assert.ok(
    container.innerHTML.includes(`<td class="num">${formatTokens(reasoning)}</td>`),
    "Reasoning renders formatTokens(tokensReasoning)",
  )
  assert.ok(
    container.innerHTML.includes(`<td class="num">${formatCount(stepCount)}</td>`),
    "步数 renders formatCount(stepCount)",
  )
  assert.ok(!/NaN/.test(container.innerHTML), "the enriched wire must never render NaN")
})

test("session-list: a legacy wire missing the enrichment fields degrades every new cell to — and never renders NaN", async () => {
  const { renderSessionList } = await import("../src/web/public/components/session-list.js")
  const container = freshContainer()

  renderSessionList(
    container,
    { total: null, sessions: [scopeFixtureSession("ses_example_hotel", "hotel fixture", { tokens: 1200 })] },
    null,
    "time_updated",
    "desc",
    () => {},
  )

  assert.ok(
    container.innerHTML.includes(
      `<td class="num"><span class="missing-value" title="${MISSING_REASON.legacyField}">—</span></td>`,
    ),
    "missing cache/input parts degrade 命中率 to the shared not-recorded placeholder",
  )
  assert.ok(
    container.innerHTML.includes(
      `<td class="num"><span class="missing-value" title="${MISSING_REASON.legacyField}">—</span></td>`,
    ),
    "missing tokensReasoning degrades Reasoning to the shared not-recorded placeholder",
  )
  assert.ok(
    container.innerHTML.includes(
      `<td class="num"><span class="missing-value" title="${MISSING_REASON.legacyField}">—</span></td>`,
    ),
    "missing stepCount degrades 步数 to the shared not-recorded placeholder",
  )
  assert.ok(!/NaN/.test(container.innerHTML), "the legacy wire must never render NaN")
  assert.ok(!container.innerHTML.includes("undefined"), "missing fields must not leak the literal undefined")
})

test("session-list: a zero token denominator degrades 命中率 to — while honest zeros stay 0 in the value columns", async () => {
  const { renderSessionList } = await import("../src/web/public/components/session-list.js")
  const { formatTokens, formatCount } = await import("../src/web/public/format.js")
  const container = freshContainer()

  renderSessionList(
    container,
    {
      total: null,
      sessions: [
        scopeFixtureSession("ses_example_india", "india fixture", {
          tokens: 0,
          tokensInput: 0,
          tokensOutput: 0,
          tokensCacheRead: 0,
          tokensCacheWrite: 0,
          tokensReasoning: 0,
          stepCount: 0,
        }),
      ],
    },
    null,
    "time_updated",
    "desc",
    () => {},
  )

  assert.ok(
    container.innerHTML.includes(
      `<td class="num"><span class="missing-value" title="${MISSING_REASON.zeroDenominator}">—</span></td>`,
    ),
    "a zero denominator is not a computable hit rate → —",
  )
  // 0 reasoning / 0 steps are real data (the field is present and zero), not the
  // not-recorded degradation — they render an honest 0.
  assert.ok(
    container.innerHTML.includes(`<td class="num">${formatTokens(0)}</td>`),
    "a present, zero tokensReasoning renders an honest 0",
  )
  assert.ok(
    container.innerHTML.includes(`<td class="num">${formatCount(0)}</td>`),
    "a present, zero stepCount renders an honest 0",
  )
})

test("session-list: parent rows show the +N 直接子会话 badge (with/without the child token total) and child rows carry the ↳ marker", async () => {
  const { renderSessionList } = await import("../src/web/public/components/session-list.js")
  const { formatTokens } = await import("../src/web/public/format.js")
  const container = freshContainer()

  renderSessionList(
    container,
    {
      total: null,
      sessions: [
        scopeFixtureSession("ses_example_parent_a", "parent a", { childSessionCount: 3, childTokensTotal: 5000 }),
        scopeFixtureSession("ses_example_parent_b", "parent b", { childSessionCount: 1 }),
        scopeFixtureSession("ses_example_child", "child row", { parentSessionId: "ses_example_parent_a" }),
        scopeFixtureSession("ses_example_plain", "plain row"),
      ],
    },
    null,
    "time_updated",
    "desc",
    () => {},
  )

  assert.ok(
    container.innerHTML.includes(`title="3 个直接子代理会话 · 仅直接子代，不含孙代 · 合计 tokens ${formatTokens(5000)}">+3 直接子会话</span>`),
    "a parent badge reports the direct child count and the aggregate tokens",
  )
  assert.ok(
    container.innerHTML.includes('title="1 个直接子代理会话 · 仅直接子代，不含孙代">+1 直接子会话</span>'),
    "a parent without childTokensTotal reports only the count",
  )
  assert.equal(container.querySelectorAll("span.session-child-marker").length, 1, "only the child row carries the ↳ marker")
  assert.ok(
    container.innerHTML.includes(
      '<span class="session-child-marker" style="margin-right:4px" title="子代理会话（由父会话派生）">↳</span>',
    ),
    "the child marker spells out its sub-agent semantics on hover",
  )
  assert.equal(
    container.querySelectorAll("span.session-child-count-badge").length,
    2,
    "only the two rows with children carry the count badge",
  )
})

/* ---------------- 第 4 组：顶栏作用域 chip ---------------- */

test("session-scope-chip: renderSessionScopeChip fills the active chip (self-bound ✕) and clears back to hidden on exit", async () => {
  const { renderSessionScopeChip } = await import("../src/web/public/components/session-scope-chip.js")
  const container = freshContainer()

  let exitCount = 0
  renderSessionScopeChip(
    container,
    { sessionId: "ses_example_scope", sessionTitle: "scope fixture" },
    () => {
      exitCount += 1
    },
  )
  assert.equal(container.attributes.has("hidden"), false, "an active scope un-hides the chip slot")
  assert.ok(container.innerHTML.includes("scope-chip"), "the chip markup is mounted")
  assert.match(
    container.innerHTML,
    /只看此会话：scope fixture（ses_example_scope）· 看板各统计只统计这一个会话/,
    "the hover title spells out the scope semantics with id and title",
  )

  const clearButton = container.querySelector("button.scope-chip-clear")
  assert.notEqual(clearButton, null, "the chip carries its ✕ exit action")
  clearButton!.click()
  assert.equal(exitCount, 1, "the ✕ click calls the app-layer exit callback")

  // 空标题回退到 id（chip 仍可见，不出现空标签）。
  renderSessionScopeChip(container, { sessionId: "ses_example_untitled", sessionTitle: "" }, () => {})
  assert.ok(container.innerHTML.includes("ses_example_untitled"), "an empty title falls back to the session id")

  // 退出态：清空 + 落回 hidden 属性（视觉 lane 的 :not([hidden]) 选择器靠属性）。
  renderSessionScopeChip(container, null, () => {})
  assert.equal(container.innerHTML, "", "the exit state clears the chip markup")
  assert.equal(container.attributes.get("hidden"), "", "the exit state hides the slot via the hidden attribute")
})

test("session-scope-chip: flashSessionScopeVanishedNotice shows the auto-exit notice then restores hidden", async () => {
  const { flashSessionScopeVanishedNotice } = await import(
    "../src/web/public/components/session-scope-chip.js"
  )
  const container = freshContainer()

  flashSessionScopeVanishedNotice(container, 20)
  assert.equal(container.attributes.has("hidden"), false, "the notice un-hides the slot")
  assert.ok(container.innerHTML.includes("已退出"), "the notice states the scope was exited")
  assert.ok(
    container.innerHTML.includes("该会话已不存在，恢复全部会话"),
    "the notice explains why the scope was dropped",
  )
  assert.equal(
    container.querySelectorAll("button.scope-chip-clear").length,
    0,
    "the vanished notice carries no ✕ action (there is nothing to exit)",
  )

  await sleep(50)
  assert.equal(container.innerHTML, "", "the notice auto-clears after its visible duration")
  assert.equal(container.attributes.get("hidden"), "", "the slot falls back to hidden after the notice")
})

test("session-scope-chip: a real chip entering during the notice window is not flashed away", async () => {
  const { renderSessionScopeChip, flashSessionScopeVanishedNotice } = await import(
    "../src/web/public/components/session-scope-chip.js"
  )
  const container = freshContainer()

  flashSessionScopeVanishedNotice(container, 30)
  // 提示期间用户立刻又进了另一个会话的作用域：真实 chip 入场。
  renderSessionScopeChip(container, { sessionId: "ses_example_scope", sessionTitle: "scope fixture" }, () => {})

  await sleep(60)
  assert.ok(
    container.innerHTML.includes("scope fixture"),
    "the freshly entered chip must survive the stale notice timer",
  )
  assert.equal(container.attributes.has("hidden"), false, "the surviving chip stays un-hidden")
})

/* ---------------- 第 5 组：作用域面板显隐映射 ---------------- */

test("session-scope-visibility: the hidden/kept section lists are the expected disjoint sets", async () => {
  const { SESSION_SCOPE_HIDDEN_SECTION_IDS, SESSION_SCOPE_KEPT_SECTION_IDS } = await import(
    "../src/web/public/components/session-scope-visibility.js"
  )

  assert.deepEqual(SESSION_SCOPE_HIDDEN_SECTION_IDS, [
    "panel-trend",
    "panel-calendar",
    "panel-hour-heatmap",
    "panel-survival",
    "panel-distribution",
    "panel-step-distribution",
    "panel-duration-distribution",
    "panel-child-share",
    "panel-tool-error-trend",
    "panel-session-outcomes",
    "panel-agents",
    "panel-directories",
    "panel-search",
  ])
  assert.deepEqual(SESSION_SCOPE_KEPT_SECTION_IDS, [
    "kpi-row",
    "panel-tools",
    "panel-funnel",
    "panel-compaction",
    "panel-todo",
    "panel-models",
    "panel-sessions",
  ])
  assert.deepEqual(
    SESSION_SCOPE_HIDDEN_SECTION_IDS.filter((sectionId) => SESSION_SCOPE_KEPT_SECTION_IDS.includes(sectionId)),
    [],
    "no section may be both hidden and kept",
  )
})

test("session-scope-visibility: sessionScopeSectionHiddenById hides the scope-irrelevant sections only while active", async () => {
  const {
    sessionScopeSectionHiddenById,
    SESSION_SCOPE_HIDDEN_SECTION_IDS,
    SESSION_SCOPE_KEPT_SECTION_IDS,
  } = await import("../src/web/public/components/session-scope-visibility.js")

  const inactiveMap = sessionScopeSectionHiddenById(false)
  assert.equal(
    inactiveMap.size,
    SESSION_SCOPE_HIDDEN_SECTION_IDS.length + SESSION_SCOPE_KEPT_SECTION_IDS.length,
    "the map covers every managed section",
  )
  for (const sectionHidden of inactiveMap.values()) {
    assert.equal(sectionHidden, false, "everything is visible when the scope is inactive (exit restores)")
  }

  const activeMap = sessionScopeSectionHiddenById(true)
  for (const sectionId of SESSION_SCOPE_HIDDEN_SECTION_IDS) {
    assert.equal(activeMap.get(sectionId), true, `${sectionId} must be hidden under an active scope`)
  }
  for (const sectionId of SESSION_SCOPE_KEPT_SECTION_IDS) {
    assert.equal(activeMap.get(sectionId), false, `${sectionId} must stay visible under an active scope`)
  }
})

test("session-scope-visibility: every managed section id has a matching index.html anchor and TOC button", async () => {
  const { SESSION_SCOPE_HIDDEN_SECTION_IDS, SESSION_SCOPE_KEPT_SECTION_IDS } = await import(
    "../src/web/public/components/session-scope-visibility.js"
  )
  const indexHtml = readFileSync(
    fileURLToPath(new URL("../src/web/public/index.html", import.meta.url)),
    "utf8",
  )

  for (const sectionId of [...SESSION_SCOPE_HIDDEN_SECTION_IDS, ...SESSION_SCOPE_KEPT_SECTION_IDS]) {
    assert.ok(indexHtml.includes(`id="${sectionId}"`), `index.html must carry the ${sectionId} anchor`)
    assert.ok(
      indexHtml.includes(`data-toc-target="${sectionId}"`),
      `index.html must carry the ${sectionId} TOC button (app.js toggles it together with the section)`,
    )
  }
})

test("session-scope-visibility: the managed section set equals index.html's anchors and TOC targets (symmetric difference empty)", async () => {
  const { SESSION_SCOPE_HIDDEN_SECTION_IDS, SESSION_SCOPE_KEPT_SECTION_IDS } = await import(
    "../src/web/public/components/session-scope-visibility.js"
  )
  const indexHtml = readFileSync(
    fileURLToPath(new URL("../src/web/public/index.html", import.meta.url)),
    "utf8",
  )

  // 反向断言：index.html 里**每一个** section 锚点与
  // TOC 按钮都必须在受管清单（hidden ∪ kept）里，否则新增面板漏登记显隐映射
  // ——那条漏网的面板在作用域激活时不会被隐藏/保留，静默错位。
  const managedSectionIds = new Set([
    ...SESSION_SCOPE_HIDDEN_SECTION_IDS,
    ...SESSION_SCOPE_KEPT_SECTION_IDS,
  ])
  const collectMatches = (pattern: RegExp): Set<string> => {
    const matchedIds = new Set<string>()
    for (const matchResult of indexHtml.matchAll(pattern)) matchedIds.add(matchResult[1])
    return matchedIds
  }
  const anchoredSectionIds = collectMatches(/\bid="(panel-[a-z-]+|kpi-row)"/g)
  const tocTargetSectionIds = collectMatches(/\bdata-toc-target="([a-z-]+)"/g)

  const symmetricDifference = (leftSet: Set<string>, rightSet: Set<string>): string[] => [
    ...[...leftSet].filter((elementId) => !rightSet.has(elementId)),
    ...[...rightSet].filter((elementId) => !leftSet.has(elementId)),
  ]

  assert.deepEqual(
    symmetricDifference(anchoredSectionIds, managedSectionIds),
    [],
    "every index.html section anchor (panel-*/kpi-row) must be registered in the scope visibility lists",
  )
  assert.deepEqual(
    symmetricDifference(tocTargetSectionIds, managedSectionIds),
    [],
    "every index.html TOC target must be registered in the scope visibility lists",
  )
})

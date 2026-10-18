/**
 * v0.22.0「B 档」两新卡片的接线层测试：前端取数（data-source 路径/参数）、
 * 会话作用域隐藏清单、以及两 loader 的过期请求守卫（作用域版本 + 请求序号）。
 *
 * 后端两端点可能尚未落盘——本文件全程用 fetch 桩 / 隔离 VM 喂数，不依赖
 * 真实端点存在。过期请求守卫的可观测手法镜像
 * test/web-distribution-scope-race.test.ts 的隔离 VM harness。
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { createContext, runInContext } from "node:vm"

/* ---------------- 第 1 组：data-source 两 fetch 的路径 / 参数 ---------------- */

const originalFetch = globalThis.fetch

/** 记录请求 URL 的 fetch 桩：始终回 200 + 固定 body。 */
function stubFetchRecorder(responseBody: unknown): string[] {
  const requestedUrls: string[] = []
  globalThis.fetch = (async (input: unknown) => {
    requestedUrls.push(typeof input === "string" ? input : String(input))
    return { ok: true, status: 200, json: async () => responseBody } as unknown as Response
  }) as typeof fetch
  return requestedUrls
}

test("data-source: fetchToolErrorTrend hits /api/tool-error-trend with the clamped days parameter", async () => {
  const requestedUrls = stubFetchRecorder({ days: 30, points: [] })
  try {
    const { fetchToolErrorTrend } = await import("../src/web/public/data-source.js")
    await fetchToolErrorTrend()
    await fetchToolErrorTrend(90)
    await fetchToolErrorTrend(9999)
    await fetchToolErrorTrend(0)
  } finally {
    globalThis.fetch = originalFetch
  }
  assert.deepEqual(requestedUrls, [
    "/api/tool-error-trend?days=30",
    "/api/tool-error-trend?days=90",
    "/api/tool-error-trend?days=366",
    "/api/tool-error-trend?days=1",
  ])
})

test("data-source: fetchSessionOutcomes hits /api/session-outcomes and never carries a scope parameter", async () => {
  const requestedUrls = stubFetchRecorder({ totalSessions: 0 })
  try {
    const { fetchSessionOutcomes } = await import("../src/web/public/data-source.js")
    await fetchSessionOutcomes()
  } finally {
    globalThis.fetch = originalFetch
  }
  assert.deepEqual(requestedUrls, ["/api/session-outcomes"])
})

test("data-source: both v0.22.0 endpoints throw on a non-object body (contract break)", async () => {
  stubFetchRecorder(null)
  try {
    const { fetchToolErrorTrend, fetchSessionOutcomes } = await import("../src/web/public/data-source.js")
    await assert.rejects(() => fetchToolErrorTrend(), /返回空数据/)
    await assert.rejects(() => fetchSessionOutcomes(), /返回空数据/)
  } finally {
    globalThis.fetch = originalFetch
  }
})

/* ---------------- 第 2 组：作用域隐藏清单 ---------------- */

test("session-scope-visibility: both all-sessions panels join the hidden list and hide only while active", async () => {
  const { SESSION_SCOPE_HIDDEN_SECTION_IDS, sessionScopeSectionHiddenById } = await import(
    "../src/web/public/components/session-scope-visibility.js"
  )
  assert.ok(
    SESSION_SCOPE_HIDDEN_SECTION_IDS.includes("panel-tool-error-trend"),
    "the tool error trend panel is an all-sessions view and must hide under a scope",
  )
  assert.ok(
    SESSION_SCOPE_HIDDEN_SECTION_IDS.includes("panel-session-outcomes"),
    "the session outcomes panel is an all-sessions view and must hide under a scope",
  )

  const activeMap = sessionScopeSectionHiddenById(true)
  assert.equal(activeMap.get("panel-tool-error-trend"), true)
  assert.equal(activeMap.get("panel-session-outcomes"), true)
  const inactiveMap = sessionScopeSectionHiddenById(false)
  assert.equal(inactiveMap.get("panel-tool-error-trend"), false, "exit must restore the trend panel")
  assert.equal(inactiveMap.get("panel-session-outcomes"), false, "exit must restore the outcomes panel")
})

/* ---------------- 第 3 组：两 loader 的过期请求守卫（隔离 VM） ---------------- */

const appSource = readFileSync(fileURLToPath(new URL("../src/web/public/app.js", import.meta.url)), "utf8")
const importPattern = /import\s*\{([^}]+)\}\s*from\s*"[^"]+";/g
const importedNames = [...appSource.matchAll(importPattern)]
  .flatMap((match) => match[1].split(",").map((name) => name.trim()).filter(Boolean))
const executableSource = `const { ${importedNames.join(", ")} } = globalThis.__imports;\n`
  + appSource.replace(importPattern, "").replace(/\ninit\(\);\s*$/, "\n")

interface PendingRequest {
  resolve: (payload: { marker: string }) => void
  reject: (error: Error) => void
}

function createAppHarness() {
  const pendingByEndpoint = new Map<string, PendingRequest[]>()
  const elements = new Map<string, { innerHTML: string; textContent: string; hidden: boolean; className: string; querySelectorAll: () => never[] }>()
  const document = {
    getElementById(elementId: string) {
      if (!elements.has(elementId)) {
        elements.set(elementId, { innerHTML: "", textContent: "", hidden: false, className: "", querySelectorAll: () => [] })
      }
      return elements.get(elementId)!
    },
  }
  const fetchDeferred = (endpoint: string) => new Promise<{ marker: string }>((resolve, reject) => {
    const pendingRequests = pendingByEndpoint.get(endpoint) ?? []
    pendingRequests.push({ resolve, reject })
    pendingByEndpoint.set(endpoint, pendingRequests)
  })
  const imports: Record<string, (...args: unknown[]) => unknown> = Object.fromEntries(
    importedNames.map((name) => [name, () => {}]),
  )
  imports.createSessionSortController = () => ({ changeSessionScope() {} })
  imports.sessionScopeSectionHiddenById = () => new Map()
  for (const [fetchName, endpoint] of [
    ["fetchToolErrorTrend", "toolErrorTrend"],
    ["fetchSessionOutcomes", "sessionOutcomes"],
  ]) imports[fetchName] = () => fetchDeferred(endpoint)
  for (const [renderName, elementId] of [
    ["renderToolErrorTrendCard", "session-tool-error-trend"],
    ["renderSessionOutcomeCard", "session-outcomes"],
  ]) {
    imports[renderName] = (_element: unknown, payload: unknown) => {
      document.getElementById(elementId).innerHTML = (payload as { marker?: string } | null)?.marker ?? "unavailable"
      return () => {}
    }
  }
  const context = createContext({ document, __imports: imports })
  runInContext(executableSource, context)
  // Scope transitions invoke refreshAllSections; suppress background refresh only in this
  // harness so the two explicit, deferred loader calls remain deterministic.
  runInContext("state.refreshInFlight = true", context)
  const evaluate = (expression: string) => runInContext(expression, context)
  return { evaluate, pendingByEndpoint, elements }
}

const sections = [
  { loader: "loadToolErrorTrendSection", endpoint: "toolErrorTrend", elementId: "session-tool-error-trend", mark: "tool-error-trend" },
  { loader: "loadSessionOutcomesSection", endpoint: "sessionOutcomes", elementId: "session-outcomes", mark: "session-outcomes" },
]

for (const section of sections) {
  test(`${section.mark}: late success during scope leaves cache empty for theme rerender`, async () => {
    const harness = createAppHarness()
    const oldLoad = harness.evaluate(`${section.loader}()`) as Promise<void>
    harness.evaluate('enterSessionScope("ses_example_scope", "example scope")')
    harness.pendingByEndpoint.get(section.endpoint)![0].resolve({ marker: "old global view" })
    await oldLoad

    assert.equal(harness.evaluate(`state.cache.${section.endpoint}`), undefined)
    assert.equal(harness.elements.get(section.elementId)!.innerHTML, "")
    assert.equal(harness.evaluate(`state.failedSections.has("${section.mark}")`), false)
  })

  test(`${section.mark}: late failure after entering scope cannot count a hidden panel as failed`, async () => {
    const harness = createAppHarness()
    const oldLoad = harness.evaluate(`${section.loader}()`) as Promise<void>
    harness.evaluate('enterSessionScope("ses_example_scope", "example scope")')
    harness.pendingByEndpoint.get(section.endpoint)![0].reject(new Error("old failure"))
    await oldLoad

    assert.equal(harness.evaluate(`state.cache.${section.endpoint}`), undefined)
    assert.equal(harness.elements.get(section.elementId)!.innerHTML, "")
    assert.equal(harness.evaluate(`state.failedSections.has("${section.mark}")`), false)
    assert.equal(harness.elements.get("status-text")!.textContent, "连接中…")
  })

  test(`${section.mark}: old success cannot overwrite a fresh view after scope exit`, async () => {
    const harness = createAppHarness()
    const oldLoad = harness.evaluate(`${section.loader}()`) as Promise<void>
    harness.evaluate('enterSessionScope("ses_example_scope", "example scope")')
    harness.evaluate("exitSessionScope()")
    const freshLoad = harness.evaluate(`${section.loader}()`) as Promise<void>
    harness.pendingByEndpoint.get(section.endpoint)![1].resolve({ marker: "fresh view" })
    await freshLoad
    harness.pendingByEndpoint.get(section.endpoint)![0].resolve({ marker: "stale view" })
    await oldLoad

    assert.equal(harness.evaluate(`state.cache.${section.endpoint}.marker`), "fresh view")
    assert.equal(harness.elements.get(section.elementId)!.innerHTML, "fresh view")
    assert.equal(harness.evaluate(`state.failedSections.has("${section.mark}")`), false)
  })

  test(`${section.mark}: older same-scope refresh cannot replace a newer response`, async () => {
    const harness = createAppHarness()
    const oldLoad = harness.evaluate(`${section.loader}()`) as Promise<void>
    const freshLoad = harness.evaluate(`${section.loader}()`) as Promise<void>
    harness.pendingByEndpoint.get(section.endpoint)![1].resolve({ marker: "latest refresh" })
    await freshLoad
    harness.pendingByEndpoint.get(section.endpoint)![0].reject(new Error("outdated refresh"))
    await oldLoad

    assert.equal(harness.evaluate(`state.cache.${section.endpoint}.marker`), "latest refresh")
    assert.equal(harness.elements.get(section.elementId)!.innerHTML, "latest refresh")
    assert.equal(harness.evaluate(`state.failedSections.has("${section.mark}")`), false)
  })

  test(`${section.mark}: old success cannot clear the newest refresh failure`, async () => {
    const harness = createAppHarness()
    const oldLoad = harness.evaluate(`${section.loader}()`) as Promise<void>
    const freshLoad = harness.evaluate(`${section.loader}()`) as Promise<void>
    harness.pendingByEndpoint.get(section.endpoint)![1].reject(new Error("current failure"))
    await freshLoad
    harness.pendingByEndpoint.get(section.endpoint)![0].resolve({ marker: "outdated success" })
    await oldLoad

    assert.equal(harness.evaluate(`state.cache.${section.endpoint}`), null)
    assert.equal(harness.elements.get(section.elementId)!.innerHTML, "unavailable")
    assert.equal(harness.evaluate(`state.failedSections.has("${section.mark}")`), true)
  })

  test(`${section.mark}: loader short-circuits without a request while a session scope is active`, async () => {
    const harness = createAppHarness()
    harness.evaluate('enterSessionScope("ses_example_scope", "example scope")')
    await (harness.evaluate(`${section.loader}()`) as Promise<void>)
    assert.equal(harness.pendingByEndpoint.get(section.endpoint), undefined, "a hidden all-sessions panel must not fetch")
  })
}

import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { createContext, runInContext } from "node:vm"

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
    ["fetchSessionDistribution", "distribution"],
    ["fetchStepDistribution", "stepDistribution"],
    ["fetchDurationDistribution", "durationDistribution"],
    ["fetchChildShare", "childShare"],
  ]) imports[fetchName] = () => fetchDeferred(endpoint)
  for (const [renderName, elementId] of [
    ["renderDistributionCard", "session-distribution"],
    ["renderStepDistributionCard", "session-step-distribution"],
    ["renderDurationDistributionCard", "session-duration-distribution"],
    ["renderChildShareCard", "child-share"],
  ]) {
    imports[renderName] = (_element: unknown, payload: unknown) => {
      document.getElementById(elementId).innerHTML = (payload as { marker?: string } | null)?.marker ?? "unavailable"
      return () => {}
    }
  }
  const context = createContext({ document, __imports: imports })
  runInContext(executableSource, context)
  // Scope transitions invoke refreshAllSections; suppress background refresh only in this
  // harness so the four explicit, deferred loader calls remain deterministic.
  runInContext("state.refreshInFlight = true", context)
  const evaluate = (expression: string) => runInContext(expression, context)
  return { evaluate, pendingByEndpoint, elements }
}

const sections = [
  { loader: "loadDistributionSection", endpoint: "distribution", elementId: "session-distribution", mark: "distribution" },
  { loader: "loadStepDistributionSection", endpoint: "stepDistribution", elementId: "session-step-distribution", mark: "step-distribution" },
  { loader: "loadDurationDistributionSection", endpoint: "durationDistribution", elementId: "session-duration-distribution", mark: "duration-distribution" },
  { loader: "loadChildShareSection", endpoint: "childShare", elementId: "child-share", mark: "child-share" },
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
}

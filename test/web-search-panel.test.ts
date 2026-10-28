/**
 * Tests for the cross-session full-text search panel (Milestone A,
 * src/web/public/components/search-panel.js), runnable under node:test
 * via the same thin DOM shim used by web-components.test.ts.
 *
 * The search panel is a pure render component: it never touches the data
 * layer, only escorts query + mode up to an onSearch callback and renders
 * the backend /api/search payload back. Covered here:
 * - idle state renders the input + mode select + submit, no result area;
 * - onSearch === null disables the controls (pure display usage);
 * - Enter (form submit) routes query + mode to onSearch, and an empty query
 *   is dropped (never called back);
 * - loading state shows the busy placeholder;
 * - a payload with hits renders the count line and one row per hit, with
 *   the sessionTitle escaped and the sessionId URL-encoded in the deep link;
 * - an empty-hit payload renders the no-match placeholder (query escaped);
 * - a regex-error payload renders the error line (message escaped);
 * - a hostile sessionTitle / messageType is HTML-escaped (the snippet is
 *   backend-trusted and passed through by contract).
 */

import { test } from "node:test"
import assert from "node:assert/strict"

/* ------------------------- thin DOM shim ------------------------- */

/**
 * Minimal element stub — the exact implementation shared with
 * web-components.test.ts. innerHTML string capture with flat tag parsing,
 * class-token / tag.class / multi-class queries, captured event listeners
 * fired via fire()/click().
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
  value = ""
  private innerHtmlText = ""
  private stubChildren: StubElement[] = []
  private eventListeners = new Map<string, Array<(eventPayload?: unknown) => void>>()

  constructor(tagName: string) {
    this.tagName = tagName
  }

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
    this.eventListeners.clear()
  }

  get innerHTML(): string {
    return this.innerHtmlText
  }

  appendChild(childElement: StubElement): StubElement {
    this.stubChildren.push(childElement)
    return childElement
  }

  addEventListener(eventType: string, listener: (eventPayload?: unknown) => void): void {
    const typedListeners = this.eventListeners.get(eventType) ?? []
    typedListeners.push(listener)
    this.eventListeners.set(eventType, typedListeners)
  }

  fire(eventType: string, eventPayload?: unknown): void {
    for (const eventListener of this.eventListeners.get(eventType) ?? []) {
      eventListener(eventPayload)
    }
  }

  click(): void {
    this.fire("click")
  }

  classTokenList(): string[] {
    return this.className.split(/\s+/).filter((classToken) => classToken !== "")
  }

  get children(): StubElement[] {
    return this.stubChildren
  }

  querySelectorAll(elementSelector: string): StubElement[] {
    // Support tag.class / .class / tag / tag[attr] / [attr] selectors.
    // Attribute selectors (e.g. form[data-search-panel-form]) are used by
    // search-panel.js to locate its form; a bare attribute (no "=") matches
    // presence, a valued attribute matches the exact value.
    const attributeMatch = elementSelector.match(/^([a-zA-Z][a-zA-Z0-9]*)?\[([a-zA-Z-]+)(?:="([^"]*)")?\]$/)
    if (attributeMatch !== null) {
      const wantedTagName = attributeMatch[1] ?? null
      const wantedAttributeName = attributeMatch[2]!
      const wantedAttributeValue = attributeMatch[3] ?? null
      const matchedElements: StubElement[] = []
      const walkChildren = (parentElement: StubElement): void => {
        for (const childElement of parentElement.stubChildren) {
          const tagNameMatches = wantedTagName === null
            || childElement.tagName.toLowerCase() === wantedTagName.toLowerCase()
          const attributeMatches = wantedAttributeValue === null
            ? childElement.attributes.has(wantedAttributeName)
            : childElement.attributes.get(wantedAttributeName) === wantedAttributeValue
          if (tagNameMatches && attributeMatches) {
            matchedElements.push(childElement)
          }
          walkChildren(childElement)
        }
      }
      walkChildren(this)
      return matchedElements
    }
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
    // Capture named attributes (name="value") and bare boolean attributes
    // (name with no "=", e.g. the search-panel's disabled / data-search-panel-form).
    for (const attributeMatch of attributeText.matchAll(/([a-zA-Z-]+)(?:="([^"]*)")?/g)) {
      const attributeName = attributeMatch[1]
      if (attributeName === "") continue
      const attributeValue = attributeMatch[2] ?? ""
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
    location: { hash: "" },
  } as unknown as Window & typeof globalThis
}

installDomShim()

/** Fresh render container per test. */
function freshContainer(): StubElement {
  return new StubElement("div")
}

/** A minimal backend-shaped hit payload with the documented wire fields. */
function searchHitFixture(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: "ses_alpha",
    sessionTitle: "示例会话标题",
    messageId: "msg_1",
    messageType: "user",
    snippet: "这里<mark>命中词</mark>被高亮",
    hitCount: 2,
    ...overrides,
  }
}

/* --------------------------- idle state --------------------------- */

test("renderSearchPanel idle state shows the input, mode select and submit, with no result area", async () => {
  const { renderSearchPanel } = await import("../src/web/public/components/search-panel.js")
  const container = freshContainer()
  renderSearchPanel(container as unknown as HTMLElement, { status: "idle", payload: null }, null)

  assert.ok(container.querySelector("form") !== null, "the panel renders a form")
  assert.ok(container.querySelector("input.search-panel-input") !== null, "the search input is present")
  assert.equal(container.querySelectorAll("option").length, 2, "子串 / 正则 modes")
  assert.ok(container.querySelector("button.search-panel-submit") !== null, "the submit button is present")
  assert.match(container.innerHTML, /search-panel-idle/, "the idle placeholder is shown")
  assert.ok(
    container.querySelector("div.search-hit-list") === null,
    "no hit list before a search",
  )
})

test("renderSearchPanel with a null onSearch disables the controls for pure display", async () => {
  const { renderSearchPanel } = await import("../src/web/public/components/search-panel.js")
  const container = freshContainer()
  renderSearchPanel(container as unknown as HTMLElement, { status: "idle", payload: null }, null)

  assert.match(container.innerHTML, /input class="search-panel-input"[^>]* disabled/, "the input carries the disabled attribute")
  assert.match(container.innerHTML, /select class="search-panel-mode"[^>]* disabled/, "the mode select carries the disabled attribute")
  assert.match(container.innerHTML, /button type="submit" class="search-panel-submit"[^>]* disabled/, "the submit button carries the disabled attribute")
})

test("renderSearchPanel form submit routes query + mode to onSearch and drops an empty query", async () => {
  const { renderSearchPanel } = await import("../src/web/public/components/search-panel.js")
  const container = freshContainer()
  const submitted: Array<{ query: string; mode: string }> = []
  const onSearch = (query: string, mode: string) => submitted.push({ query, mode })
  renderSearchPanel(container as unknown as HTMLElement, { status: "idle", payload: null }, onSearch)

  const formElement = container.querySelector("form")!
  const inputElement = container.querySelector("input.search-panel-input")!
  const modeElement = container.querySelector("select.search-panel-mode")!

  // Empty query: the component must not call back (mirrors backend 400).
  inputElement.value = "   "
  formElement.fire("submit", { preventDefault: () => {} })
  assert.equal(submitted.length, 0, "a blank query never reaches onSearch")

  // A real query with the default (substring) mode.
  inputElement.value = "  API 错误  "
  modeElement.value = "substring"
  formElement.fire("submit", { preventDefault: () => {} })
  assert.deepEqual(submitted, [{ query: "API 错误", mode: "substring" }], "the trimmed query routes with the selected mode")

  // Regex mode routes through.
  inputElement.value = "error[0-9]+"
  modeElement.value = "regex"
  formElement.fire("submit", { preventDefault: () => {} })
  assert.deepEqual(submitted[1], { query: "error[0-9]+", mode: "regex" }, "regex mode is passed through")
})

/* ------------------------- result states ------------------------- */

test("renderSearchPanel loading state shows the busy placeholder", async () => {
  const { renderSearchPanel } = await import("../src/web/public/components/search-panel.js")
  const container = freshContainer()
  renderSearchPanel(container as unknown as HTMLElement, { status: "loading", payload: null }, null)

  assert.match(container.innerHTML, /aria-busy="true"/, "the results area marks itself busy")
  assert.match(container.innerHTML, /正在搜索…/, "the busy text is shown")
})

test("renderSearchPanel renders the count line and one row per hit with URL-encoded deep links", async () => {
  const { renderSearchPanel } = await import("../src/web/public/components/search-panel.js")
  const container = freshContainer()
  renderSearchPanel(
    container as unknown as HTMLElement,
    {
      status: "done",
      payload: {
        query: "重试",
        mode: "substring",
        total: 3,
        hits: [
          searchHitFixture({ sessionId: "ses_alpha", sessionTitle: "Alpha 会话", messageType: "user", hitCount: 2 }),
          searchHitFixture({ sessionId: "ses_beta", sessionTitle: "Beta 会话", messageType: "assistant", hitCount: 1 }),
        ],
      },
    },
    null,
  )

  assert.match(container.innerHTML, /共 <b class="num">3<\/b> 条命中/, "the total count line renders")
  const hitRows = container.querySelectorAll("a.search-hit")
  assert.equal(hitRows.length, 2, "one row per hit")
  assert.ok(container.innerHTML.includes('href="#/session/ses_alpha"'), "sessionId deep link is present")
  assert.match(container.innerHTML, />Alpha 会话</, "the session title renders")
  assert.ok(container.innerHTML.includes("命中 2 处"), "the per-hit count renders")
})

test("renderSearchPanel escapes hostile sessionTitle / messageType text", async () => {
  const { renderSearchPanel } = await import("../src/web/public/components/search-panel.js")
  const container = freshContainer()
  renderSearchPanel(
    container as unknown as HTMLElement,
    {
      status: "done",
      payload: {
        query: "x",
        mode: "substring",
        total: 1,
        hits: [
          searchHitFixture({
            sessionId: "ses bad/x",
            sessionTitle: "<script>alert('title')</script>",
            messageType: "<b>type</b>",
          }),
        ],
      },
    },
    null,
  )

  assert.ok(
    !container.innerHTML.includes("<script>alert('title')</script>"),
    "a hostile sessionTitle is escaped, not executed as markup",
  )
  assert.match(container.innerHTML, /&lt;script&gt;alert\(&#39;title&#39;\)&lt;\/script&gt;/, "the escaped title text is present")
  assert.match(container.innerHTML, /&lt;b&gt;type&lt;\/b&gt;/, "a hostile messageType is escaped")
  assert.ok(
    container.innerHTML.includes('href="#/session/ses%20bad%2Fx"'),
    "a hostile sessionId is URL-encoded into the href, not emitted as a raw attribute",
  )
})

test("renderSearchPanel empty-hit payload renders the escaped no-match placeholder", async () => {
  const { renderSearchPanel } = await import("../src/web/public/components/search-panel.js")
  const container = freshContainer()
  renderSearchPanel(
    container as unknown as HTMLElement,
    { status: "done", payload: { query: "不存在<词>", mode: "substring", hits: [], total: 0 } },
    null,
  )

  assert.match(container.innerHTML, /search-panel-empty/, "the empty placeholder is shown")
  assert.match(container.innerHTML, /没有命中「不存在&lt;词&gt;」的结果/, "the query is escaped inside the placeholder")
})

test("renderSearchPanel regex-error payload renders the escaped error line", async () => {
  const { renderSearchPanel } = await import("../src/web/public/components/search-panel.js")
  const container = freshContainer()
  renderSearchPanel(
    container as unknown as HTMLElement,
    { status: "error", payload: null, error: "invalid regex: [<unclosed>" },
    null,
  )

  assert.match(container.innerHTML, /search-panel-error/, "the error line is shown")
  assert.match(container.innerHTML, /invalid regex: \[&lt;unclosed&gt;/, "the error message is escaped")
})

test("renderSearchPanel passes the backend snippet through as trusted rich text", async () => {
  const { renderSearchPanel } = await import("../src/web/public/components/search-panel.js")
  const container = freshContainer()
  renderSearchPanel(
    container as unknown as HTMLElement,
    {
      status: "done",
      payload: {
        query: "重试",
        mode: "substring",
        total: 1,
        hits: [searchHitFixture({ snippet: "已转义的 <mark>命中词</mark> 与文本" })],
      },
    },
    null,
  )

  assert.ok(
    container.innerHTML.includes("<mark>命中词</mark>"),
    "the backend <mark> highlight is preserved through the render",
  )
  assert.match(container.innerHTML, /已转义的 <mark>命中词<\/mark> 与文本/, "the snippet text renders verbatim")
})
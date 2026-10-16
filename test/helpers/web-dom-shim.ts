/**
 * v0.20.0 会话作用域接线测试（test/web-session-scope.test.ts）用的
 * 轻量 DOM shim。惯常与断言风格沿用 test/web-components.test.ts 的
 * StubElement——为什么另立文件而不是导入那一份：该 shim 是内联在
 * 测试文件里的私有类，且作用域接线需要 setAttribute/removeAttribute
 * （hidden 属性语义走属性通道，见 session-scope-chip.js 文件头）与
 * window.setTimeout（消失提示的限时恢复），这两个能力在内联版里没有。
 * 两处 shims 并存是测试脚手架的既有形态，不为共享而回改一个全绿的
 * 3500 行测试文件。
 */

export class StubElement {
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
  private eventListeners = new Map<string, Array<(eventPayload?: unknown) => void>>()

  constructor(tagName: string) {
    this.tagName = tagName
  }

  /** hidden 属性语义走 attributes Map（与真实 DOM 的 [hidden] 对齐）。 */
  setAttribute(attributeName: string, attributeValue: string): void {
    this.attributes.set(attributeName, String(attributeValue))
  }

  removeAttribute(attributeName: string): void {
    this.attributes.delete(attributeName)
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

  /** Fire listeners with a bubbling-compatible payload（真实点击事件的
   * 最小替身：带 stopPropagation 记录，供「只看此会话」按钮的拦截断言）。 */
  fire(eventType: string, eventPayload?: unknown): void {
    for (const eventListener of this.eventListeners.get(eventType) ?? []) {
      eventListener(eventPayload)
    }
  }

  click(eventPayload?: unknown): void {
    this.fire("click", eventPayload)
  }

  getBoundingClientRect(): { width: number; height: number } {
    return { width: 200, height: 60 }
  }

  classTokenList(): string[] {
    return this.className.split(/\s+/).filter((classToken) => classToken !== "")
  }

  get children(): StubElement[] {
    return this.stubChildren
  }

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
        const classNameMatches = wantedClassTokens
          .every((classToken) => childElement.classTokenList().includes(classToken))
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

  querySelector(elementSelector: string): StubElement | null {
    return this.querySelectorAll(elementSelector)[0] ?? null
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
    for (const attributeMatch of attributeText.matchAll(NAMED_ATTRIBUTE_PATTERN)) {
      const attributeName = attributeMatch[1]
      const attributeValue = attributeMatch[2]
      stubElement.attributes.set(attributeName, attributeValue)
      if (attributeName === "class") stubElement.className = attributeValue
      if (attributeName === "title") stubElement.title = attributeValue
      if (attributeName.startsWith("data-")) {
        stubElement.dataset[toCamelCase(attributeName.slice("data-".length))] = attributeValue
      }
    }
    stubElements.push(stubElement)
  }
  return stubElements
}

export function installDomShim(): void {
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
    // flashSessionScopeVanishedNotice 的限时恢复走 window.setTimeout：
    // 代理到真实 Node 定时器（测试传短时限并 await，不留跨测试挂钟）。
    setTimeout: ((handler: () => void, timeout = 0, ...args: unknown[]) =>
      globalThis.setTimeout(handler, timeout, ...args)) as unknown as typeof globalThis.setTimeout,
  } as unknown as Window & typeof globalThis
}

/** Fresh render container per test. */
export function freshContainer(): StubElement {
  return new StubElement("div")
}

/** Await a short wall-clock tick（限时恢复类断言用）。 */
export function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    globalThis.setTimeout(resolve, milliseconds)
  })
}

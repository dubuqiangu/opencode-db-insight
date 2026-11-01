/**
 * Tests for the session SVG export renderer (v0.29.0 B8,
 * src/export/svg.ts): a DOM-free, zero-dependency, deterministic and total
 * builder that renders the same data as the markdown export. Locked here
 * are XML escaping / illegal-character stripping, the header block, the
 * message-type composition bar, the system-prompt presence note, and the
 * never-throws contract on malformed input.
 */

import { test } from "node:test"
import assert from "node:assert/strict"

import type { SessionMessageRecord } from "../src/db/types.ts"
import { escapeXmlText, renderSessionSvgReport } from "../src/export/svg.ts"
import { buildFakeSessionSummary } from "./helpers/fake-insight-db.ts"

/** A message record with every field defaulted; override the ones a case needs. */
function makeMessage(
  overrides: Partial<SessionMessageRecord> = {},
): SessionMessageRecord {
  return {
    id: "msg_1",
    sessionId: "ses_export_fixture",
    type: "user",
    seq: 0,
    timeCreated: new Date(2026, 9, 5, 15, 30).getTime(),
    timeUpdated: new Date(2026, 9, 5, 15, 30).getTime(),
    data: { text: "帮我修复登录 bug" },
    ...overrides,
  }
}

/** Assert the document has no unescaped ampersand (a quick well-formedness proxy). */
function assertNoBareAmpersand(document: string): void {
  assert.ok(
    !/&(?!(amp|lt|gt|quot|apos);)/.test(document),
    "every '&' must begin a known XML entity",
  )
}

// ---------------------------------------------------------------------------
// escapeXmlText — the single escaping chokepoint
// ---------------------------------------------------------------------------

test("escapeXmlText escapes the five markup-significant characters", () => {
  assert.equal(
    escapeXmlText(`a&b<c>d"e'f`),
    "a&amp;b&lt;c&gt;d&quot;e&apos;f",
  )
})

test("escapeXmlText strips characters illegal in XML 1.0", () => {
  assert.equal(escapeXmlText("a\u0000b\u001fc\u000bd"), "abcd")
  assert.equal(escapeXmlText("safe\u0009tab"), "safe\u0009tab", "tab is legal")
})

// ---------------------------------------------------------------------------
// header block
// ---------------------------------------------------------------------------

test("renderSessionSvgReport emits a well-formed SVG envelope with the header fields", () => {
  const sessionSummary = buildFakeSessionSummary({
    title: "导出测试会话",
    tokens: 123456,
  })
  const document = renderSessionSvgReport(sessionSummary, [makeMessage()], null)

  assert.ok(document.startsWith('<?xml version="1.0" encoding="UTF-8"?>'))
  assert.ok(document.includes('xmlns="http://www.w3.org/2000/svg"'))
  assert.ok(document.trimEnd().endsWith("</svg>"))
  assertNoBareAmpersand(document)

  // Header fields the markdown export also shows.
  assert.ok(document.includes("导出测试会话"))
  assert.ok(document.includes("会话 ID"))
  assert.ok(document.includes("ses_export_fixture"))
  assert.ok(document.includes("glm-5.3"))
  assert.ok(document.includes("fixer"))
  assert.ok(document.includes("123,456"), "token counts use thousand separators")
})

test("renderSessionSvgReport adds a cost line only when cost is positive", () => {
  const freeSession = renderSessionSvgReport(
    buildFakeSessionSummary({ cost: 0 }),
    [makeMessage()],
    null,
  )
  assert.ok(!freeSession.includes("费用"))

  const paidSession = renderSessionSvgReport(
    buildFakeSessionSummary({ cost: 0.5 }),
    [makeMessage()],
    null,
  )
  assert.ok(paidSession.includes("费用"))
  assert.ok(paidSession.includes("$0.5"))
})

// ---------------------------------------------------------------------------
// message-type composition bar
// ---------------------------------------------------------------------------

test("renderSessionSvgReport draws bar segments for each present message type", () => {
  const messages = [
    makeMessage({ type: "user" }),
    makeMessage({ id: "msg_2", type: "assistant" }),
    makeMessage({ id: "msg_3", type: "assistant" }),
    makeMessage({ id: "msg_4", type: "compaction", data: { reason: "size" } }),
  ]
  const document = renderSessionSvgReport(buildFakeSessionSummary(), messages, null)

  assert.ok(document.includes("消息类型构成"))
  assert.ok(document.includes("#3b82f6"), "user segment colour")
  assert.ok(document.includes("#10b981"), "assistant segment colour")
  assert.ok(document.includes("#ef4444"), "compaction segment colour")
  // Only the categories that actually occur get a legend line.
  assert.ok(document.includes("用户 — 1"))
  assert.ok(document.includes("助手 — 2"))
  assert.ok(document.includes("压缩 — 1"))
  assert.ok(!document.includes("模型切换 — "))
})

test("renderSessionSvgReport drops idle / synthetic from the composition", () => {
  const onlyIgnored = renderSessionSvgReport(
    buildFakeSessionSummary(),
    [makeMessage({ type: "idle" }), makeMessage({ id: "m", type: "synthetic" })],
    null,
  )
  assert.ok(onlyIgnored.includes("（本会话无消息记录）"))
  assert.ok(!onlyIgnored.includes("#3b82f6"), "no user segment when everything is ignored")
})

test("renderSessionSvgReport reports an empty composition for a message-less session", () => {
  const document = renderSessionSvgReport(buildFakeSessionSummary(), [], null)
  assert.ok(document.includes("（本会话无消息记录）"))
  assertNoBareAmpersand(document)
})

test("renderSessionSvgReport folds unknown message types into 其他", () => {
  const document = renderSessionSvgReport(
    buildFakeSessionSummary(),
    [makeMessage({ type: "mystery" })],
    null,
  )
  assert.ok(document.includes("其他 — 1"))
})

// ---------------------------------------------------------------------------
// system prompt note
// ---------------------------------------------------------------------------

test("renderSessionSvgReport states prompt presence with a character count", () => {
  const document = renderSessionSvgReport(
    buildFakeSessionSummary(),
    [makeMessage()],
    "环境提示词",
  )
  assert.ok(document.includes("系统提示词"))
  assert.ok(document.includes("已记录 · 5 字符"))
})

test("renderSessionSvgReport reports an absent system prompt", () => {
  const document = renderSessionSvgReport(buildFakeSessionSummary(), [makeMessage()], null)
  assert.ok(document.includes("（未记录系统提示词）"))

  const blankPrompt = renderSessionSvgReport(buildFakeSessionSummary(), [makeMessage()], "   ")
  assert.ok(blankPrompt.includes("（未记录系统提示词）"))
})

// ---------------------------------------------------------------------------
// escaping + determinism + totality
// ---------------------------------------------------------------------------

test("renderSessionSvgReport escapes a hostile title", () => {
  const sessionSummary = buildFakeSessionSummary({
    title: `</text><script>alert("x")</script>&`,
  })
  const document = renderSessionSvgReport(sessionSummary, [makeMessage()], null)

  assert.ok(!document.includes("<script>"))
  assert.ok(document.includes("&lt;script&gt;"))
  assert.ok(document.includes("&amp;"))
  assertNoBareAmpersand(document)
})

test("renderSessionSvgReport strips illegal control characters from a title", () => {
  const sessionSummary = buildFakeSessionSummary({ title: "标\u0000题\u001f" })
  const document = renderSessionSvgReport(sessionSummary, [makeMessage()], null)
  assert.ok(document.includes("标题"))
  assert.ok(!document.includes("\u0000"))
  assert.ok(!document.includes("\u001f"))
})

test("renderSessionSvgReport is deterministic for identical input", () => {
  const sessionSummary = buildFakeSessionSummary()
  const messages = [
    makeMessage({ type: "user" }),
    makeMessage({ id: "msg_2", type: "assistant" }),
  ]
  const firstDocument = renderSessionSvgReport(sessionSummary, messages, "提示词")
  const secondDocument = renderSessionSvgReport(sessionSummary, messages, "提示词")
  assert.equal(firstDocument, secondDocument)
})

test("renderSessionSvgReport never throws on malformed input", () => {
  const hostileMessages = [
    null,
    undefined,
    42,
    { type: 12345 },
    { type: "assistant", data: "not-an-object" },
  ] as unknown as SessionMessageRecord[]
  const hostileSummary = {} as never

  assert.doesNotThrow(() => renderSessionSvgReport(hostileSummary, hostileMessages, null))
  const document = renderSessionSvgReport(hostileSummary, hostileMessages, null)
  assert.ok(document.startsWith('<?xml version="1.0"'))
  assert.ok(document.trimEnd().endsWith("</svg>"))
  assertNoBareAmpersand(document)
})

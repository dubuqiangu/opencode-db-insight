/**
 * Unit tests for the pure markdown-formatting helpers (DESIGN.md §8).
 *
 * Every helper is total: malformed input degrades to a placeholder rather
 * than throwing, so these tests pin both the happy path and the boundaries
 * (exactly at the limit, one over, empty, multibyte, circular JSON).
 */

import { test } from "node:test"
import assert from "node:assert/strict"

import {
  NOTICE_TEXT_CHARACTER_LIMIT,
  TOOL_OUTPUT_CHARACTER_LIMIT,
  buildCodeFence,
  collapseToSingleLine,
  escapeMarkdownSpecialCharacters,
  formatLocalTimestamp,
  formatTokenCount,
  longestBacktickRun,
  safeStringifyJson,
  truncateNoticeText,
  truncateToolOutput,
  wrapTextAsBlockquote,
} from "../src/export/format-helpers.ts"

const UNSERIALIZABLE_PLACEHOLDER = "（无法序列化为 JSON）"

test("escapeMarkdownSpecialCharacters prefixes every structural markdown character", () => {
  const structuralCharacters = ["\\", "`", "*", "_", "[", "]", "<", ">", "#", "|", "~"]
  for (const structuralCharacter of structuralCharacters) {
    const escaped = escapeMarkdownSpecialCharacters(structuralCharacter)
    assert.equal(escaped, `\\${structuralCharacter}`, `"${structuralCharacter}" must be escaped`)
  }
})

test("escapeMarkdownSpecialCharacters leaves ordinary text and CJK untouched", () => {
  const plainText = "普通标题 abc 123 (parentheses) - dash . dot ! bang"
  assert.equal(escapeMarkdownSpecialCharacters(plainText), plainText)
})

test("escapeMarkdownSpecialCharacters escapes every occurrence in a realistic title", () => {
  assert.equal(
    escapeMarkdownSpecialCharacters("# a *b* [c]"),
    "\\# a \\*b\\* \\[c\\]",
  )
})

test("formatLocalTimestamp formats an epoch as local YYYY-MM-DD HH:mm with zero padding", () => {
  const localTime = new Date(2026, 9, 5, 9, 7)
  assert.equal(formatLocalTimestamp(localTime.getTime()), "2026-10-05 09:07")
})

test("formatLocalTimestamp degrades to the placeholder for zero, negative and non-finite values", () => {
  for (const invalidTimestamp of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(formatLocalTimestamp(invalidTimestamp), "未知")
  }
})

test("formatTokenCount inserts deterministic thousand separators", () => {
  assert.equal(formatTokenCount(0), "0")
  assert.equal(formatTokenCount(999), "999")
  assert.equal(formatTokenCount(1000), "1,000")
  assert.equal(formatTokenCount(1234567), "1,234,567")
})

test("formatTokenCount floors fractions and degrades invalid counts to zero", () => {
  assert.equal(formatTokenCount(1234.9), "1,234")
  assert.equal(formatTokenCount(-5), "0")
  assert.equal(formatTokenCount(Number.NaN), "0")
  assert.equal(formatTokenCount(Number.POSITIVE_INFINITY), "0")
})

test("longestBacktickRun returns the length of the longest run, 0 when none", () => {
  assert.equal(longestBacktickRun(""), 0)
  assert.equal(longestBacktickRun("no ticks here"), 0)
  assert.equal(longestBacktickRun("`"), 1)
  assert.equal(longestBacktickRun("a``b```c"), 3)
})

test("buildCodeFence uses a three-backtick fence when the content has no long run", () => {
  assert.equal(buildCodeFence("let x = 1", "json"), "```json\nlet x = 1\n```")
  assert.equal(buildCodeFence("", ""), "```\n\n```")
})

test("buildCodeFence grows the fence one longer than any run inside the content", () => {
  const contentWithTripleBackticks = "before ```code``` after"
  const fenced = buildCodeFence(contentWithTripleBackticks, "")
  assert.ok(fenced.startsWith("````\n"), "the fence must outgrow the embedded triple backticks")
  assert.ok(fenced.endsWith("\n````"))
  assert.ok(fenced.includes(contentWithTripleBackticks))
})

test("wrapTextAsBlockquote prefixes each line and turns blank lines into a bare marker", () => {
  assert.equal(wrapTextAsBlockquote("line one\nline two"), "> line one\n> line two")
  assert.equal(wrapTextAsBlockquote("a\n\nb"), "> a\n>\n> b")
  assert.equal(wrapTextAsBlockquote("   "), ">")
  assert.equal(wrapTextAsBlockquote(""), ">")
})

test("truncateToolOutput returns output at or below the limit untouched", () => {
  assert.equal(truncateToolOutput("", 6), "")
  assert.equal(truncateToolOutput("abcdef", 6), "abcdef")
})

test("truncateToolOutput truncates over the limit and records the full length", () => {
  assert.equal(truncateToolOutput("abcdefg", 6), "abcdef\n...（截断，完整 7 字符）")
})

test("truncateToolOutput applies the exported default limit at the exact boundary", () => {
  const atLimit = "x".repeat(TOOL_OUTPUT_CHARACTER_LIMIT)
  assert.equal(truncateToolOutput(atLimit), atLimit)

  const oneOverLimit = atLimit + "y"
  const truncated = truncateToolOutput(oneOverLimit)
  assert.ok(truncated.endsWith(`...（截断，完整 ${TOOL_OUTPUT_CHARACTER_LIMIT + 1} 字符）`))
})

test("truncateToolOutput drops a lone high surrogate at the cut instead of splitting an emoji", () => {
  // "ab" + 😀 (a surrogate pair) + "cdef" = 8 code units; cutting at 3 would
  // leave a bare high surrogate, which must be removed.
  const emojiText = `ab\u{1F600}cdef`
  const truncated = truncateToolOutput(emojiText, 3)
  assert.equal(truncated, "ab\n...（截断，完整 8 字符）")
  assert.ok(!/[\ud800-\udbff]$/.test(truncated), "no dangling high surrogate may survive")
})

test("truncateNoticeText returns text at or below the limit untouched", () => {
  assert.equal(truncateNoticeText("", 6), "")
  assert.equal(truncateNoticeText("abcdef", 6), "abcdef")
})

test("truncateNoticeText appends an ellipsis over the limit and never splits a surrogate", () => {
  assert.equal(truncateNoticeText("abcdefg", 6), "abcdef...")
  // A notice cut in the middle of an emoji drops the dangling surrogate too.
  assert.equal(truncateNoticeText(`ab\u{1F600}cd`, 3), "ab...")
})

test("truncateNoticeText applies the exported default limit at the exact boundary", () => {
  const atLimit = "n".repeat(NOTICE_TEXT_CHARACTER_LIMIT)
  assert.equal(truncateNoticeText(atLimit), atLimit)
  assert.equal(truncateNoticeText(atLimit + "x"), `${atLimit}...`)
})

test("safeStringifyJson serializes values with two-space indentation", () => {
  assert.equal(safeStringifyJson({ a: 1 }), '{\n  "a": 1\n}')
  assert.equal(safeStringifyJson([1, 2]), "[\n  1,\n  2\n]")
  assert.equal(safeStringifyJson("hi"), '"hi"')
  assert.equal(safeStringifyJson(null), "null")
})

test("safeStringifyJson degrades to a placeholder for values JSON cannot represent", () => {
  assert.equal(safeStringifyJson(undefined), UNSERIALIZABLE_PLACEHOLDER)
  assert.equal(safeStringifyJson(Symbol("s")), UNSERIALIZABLE_PLACEHOLDER)
  assert.equal(safeStringifyJson(10n), UNSERIALIZABLE_PLACEHOLDER)
})

test("safeStringifyJson degrades to a placeholder for a circular structure instead of throwing", () => {
  const circularRecord: Record<string, unknown> = { name: "loop" }
  circularRecord["self"] = circularRecord
  assert.equal(safeStringifyJson(circularRecord), UNSERIALIZABLE_PLACEHOLDER)
})

test("collapseToSingleLine collapses whitespace runs and trims the edges", () => {
  assert.equal(collapseToSingleLine("  a \n\t b  "), "a b")
  assert.equal(collapseToSingleLine("line1\nline2"), "line1 line2")
  assert.equal(collapseToSingleLine("\n\n"), "")
  assert.equal(collapseToSingleLine("a\u00a0b"), "a b")
})

test("the exported character limits keep their documented values", () => {
  assert.equal(TOOL_OUTPUT_CHARACTER_LIMIT, 4000)
  assert.equal(NOTICE_TEXT_CHARACTER_LIMIT, 200)
})

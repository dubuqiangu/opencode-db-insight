/**
 * Focused regression tests for clipToColumns (src/tui/clip-columns.ts).
 *
 * The bug these lock down: the ellipsis used to be charged a column even when
 * no truncation happened, so text that exactly filled the budget came back
 * truncated ("abcde" at 5 columns → "abcd…"). The ellipsis must be reserved
 * ONLY when the text actually overflows; exact fits pass through unchanged and
 * the wide-glyph handling stays intact.
 */

import { test } from "node:test"
import assert from "node:assert/strict"

import { clipToColumns, SIDEBAR_TODO_LABEL_MAX_COLUMNS } from "../src/tui/clip-columns.ts"

test("clipToColumns passes an exact ASCII fit through unchanged", () => {
  assert.equal(clipToColumns("abcde", 5), "abcde")
})

test("clipToColumns truncates one ASCII glyph over the budget with an ellipsis", () => {
  assert.equal(clipToColumns("abcdef", 5), "abcd…")
})

test("clipToColumns passes an exact wide-glyph fit through unchanged", () => {
  // Two CJK glyphs are four display columns — exactly the budget.
  assert.equal(clipToColumns("字字", 4), "字字")
})

test("clipToColumns truncates wide glyphs one over the budget and never exceeds it", () => {
  // Three CJK glyphs are six columns; with the ellipsis charged one column
  // only the first glyph plus "…" fit inside a four-column budget.
  const clipped = clipToColumns("字字字", 4)
  assert.equal(clipped, "字…")
  assert.ok(clipped.length <= 3, "one wide glyph (2 cols) + ellipsis (1 col)")
})

test("clipToColumns drops a wide glyph that would land on the ellipsis column", () => {
  // "a字b" is four columns and overflows a three-column budget, so the wide
  // glyph is dropped rather than half-rendered; "a字" fits exactly.
  assert.equal(clipToColumns("a字", 3), "a字")
  assert.equal(clipToColumns("a字b", 3), "a…")
})

test("clipToColumns keeps the default budget's exact fit and marks the next glyph", () => {
  const exactFit = "x".repeat(SIDEBAR_TODO_LABEL_MAX_COLUMNS)
  assert.equal(clipToColumns(exactFit), exactFit)
  assert.equal(
    clipToColumns(`${exactFit}x`),
    `${"x".repeat(SIDEBAR_TODO_LABEL_MAX_COLUMNS - 1)}…`,
  )
})

test("clipToColumns answers a non-positive budget with an empty string", () => {
  assert.equal(clipToColumns("abcde", 0), "")
  assert.equal(clipToColumns("abcde", -3), "")
})

/**
 * Display-column helpers for the TUI sidebar.
 *
 * The sidebar is narrow and todo text is free-form (the model writes it): one
 * long line used to push the caret glyph off-screen and stretch the block.
 * Clipping has to count *columns*, not UTF-16 units — CJK and most emoji take
 * two cells, so a `String#length` cut leaves either slack or overflow.
 *
 * Kept free of JSX/solid imports so the test runner can exercise it directly.
 */

/** Maximum display columns for one todo label inside the sidebar. */
export const SIDEBAR_TODO_LABEL_MAX_COLUMNS = 44

/** Ranges rendered two cells wide by terminal emulators. */
const WIDE_GLYPH_PATTERN =
  /[\u1100-\u115F\u2E80-\uA4CF\uA960-\uA97F\uAC00-\uD7A3\uF900-\uFAFF\uFE10-\uFE19\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6]|[\u{1F300}-\u{1FAFF}\u{20000}-\u{3FFFD}]/u

function glyphColumns(glyph: string): number {
  return WIDE_GLYPH_PATTERN.test(glyph) ? 2 : 1
}

/**
 * Clip `text` to at most `maxColumns` display columns.
 *
 * A clipped result always ends with "…" and never exceeds the budget: the
 * ellipsis is charged one column, so a wide glyph that would land on the last
 * column is dropped rather than half-rendered.
 */
export function clipToColumns(text: string, maxColumns = SIDEBAR_TODO_LABEL_MAX_COLUMNS): string {
  if (maxColumns <= 0) return ""
  let usedColumns = 0
  let kept = ""
  for (const glyph of text) {
    if (usedColumns + glyphColumns(glyph) + 1 > maxColumns) return `${kept}…`
    kept += glyph
    usedColumns += glyphColumns(glyph)
  }
  return text
}
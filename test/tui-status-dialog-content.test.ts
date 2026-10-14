/**
 * Tests for the pure /insight-status dialog content builders (v0.16.0):
 * number/date formatting, CJK-aware alignment, proportional track bars,
 * the full-line layout (complete model names, aligned columns, footer),
 * and every degradation path (no usage, empty trend, null data).
 */

import { test } from "node:test"
import assert from "node:assert/strict"

import type { DailyTrendPoint } from "../src/stats/daily-buckets.ts"
import type { StatusPanelData } from "../src/tui/status-panel-data.ts"
import {
  annotateKpiTokenValue,
  buildProportionalTrackBar,
  buildStatusDialogLines,
  computeDisplayWidth,
  formatClockTime,
  formatCompactTokenCount,
  formatFullTokenCount,
  formatHitRatePercent,
  formatSharePercent,
  HIT_RATE_BAR_WIDTH,
  MODEL_BAR_WIDTH,
  padEndDisplay,
  padStartDisplay,
  STATUS_DIALOG_CLOSE_HINT_TEXT,
  STATUS_DIALOG_FOOTER_HINT,
  TREND_BAR_WIDTH,
  type StatusDialogLine,
} from "../src/tui/status-dialog-content.ts"

// ---------------------------------------------------------------------------
// Formatting helpers.

test("formatCompactTokenCount covers the K/M/G ladder and degenerate inputs", () => {
  assert.equal(formatCompactTokenCount(0), "0")
  assert.equal(formatCompactTokenCount(-5), "0")
  assert.equal(formatCompactTokenCount(Number.NaN), "0")
  assert.equal(formatCompactTokenCount(812), "812")
  assert.equal(formatCompactTokenCount(1234), "1.2K")
  assert.equal(formatCompactTokenCount(949_999), "950K")
  assert.equal(formatCompactTokenCount(1_234_567), "1.2M")
  assert.equal(formatCompactTokenCount(12_345_678_901), "12.3G")
})

test("formatFullTokenCount groups thousands and degrades degenerate inputs to 0", () => {
  assert.equal(formatFullTokenCount(0), "0")
  assert.equal(formatFullTokenCount(-5), "0")
  assert.equal(formatFullTokenCount(Number.NaN), "0")
  assert.equal(formatFullTokenCount(999), "999")
  assert.equal(formatFullTokenCount(1_234_567), "1,234,567")
  assert.equal(formatFullTokenCount(12_345_678_901), "12,345,678,901")
})

test("annotateKpiTokenValue appends the compact spelling only when it differs", () => {
  // < 1000: 缩写与全量相同，注记是废话，不加。
  assert.equal(annotateKpiTokenValue(0), "0")
  assert.equal(annotateKpiTokenValue(999), "999")
  assert.equal(annotateKpiTokenValue(Number.NaN), "0")
  // >= 1000: 全量 + 全角括号缩写——KPI 行是全量与缩写两种写法唯一相遇处。
  assert.equal(annotateKpiTokenValue(1_234_567), "1,234,567（1.2M）")
  assert.equal(annotateKpiTokenValue(35_509_713), "35,509,713（35.5M）")
  assert.equal(annotateKpiTokenValue(12_345_678_901), "12,345,678,901（12.3G）")
})

test("formatHitRatePercent clamps into [0,100] with one decimal", () => {
  assert.equal(formatHitRatePercent(0), "0%")
  assert.equal(formatHitRatePercent(0.875), "87.5%")
  assert.equal(formatHitRatePercent(1), "100.0%")
  assert.equal(formatHitRatePercent(2), "100%")
  assert.equal(formatHitRatePercent(-0.5), "0%")
  assert.equal(formatHitRatePercent(Number.NaN), "0%")
})

test("formatSharePercent clamps into [0,100] and always keeps one decimal", () => {
  assert.equal(formatSharePercent(0), "0.0%")
  assert.equal(formatSharePercent(-1), "0.0%")
  assert.equal(formatSharePercent(Number.NaN), "0.0%")
  assert.equal(formatSharePercent(0.75), "75.0%")
  assert.equal(formatSharePercent(1), "100.0%")
  assert.equal(formatSharePercent(1.5), "100.0%")
})

test("formatClockTime renders local HH:mm and degrades bad timestamps", () => {
  assert.equal(formatClockTime(new Date(2026, 9, 13, 9, 5).getTime()), "09:05")
  assert.equal(formatClockTime(new Date(2026, 9, 13, 21, 36).getTime()), "21:36")
  assert.equal(formatClockTime(Number.NaN), "--:--")
})

// ---------------------------------------------------------------------------
// CJK-aware alignment.

test("computeDisplayWidth counts CJK characters as two cells", () => {
  assert.equal(computeDisplayWidth("deepseek-v4-flash"), 17)
  assert.equal(computeDisplayWidth("缓存命中率"), 10)
  assert.equal(computeDisplayWidth("Token 总量"), 10)
  assert.equal(computeDisplayWidth(""), 0)
})

test("padEndDisplay / padStartDisplay pad to display width, not code units", () => {
  assert.equal(padEndDisplay("模型", 8), "模型    ")
  assert.equal(padStartDisplay("1.2M", 7), "   1.2M")
  assert.equal(padEndDisplay("exactly-9", 8), "exactly-9")
  assert.equal(padStartDisplay("over-width", 4), "over-width")
})

// ---------------------------------------------------------------------------
// Proportional track bars.

test("buildProportionalTrackBar fills by ratio and keeps a visible track", () => {
  assert.equal(
    buildProportionalTrackBar(400, 400, 10),
    "██████████",
    "the max value fills the whole bar",
  )
  assert.equal(
    buildProportionalTrackBar(0, 400, 10),
    "░░░░░░░░░░",
    "zero leaves the bare track",
  )
  assert.equal(
    buildProportionalTrackBar(1, 400, 10),
    "█░░░░░░░░░",
    "a tiny positive still shows one fill cell",
  )
  assert.equal(
    buildProportionalTrackBar(200, 400, 10),
    "█████░░░░░",
  )
  assert.equal(
    buildProportionalTrackBar(200, 0, 10),
    "░░░░░░░░░░",
    "a non-positive max leaves the bare track",
  )
  assert.equal(
    buildProportionalTrackBar(Number.NaN, 400, 10),
    "░░░░░░░░░░",
  )
  assert.equal(buildProportionalTrackBar(200, 400, 0), "")
})

// ---------------------------------------------------------------------------
// buildStatusDialogLines — the full layout.

function buildTrendPointFixture(dateKey: string, tokens: number): DailyTrendPoint {
  // byModel: {} — the dialog ignores the per-model buckets;
  // the field is required on the wire type but irrelevant to this fixture.
  return { date: dateKey, steps: 1, input: tokens, read: 0, output: 0, hitRate: 0, byModel: {} }
}

function buildReadyPanelDataFixture(): StatusPanelData {
  return {
    todayTokens: 1_234_567,
    todayHitRate: 0.875,
    todayModelTopFive: [
      { modelId: "deepseek-v4-flash", tokens: 900_000 },
      { modelId: "claude-opus-5", tokens: 300_000 },
    ],
    weekTrend: [
      buildTrendPointFixture("2026-10-07", 100),
      buildTrendPointFixture("2026-10-08", 400),
      buildTrendPointFixture("2026-10-09", 200),
      buildTrendPointFixture("2026-10-10", 0),
      buildTrendPointFixture("2026-10-11", 100),
      buildTrendPointFixture("2026-10-12", 100),
      buildTrendPointFixture("2026-10-13", 300),
    ],
  }
}

function collectSectionLines(lines: StatusDialogLine[], headingText: string): StatusDialogLine[] {
  const headingIndex = lines.findIndex((line) => line.text === headingText)
  assert.ok(headingIndex > 0, `section heading "${headingText}" must exist`)
  const nextHeadingIndex = lines.findIndex(
    (line, lineIndex) =>
      lineIndex > headingIndex && line.emphasis === "section-heading",
  )
  return lines.slice(headingIndex + 1, nextHeadingIndex === -1 ? lines.length : nextHeadingIndex)
}

test("buildStatusDialogLines renders header, KPIs, leaderboard, trend and footer", () => {
  const dialogLines = buildStatusDialogLines(buildReadyPanelDataFixture(), "21:36", "2026-10-13")

  // Header: title at the left, ✕ ESC pinned to the widest body line's
  // right edge (the dialog's visual top-right), the whole strip clickable.
  assert.ok(dialogLines[0].text.startsWith("db-insight 用量总览"), "title leads the header")
  assert.ok(
    dialogLines[0].text.endsWith(STATUS_DIALOG_CLOSE_HINT_TEXT),
    "the close hint is pinned to the header's right edge",
  )
  assert.equal(dialogLines[0].closeAction, "close-dialog", "the header strip is click-to-close")
  const headerSpanEmphases = dialogLines[0].spans?.map((span) => span.emphasis)
  assert.deepEqual(headerSpanEmphases, ["dialog-title", "close-hint"])
  const bodyWidth = Math.max(
    ...dialogLines.slice(1).map((bodyLine) => computeDisplayWidth(bodyLine.text)),
  )
  assert.equal(
    computeDisplayWidth(dialogLines[0].text),
    bodyWidth,
    "header width mirrors the widest body line, so the hint lands on the dialog's right edge",
  )
  assert.ok(dialogLines[1].text.includes("生成于 21:36"))
  assert.ok(
    dialogLines.some((line) => line.text === STATUS_DIALOG_FOOTER_HINT),
    "the footer hint must be present",
  )

  const todayLines = collectSectionLines(dialogLines, "今日用量")
  const tokenLine = todayLines.find((line) => line.text.includes("Token 总量"))!
  assert.ok(
    tokenLine.text.includes("1,234,567（1.2M）"),
    "today total shows the full grouped number with the compact annotation",
  )
  const hitRateLine = todayLines.find((line) => line.text.includes("缓存命中率"))!
  assert.ok(hitRateLine.text.includes("87.5%"))
  assert.ok(
    hitRateLine.text.includes("█") && hitRateLine.text.includes("░"),
    "the hit rate carries a bar with fill and track",
  )
  assert.ok(
    hitRateLine.text.includes("█".repeat(HIT_RATE_BAR_WIDTH - 3)),
    "87.5% of 20 cells is 18 filled",
  )
})

test("model names appear complete — no truncation at any width", () => {
  const longModelId = "futureppo/glm-5.3-with-a-very-long-variant-suffix-attached"
  const dialogLines = buildStatusDialogLines(
    {
      todayTokens: 500,
      todayHitRate: 0.5,
      todayModelTopFive: [
        { modelId: "deepseek-v4-flash", tokens: 300 },
        { modelId: longModelId, tokens: 200 },
      ],
      weekTrend: [],
    },
    "21:36",
    "2026-10-13",
  )

  const leaderboardLines = collectSectionLines(dialogLines, "模型 TOP5（今日）")
  const modelRowLines = leaderboardLines.filter((line) => line.emphasis === "leaderboard-row")
  assert.equal(modelRowLines.length, 2)
  assert.ok(modelRowLines[0].text.includes("deepseek-v4-flash"), "the full id is intact")
  assert.ok(modelRowLines[1].text.includes(longModelId), "even a 54-char id is never cut")
})

test("leaderboard bars scale to the top model and columns stay aligned", () => {
  const dialogLines = buildStatusDialogLines(buildReadyPanelDataFixture(), "21:36", "2026-10-13")
  const leaderboardLines = collectSectionLines(dialogLines, "模型 TOP5（今日）")
  const modelRowLines = leaderboardLines.filter((line) => line.emphasis === "leaderboard-row")

  assert.equal(modelRowLines.length, 2)
  assert.ok(
    modelRowLines[0].text.includes("█".repeat(MODEL_BAR_WIDTH)),
    "the top model gets the full-width bar",
  )
  assert.ok(
    !modelRowLines[1].text.includes("█".repeat(MODEL_BAR_WIDTH)),
    "the second model gets a shorter bar",
  )

  // Column alignment: every row's value segment starts at the same offset.
  const valueStartOffsets = modelRowLines.map(
    (rowLine) => rowLine.text.indexOf(formatCompactTokenCount(900_000)) === -1
      ? rowLine.text.indexOf(formatCompactTokenCount(300_000))
      : rowLine.text.indexOf(formatCompactTokenCount(900_000)),
  )
  assert.equal(valueStartOffsets[0], valueStartOffsets[1], "value columns align")
  assert.ok(modelRowLines[0].text.includes("72.9%"), "the share percent is computed")
  assert.ok(modelRowLines[0].spans !== undefined)
  const leaderboardBarSpans = modelRowLines[0].spans!.filter(
    (span) => span.emphasis === "leaderboard-bar",
  )
  assert.equal(leaderboardBarSpans.length, 1)
  assert.equal(leaderboardBarSpans[0].colorSlot, 0, "rank 1 uses palette slot 0")
})

test("buildStatusDialogLines caps the leaderboard at five models", () => {
  const dialogLines = buildStatusDialogLines(
    {
      todayTokens: 1000,
      todayHitRate: 0,
      todayModelTopFive: Array.from({ length: 9 }, (_unused, modelIndex) => ({
        modelId: `model-${modelIndex}`,
        tokens: 100,
      })),
      weekTrend: [],
    },
    "21:36",
    "2026-10-13",
  )
  const leaderboardLines = collectSectionLines(dialogLines, "模型 TOP5（今日）")
  const modelRowLines = leaderboardLines.filter((line) => line.emphasis === "leaderboard-row")
  assert.equal(modelRowLines.length, 5, "exactly five leaderboard rows")
  assert.ok(modelRowLines[4].text.includes("model-4"))
  assert.ok(!leaderboardLines.some((line) => line.text.includes("model-5")))
})

test("the trend section renders seven aligned rows with wide bars", () => {
  const dialogLines = buildStatusDialogLines(buildReadyPanelDataFixture(), "21:36", "2026-10-13")
  const trendLines = collectSectionLines(dialogLines, "近 7 日趋势")
  const trendRowLines = trendLines.filter((line) => line.emphasis === "trend-row")
  assert.equal(trendRowLines.length, 7)

  // Equal-width date labels (MM-DD) and one fixed bar per row.
  for (const trendRowLine of trendRowLines) {
    assert.equal(trendRowLine.text.slice(0, 5).length, 5)
    assert.match(trendRowLine.text.slice(0, 5), /^\d{2}-\d{2}$/)
    const fillCount = [...trendRowLine.text].filter((ch) => ch === "█").length
    const trackCount = [...trendRowLine.text].filter((ch) => ch === "░").length
    assert.equal(fillCount + trackCount, TREND_BAR_WIDTH, "every row carries one fixed-width bar")
  }

  // The max day fills the whole bar; today's row is highlighted.
  const maxDayLine = trendRowLines.find((line) => line.text.includes("400"))!
  assert.ok(maxDayLine.text.includes("█".repeat(TREND_BAR_WIDTH)))
  const todayRowLine = trendRowLines.find((line) => line.text.startsWith("10-13"))!
  assert.ok(
    todayRowLine.spans!.some((span) => span.emphasis === "trend-bar-today"),
    "today's bar is marked for highlight",
  )
  assert.ok(
    trendRowLines[0].spans!.every((span) => span.emphasis !== "trend-bar-today"),
    "other days use the plain trend bar emphasis",
  )

  // Value columns align: the last 7 characters hold the compact value.
  for (const trendRowLine of trendRowLines) {
    assert.equal(trendRowLine.text.length, 5 + 2 + TREND_BAR_WIDTH + 1 + 7)
  }
})

test("spans concatenate to the plain line text for every line", () => {
  const dialogLines = buildStatusDialogLines(buildReadyPanelDataFixture(), "21:36", "2026-10-13")
  for (const dialogLine of dialogLines) {
    if (dialogLine.spans === undefined) continue
    assert.equal(
      dialogLine.spans.map((span) => span.text).join(""),
      dialogLine.text,
      `spans must reconstruct the line: ${dialogLine.text}`,
    )
  }
})

// ---------------------------------------------------------------------------
// Degradation paths.

test("no usage today degrades the KPI and leaderboard sections to notes", () => {
  const dialogLines = buildStatusDialogLines(
    {
      todayTokens: 0,
      todayHitRate: 0,
      todayModelTopFive: [],
      weekTrend: [buildTrendPointFixture("2026-10-13", 42)],
    },
    "21:36",
    "2026-10-13",
  )
  const todayLines = collectSectionLines(dialogLines, "今日用量")
  assert.deepEqual(todayLines, [{ emphasis: "empty-note", text: "今日暂无用量" }])
  const leaderboardLines = collectSectionLines(dialogLines, "模型 TOP5（今日）")
  assert.ok(leaderboardLines.some((line) => line.text === "今日暂无模型用量"))
  // The trend still renders — it has data.
  assert.ok(dialogLines.some((line) => line.emphasis === "trend-row"))
})

test("an all-zero trend degrades to the no-usage note", () => {
  const dialogLines = buildStatusDialogLines(
    {
      todayTokens: 0,
      todayHitRate: 0,
      todayModelTopFive: [],
      weekTrend: Array.from({ length: 7 }, (_unused, dayIndex) =>
        buildTrendPointFixture(`2026-10-0${dayIndex + 7}`, 0),
      ),
    },
    "21:36",
    "2026-10-13",
  )
  const trendLines = collectSectionLines(dialogLines, "近 7 日趋势")
  assert.ok(trendLines.some((line) => line.text === "近 7 日无用量"))
  assert.ok(!trendLines.some((line) => line.emphasis === "trend-row"))
})

test("an empty trend degrades to the no-data note", () => {
  const dialogLines = buildStatusDialogLines(
    {
      todayTokens: 10,
      todayHitRate: 0,
      todayModelTopFive: [],
      weekTrend: [],
    },
    "21:36",
    "2026-10-13",
  )
  const trendLines = collectSectionLines(dialogLines, "近 7 日趋势")
  assert.ok(trendLines.some((line) => line.text === "近 7 日无数据"))
})

test("null data degrades to the dignified unavailable copy with the footer", () => {
  const dialogLines = buildStatusDialogLines(null, "21:36", "2026-10-13")
  // The clickable header is present even in the unavailable state.
  assert.ok(
    dialogLines[0].text.startsWith("db-insight 用量总览") &&
      dialogLines[0].text.endsWith(STATUS_DIALOG_CLOSE_HINT_TEXT),
    "the null-data dialog still shows the pinned close hint",
  )
  assert.equal(dialogLines[0].closeAction, "close-dialog")
  assert.ok(
    dialogLines.some((line) => line.emphasis === "unavailable-title" && line.text.includes("不可用")),
  )
  assert.ok(dialogLines.some((line) => line.text.includes("/insight-refresh")))
  assert.ok(
    dialogLines.some((line) => line.text === STATUS_DIALOG_FOOTER_HINT),
    "the footer hint is present even in the unavailable state",
  )
  assert.ok(!dialogLines.some((line) => line.emphasis === "section-heading"))
  assert.ok(!dialogLines.some((line) => line.emphasis === "trend-row"))
})

test("small token totals stay unannotated — never 500（500）", () => {
  const dialogLines = buildStatusDialogLines(
    {
      todayTokens: 500,
      todayHitRate: 0.5,
      todayModelTopFive: [],
      weekTrend: [],
    },
    "21:36",
    "2026-10-13",
  )
  const tokenLine = dialogLines.find((line) => line.text.includes("Token 总量"))!
  assert.ok(tokenLine.text.includes("500"), "the raw total is shown")
  assert.ok(!tokenLine.text.includes("（"), "no redundant compact annotation below 1000")
})

test("a body narrower than the title keeps a one-space gap before the hint", () => {
  // 今日暂无用量 + 空趋势：正文很窄，标题+关闭标记反而定义弹窗宽度，
  // 兜底 gapWidth = 1——标记仍紧随标题之后，不与标题粘连。
  const dialogLines = buildStatusDialogLines(
    {
      todayTokens: 0,
      todayHitRate: 0,
      todayModelTopFive: [],
      weekTrend: [],
    },
    "21:36",
    "2026-10-13",
  )
  const headerText = dialogLines[0].text
  assert.ok(headerText.includes("db-insight 用量总览 " + STATUS_DIALOG_CLOSE_HINT_TEXT))
  assert.equal(dialogLines[0].closeAction, "close-dialog")
})

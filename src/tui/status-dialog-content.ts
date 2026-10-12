/**
 * Pure content builders for the /insight-status dialog (redesign v0.16.0).
 *
 * Everything here is plain string math: alignment (CJK-aware display
 * widths), proportional block bars, number formatting and the degradation
 * copy for empty/failed data. No JSX, no host API — the dialog lifecycle
 * (status-dialog.ts) feeds it a StatusPanelData snapshot, and the JSX
 * renderer (status-dialog-render.tsx) only maps each span's emphasis to a
 * color. That keeps every layout decision unit-testable in plain node.
 *
 * Unlike the retired sidebar panel there is NO line-length cap: a large
 * dialog is wide enough for full model ids, so "deepseek-v4-flash" is never
 * truncated into "deepseek-v4-fl" again.
 */

import type { DailyTrendPoint } from "../stats/daily-buckets.ts"
import type { StatusPanelData } from "./status-panel-data.ts"
import { STATUS_PANEL_MODEL_LIMIT } from "./status-panel-data.ts"

/** Hit-rate progress bar width (cells). */
export const HIT_RATE_BAR_WIDTH = 20

/** Model leaderboard bar width (cells). */
export const MODEL_BAR_WIDTH = 14

/** 7-day trend bar width (cells) — the dialog is wide, so bars grow. */
export const TREND_BAR_WIDTH = 28

/** Minimum model-name column width; grows when ids are longer. */
export const MIN_MODEL_NAME_COLUMN_WIDTH = 20

/** Width of the trend value column (right-aligned compact token text). */
export const TREND_VALUE_COLUMN_WIDTH = 7

/** Bar fill character. */
const BAR_FILL_CHARACTER = "█"

/** Bar track character: keeps the chart's full width readable at zero. */
const BAR_TRACK_CHARACTER = "░"

/** Footer hint shown at the bottom of every dialog variant. */
export const STATUS_DIALOG_FOOTER_HINT = "ESC 关闭 · r 刷新数据"

/**
 * Visual role of one span/line. The renderer maps each emphasis to a
 * color/bold pair; the content module never hardcodes colors.
 */
export type StatusDialogEmphasis =
  | "dialog-title"
  | "dialog-subtitle"
  | "section-heading"
  | "kpi-label"
  | "kpi-value"
  | "hit-rate-bar"
  | "rank-badge"
  | "model-name"
  | "table-headline"
  | "table-value"
  | "leaderboard-row"
  | "leaderboard-bar"
  | "trend-row"
  | "trend-date"
  | "trend-bar"
  | "trend-bar-today"
  | "empty-note"
  | "unavailable-title"
  | "unavailable-note"
  | "footer-hint"

/** One colored run inside a line; `text` is an exact substring of line.text. */
export interface StatusDialogSpan {
  emphasis: StatusDialogEmphasis
  text: string
  /** Leaderboard bars pick their color by rank (0 = top model). */
  colorSlot?: number
}

/** One dialog line. `spans` absent → render `text` with the line emphasis. */
export interface StatusDialogLine {
  emphasis: StatusDialogEmphasis
  text: string
  spans?: StatusDialogSpan[]
}

// ---------------------------------------------------------------------------
// Number / date formatting.

/** Compact token counts: 0 / 812 / 1.2K / 3.4M / 12.3G. */
export function formatCompactTokenCount(tokenCount: number): string {
  if (!Number.isFinite(tokenCount) || tokenCount <= 0) return "0"
  if (tokenCount < 1000) return String(Math.round(tokenCount))
  const scaleUnits = ["K", "M", "G", "T"] as const
  let scaledValue = tokenCount
  let scaleIndex = -1
  while (scaledValue >= 1000 && scaleIndex < scaleUnits.length - 1) {
    scaledValue /= 1000
    scaleIndex += 1
  }
  const scaledText =
    scaledValue >= 100 ? String(Math.round(scaledValue)) : scaledValue.toFixed(1)
  return `${scaledText}${scaleUnits[scaleIndex]}`
}

/** Full token count with thousands separators: 1234567 → "1,234,567". */
export function formatFullTokenCount(tokenCount: number): string {
  if (!Number.isFinite(tokenCount) || tokenCount <= 0) return "0"
  return String(Math.round(tokenCount)).replace(/\B(?=(\d{3})+(?!\d))/g, ",")
}

/** Percent text of a [0,1] hit rate, e.g. 0.875 → "87.5%". */
export function formatHitRatePercent(hitRate: number): string {
  if (!Number.isFinite(hitRate) || hitRate <= 0) return "0%"
  if (hitRate > 1) return "100%"
  return `${(hitRate * 100).toFixed(1)}%`
}

/** Percent text of a share with one decimal, clamped into [0,100]. */
export function formatSharePercent(shareFraction: number): string {
  if (!Number.isFinite(shareFraction) || shareFraction <= 0) return "0.0%"
  if (shareFraction > 1) return "100.0%"
  return `${(shareFraction * 100).toFixed(1)}%`
}

/** Local clock time "HH:mm"; unparsable timestamps degrade to "--:--". */
export function formatClockTime(timestampMs: number): string {
  const clockMoment = new Date(timestampMs)
  if (Number.isNaN(clockMoment.getTime())) return "--:--"
  const twoDigits = (value: number) => String(value).padStart(2, "0")
  return `${twoDigits(clockMoment.getHours())}:${twoDigits(clockMoment.getMinutes())}`
}

// ---------------------------------------------------------------------------
// CJK-aware alignment helpers.

/** Display width of text: CJK characters count as two terminal cells. */
export function computeDisplayWidth(text: string): number {
  let width = 0
  for (const character of text) {
    const codePoint = character.codePointAt(0) ?? 0
    const isWide =
      (codePoint >= 0x1100 && codePoint <= 0x115f) || // Hangul Jamo
      (codePoint >= 0x2e80 && codePoint <= 0xa4cf) || // CJK radicals..Yi
      (codePoint >= 0xac00 && codePoint <= 0xd7a3) || // Hangul syllables
      (codePoint >= 0xf900 && codePoint <= 0xfaff) || // CJK compat ideographs
      (codePoint >= 0xfe30 && codePoint <= 0xfe4f) || // CJK compat forms
      (codePoint >= 0xff00 && codePoint <= 0xff60) || // fullwidth forms
      (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
      (codePoint >= 0x20000 && codePoint <= 0x3fffd) // CJK extensions
    width += isWide ? 2 : 1
  }
  return width
}

/** Pad text on the right so its display width reaches targetWidth cells. */
export function padEndDisplay(text: string, targetWidth: number): string {
  const padding = targetWidth - computeDisplayWidth(text)
  return padding <= 0 ? text : text + " ".repeat(padding)
}

/** Pad text on the left so its display width reaches targetWidth cells. */
export function padStartDisplay(text: string, targetWidth: number): string {
  const padding = targetWidth - computeDisplayWidth(text)
  return padding <= 0 ? text : " ".repeat(padding) + text
}

// ---------------------------------------------------------------------------
// Bars.

/**
 * Proportional bar with a visible ░ track: value === maxValue fills the whole
 * width, zero leaves the bare track, tiny positives still show one fill
 * cell so a day with usage never looks empty.
 */
export function buildProportionalTrackBar(
  value: number,
  maxValue: number,
  barWidth: number,
): string {
  if (barWidth <= 0) return ""
  if (!Number.isFinite(value) || !Number.isFinite(maxValue) || maxValue <= 0) {
    return BAR_TRACK_CHARACTER.repeat(barWidth)
  }
  const filledCellCount =
    value <= 0 ? 0 : Math.min(barWidth, Math.max(1, Math.round((value / maxValue) * barWidth)))
  return (
    BAR_FILL_CHARACTER.repeat(filledCellCount) +
    BAR_TRACK_CHARACTER.repeat(barWidth - filledCellCount)
  )
}

// ---------------------------------------------------------------------------
// Section builders.

function buildHeaderLines(generatedAtText: string): StatusDialogLine[] {
  return [
    { emphasis: "dialog-title", text: "db-insight 用量总览" },
    { emphasis: "dialog-subtitle", text: `生成于 ${generatedAtText} · 统计窗口：近 7 日` },
  ]
}

function buildTodaySectionLines(
  todayTokens: number,
  todayHitRate: number,
  hasTodayUsage: boolean,
): StatusDialogLine[] {
  const sectionLines: StatusDialogLine[] = [{ emphasis: "section-heading", text: "今日用量" }]
  if (!hasTodayUsage) {
    sectionLines.push({ emphasis: "empty-note", text: "今日暂无用量" })
    return sectionLines
  }

  const kpiLabelWidth = Math.max(
    computeDisplayWidth("Token 总量"),
    computeDisplayWidth("缓存命中率"),
  )
  const tokenLabelText = padEndDisplay("Token 总量", kpiLabelWidth)
  const hitRateLabelText = padEndDisplay("缓存命中率", kpiLabelWidth)
  sectionLines.push({
    emphasis: "kpi-label",
    text: `${tokenLabelText}  ${formatFullTokenCount(todayTokens)}`,
    spans: [
      { emphasis: "kpi-label", text: `${tokenLabelText}  ` },
      { emphasis: "kpi-value", text: formatFullTokenCount(todayTokens) },
    ],
  })
  const hitRatePercentText = formatHitRatePercent(todayHitRate)
  const hitRateBarText = buildProportionalTrackBar(todayHitRate, 1, HIT_RATE_BAR_WIDTH)
  sectionLines.push({
    emphasis: "kpi-label",
    text: `${hitRateLabelText}  ${hitRatePercentText}  ${hitRateBarText}`,
    spans: [
      { emphasis: "kpi-label", text: `${hitRateLabelText}  ` },
      { emphasis: "kpi-value", text: hitRatePercentText },
      { emphasis: "hit-rate-bar", text: `  ${hitRateBarText}` },
    ],
  })
  return sectionLines
}

function buildModelLeaderboardLines(
  topModels: Array<{ modelId: string; tokens: number }>,
  todayTokens: number,
): StatusDialogLine[] {
  const sectionLines: StatusDialogLine[] = [
    { emphasis: "section-heading", text: `模型 TOP${STATUS_PANEL_MODEL_LIMIT}（今日）` },
  ]
  const visibleModels = topModels.slice(0, STATUS_PANEL_MODEL_LIMIT)
  if (visibleModels.length === 0) {
    sectionLines.push({ emphasis: "empty-note", text: "今日暂无模型用量" })
    return sectionLines
  }

  const modelNameColumnWidth = Math.max(
    MIN_MODEL_NAME_COLUMN_WIDTH,
    ...visibleModels.map((modelUsage) => computeDisplayWidth(modelUsage.modelId)),
  )
  const modelTokensColumnWidth = Math.max(
    7,
    ...visibleModels.map((modelUsage) => formatCompactTokenCount(modelUsage.tokens).length),
  )
  const maxModelTokens = Math.max(...visibleModels.map((modelUsage) => modelUsage.tokens))

  const headlineText =
    padEndDisplay("   模型", 3 + modelNameColumnWidth + 2) +
    padStartDisplay("用量", modelTokensColumnWidth) +
    "  " +
    " ".repeat(MODEL_BAR_WIDTH) +
    " " +
    padStartDisplay("比例", 6)
  sectionLines.push({ emphasis: "table-headline", text: headlineText })

  for (let modelIndex = 0; modelIndex < visibleModels.length; modelIndex += 1) {
    const modelUsage = visibleModels[modelIndex]
    const rankBadgeText = `${modelIndex + 1}. `
    const modelNameText = `${padEndDisplay(modelUsage.modelId, modelNameColumnWidth)}  `
    const modelTokensText = `${padStartDisplay(formatCompactTokenCount(modelUsage.tokens), modelTokensColumnWidth)}  `
    const modelBarText = `${buildProportionalTrackBar(modelUsage.tokens, maxModelTokens, MODEL_BAR_WIDTH)} `
    const modelShareText = padStartDisplay(
      formatSharePercent(todayTokens > 0 ? modelUsage.tokens / todayTokens : 0),
      6,
    )
    const rowText = rankBadgeText + modelNameText + modelTokensText + modelBarText + modelShareText
    sectionLines.push({
      emphasis: "leaderboard-row",
      text: rowText,
      spans: [
        { emphasis: "rank-badge", text: rankBadgeText },
        { emphasis: "model-name", text: modelNameText },
        { emphasis: "table-value", text: modelTokensText },
        { emphasis: "leaderboard-bar", text: modelBarText, colorSlot: modelIndex },
        { emphasis: "table-value", text: modelShareText },
      ],
    })
  }
  return sectionLines
}

function buildWeekTrendLines(
  weekTrend: DailyTrendPoint[],
  todayDateKey: string,
): StatusDialogLine[] {
  const sectionLines: StatusDialogLine[] = [{ emphasis: "section-heading", text: "近 7 日趋势" }]
  if (weekTrend.length === 0) {
    sectionLines.push({ emphasis: "empty-note", text: "近 7 日无数据" })
    return sectionLines
  }

  const dayTokenTotals = weekTrend.map(
    (trendPoint) => trendPoint.input + trendPoint.read + trendPoint.output,
  )
  const maxDayTokens = Math.max(...dayTokenTotals)
  if (maxDayTokens <= 0) {
    sectionLines.push({ emphasis: "empty-note", text: "近 7 日无用量" })
    return sectionLines
  }

  for (let trendIndex = 0; trendIndex < weekTrend.length; trendIndex += 1) {
    const trendPoint = weekTrend[trendIndex]
    const isToday = trendPoint.date === todayDateKey
    const dateLabelText = `${trendPoint.date.slice(5)}  `
    const trendBarText = `${buildProportionalTrackBar(dayTokenTotals[trendIndex], maxDayTokens, TREND_BAR_WIDTH)} `
    const trendValueText = padStartDisplay(
      formatCompactTokenCount(dayTokenTotals[trendIndex]),
      TREND_VALUE_COLUMN_WIDTH,
    )
    sectionLines.push({
      emphasis: "trend-row",
      text: dateLabelText + trendBarText + trendValueText,
      spans: [
        { emphasis: "trend-date", text: dateLabelText },
        { emphasis: isToday ? "trend-bar-today" : "trend-bar", text: trendBarText },
        { emphasis: "table-value", text: trendValueText },
      ],
    })
  }
  return sectionLines
}

function buildUnavailableLines(): StatusDialogLine[] {
  return [
    { emphasis: "unavailable-title", text: "db-insight 用量数据不可用" },
    { emphasis: "unavailable-note", text: "未找到 opencode 数据库，或本次读取失败。" },
    { emphasis: "unavailable-note", text: "可先运行 /insight-refresh 刷新缓存后重试。" },
  ]
}

/**
 * Build every dialog line. Pure; a null snapshot (database missing or scan
 * failure) degrades to the dignified unavailable copy instead of throwing,
 * and empty sections degrade to their placeholder notes.
 */
export function buildStatusDialogLines(
  statusData: StatusPanelData | null,
  generatedAtText: string,
  todayDateKey: string,
): StatusDialogLine[] {
  if (statusData === null) {
    return [
      ...buildUnavailableLines(),
      { emphasis: "footer-hint", text: STATUS_DIALOG_FOOTER_HINT },
    ]
  }

  const hasTodayUsage = statusData.todayTokens > 0 || statusData.todayModelTopFive.length > 0
  return [
    ...buildHeaderLines(generatedAtText),
    ...buildTodaySectionLines(statusData.todayTokens, statusData.todayHitRate, hasTodayUsage),
    ...buildModelLeaderboardLines(statusData.todayModelTopFive, statusData.todayTokens),
    ...buildWeekTrendLines(statusData.weekTrend, todayDateKey),
    { emphasis: "footer-hint", text: STATUS_DIALOG_FOOTER_HINT },
  ]
}

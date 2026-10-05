/**
 * Pure text builders for the /insight-status panel (DESIGN.md §8, task T6.2):
 * plain text lines (icon + numbers), no hardcoded colors — the host theme
 * owns coloring. Every line is capped at STATUS_PANEL_MAX_LINE_LENGTH so a
 * long model id can never break the sidebar layout.
 */

import type { DailyTrendPoint } from "../stats/daily-buckets.ts"
import type { StatusPanelData } from "./status-panel-data.ts"

/** Hard cap for one panel line (T6.2: bar-chart lines stay ≤ 40 characters). */
export const STATUS_PANEL_MAX_LINE_LENGTH = 40

/** Single-line placeholder while the database is missing or unreadable. */
export const UNAVAILABLE_STATUS_PANEL_TEXT = "db-insight: 数据不可用"

/** Today section placeholder when there is no usage today. */
const NO_USAGE_TODAY_TEXT = "📊 今日暂无用量"

/** Model leaderboard bar width (characters). */
const MODEL_BAR_WIDTH = 8

/** Trend chart bar width (characters). */
const TREND_BAR_WIDTH = 12

/** Trend bar character. */
const BAR_FILL_CHARACTER = "█"

/** The model/trend values the panel needs, decoupled from the db types. */
export interface TodayUsageStats {
  todayTokens: number
  todayHitRate: number
  topModels: Array<{ modelId: string; tokens: number }>
}

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

/** Percent text of a [0,1] hit rate, e.g. 0.875 → "87.5%". */
export function formatHitRatePercent(hitRate: number): string {
  if (!Number.isFinite(hitRate) || hitRate <= 0) return "0%"
  if (hitRate > 1) return "100%"
  return `${(hitRate * 100).toFixed(1)}%`
}

/** Truncate text to maxCharacters without splitting a surrogate pair. */
function truncatePanelText(text: string, maxCharacters: number): string {
  if (text.length <= maxCharacters) return text
  const truncatedText = text.slice(0, maxCharacters)
  if (/[\ud800-\udbff]$/.test(truncatedText)) return truncatedText.slice(0, -1)
  return truncatedText
}

/** Bar of BAR_FILL characters proportional to value/maxValue. */
function buildProportionalBar(value: number, maxValue: number, barWidth: number): string {
  if (!Number.isFinite(value) || value <= 0 || !Number.isFinite(maxValue) || maxValue <= 0) {
    return ""
  }
  const filledCharacters = Math.max(1, Math.round((value / maxValue) * barWidth))
  return BAR_FILL_CHARACTER.repeat(Math.min(filledCharacters, barWidth))
}

/**
 * Build every panel line. Pure; empty inputs degrade to placeholders:
 * no today usage → the 今日暂无用量 line, no trend points → trend omitted.
 * The final pass guarantees the 40-character line cap.
 */
export function buildStatusPanelLines(
  todayStats: TodayUsageStats,
  weekTrend: DailyTrendPoint[],
): string[] {
  const panelLines: string[] = []

  const hasTodayUsage = todayStats.todayTokens > 0 || todayStats.topModels.length > 0
  if (!hasTodayUsage) {
    panelLines.push(NO_USAGE_TODAY_TEXT)
  } else {
    panelLines.push(
      `📊 今日 ${formatCompactTokenCount(todayStats.todayTokens)} tokens · 命中率 ${formatHitRatePercent(todayStats.todayHitRate)}`,
    )
  }

  const visibleModelCount = Math.min(todayStats.topModels.length, 5)
  if (visibleModelCount > 0) {
    panelLines.push("🏆 模型 TOP5（今日）")
    const maxModelTokens = Math.max(
      ...todayStats.topModels.slice(0, visibleModelCount).map((modelUsage) => modelUsage.tokens),
    )
    for (let modelIndex = 0; modelIndex < visibleModelCount; modelIndex += 1) {
      const modelUsage = todayStats.topModels[modelIndex]
      const modelBar = buildProportionalBar(modelUsage.tokens, maxModelTokens, MODEL_BAR_WIDTH)
      panelLines.push(
        `  ${modelIndex + 1}. ${truncatePanelText(modelUsage.modelId, 14)} ${modelBar} ${formatCompactTokenCount(modelUsage.tokens)}`,
      )
    }
  }

  if (weekTrend.length > 0) {
    const maxTrendTokens = Math.max(...weekTrend.map((trendPoint) => trendPoint.input + trendPoint.read + trendPoint.output))
    panelLines.push("📈 近 7 日")
    if (maxTrendTokens <= 0) {
      panelLines.push("  （近 7 日无用量）")
    } else {
      for (const trendPoint of weekTrend) {
        const dayTokens = trendPoint.input + trendPoint.read + trendPoint.output
        const trendBar = buildProportionalBar(dayTokens, maxTrendTokens, TREND_BAR_WIDTH)
        panelLines.push(`  ${trendPoint.date.slice(5)} ${trendBar} ${formatCompactTokenCount(dayTokens)}`)
      }
    }
  }

  return panelLines.map((panelLine) => truncatePanelText(panelLine, STATUS_PANEL_MAX_LINE_LENGTH))
}

/**
 * Render the whole panel text for one data snapshot; null (db unavailable)
 * renders the single unavailable line. This is what the slot renders.
 */
export function renderStatusPanelText(statusData: StatusPanelData | null): string {
  if (statusData === null) return UNAVAILABLE_STATUS_PANEL_TEXT
  return buildStatusPanelLines(
    {
      todayTokens: statusData.todayTokens,
      todayHitRate: statusData.todayHitRate,
      topModels: statusData.todayModelTopFive,
    },
    statusData.weekTrend,
  ).join("\n")
}

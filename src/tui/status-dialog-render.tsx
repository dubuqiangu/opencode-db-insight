/** @jsxImportSource @opentui/solid */
/**
 * JSX presentation of the /insight-status dialog (redesign v0.16.0).
 *
 * All layout and alignment math lives in status-dialog-content.ts; this
 * file only maps each span's emphasis to a foreground color / bold pair.
 * The palette mirrors the web dashboard's dark-theme tokens
 * (src/web/public/styles.css): --accent green for headline numbers,
 * --blue for structure, --m1..--m5 for the model leaderboard ranks.
 */

import { TextAttributes } from "@opentui/core"

import type {
  StatusDialogEmphasis,
  StatusDialogLine,
  StatusDialogSpan,
} from "./status-dialog-content.ts"
import type { StatusDialogSnapshot } from "./status-dialog.ts"

/** Per-rank bar colors (web dashboard --m1..--m5, dark theme). */
const MODEL_RANK_BAR_COLORS = ["#7aa2f7", "#4ade80", "#c084fc", "#fbbf24", "#f472b6"] as const

interface EmphasisStyle {
  foregroundColor: string
  bold: boolean
}

/** Emphasis → color/bold. One table, no exceptions, no inline hex at use sites. */
const EMPHASIS_STYLES: Record<StatusDialogEmphasis, EmphasisStyle> = {
  "dialog-title": { foregroundColor: "#4ade80", bold: true },
  "dialog-subtitle": { foregroundColor: "#5d6b84", bold: false },
  "section-heading": { foregroundColor: "#7aa2f7", bold: true },
  "kpi-label": { foregroundColor: "#99a3ba", bold: false },
  "kpi-value": { foregroundColor: "#4ade80", bold: true },
  "hit-rate-bar": { foregroundColor: "#fbbf24", bold: false },
  "rank-badge": { foregroundColor: "#99a3ba", bold: false },
  "model-name": { foregroundColor: "#e6edf3", bold: false },
  "table-headline": { foregroundColor: "#5d6b84", bold: false },
  "table-value": { foregroundColor: "#99a3ba", bold: false },
  "leaderboard-row": { foregroundColor: "#99a3ba", bold: false },
  "leaderboard-bar": { foregroundColor: "#7aa2f7", bold: false },
  "trend-row": { foregroundColor: "#99a3ba", bold: false },
  "trend-date": { foregroundColor: "#99a3ba", bold: false },
  "trend-bar": { foregroundColor: "#7aa2f7", bold: false },
  "trend-bar-today": { foregroundColor: "#4ade80", bold: true },
  "empty-note": { foregroundColor: "#99a3ba", bold: false },
  "unavailable-title": { foregroundColor: "#f87171", bold: true },
  "unavailable-note": { foregroundColor: "#99a3ba", bold: false },
  "footer-hint": { foregroundColor: "#5d6b84", bold: false },
}

/** Resolve one span's style; leaderboard bars recolor by rank. */
function resolveEmphasisStyle(span: StatusDialogSpan): EmphasisStyle {
  if (span.emphasis === "leaderboard-bar" && typeof span.colorSlot === "number") {
    return {
      foregroundColor: MODEL_RANK_BAR_COLORS[span.colorSlot % MODEL_RANK_BAR_COLORS.length],
      bold: false,
    }
  }
  return EMPHASIS_STYLES[span.emphasis]
}

function renderTextAttributes(style: EmphasisStyle): number {
  return style.bold ? TextAttributes.BOLD : TextAttributes.NONE
}

function renderSpanNode(span: StatusDialogSpan) {
  const spanStyle = resolveEmphasisStyle(span)
  return (
    <span fg={spanStyle.foregroundColor} attributes={renderTextAttributes(spanStyle)}>
      {span.text}
    </span>
  )
}

function renderDialogLine(line: StatusDialogLine) {
  const lineStyle = EMPHASIS_STYLES[line.emphasis]
  if (line.spans !== undefined) {
    return (
      <text fg={lineStyle.foregroundColor} attributes={renderTextAttributes(lineStyle)} wrapMode="none">
        {line.spans.map((span) => renderSpanNode(span))}
      </text>
    )
  }
  return (
    <text fg={lineStyle.foregroundColor} attributes={renderTextAttributes(lineStyle)} wrapMode="none">
      {line.text}
    </text>
  )
}

/**
 * The one JSX render the dialog host shows: a vertical stack of pre-aligned
 * lines. Reactive on the snapshot signal — the r key swaps the whole
 * content without reopening the dialog.
 */
export function renderStatusDialog(readSnapshot: () => StatusDialogSnapshot) {
  const snapshot = readSnapshot()
  return <box flexDirection="column">{snapshot.lines.map((line) => renderDialogLine(line))}</box>
}

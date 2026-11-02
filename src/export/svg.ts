/**
 * Session SVG export renderer (v0.29.0, B8).
 *
 * Ported from billion-context's DOM-free report builders
 * (`buildSessionReportMd` / `buildSessionReportSvg`): the `.md` and `.svg`
 * exports are two renderings of the same already-fetched data — the header
 * comes from a querySessionSummaryById row, the message list from
 * querySessionMessages, the system prompt from querySessionSystemPrompt
 * (joined by the HTTP route). Pure, zero-dependency and total: malformed
 * input degrades to placeholders and rendering never throws, so a hostile
 * session can never break the route with a 500.
 *
 * Document layout:
 *   1. header block (title + id / model / agent / timestamps / tokens / cost)
 *   2. 消息类型构成 — a stacked bar over the non-ignored message types
 *      (idle / synthetic dropped, exactly like the markdown export)
 *   3. 系统提示词 — presence + character count
 *
 * Every wire string is XML-escaped and stripped of characters illegal in
 * XML 1.0, so a title or id containing `&` / `<` / control bytes can never
 * produce a document that fails to parse.
 */

import type { SessionMessageRecord, SessionSummary } from "../db/types.ts"
import { coerceNumber, coerceText } from "../db/rows.ts"
import { formatLocalTimestamp, formatTokenCount } from "./format-helpers.ts"
import { isIgnoredMessageType } from "./message-roles.ts"

/** Stable PNG-free canvas; wide enough for long titles without reflow. */
const PAGE_WIDTH = 960
const PAGE_PADDING = 28
const CONTENT_WIDTH = PAGE_WIDTH - PAGE_PADDING * 2

const FONT_STACK =
  "-apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif"
const MONOSPACE_FONT_STACK = "'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace"

const TITLE_FONT_SIZE = 24
const META_FONT_SIZE = 13
const META_LINE_HEIGHT = 20
const SECTION_FONT_SIZE = 15
const SECTION_LABEL_LINE_HEIGHT = 22
const BAR_HEIGHT = 26
const LEGEND_SWATCH_SIZE = 12
const LEGEND_LINE_HEIGHT = 20

const INK_COLOR = "#1f2933"
const MUTED_INK_COLOR = "#52606d"
const TRACK_COLOR = "#e4e7eb"

/** One composition bar category: fixed order keeps the output deterministic. */
interface MessageTypeCategory {
  readonly categoryKey: string
  readonly label: string
  readonly color: string
}

/**
 * Composition buckets, in fixed display order. Known wire types map to
 * their own bucket; idle / synthetic are dropped; anything else (unknown
 * or malformed type) folds into 其他 — mirroring the markdown export's
 * "unknown message type" notice.
 */
const MESSAGE_TYPE_CATEGORIES: readonly MessageTypeCategory[] = [
  { categoryKey: "user", label: "用户", color: "#3b82f6" },
  { categoryKey: "assistant", label: "助手", color: "#10b981" },
  { categoryKey: "system", label: "系统", color: "#f59e0b" },
  { categoryKey: "model-switched", label: "模型切换", color: "#8b5cf6" },
  { categoryKey: "compaction", label: "压缩", color: "#ef4444" },
  { categoryKey: "other", label: "其他", color: "#94a3b8" },
]

const OTHER_CATEGORY_KEY = "other"

/** Characters XML 1.0 forbids anywhere in a document. */
const XML_ILLEGAL_CHARACTER_PATTERN =
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g

/**
 * Make a wire string safe to place in XML text / attributes: drop illegal
 * control characters, then escape the five markup-significant characters
 * (`&` first so its replacement is not re-escaped).
 */
export function escapeXmlText(text: string): string {
  return text
    .replace(XML_ILLEGAL_CHARACTER_PATTERN, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;")
}

/** One header field even if the wire value is empty, so lines never collapse. */
function readSingleLineField(value: unknown, fallback: string): string {
  const text = coerceText(value).replace(/[\r\n\t]+/g, " ").trim()
  return text === "" ? fallback : text
}

/** Count the non-ignored messages per category; returns counts in fixed order. */
function countMessageTypeCategories(
  messages: SessionMessageRecord[],
): Array<{ category: MessageTypeCategory; count: number }> {
  const countByCategoryKey = new Map<string, number>()
  for (const category of MESSAGE_TYPE_CATEGORIES) {
    countByCategoryKey.set(category.categoryKey, 0)
  }

  for (const message of messages) {
    if (typeof message !== "object" || message === null) continue
    const messageType = coerceText((message as SessionMessageRecord).type)
    if (isIgnoredMessageType(messageType)) continue
    const categoryKey = MESSAGE_TYPE_CATEGORIES.some(
      (category) => category.categoryKey === messageType,
    )
      ? messageType
      : OTHER_CATEGORY_KEY
    countByCategoryKey.set(categoryKey, (countByCategoryKey.get(categoryKey) ?? 0) + 1)
  }

  return MESSAGE_TYPE_CATEGORIES.map((category) => ({
    category,
    count: countByCategoryKey.get(category.categoryKey) ?? 0,
  }))
}

/** Minimal well-formed SVG used only if the main build somehow throws. */
function renderFallbackSvg(): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<svg xmlns="http://www.w3.org/2000/svg" width="${PAGE_WIDTH}" height="120"`,
    ` viewBox="0 0 ${PAGE_WIDTH} 120" role="img" font-family="${FONT_STACK}">`,
    `<rect width="${PAGE_WIDTH}" height="120" fill="#ffffff"/>`,
    `<text x="${PAGE_PADDING}" y="60" font-size="${SECTION_FONT_SIZE}" fill="${MUTED_INK_COLOR}">`,
    "（无法生成会话报告）",
    "</text>",
    "</svg>",
    "",
  ].join("")
}

/**
 * Render a full session SVG report. `systemPrompt` may be null when the
 * session has no instruction state; the tail section then reports absence.
 * Never throws — any unexpected failure degrades to a minimal valid SVG.
 */
export function renderSessionSvgReport(
  sessionSummary: SessionSummary,
  messages: SessionMessageRecord[],
  systemPrompt: string | null,
): string {
  try {
    return buildSessionSvgReport(sessionSummary, messages, systemPrompt)
  } catch {
    return renderFallbackSvg()
  }
}

function buildSessionSvgReport(
  sessionSummary: SessionSummary,
  messages: SessionMessageRecord[],
  systemPrompt: string | null,
): string {
  const summaryRecord: Record<string, unknown> =
    typeof sessionSummary === "object" && sessionSummary !== null
      ? (sessionSummary as Record<string, unknown>)
      : {}

  const elementParts: string[] = []
  const sessionTitle = readSingleLineField(summaryRecord["title"], "（无标题会话）")
  elementParts.push(`<title>${escapeXmlText(sessionTitle)}</title>`)
  elementParts.push(
    `<desc>${escapeXmlText(`会话用量报告 — ${sessionTitle}`)}</desc>`,
  )
  // Background <rect>: its height is the page height, known only after the
  // layout pass below. Reserve the slot here (document start = painted behind
  // all content) and fill it in later with a DIRECT numeric interpolation —
  // no "__PAGE_HEIGHT__" placeholder token, which a session title literally
  // containing that text could otherwise corrupt via a blanket replace.
  const backgroundRectPartIndex = elementParts.length
  elementParts.push("")

  let cursorY = PAGE_PADDING

  // ---- 1. header block -----------------------------------------------------
  const titleBaseline = cursorY + TITLE_FONT_SIZE
  elementParts.push(
    `<text x="${PAGE_PADDING}" y="${titleBaseline}" font-size="${TITLE_FONT_SIZE}" font-weight="700" fill="${INK_COLOR}">${escapeXmlText(sessionTitle)}</text>`,
  )
  cursorY = titleBaseline + 14

  const headerFields: Array<[string, string]> = [
    ["会话 ID", readSingleLineField(summaryRecord["id"], "未知")],
    ["模型", readSingleLineField(summaryRecord["modelId"], "未知")],
    ["Agent", readSingleLineField(summaryRecord["agent"], "未知")],
    ["创建时间", formatLocalTimestamp(coerceNumber(summaryRecord["timeCreated"]))],
    ["更新时间", formatLocalTimestamp(coerceNumber(summaryRecord["timeUpdated"]))],
    ["Token 汇总", formatTokenCount(coerceNumber(summaryRecord["tokens"]))],
  ]
  const sessionCost = coerceNumber(summaryRecord["cost"])
  if (sessionCost > 0) {
    headerFields.push(["费用", `$${sessionCost}`])
  }

  for (const [fieldLabel, fieldValue] of headerFields) {
    const fieldBaseline = cursorY + META_FONT_SIZE
    elementParts.push(
      `<text x="${PAGE_PADDING}" y="${fieldBaseline}" font-size="${META_FONT_SIZE}" fill="${MUTED_INK_COLOR}"><tspan font-weight="600">${escapeXmlText(fieldLabel)}</tspan><tspan>：${escapeXmlText(fieldValue)}</tspan></text>`,
    )
    cursorY = fieldBaseline + (META_LINE_HEIGHT - META_FONT_SIZE)
  }

  // ---- 2. 消息类型构成 ------------------------------------------------------
  cursorY += 14
  const sectionBaseline = cursorY + SECTION_FONT_SIZE
  elementParts.push(
    `<text x="${PAGE_PADDING}" y="${sectionBaseline}" font-size="${SECTION_FONT_SIZE}" font-weight="600" fill="${INK_COLOR}">消息类型构成</text>`,
  )
  cursorY = sectionBaseline + 10

  const categoryCounts = countMessageTypeCategories(
    Array.isArray(messages) ? messages : [],
  )
  const totalMessageCount = categoryCounts.reduce((sum, entry) => sum + entry.count, 0)

  if (totalMessageCount === 0) {
    const emptyBaseline = cursorY + META_FONT_SIZE
    elementParts.push(
      `<text x="${PAGE_PADDING}" y="${emptyBaseline}" font-size="${META_FONT_SIZE}" fill="${MUTED_INK_COLOR}">（本会话无消息记录）</text>`,
    )
    cursorY = emptyBaseline + (META_LINE_HEIGHT - META_FONT_SIZE)
  } else {
    const barY = cursorY
    elementParts.push(
      `<rect x="${PAGE_PADDING}" y="${barY}" width="${CONTENT_WIDTH}" height="${BAR_HEIGHT}" fill="${TRACK_COLOR}"/>`,
    )

    let consumedWidth = 0
    let consumedCount = 0
    for (const { category, count } of categoryCounts) {
      if (count === 0) continue
      consumedCount += count
      // Round the right edge cumulatively so the last segment lands exactly
      // on CONTENT_WIDTH (no rounding gap, still deterministic).
      const rightEdge = Math.round((consumedCount / totalMessageCount) * CONTENT_WIDTH)
      const segmentWidth = rightEdge - consumedWidth
      if (segmentWidth > 0) {
        elementParts.push(
          `<rect x="${PAGE_PADDING + consumedWidth}" y="${barY}" width="${segmentWidth}" height="${BAR_HEIGHT}" fill="${category.color}"/>`,
        )
      }
      consumedWidth = rightEdge
    }

    cursorY = barY + BAR_HEIGHT + 12

    for (const { category, count } of categoryCounts) {
      if (count === 0) continue
      const legendBaseline = cursorY + META_FONT_SIZE
      elementParts.push(
        `<rect x="${PAGE_PADDING}" y="${legendBaseline - LEGEND_SWATCH_SIZE + 1}" width="${LEGEND_SWATCH_SIZE}" height="${LEGEND_SWATCH_SIZE}" fill="${category.color}"/>`,
      )
      elementParts.push(
        `<text x="${PAGE_PADDING + LEGEND_SWATCH_SIZE + 8}" y="${legendBaseline}" font-size="${META_FONT_SIZE}" fill="${MUTED_INK_COLOR}">${escapeXmlText(`${category.label} — ${formatTokenCount(count)}`)}</text>`,
      )
      cursorY = legendBaseline + (LEGEND_LINE_HEIGHT - META_FONT_SIZE)
    }
  }

  // ---- 3. 系统提示词 --------------------------------------------------------
  cursorY += 14
  const promptSectionBaseline = cursorY + SECTION_FONT_SIZE
  elementParts.push(
    `<text x="${PAGE_PADDING}" y="${promptSectionBaseline}" font-size="${SECTION_FONT_SIZE}" font-weight="600" fill="${INK_COLOR}">系统提示词</text>`,
  )
  cursorY = promptSectionBaseline + 10

  const systemPromptText = typeof systemPrompt === "string" ? systemPrompt : ""
  const systemPromptValue =
    systemPromptText.trim() === ""
      ? "（未记录系统提示词）"
      : `已记录 · ${formatTokenCount(systemPromptText.length)} 字符`
  const promptBaseline = cursorY + META_FONT_SIZE
  elementParts.push(
    `<text x="${PAGE_PADDING}" y="${promptBaseline}" font-size="${META_FONT_SIZE}" font-family="${MONOSPACE_FONT_STACK}" fill="${MUTED_INK_COLOR}">${escapeXmlText(systemPromptValue)}</text>`,
  )
  cursorY = promptBaseline + (META_LINE_HEIGHT - META_FONT_SIZE)

  const pageHeight = Math.ceil(cursorY + PAGE_PADDING)
  elementParts[backgroundRectPartIndex] =
    `<rect width="${PAGE_WIDTH}" height="${pageHeight}" fill="#ffffff"/>`

  const headerLines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<svg xmlns="http://www.w3.org/2000/svg" width="${PAGE_WIDTH}" height="${pageHeight}"`,
    ` viewBox="0 0 ${PAGE_WIDTH} ${pageHeight}" role="img" font-family="${FONT_STACK}">`,
  ]
  const bodyLines = elementParts
  const footerLines = ["</svg>", ""]

  return [...headerLines, ...bodyLines, ...footerLines].join("\n")
}

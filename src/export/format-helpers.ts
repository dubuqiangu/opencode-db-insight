/**
 * Text formatting helpers for the session markdown export (DESIGN.md §8).
 *
 * Every helper is pure and total: invalid input degrades to a placeholder
 * instead of throwing, so one malformed message can never break a whole
 * export (tolerance requirement of T5.1).
 */

/** Max characters of one tool call output before it is truncated. */
export const TOOL_OUTPUT_CHARACTER_LIMIT = 4000

/** Max characters of a one-line notice (system / model-switched / compaction). */
export const NOTICE_TEXT_CHARACTER_LIMIT = 200

/** Placeholder shown when a timestamp is missing or invalid. */
const INVALID_TIMESTAMP_PLACEHOLDER = "未知"

/** Placeholder shown when a value cannot be serialized to JSON. */
const UNSERIALIZABLE_PLACEHOLDER = "（无法序列化为 JSON）"

/**
 * Escape the markdown characters that would otherwise change document
 * structure (headings, emphasis, links, quotes, code, strikethrough).
 * Used for the session title, never for message bodies.
 */
export function escapeMarkdownSpecialCharacters(text: string): string {
  return text.replace(/([\\`*_[\]<>#|~])/g, "\\$1")
}

/**
 * Format an epoch-milliseconds timestamp as a local, human-readable
 * "YYYY-MM-DD HH:mm" string (DESIGN §10: bucketing follows machine-local
 * time). Zero / non-finite values degrade to the placeholder.
 */
export function formatLocalTimestamp(epochMilliseconds: number): string {
  if (!Number.isFinite(epochMilliseconds) || epochMilliseconds <= 0) {
    return INVALID_TIMESTAMP_PLACEHOLDER
  }
  const localDate = new Date(epochMilliseconds)
  const twoDigits = (value: number) => String(value).padStart(2, "0")
  const datePart =
    `${localDate.getFullYear()}-${twoDigits(localDate.getMonth() + 1)}-${twoDigits(localDate.getDate())}`
  const timePart = `${twoDigits(localDate.getHours())}:${twoDigits(localDate.getMinutes())}`
  return `${datePart} ${timePart}`
}

/** Format a token count with deterministic thousand separators. */
export function formatTokenCount(tokenCount: number): string {
  if (!Number.isFinite(tokenCount) || tokenCount <= 0) return "0"
  return String(Math.floor(tokenCount)).replace(/\B(?=(\d{3})+(?!\d))/g, ",")
}

/** Longest run of consecutive backticks inside a text, 0 when none. */
export function longestBacktickRun(text: string): number {
  const backtickRuns = text.match(/`+/g)
  if (backtickRuns === null) return 0
  return backtickRuns.reduce((longestRun, currentRun) => Math.max(longestRun, currentRun.length), 0)
}

/**
 * Wrap content in a fenced code block whose fence is always one backtick
 * longer than any run inside the content, so embedded ``` can never break
 * the export structure (DESIGN §8: escape with a longer fence).
 */
export function buildCodeFence(content: string, language: string): string {
  const fenceLength = Math.max(3, longestBacktickRun(content) + 1)
  const fence = "`".repeat(fenceLength)
  return `${fence}${language}\n${content}\n${fence}`
}

/** Prefix every line of a text with "> " so it renders as a blockquote. */
export function wrapTextAsBlockquote(text: string): string {
  return text
    .split("\n")
    .map((textLine) => (textLine.trim() === "" ? ">" : `> ${textLine}`))
    .join("\n")
}

/**
 * Truncate a tool output at the character limit, marking the truncation
 * with the original full length (T5.1: `...（截断，完整 N 字符）`).
 */
export function truncateToolOutput(toolOutput: string, characterLimit: number = TOOL_OUTPUT_CHARACTER_LIMIT): string {
  if (toolOutput.length <= characterLimit) return toolOutput
  return `${toolOutput.slice(0, characterLimit)}\n...（截断，完整 ${toolOutput.length} 字符）`
}

/** Truncate a notice text with a plain ellipsis marker. */
export function truncateNoticeText(noticeText: string, characterLimit: number = NOTICE_TEXT_CHARACTER_LIMIT): string {
  if (noticeText.length <= characterLimit) return noticeText
  return `${noticeText.slice(0, characterLimit)}...`
}

/**
 * Serialize any value to indented JSON; unserializable input (undefined,
 * circular structures, bigint overflow) degrades to a placeholder string
 * instead of throwing.
 */
export function safeStringifyJson(value: unknown): string {
  try {
    const serialized = JSON.stringify(value, null, 2)
    return serialized === undefined ? UNSERIALIZABLE_PLACEHOLDER : serialized
  } catch {
    return UNSERIALIZABLE_PLACEHOLDER
  }
}

/** Collapse all whitespace runs into single spaces (single-line notices). */
export function collapseToSingleLine(text: string): string {
  return text.replace(/\s+/g, " ").trim()
}

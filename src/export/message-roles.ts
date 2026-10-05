/**
 * Per-role renderers for the session markdown export (DESIGN.md §8).
 *
 * Wire shapes probed from opencode.db (2026-10-06, T5.1):
 * - user:            { text, time }
 * - assistant:       { content: [{type: "text"|"reasoning", text} | {type: "tool", name, state}] }
 *   - tool state:    { status, input, content: [{type: "text", text}], metadata: { output, exit } }
 * - system:          { text, time }
 * - model-switched:  { model: {id, providerID}, previous: {id, providerID} }
 * - compaction:      { status, reason, summary }
 * - idle / synthetic: ignored by the export
 *
 * Every renderer returns "" for messages with no renderable content —
 * callers skip them; nothing here throws on malformed input.
 */

import type { SessionMessageRecord } from "../db/types.ts"
import { asRecord, coerceText } from "../db/rows.ts"
import {
  buildCodeFence,
  collapseToSingleLine,
  formatLocalTimestamp,
  longestBacktickRun,
  safeStringifyJson,
  truncateNoticeText,
  truncateToolOutput,
  wrapTextAsBlockquote,
} from "./format-helpers.ts"

const USER_SECTION_HEADING = "## 🧑 用户"
const ASSISTANT_SECTION_HEADING = "## 🤖 助手"

/** Message types the export intentionally drops (DESIGN §8). */
export function isIgnoredMessageType(messageType: string): boolean {
  return messageType === "idle" || messageType === "synthetic"
}

/**
 * Render one user message section. Empty / missing text yields "" so the
 * caller can skip the whole section.
 */
export function renderUserMessageSection(message: SessionMessageRecord): string {
  const dataRecord = asRecord(message.data)
  const userText = dataRecord === null ? "" : readMessageText(dataRecord)
  if (userText.trim() === "") return ""

  const sectionLines = [USER_SECTION_HEADING]
  const timestampLine = renderTimestampLine(message.timeCreated)
  if (timestampLine !== "") sectionLines.push("", timestampLine)
  sectionLines.push("", renderFreeTextPassage(userText))
  return sectionLines.join("\n")
}

/**
 * Render one assistant message section: text parts flow directly into the
 * document, reasoning parts become blockquotes, tool calls become code
 * blocks (name + params JSON + output).
 */
export function renderAssistantMessageSection(message: SessionMessageRecord): string {
  const dataRecord = asRecord(message.data)
  const contentParts =
    dataRecord !== null && Array.isArray(dataRecord["content"])
      ? (dataRecord["content"] as unknown[])
      : []

  const renderedParts: string[] = []
  for (const contentPart of contentParts) {
    const partRecord = asRecord(contentPart)
    if (partRecord === null) continue
    const partType = coerceText(partRecord["type"])
    if (partType === "text") {
      const textPassage = coerceText(partRecord["text"])
      if (textPassage.trim() !== "") renderedParts.push(renderFreeTextPassage(textPassage))
    } else if (partType === "reasoning") {
      const reasoningPassage = coerceText(partRecord["text"])
      if (reasoningPassage.trim() !== "") renderedParts.push(wrapTextAsBlockquote(reasoningPassage))
    } else if (partType === "tool") {
      renderedParts.push(renderToolCallBlock(partRecord))
    }
  }
  if (renderedParts.length === 0) return ""

  const sectionLines = [ASSISTANT_SECTION_HEADING]
  const timestampLine = renderTimestampLine(message.timeCreated)
  if (timestampLine !== "") sectionLines.push("", timestampLine)
  sectionLines.push("", renderedParts.join("\n\n"))
  return sectionLines.join("\n")
}

/**
 * Render a non-conversation message (system / model-switched / compaction /
 * anything unknown) as a `---` divider followed by one italic notice line.
 */
export function renderNoticeSection(message: SessionMessageRecord): string {
  return `---\n\n*${buildNoticeLine(message)}*`
}

/**
 * Free-flowing text rendered as markdown body. When the text contains a
 * backtick run of three or more (a fence), the whole passage is wrapped in
 * a longer code fence so it cannot break the surrounding structure.
 */
function renderFreeTextPassage(textPassage: string): string {
  if (longestBacktickRun(textPassage) >= 3) return buildCodeFence(textPassage, "")
  return textPassage
}

/** Italic timestamp line under a section heading; "" when unknown. */
function renderTimestampLine(timeCreated: number): string {
  if (!Number.isFinite(timeCreated) || timeCreated <= 0) return ""
  return `*时间: ${formatLocalTimestamp(timeCreated)}*`
}

/**
 * Extract the text of a user message: the wire `text` field, or the text
 * parts of a `content` array when a caller stores that shape instead.
 */
function readMessageText(dataRecord: Record<string, unknown>): string {
  const textField = dataRecord["text"]
  if (typeof textField === "string") return textField
  const contentParts = Array.isArray(dataRecord["content"])
    ? (dataRecord["content"] as unknown[])
    : []
  return contentParts
    .map((contentPart) => asRecord(contentPart))
    .filter(
      (partRecord): partRecord is Record<string, unknown> =>
        partRecord !== null && coerceText(partRecord["type"]) === "text",
    )
    .map((partRecord) => coerceText(partRecord["text"]))
    .filter((textPassage) => textPassage !== "")
    .join("\n\n")
}

/**
 * Render one tool call part: bold name heading (+ status when not
 * completed), params in a json fence, output in a text fence.
 */
function renderToolCallBlock(toolPartRecord: Record<string, unknown>): string {
  const toolName = readToolName(toolPartRecord)
  const stateRecord = asRecord(toolPartRecord["state"])
  const blockLines = [`**🔧 工具调用: ${toolName}**${renderToolStatusSuffix(stateRecord)}`]

  if (stateRecord !== null && stateRecord["input"] !== undefined && stateRecord["input"] !== null) {
    blockLines.push("", "参数:", "", buildCodeFence(safeStringifyJson(stateRecord["input"]), "json"))
  }

  const toolOutput = stateRecord === null ? "" : readToolOutput(stateRecord)
  if (toolOutput.trim() === "") {
    blockLines.push("", "*（无输出记录）*")
  } else {
    blockLines.push("", "输出:", "", buildCodeFence(truncateToolOutput(toolOutput), "text"))
  }
  return blockLines.join("\n")
}

/** Current wire key is "name"; older shapes used "tool". */
function readToolName(toolPartRecord: Record<string, unknown>): string {
  let toolName = coerceText(toolPartRecord["name"])
  if (toolName === "") toolName = coerceText(toolPartRecord["tool"])
  return toolName === "" ? "unknown" : toolName
}

/** Status annotation appended to the tool heading for non-completed calls. */
function renderToolStatusSuffix(stateRecord: Record<string, unknown> | null): string {
  if (stateRecord === null) return ""
  const statusText = coerceText(stateRecord["status"])
  if (statusText === "" || statusText === "completed") return ""
  return `（状态: ${statusText}）`
}

/**
 * Tool output lives in `state.metadata.output` (string); older shapes only
 * carry `state.content` text parts, which are joined as a fallback.
 */
function readToolOutput(stateRecord: Record<string, unknown>): string {
  const metadataRecord = asRecord(stateRecord["metadata"])
  const rawOutput = metadataRecord === null ? undefined : metadataRecord["output"]
  if (typeof rawOutput === "string" && rawOutput !== "") return rawOutput

  const contentParts = Array.isArray(stateRecord["content"])
    ? (stateRecord["content"] as unknown[])
    : []
  return contentParts
    .map((contentPart) => asRecord(contentPart))
    .filter(
      (partRecord): partRecord is Record<string, unknown> =>
        partRecord !== null && coerceText(partRecord["type"]) === "text",
    )
    .map((partRecord) => coerceText(partRecord["text"]))
    .filter((textPassage) => textPassage !== "")
    .join("\n\n")
}

/** Build the single italic notice line for a non-conversation message. */
function buildNoticeLine(message: SessionMessageRecord): string {
  const messageType = coerceText(message.type)
  const dataRecord = asRecord(message.data)

  if (messageType === "system") {
    const systemText =
      dataRecord === null ? "" : collapseToSingleLine(coerceText(dataRecord["text"]))
    if (systemText === "") return "系统指令更新（内容缺失）"
    return `系统指令更新: ${truncateNoticeText(systemText)}`
  }

  if (messageType === "model-switched") {
    const currentModelId = readModelId(dataRecord, "model")
    const previousModelId = readModelId(dataRecord, "previous")
    return `模型切换: ${previousModelId} → ${currentModelId}`
  }

  if (messageType === "compaction") {
    const compactionReason =
      dataRecord === null ? "" : collapseToSingleLine(coerceText(dataRecord["reason"]))
    const compactionSummary =
      dataRecord === null ? "" : collapseToSingleLine(coerceText(dataRecord["summary"]))
    const reasonLabel = compactionReason === "" ? "未知原因" : compactionReason
    return `上下文压缩（${reasonLabel}）: ${truncateNoticeText(compactionSummary)}`
  }

  const dataPreview = truncateNoticeText(collapseToSingleLine(safeStringifyJson(message.data)))
  const typeLabel = messageType === "" ? "缺失" : messageType
  return `未知消息类型（${typeLabel}）: ${dataPreview}`
}

/** Read a model id out of a {"id","providerID"} wire record. */
function readModelId(
  dataRecord: Record<string, unknown> | null,
  modelKey: string,
): string {
  if (dataRecord === null) return "未知"
  const modelRecord = asRecord(dataRecord[modelKey])
  if (modelRecord === null) return "未知"
  const modelId = coerceText(modelRecord["id"])
  return modelId === "" ? "未知" : modelId
}

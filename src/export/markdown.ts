/**
 * Session markdown export renderer (DESIGN.md §8, task T5.1).
 *
 * Pure function over already-fetched data: the header comes from a
 * querySessionList row, the message list from querySessionMessages, the
 * system prompt from querySessionSystemPrompt (joined by the HTTP route).
 * Rendering never throws — malformed messages are skipped or annotated.
 *
 * Document layout:
 *   1. header block (title / model / agent / timestamps / token summary)
 *   2. one section per message: ## 🧑 用户 / ## 🤖 助手, or a `---` + italic
 *      notice line for system / model-switched / compaction
 *   3. ## 📋 系统提示词 tail section with the prompt wrapped in a blockquote
 */

import type { SessionMessageRecord, SessionSummary } from "../db/types.ts"
import { coerceNumber, coerceText } from "../db/rows.ts"
import {
  escapeMarkdownSpecialCharacters,
  formatLocalTimestamp,
  formatTokenCount,
  wrapTextAsBlockquote,
} from "./format-helpers.ts"
import {
  isIgnoredMessageType,
  renderAssistantMessageSection,
  renderNoticeSection,
  renderUserMessageSection,
} from "./message-roles.ts"

/**
 * Render a full session export document. `systemPrompt` may be null when
 * the session has no instruction state; the tail section is omitted then.
 */
export function renderSessionMarkdown(
  sessionSummary: SessionSummary,
  messages: SessionMessageRecord[],
  systemPrompt: string | null,
): string {
  const markdownSections: string[] = [renderHeaderSection(sessionSummary)]

  const messageList = Array.isArray(messages) ? messages : []
  if (messageList.length === 0) {
    markdownSections.push("*（本会话无消息记录）*")
  }

  for (const message of messageList) {
    if (typeof message !== "object" || message === null) continue
    const messageType = coerceText(message.type)
    if (isIgnoredMessageType(messageType)) continue

    const messageSection =
      messageType === "user"
        ? renderUserMessageSection(message)
        : messageType === "assistant"
          ? renderAssistantMessageSection(message)
          : renderNoticeSection(message)
    if (messageSection !== "") markdownSections.push(messageSection)
  }

  const systemPromptSection = renderSystemPromptSection(systemPrompt)
  if (systemPromptSection !== "") markdownSections.push(systemPromptSection)

  return `${markdownSections.join("\n\n")}\n`
}

/**
 * Header block. Field access is defensively coerced: a hostile or partial
 * summary degrades to "未知" / "0" placeholders instead of crashing.
 */
function renderHeaderSection(sessionSummary: SessionSummary): string {
  const summaryRecord: Record<string, unknown> =
    typeof sessionSummary === "object" && sessionSummary !== null
      ? (sessionSummary as Record<string, unknown>)
      : {}

  const sessionTitle = coerceText(summaryRecord["title"])
  const headerLines = [
    `# ${sessionTitle === "" ? "（无标题会话）" : escapeMarkdownSpecialCharacters(sessionTitle)}`,
    `- **会话 ID**: ${coerceText(summaryRecord["id"]) || "未知"}`,
    `- **模型**: ${coerceText(summaryRecord["modelId"]) || "未知"}`,
    `- **Agent**: ${coerceText(summaryRecord["agent"]) || "未知"}`,
    `- **创建时间**: ${formatLocalTimestamp(coerceNumber(summaryRecord["timeCreated"]))}`,
    `- **更新时间**: ${formatLocalTimestamp(coerceNumber(summaryRecord["timeUpdated"]))}`,
    `- **Token 汇总**: ${formatTokenCount(coerceNumber(summaryRecord["tokens"]))}`,
  ]

  const sessionCost = coerceNumber(summaryRecord["cost"])
  if (sessionCost > 0) headerLines.push(`- **费用**: $${sessionCost}`)

  return headerLines.join("\n")
}

/** Tail section with the system prompt as one blockquote; "" when absent. */
function renderSystemPromptSection(systemPrompt: string | null): string {
  if (typeof systemPrompt !== "string" || systemPrompt.trim() === "") return ""
  return `## 📋 系统提示词\n\n${wrapTextAsBlockquote(systemPrompt)}`
}

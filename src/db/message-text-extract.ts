/**
 * 回放消息文本提取的 TS 侧复刻（搜索后端单点）。
 *
 * 与前端 src/web/public/components/replay-message-text.js 逐函数语义对齐，
 * 保证搜索命中的文本 == 回放页实际渲染的文本（「搜得到却渲染不出来」的
 * 错位由这个同源收敛消除）。这是后端独立的一份纯函数实现，不 import
 * 前端 JS——两处各写各的、但行为必须处处一致。
 *
 * 对齐不变量：buildSearchableMessageText 输出的每一段，与前端
 * buildSearchableMessageText 的输出逐字节一致（同样的六类文本、同样的
 * "\n\n" 拼接、同样的 reasoning / tool output 截断上限）。改任一侧前
 * 先读对侧文件头。
 */

/** 对象/非空/非数组守卫：返回普通记录或 null。 */
export function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null
  }
  return value as Record<string, unknown>
}

/** 文本内容块：type 为 "text" 时返回其 .text 字符串，否则 ""。 */
export function partText(contentPart: unknown): string {
  if (contentPart === null || typeof contentPart !== "object") return ""
  const partRecord = contentPart as Record<string, unknown>
  if (String(partRecord["type"]) !== "text") return ""
  return typeof partRecord["text"] === "string" ? partRecord["text"] : ""
}

/**
 * 消息正文：data.text 字符串，或 data.content[] 各 text 块的 "\n\n" 拼接。
 * 与前端 readMessageText 一致——text 字段优先，content 数组回退。
 */
export function readMessageText(dataRecord: unknown): string {
  const data = asRecord(dataRecord)
  if (data === null) return ""
  const textField = data["text"]
  if (typeof textField === "string") return textField
  if (Array.isArray(data["content"])) {
    return (data["content"] as unknown[])
      .map((part) => partText(part))
      .filter((text) => text !== "")
      .join("\n\n")
  }
  return ""
}

/** 工具名：name 优先，tool 回退，两者皆空则 "unknown"。 */
export function readToolName(partRecord: unknown): string {
  const part = asRecord(partRecord)
  if (part === null) return "unknown"
  let toolName = typeof part["name"] === "string" ? part["name"] : ""
  if (toolName === "") toolName = typeof part["tool"] === "string" ? part["tool"] : ""
  return toolName === "" ? "unknown" : toolName
}

/** 工具入参展示串：state.input 非 null/undefined 时 JSON.stringify 美化。 */
export function readToolInput(stateRecord: unknown): string {
  const state = asRecord(stateRecord)
  if (state === null) return ""
  if (state["input"] === undefined || state["input"] === null) return ""
  return JSON.stringify(state["input"], null, 2)
}

/** 工具输出：state.metadata.output 字符串，或 state.content[] 文本 "\n\n" 拼接。 */
export function readToolOutput(stateRecord: unknown): string {
  const state = asRecord(stateRecord)
  if (state === null) return ""
  const metadata = asRecord(state["metadata"])
  if (
    metadata !== null &&
    typeof metadata["output"] === "string" &&
    metadata["output"] !== ""
  ) {
    return metadata["output"]
  }
  if (Array.isArray(state["content"])) {
    return (state["content"] as unknown[])
      .map((part) => partText(part))
      .filter((text) => text !== "")
      .join("\n\n")
  }
  return ""
}

/** 渲染与搜索共用的工具输出上限（与前端 TOOL_OUTPUT_DISPLAY_MAX_CHARS 同源）。 */
export const TOOL_OUTPUT_DISPLAY_MAX_CHARS = 200_000

/** 渲染与搜索共用的 reasoning（thinking）正文上限（与前端同源）。 */
export const REASONING_DISPLAY_MAX_CHARS = 100_000

/** 按上限于码元边界截断，不留孤立高位代理（emoji 被切半会破坏渲染）。 */
function truncateForDisplay(text: unknown, characterLimit: number): string {
  const rawText = typeof text === "string" ? text : ""
  if (rawText.length <= characterLimit) return rawText
  let cutText = rawText.slice(0, characterLimit)
  if (/[\ud800-\udbff]$/.test(cutText)) cutText = cutText.slice(0, -1)
  return cutText
}

/**
 * 单条消息的**可搜索文本**：user 正文、assistant text / reasoning / tool
 * name / tool input / tool output。与前端 buildSearchableMessageText 逐
 * 字节对齐（同样的六类、同样的截断、同样的 "\n\n" 拼接）。user/assistant
 * 之外的类型返回 ""。
 */
export function buildSearchableMessageText(messageRecord: unknown): string {
  const message = asRecord(messageRecord)
  if (message === null) return ""
  const dataRecord = asRecord(message["data"])
  if (dataRecord === null) return ""
  const messageType = String(message["type"] ?? "")
  if (messageType !== "user" && messageType !== "assistant") return ""
  const passages: string[] = [readMessageText(dataRecord)]
  if (messageType === "assistant" && Array.isArray(dataRecord["content"])) {
    for (const contentPart of dataRecord["content"] as unknown[]) {
      const partRecord = asRecord(contentPart)
      if (partRecord === null) continue
      const partType = String(partRecord["type"] ?? "")
      if (partType === "reasoning") {
        passages.push(
          truncateForDisplay(partRecord["text"], REASONING_DISPLAY_MAX_CHARS),
        )
      } else if (partType === "tool") {
        passages.push(readToolName(partRecord))
        passages.push(readToolInput(asRecord(partRecord["state"])))
        passages.push(
          truncateForDisplay(
            readToolOutput(asRecord(partRecord["state"])),
            TOOL_OUTPUT_DISPLAY_MAX_CHARS,
          ),
        )
      }
    }
  }
  return passages.filter((passage) => passage !== "").join("\n\n")
}
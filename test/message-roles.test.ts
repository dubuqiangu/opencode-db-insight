/**
 * Unit tests for the per-role session export renderers (DESIGN.md §8).
 *
 * Fixtures are constructed in place from the wire shapes probed from
 * opencode.db; no database or HTTP layer is involved. The focus is role
 * classification, ignored types, empty/null inputs and escaping.
 */

import { test } from "node:test"
import assert from "node:assert/strict"

import type { SessionMessageRecord } from "../src/db/types.ts"
import {
  isIgnoredMessageType,
  renderAssistantMessageSection,
  renderNoticeSection,
  renderUserMessageSection,
} from "../src/export/message-roles.ts"

function buildMessage(overrides: Partial<SessionMessageRecord> = {}): SessionMessageRecord {
  return {
    id: "msg_fixture",
    sessionId: "ses_fixture",
    type: "user",
    seq: 1,
    timeCreated: 0,
    timeUpdated: 0,
    data: null,
    ...overrides,
  }
}

test("isIgnoredMessageType ignores only idle and synthetic messages", () => {
  assert.equal(isIgnoredMessageType("idle"), true)
  assert.equal(isIgnoredMessageType("synthetic"), true)
  for (const renderedType of ["user", "assistant", "system", "model-switched", "compaction", ""]) {
    assert.equal(isIgnoredMessageType(renderedType), false, `${renderedType} must not be ignored`)
  }
})

test("renderUserMessageSection returns empty for missing, non-object or blank content", () => {
  assert.equal(renderUserMessageSection(buildMessage({ data: null })), "")
  assert.equal(renderUserMessageSection(buildMessage({ data: "not a record" })), "")
  assert.equal(renderUserMessageSection(buildMessage({ data: { text: "   " } })), "")
  assert.equal(renderUserMessageSection(buildMessage({ data: {} })), "")
})

test("renderUserMessageSection renders a heading, a local timestamp and the body", () => {
  const createdAt = new Date(2026, 9, 5, 14, 30).getTime()
  const section = renderUserMessageSection(
    buildMessage({ type: "user", timeCreated: createdAt, data: { text: "帮我修复登录 bug" } }),
  )

  assert.match(section, /^## 🧑 用户\n\n\*时间: 2026-10-05 14:30\*\n\n帮我修复登录 bug$/)
})

test("renderUserMessageSection omits the timestamp line for unknown creation time", () => {
  const section = renderUserMessageSection(
    buildMessage({ type: "user", timeCreated: 0, data: { text: "no timestamp" } }),
  )
  assert.equal(section, "## 🧑 用户\n\nno timestamp")
})

test("renderUserMessageSection falls back to text content parts when the text field is absent", () => {
  const section = renderUserMessageSection(
    buildMessage({
      type: "user",
      data: {
        content: [
          { type: "text", text: "first paragraph" },
          { type: "text", text: "second paragraph" },
          { type: "reasoning", text: "ignored" },
        ],
      },
    }),
  )
  assert.ok(section.includes("first paragraph\n\nsecond paragraph"))
  assert.ok(!section.includes("ignored"), "non-text parts must not leak into a user section")
})

test("renderUserMessageSection redacts credentials in the body", () => {
  const secret = "sk-testonly0000111122223333WXYZ"
  const section = renderUserMessageSection(buildMessage({ data: { text: `key ${secret}` } }))
  assert.ok(!section.includes(secret), "the secret must be gone")
  assert.ok(section.includes("sk-…WXYZ"), "the masked tail stays readable")
})

test("renderUserMessageSection wraps a passage containing a fence in a longer code fence", () => {
  const section = renderUserMessageSection(
    buildMessage({ data: { text: "before ```code``` after" } }),
  )
  assert.ok(section.includes("````\nbefore ```code``` after\n````"), "the embedded fence must not break the section")
})

test("renderAssistantMessageSection returns empty when there is no renderable part", () => {
  assert.equal(renderAssistantMessageSection(buildMessage({ type: "assistant", data: null })), "")
  assert.equal(
    renderAssistantMessageSection(buildMessage({ type: "assistant", data: { content: [] } })),
    "",
  )
  assert.equal(
    renderAssistantMessageSection(
      buildMessage({
        type: "assistant",
        data: { content: [{ type: "text", text: "  " }, { type: "reasoning", text: "" }] },
      }),
    ),
    "",
  )
})

test("renderAssistantMessageSection renders text, a reasoning blockquote and tool blocks", () => {
  const section = renderAssistantMessageSection(
    buildMessage({
      type: "assistant",
      data: {
        content: [
          { type: "text", text: "answer text" },
          { type: "reasoning", text: "my reasoning" },
          {
            type: "tool",
            name: "bash",
            state: { status: "completed", input: { command: "ls" }, metadata: { output: "file.txt" } },
          },
          { type: "tool", name: "read", state: { status: "running" } },
        ],
      },
    }),
  )

  assert.match(section, /^## 🤖 助手/)
  assert.ok(section.includes("answer text"))
  assert.ok(section.includes("> my reasoning"))
  assert.ok(section.includes("**🔧 工具调用: bash**"))
  assert.ok(section.includes("参数:"))
  assert.ok(section.includes("```json\n{\n  \"command\": \"ls\"\n}\n```"))
  assert.ok(section.includes("输出:"))
  assert.ok(section.includes("```text\nfile.txt\n```"))
  assert.ok(section.includes("**🔧 工具调用: read**（状态: running）"), "non-completed status is annotated")
})

test("renderAssistantMessageSection marks a tool call with no recorded output", () => {
  const section = renderAssistantMessageSection(
    buildMessage({
      type: "assistant",
      data: { content: [{ type: "tool", name: "read", state: {} }] },
    }),
  )
  assert.ok(section.includes("*（无输出记录）*"))
})

test("renderAssistantMessageSection falls back to content text parts for tool output", () => {
  const section = renderAssistantMessageSection(
    buildMessage({
      type: "assistant",
      data: {
        content: [
          { type: "tool", name: "read", state: { content: [{ type: "text", text: "fallback output" }] } },
        ],
      },
    }),
  )
  assert.ok(section.includes("fallback output"))
})

test("renderAssistantMessageSection labels a tool call with no name as unknown", () => {
  const section = renderAssistantMessageSection(
    buildMessage({
      type: "assistant",
      data: { content: [{ type: "tool", state: {} }] },
    }),
  )
  assert.ok(section.includes("**🔧 工具调用: unknown**"))
})

test("renderAssistantMessageSection collapses and escapes a hostile tool name", () => {
  const section = renderAssistantMessageSection(
    buildMessage({
      type: "assistant",
      data: { content: [{ type: "tool", name: "line\none*bold", state: {} }] },
    }),
  )
  assert.ok(section.includes("**🔧 工具调用: line one\\*bold**"), "the newline and asterisk must be neutralised")
  assert.ok(!section.includes("one*bold**"), "a raw asterisk must never reach the bold heading")
})

test("renderNoticeSection renders a system message and escapes its asterisks", () => {
  const section = renderNoticeSection(
    buildMessage({ type: "system", data: { text: "hello *world*" } }),
  )
  assert.equal(section, "---\n\n*系统指令更新: hello \\*world\\**")
})

test("renderNoticeSection reports a system message with missing content", () => {
  assert.equal(renderNoticeSection(buildMessage({ type: "system", data: null })), "---\n\n*系统指令更新（内容缺失）*")
})

test("renderNoticeSection renders a model-switched message with previous and current model", () => {
  const section = renderNoticeSection(
    buildMessage({
      type: "model-switched",
      data: { model: { id: "glm-5" }, previous: { id: "gpt-5" } },
    }),
  )
  assert.equal(section, "---\n\n*模型切换: gpt-5 → glm-5*")
})

test("renderNoticeSection falls back to an unknown label when a switched model id is missing", () => {
  const section = renderNoticeSection(
    buildMessage({ type: "model-switched", data: { model: { id: "glm-5" } } }),
  )
  assert.equal(section, "---\n\n*模型切换: 未知 → glm-5*")
})

test("renderNoticeSection renders a compaction message with reason and summary", () => {
  const section = renderNoticeSection(
    buildMessage({ type: "compaction", data: { reason: "token limit", summary: "context condensed" } }),
  )
  assert.equal(section, "---\n\n*上下文压缩（token limit）: context condensed*")
})

test("renderNoticeSection labels a compaction with no reason as unknown", () => {
  const section = renderNoticeSection(
    buildMessage({ type: "compaction", data: { summary: "context condensed" } }),
  )
  assert.equal(section, "---\n\n*上下文压缩（未知原因）: context condensed*")
})

test("renderNoticeSection previews an unknown message type with its serialized data", () => {
  const section = renderNoticeSection(buildMessage({ type: "mystery", data: { a: 1 } }))
  assert.equal(section, "---\n\n*未知消息类型（mystery）: { \"a\": 1 }*")
})

test("renderNoticeSection labels an empty message type as missing", () => {
  const section = renderNoticeSection(buildMessage({ type: "", data: null }))
  assert.equal(section, "---\n\n*未知消息类型（缺失）: null*")
})

const NOTICE_SECRET = "sk-testonly0000111122223333WXYZ"

test("renderNoticeSection redacts credentials in a system notice (L3)", () => {
  const section = renderNoticeSection(
    buildMessage({ type: "system", data: { text: `系统指令 ${NOTICE_SECRET}` } }),
  )
  assert.ok(!section.includes(NOTICE_SECRET), "the secret must be gone")
  assert.ok(section.includes("sk-…WXYZ"), "the masked tail stays readable")
})

test("renderNoticeSection redacts credentials in a compaction summary and reason (L3)", () => {
  const section = renderNoticeSection(
    buildMessage({
      type: "compaction",
      data: { reason: `auto ${NOTICE_SECRET}`, summary: `condensed ${NOTICE_SECRET}` },
    }),
  )
  assert.ok(!section.includes(NOTICE_SECRET), "the secret must be gone from both fields")
  assert.ok(section.includes("sk-…WXYZ"), "the masked tail stays readable")
})

test("renderNoticeSection redacts credentials in a switched model id (L3)", () => {
  const section = renderNoticeSection(
    buildMessage({
      type: "model-switched",
      data: { model: { id: NOTICE_SECRET }, previous: { id: "gpt-5" } },
    }),
  )
  assert.ok(!section.includes(NOTICE_SECRET), "the secret must be gone")
  assert.ok(section.includes("sk-…WXYZ"), "the masked tail stays readable")
})

test("renderNoticeSection redacts credentials in the unknown-type data preview (L3)", () => {
  const section = renderNoticeSection(
    buildMessage({ type: "mystery", data: { token: NOTICE_SECRET } }),
  )
  assert.ok(!section.includes(NOTICE_SECRET), "the secret must be gone")
  assert.ok(section.includes("sk-…WXYZ"), "the masked tail stays readable")
})

test("renderNoticeSection redacts BEFORE truncation, so a boundary secret is not split (L3)", () => {
  // 190 padding chars + a space + a 29-char token = 220 chars, past the
  // 200-char notice limit. If truncation ran first, the token would be cut
  // at the limit into an unrecognizable "sk-BBBBBB" fragment and the
  // redaction patterns would then miss it. Redact-first shrinks it to the
  // 8-char "sk-…WXYZ" mask, so nothing spills and nothing needs truncating.
  const boundarySecret = "sk-" + "B".repeat(22) + "WXYZ"
  const systemText = "x".repeat(190) + " " + boundarySecret
  const section = renderNoticeSection(buildMessage({ type: "system", data: { text: systemText } }))
  assert.ok(section.includes("sk-…WXYZ"), "the full token was redacted, not split")
  assert.ok(!section.includes(boundarySecret), "the raw token never reaches the notice")
  assert.ok(!section.includes("sk-BBBBBB"), "no truncated token fragment leaks")
})

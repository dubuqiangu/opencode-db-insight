/**
 * Unit tests for the session markdown export renderer (T5.1).
 * All fixtures are constructed in place from the wire shapes probed from
 * opencode.db — no database or HTTP layer involved.
 */

import { test } from "node:test"
import assert from "node:assert/strict"

import type { SessionMessageRecord, SessionSummary } from "../src/db/types.ts"
import { renderSessionMarkdown } from "../src/export/markdown.ts"
import { truncateNoticeText, truncateToolOutput } from "../src/export/format-helpers.ts"

function buildSessionSummaryFixture(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id: "ses_export_fixture",
    title: "导出测试会话",
    modelId: "glm-5.3",
    agent: "fixer",
    directory: "",
    timeCreated: Date.UTC(2026, 9, 5, 6, 30),
    timeUpdated: Date.UTC(2026, 9, 5, 7, 15),
    tokens: 123456,
    tokensInput: 100000,
    tokensOutput: 20000,
    tokensCacheRead: 3456,
    cost: 0,
    ...overrides,
  }
}

function buildMessageFixture(
  type: string,
  data: unknown,
  overrides: Partial<SessionMessageRecord> = {},
): SessionMessageRecord {
  return {
    id: "msg_fixture",
    sessionId: "ses_export_fixture",
    type,
    seq: 0,
    timeCreated: Date.UTC(2026, 9, 5, 6, 31),
    timeUpdated: Date.UTC(2026, 9, 5, 6, 31),
    data,
    ...overrides,
  }
}

test("多角色会话渲染出用户/助手分节、reasoning 引用块与头部元信息", () => {
  const userMessage = buildMessageFixture("user", { text: "帮我修复登录 bug" })
  const assistantMessage = buildMessageFixture("assistant", {
    agent: "fixer",
    model: { id: "glm-5.3", providerID: "futureppo" },
    tokens: { input: 100, output: 200, reasoning: 10, cache: { read: 50, write: 0 } },
    content: [
      { type: "text", text: "已定位问题：密码比较用了弱哈希。" },
      { type: "reasoning", text: "先检查登录链路，再查哈希函数。" },
    ],
  })

  const renderedExport = renderSessionMarkdown(
    buildSessionSummaryFixture(),
    [userMessage, assistantMessage],
    "你是一个助手",
  )

  assert.match(renderedExport, /## 🧑 用户/)
  assert.match(renderedExport, /## 🤖 助手/)
  assert.ok(renderedExport.includes("帮我修复登录 bug"))
  assert.ok(renderedExport.includes("已定位问题：密码比较用了弱哈希。"))
  assert.ok(renderedExport.includes("> 先检查登录链路，再查哈希函数。"))
  assert.ok(renderedExport.includes("- **模型**: glm-5.3"))
  assert.ok(renderedExport.includes("- **Agent**: fixer"))
  assert.ok(renderedExport.includes("- **Token 汇总**: 123,456"))
  assert.match(renderedExport, /- \*\*创建时间\*\*: \d{4}-\d{2}-\d{2} \d{2}:\d{2}/)
  assert.match(renderedExport, /- \*\*更新时间\*\*: \d{4}-\d{2}-\d{2} \d{2}:\d{2}/)
  assert.match(renderedExport, /\*时间: \d{4}-\d{2}-\d{2} \d{2}:\d{2}\*/)
})

test("工具调用渲染为名称加 json 参数与 text 输出围栏", () => {
  const assistantMessage = buildMessageFixture("assistant", {
    content: [
      {
        type: "tool",
        id: "call_fixture",
        name: "shell",
        state: {
          status: "completed",
          input: { command: "npm test" },
          metadata: { output: "全部用例通过", exit: 0 },
        },
      },
    ],
  })

  const renderedExport = renderSessionMarkdown(
    buildSessionSummaryFixture(),
    [assistantMessage],
    null,
  )

  assert.ok(renderedExport.includes("**🔧 工具调用: shell**"))
  assert.ok(renderedExport.includes("```json"))
  assert.ok(renderedExport.includes('"command": "npm test"'))
  assert.ok(renderedExport.includes("```text"))
  assert.ok(renderedExport.includes("全部用例通过"))
})

test("工具输出与用户消息中的三反引号被四反引号围栏包裹，不破坏结构", () => {
  const userMessageWithFence = buildMessageFixture("user", {
    text: "示例：\n```bash\nls -la\n```",
  })
  const assistantMessage = buildMessageFixture("assistant", {
    content: [
      {
        type: "tool",
        id: "call_fixture",
        name: "read",
        state: {
          status: "completed",
          input: { path: "src/index.ts" },
          metadata: { output: "审查结果：\n```js\nconsole.log('x')\n```\n结束" },
        },
      },
    ],
  })

  const renderedExport = renderSessionMarkdown(
    buildSessionSummaryFixture(),
    [userMessageWithFence, assistantMessage],
    null,
  )

  // both the user passage and the tool output are fenced with four backticks
  assert.ok(renderedExport.includes("````\n示例："))
  assert.ok(renderedExport.includes("````text\n审查结果："))
  // four four-backtick fences appear in total: each opened fence is closed again
  const fourBacktickCount = (renderedExport.match(/````/g) ?? []).length
  assert.equal(fourBacktickCount, 4)
})

test("空消息数组仅输出头部与占位说明，不抛异常", () => {
  const renderedExport = renderSessionMarkdown(buildSessionSummaryFixture(), [], null)

  assert.ok(renderedExport.includes("# 导出测试会话"))
  assert.ok(renderedExport.includes("*（本会话无消息记录）*"))
  assert.ok(!renderedExport.includes("## 🧑 用户"))
  assert.ok(!renderedExport.includes("## 🤖 助手"))
})

test("缺 systemPrompt 时省略系统提示词节，提供时用引用块包裹", () => {
  const userMessage = buildMessageFixture("user", { text: "你好" })

  const exportWithoutPrompt = renderSessionMarkdown(
    buildSessionSummaryFixture(),
    [userMessage],
    null,
  )
  assert.ok(!exportWithoutPrompt.includes("## 📋 系统提示词"))

  const exportWithPrompt = renderSessionMarkdown(
    buildSessionSummaryFixture(),
    [userMessage],
    "第一行指令\n第二行指令",
  )
  assert.ok(exportWithPrompt.includes("## 📋 系统提示词"))
  assert.ok(exportWithPrompt.includes("> 第一行指令"))
  assert.ok(exportWithPrompt.includes("> 第二行指令"))
})

test("超长工具输出截断到 4000 字符并标注完整长度", () => {
  const oversizedToolOutput = "x".repeat(5000)
  const assistantMessage = buildMessageFixture("assistant", {
    content: [
      {
        type: "tool",
        id: "call_fixture",
        name: "shell",
        state: {
          status: "completed",
          input: { command: "cat huge.log" },
          metadata: { output: oversizedToolOutput },
        },
      },
    ],
  })

  const renderedExport = renderSessionMarkdown(
    buildSessionSummaryFixture(),
    [assistantMessage],
    null,
  )

  assert.ok(renderedExport.includes("...（截断，完整 5000 字符）"))
  assert.ok(renderedExport.includes("x".repeat(4000)))
  assert.ok(!renderedExport.includes("x".repeat(4001)))
})

test("坏 JSON 与缺失字段的消息被安全跳过或标注，绝不抛异常", () => {
  const brokenMessages: SessionMessageRecord[] = [
    buildMessageFixture("user", null), // data missing entirely
    buildMessageFixture("assistant", "not-an-object"), // data is a bare string
    buildMessageFixture("assistant", { content: null }), // content missing
    buildMessageFixture("assistant", { content: [{ type: "text" }] }), // text field missing
    buildMessageFixture("assistant", {
      // tool without a name and without any output
      content: [{ type: "tool", state: { status: "completed", input: { probe: 1 } } }],
    }),
    buildMessageFixture("model-switched", null), // model fields missing
    buildMessageFixture("nonexistent-type", undefined),
  ]

  const renderedExport = renderSessionMarkdown(
    buildSessionSummaryFixture(),
    brokenMessages,
    null,
  )

  assert.ok(!renderedExport.includes("## 🧑 用户"), "空内容的用户分节应被跳过")
  const assistantSectionCount = (renderedExport.match(/## 🤖 助手/g) ?? []).length
  assert.equal(assistantSectionCount, 1, "只有带可渲染 part 的助手消息应生成分节")
  assert.ok(renderedExport.includes("**🔧 工具调用: unknown**"))
  assert.ok(renderedExport.includes("（无输出记录）"))
  assert.ok(renderedExport.includes("*模型切换: 未知 → 未知*"))
  assert.ok(renderedExport.includes("未知消息类型（nonexistent-type）"))
})

test("system/model-switched/compaction 渲染为分隔线加斜体说明，idle/synthetic 被忽略", () => {
  const noticeMessages: SessionMessageRecord[] = [
    buildMessageFixture("system", { text: "工具目录已更新，新增 browser 插件。" }),
    buildMessageFixture("system", { text: "y".repeat(300) }), // 超长说明被截断
    buildMessageFixture("model-switched", {
      model: { id: "glm-5.3", providerID: "futureppo" },
      previous: { id: "glm-5.3-flash", providerID: "bai" },
    }),
    buildMessageFixture("compaction", {
      status: "completed",
      reason: "auto",
      summary: "已压缩历史上下文。",
    }),
    buildMessageFixture("idle", { outcome: "failed" }),
    buildMessageFixture("synthetic", { text: "Continue if you have next steps." }),
  ]

  const renderedExport = renderSessionMarkdown(
    buildSessionSummaryFixture(),
    noticeMessages,
    null,
  )

  assert.ok(renderedExport.includes("---"))
  assert.ok(renderedExport.includes("*系统指令更新: 工具目录已更新，新增 browser 插件。*"))
  assert.ok(renderedExport.includes(`系统指令更新: ${"y".repeat(200)}...`))
  assert.ok(renderedExport.includes("*模型切换: glm-5.3-flash → glm-5.3*"))
  assert.ok(renderedExport.includes("*上下文压缩（auto）: 已压缩历史上下文。*"))
  assert.ok(!renderedExport.includes("Continue if you have next steps"))
  assert.ok(!renderedExport.includes("failed"))
})

test("标题中的 Markdown 特殊字符被转义", () => {
  const renderedExport = renderSessionMarkdown(
    buildSessionSummaryFixture({ title: "#1 *重要* [草稿] <v2>" }),
    [],
    null,
  )

  assert.ok(renderedExport.includes("\\#1 \\*重要\\* \\[草稿\\] \\<v2\\>"))
  assert.ok(!renderedExport.includes("#1 *重要* [草稿] <v2>"))
})

test("费用为正数时头部包含费用行，为零时省略", () => {
  const exportWithoutCost = renderSessionMarkdown(
    buildSessionSummaryFixture({ cost: 0 }),
    [],
    null,
  )
  assert.ok(!exportWithoutCost.includes("**费用**"))

  const exportWithCost = renderSessionMarkdown(
    buildSessionSummaryFixture({ cost: 0.42 }),
    [],
    null,
  )
  assert.ok(exportWithCost.includes("- **费用**: $0.42"))
})

test("标题中的换行折叠成空格，文档始终只有一个一级标题（P2-3）", () => {
  const renderedExport = renderSessionMarkdown(
    buildSessionSummaryFixture({ title: "第一行\n第二行\r\n第三行" }),
    [],
    null,
  )

  assert.ok(renderedExport.includes("# 第一行 第二行 第三行"))
  const headingLineCount = (renderedExport.match(/^# /gm) ?? []).length
  assert.equal(headingLineCount, 1, "标题里的换行不能拆出第二行标题")
})

test("notice 行内的星号被转义，不能吞掉斜体定界符（P2-3）", () => {
  const renderedExport = renderSessionMarkdown(
    buildSessionSummaryFixture(),
    [buildMessageFixture("system", { text: "前缀 *强调* 中缀 **粗体** 后缀" })],
    null,
  )

  assert.ok(renderedExport.includes("系统指令更新: 前缀 \\*强调\\* 中缀 \\*\\*粗体\\*\\* 后缀"))
  assert.ok(!renderedExport.includes("*强调*"))
  assert.ok(!renderedExport.includes("**粗体**"))
})

test("truncateToolOutput 截在高代理位时回退一个码元，不留半个 emoji（P2-1）", () => {
  // "x" + 2000 个 emoji：长度 4001，4000 处的截断点落在最后一对代理中间。
  const surrogateHeavyOutput = "x" + "😀".repeat(2000)
  assert.equal(surrogateHeavyOutput.length, 4001)

  const truncatedOutput = truncateToolOutput(surrogateHeavyOutput)
  assert.equal(truncatedOutput, "x" + "😀".repeat(1999) + "\n...（截断，完整 4001 字符）")
  // 回退后的结尾必须是完整的 emoji（一个低位代理），不是孤立的高代理。
  assert.ok(!/[\ud800-\udbff]$/.test(truncatedOutput))
})

test("truncateNoticeText 截在高代理位时同样回退一个码元（P2-1）", () => {
  // "x" + 150 个 emoji：长度 301，200 处的截断点落在代理对中间。
  const surrogateHeavyNotice = "x" + "😀".repeat(150)
  assert.equal(surrogateHeavyNotice.length, 301)

  assert.equal(truncateNoticeText(surrogateHeavyNotice), "x" + "😀".repeat(99) + "...")
})

/**
 * 回放时间线分页的成本上限（v0.24.x）。
 *
 * renderTimeline 原来只按固定条数分页：首屏永远 200 条，不管它们多重。
 * 实测本机库 1041 个有可见消息的会话，200 条一块的正文长度中位数
 * 112,823、p95 708,134、p99 1,062,388、最大 1,744,374——约 11% 的会话
 * 一打开就要布局几十万到一百多万字符。
 *
 * 现在的契约是「条数上限 + 字符预算」双重封顶，且预算不改分页语义：
 * appendNextChunk 若干次之后前 N 条必然齐全，nodeAt(i) 仍是第 i 条可见
 * 消息。这一点是 replay-search 的命中导航与 replay-deep-link 的定位循环
 * 的正确性基础，所以本文件把它钉死。
 *
 * DOM shim 复用 test/helpers/web-dom-shim.ts（与 web-session-scope 等共用）。
 */

import { test } from "node:test"
import assert from "node:assert/strict"

import { freshContainer, installDomShim } from "./helpers/web-dom-shim.ts"

if (globalThis.document === undefined) installDomShim()

/** Fictional SessionMessageRecord fixture (example-alpha series only). */
function playlistMessageRecord(recordSeq: number, recordType: string, recordData: Record<string, unknown>) {
  return {
    id: `msg_example_alpha_${String(recordSeq).padStart(4, "0")}`,
    sessionId: "ses_example_alpha",
    type: recordType,
    seq: recordSeq,
    timeCreated: 1_700_000_000_000 + recordSeq * 1_000,
    data: recordData,
  }
}

/** 一条正文长度为 characterCount 的 user 消息（占位字符，长度即成本）。 */
function heavyUserRecord(recordSeq: number, characterCount: number, markerText = "") {
  return playlistMessageRecord(recordSeq, "user", {
    text: markerText + "填".repeat(Math.max(0, characterCount - markerText.length)),
  })
}

test("a single message heavier than the whole budget renders alone as one page and does not loop forever", async () => {
  const { renderTimeline } = await import("../src/web/public/components/replay-timeline.js")

  const container = freshContainer()
  // 400,000 字符的正文 + 预算 10,000：任何「按预算切」都无法把它切小。
  const oversizedRecords = [
    heavyUserRecord(0, 400_000, "超重消息"),
    playlistMessageRecord(1, "user", { text: "正常的一条" }),
  ]
  const paginationController = renderTimeline(container, oversizedRecords, 200, 10_000)

  // 至少 1 条：超重消息独占首块，绝不会因为超预算被跳过。
  assert.equal(paginationController.renderedCount, 1, "the oversized message still occupies the first page")
  assert.equal(paginationController.hasMore, true, "the remaining message waits for the next page")
  assert.equal(container.querySelectorAll(".replay-node").length, 1)
  assert.equal(paginationController.nodeAt(0)!.dataset.messageId, "msg_example_alpha_0000")

  // 追加一次就推进一条：renderedCount 必须前进，否则搜索/深链的 while 会转不停。
  const hasMoreAfterSecondPage = paginationController.appendNextChunk()
  assert.equal(paginationController.renderedCount, 2, "the append always advances at least one message")
  assert.equal(hasMoreAfterSecondPage, false)
  assert.equal(container.querySelectorAll(".replay-node").length, 2)
})

test("the character budget shortens a page below 200 messages once the heavy messages add up", async () => {
  const { renderTimeline } = await import("../src/web/public/components/replay-timeline.js")

  const container = freshContainer()
  // 每条 20,000 字符 × 30 条 = 600,000 字符；预算 100,000 只能装下 5 条。
  const heavyRecords = Array.from({ length: 30 }, (_unusedElement, recordSeq) =>
    heavyUserRecord(recordSeq, 20_000),
  )
  const paginationController = renderTimeline(container, heavyRecords, 200, 100_000)

  assert.equal(paginationController.renderedCount, 5, "budget 100,000 / 20,000 per message = 5 messages")
  assert.equal(paginationController.hasMore, true)
  assert.ok(
    paginationController.renderedCount < paginationController.visibleCount,
    "the page is shorter than the count cap",
  )
  assert.equal(container.querySelectorAll(".replay-node").length, 5)

  // 继续追加：每块仍是 5 条，直到末尾。
  while (paginationController.hasMore) paginationController.appendNextChunk()
  assert.equal(paginationController.renderedCount, 30, "every message ends up rendered")
  assert.equal(container.querySelectorAll(".replay-node").length, 30)
})

test("nodeAt(i) stays aligned with the i-th visible message across many budget-trimmed appends", async () => {
  const { renderTimeline } = await import("../src/web/public/components/replay-timeline.js")
  const { findVisibleMessageIndex } = await import("../src/web/public/components/replay-deep-link.js")

  const container = freshContainer()
  // 混合形状：重 user、重 assistant text、idle（不占格）、通知行、普通小行。
  // 每块都受预算挤压，用来验证「块再短，第 i 条还是第 i 条」。
  const mixedRecords = []
  for (let recordSeq = 0; recordSeq < 40; recordSeq += 1) {
    const shapeSelector = recordSeq % 5
    if (shapeSelector === 0) {
      mixedRecords.push(heavyUserRecord(recordSeq, 15_000))
    } else if (shapeSelector === 1) {
      mixedRecords.push(playlistMessageRecord(recordSeq, "assistant", {
        model: { id: "glm-5.3" },
        content: [{ type: "text", text: "回".repeat(12_000) }],
      }))
    } else if (shapeSelector === 2) {
      mixedRecords.push(playlistMessageRecord(recordSeq, "idle", { duration: 1_000 }))
    } else if (shapeSelector === 3) {
      mixedRecords.push(playlistMessageRecord(recordSeq, "system", { text: `系统指令 ${recordSeq}` }))
    } else {
      mixedRecords.push(playlistMessageRecord(recordSeq, "user", { text: `小行 ${recordSeq}` }))
    }
  }
  const paginationController = renderTimeline(container, mixedRecords, 200, 50_000)
  const visibleRecordIds = mixedRecords
    .filter((record) => record.type !== "idle" && record.type !== "synthetic")
    .map((record) => record.id)

  let observedPageSizes = [paginationController.renderedCount]
  while (paginationController.hasMore) {
    const countBeforeAppend = paginationController.renderedCount
    paginationController.appendNextChunk()
    observedPageSizes.push(paginationController.renderedCount - countBeforeAppend)
    assert.ok(paginationController.renderedCount > countBeforeAppend, "each append advances")
  }

  assert.ok(observedPageSizes.length > 2, "the mixed session really needed several pages")
  assert.ok(observedPageSizes.some((pageSize) => pageSize < 200), "at least one page was trimmed by the budget")
  assert.equal(paginationController.renderedCount, visibleRecordIds.length)

  for (let visibleIndex = 0; visibleIndex < visibleRecordIds.length; visibleIndex += 1) {
    const nodeElement = paginationController.nodeAt(visibleIndex)
    assert.notEqual(nodeElement, null, `node ${visibleIndex} is rendered`)
    assert.equal(
      nodeElement!.dataset.messageId,
      visibleRecordIds[visibleIndex],
      `nodeAt(${visibleIndex}) must be the ${visibleIndex}-th visible message`,
    )
    const timelineListElement = container.children[0]!
    assert.ok(
      timelineListElement.children[visibleIndex] === nodeElement,
      `nodeAt(${visibleIndex}) is the ${visibleIndex}-th child of the timeline list`,
    )
    // 深链用的是同一套下标换算，这里顺带锁住两侧口径一致。
    assert.equal(findVisibleMessageIndex(mixedRecords, nodeElement!.dataset.messageId), visibleIndex)
  }
})

test("an ordinary small session still pages at exactly 200 messages, unchanged", async () => {
  const { renderTimeline } = await import("../src/web/public/components/replay-timeline.js")

  const container = freshContainer()
  // 普通会话：每条 200 字符左右，200 条才 40,000 字符，远在默认预算之内。
  const ordinaryRecords = Array.from({ length: 450 }, (_unusedElement, recordSeq) =>
    playlistMessageRecord(recordSeq, "user", { text: `普通消息 ${recordSeq} ` + "字".repeat(180) }),
  )
  const paginationController = renderTimeline(container, ordinaryRecords)

  assert.equal(paginationController.renderedCount, 200, "the default first page is still 200 messages")
  assert.equal(paginationController.hasMore, true)
  assert.equal(container.querySelectorAll(".replay-node").length, 200)
  assert.equal(paginationController.nodeAt(199)!.dataset.messageId, "msg_example_alpha_0199")

  paginationController.appendNextChunk()
  assert.equal(paginationController.renderedCount, 400, "the second page is again 200 messages")
  paginationController.appendNextChunk()
  assert.equal(paginationController.renderedCount, 450, "the tail page stops at the end")
  assert.equal(paginationController.hasMore, false)
  assert.equal(paginationController.nodeAt(449)!.dataset.messageId, "msg_example_alpha_0449")
  assert.equal(paginationController.nodeAt(450), null, "past the end returns null")
})
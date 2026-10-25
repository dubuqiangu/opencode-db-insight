/**
 * 数值可信度契约（`src/web/public/precision.js`）。
 *
 * 这一组用例守的是「口径只有一处出口」，不是某个数字算得对不对：
 * - 三档徽标：实值 / 估算 / 推断；非实值共用琥珀色调 class，未知档回落估算；
 * - 不可得占位：每个原因键渲染自己的说明，未知键回落 notRecorded；
 * - 组件里不得再手拼 "—" 作占位，所有不可得必须走 `renderMissingValue`；
 * - 组件引用的原因键必须存在于目录里（键名写错只会静默降级，靠本组用例兜住）；
 * - `format.js` 仍返回纯文本 "—"，因为调用方无从判断原因——这是刻意保留的边界。
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync, readdirSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "..")
const componentDirectory = join(repositoryRoot, "src", "web", "public", "components")
const precisionModulePath = join(repositoryRoot, "src", "web", "public", "precision.js")

const precisionModule = await import("../src/web/public/precision.js")
const { MISSING_REASON, renderPrecisionBadge, renderMissingValue } = precisionModule

/** 去掉块注释与行注释，只留可执行代码——注释里出现 "—" 不算违规。 */
function stripComments(sourceText) {
  return sourceText
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1")
}

function readComponentSources() {
  return readdirSync(componentDirectory)
    .filter((fileName) => fileName.endsWith(".js"))
    .map((fileName) => ({
      fileName,
      sourceText: readFileSync(join(componentDirectory, fileName), "utf8"),
    }))
}

test("三档徽标各自渲染对应文案，非实值共用琥珀色调 class", () => {
  assert.match(
    renderPrecisionBadge("exact"),
    /^<span class="precision exact" title="实值：/,
    "实值走 exact 色调",
  )
  for (const nonExactKind of ["estimate", "inferred"]) {
    assert.match(
      renderPrecisionBadge(nonExactKind),
      /^<span class="precision estimate" title="/,
      `${nonExactKind} 与估算同色，靠标签文字区分`,
    )
  }
  assert.ok(renderPrecisionBadge("inferred").includes(">推断</span>"), "推断档读作推断")
  assert.ok(renderPrecisionBadge("estimate").includes(">估算</span>"), "估算档读作估算")
})

test("未知精度档回落估算，绝不冒充实值", () => {
  const unknownKindHtml = renderPrecisionBadge("real")
  assert.ok(unknownKindHtml.includes("estimate"), "未知档不得带 exact class")
  assert.ok(unknownKindHtml.includes(">估算</span>"), "未知档按估算呈现")
})

test("原因目录冻结，且每个原因都能渲染出自己的文案", () => {
  assert.ok(Object.isFrozen(MISSING_REASON), "原因目录必须冻结，防止运行期被改写")
  const reasonKeys = Object.keys(MISSING_REASON)
  assert.ok(reasonKeys.length >= 9, "目录至少覆盖九种已确认的缺失原因")
  for (const reasonKey of reasonKeys) {
    assert.equal(
      renderMissingValue(MISSING_REASON[reasonKey]),
      `<span class="missing-value" title="${MISSING_REASON[reasonKey]}">—</span>`,
      `${reasonKey} 的悬浮文案取自目录原文`,
    )
  }
})

test("原因为空时回落「本库没有该字段的记录」，不留空悬浮", () => {
  assert.equal(
    renderMissingValue(undefined),
    renderMissingValue(MISSING_REASON.notRecorded),
    "未传原因时回落到 notRecorded",
  )
  assert.equal(
    renderMissingValue(""),
    renderMissingValue(MISSING_REASON.notRecorded),
    "空串原因同样回落",
  )
  assert.ok(renderMissingValue(undefined).includes('title="本库没有该字段的记录"'))
})

test("每个不可得占位的原因都取自目录常量，不手写文案", () => {
  const violations = []
  for (const { fileName, sourceText } of readComponentSources()) {
    const executableText = stripComments(sourceText)
    for (const callMatch of executableText.matchAll(/renderMissingValue\(\s*([^)]*)/g)) {
      const argumentText = callMatch[1].trim()
      if (!argumentText.startsWith("MISSING_REASON.")) {
        violations.push(`${fileName}: renderMissingValue(${argumentText}`)
      }
    }
  }
  assert.deepEqual(violations, [], "原因必须来自 MISSING_REASON，不接受手写字符串")
})

test("组件不再手拼「—」占位，不可得一律走统一出口", () => {
  const violations = []
  for (const { fileName, sourceText } of readComponentSources()) {
    const executableText = stripComments(sourceText)
    // 手拼的占位只剩两种形态：元素内容直接写短横线，或独立字符串字面量 "—"。
    if (/>—</.test(executableText)) {
      violations.push(`${fileName}: 元素内容里手写了短横线`)
    }
    if (/"—"/.test(executableText) || /`—`/.test(executableText)) {
      violations.push(`${fileName}: 用独立字符串字面量兜底短横线`)
    }
  }
  assert.deepEqual(violations, [], "所有不可得占位都应改用 renderMissingValue")
})

test("组件引用的原因键全部存在于目录里", () => {
  const usedReasonKeys = new Set()
  for (const { fileName, sourceText } of readComponentSources()) {
    const executableText = stripComments(sourceText)
    for (const matchedKey of executableText.matchAll(/MISSING_REASON\.([A-Za-z]+)/g)) {
      usedReasonKeys.add(matchedKey[1])
      assert.ok(
        Object.hasOwn(MISSING_REASON, matchedKey[1]),
        `${fileName} 引用了目录里不存在的原因键 ${matchedKey[1]}`,
      )
    }
  }
  assert.ok(usedReasonKeys.size >= 9, "九种已确认原因都应至少被一个组件用到")
})

test("KPI 卡不再自带一份徽标实现，改从 precision.js 引入", () => {
  const kpiCardText = readFileSync(join(componentDirectory, "kpi-card.js"), "utf8")
  assert.ok(
    kpiCardText.includes('from "../precision.js"'),
    "kpi-card 必须从 precision.js 引入徽标",
  )
  assert.ok(
    !/function precisionBadge\(/.test(kpiCardText),
    "不得保留本地 precisionBadge 副本",
  )
  assert.ok(
    !kpiCardText.includes("PRECISION_TITLE_EXACT"),
    "文案常量只应存在于 precision.js",
  )
})

test("format.js 保留纯文本短横线，作为「调用方不知原因」的边界", async () => {
  const { formatTokens, formatPercent, formatDuration } = await import("../src/web/public/format.js")
  for (const formattingFunction of [formatTokens, formatPercent, formatDuration]) {
    assert.equal(formattingFunction(Number.NaN), "—", "非有限输入必须返回纯文本短横线")
  }
  const formatSourceText = readFileSync(
    join(repositoryRoot, "src", "web", "public", "format.js"),
    "utf8",
  )
  assert.ok(
    formatSourceText.includes("renderMissingValue"),
    "头注必须指明知道原因时改走统一出口",
  )
})

test("precision.js 自己不引入任何组件，保持叶子模块", () => {
  const precisionSourceText = readFileSync(precisionModulePath, "utf8")
  assert.ok(!/^import /m.test(precisionSourceText), "precision.js 不应依赖其它模块")
})

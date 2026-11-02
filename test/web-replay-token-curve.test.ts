/**
 * 回放页 Token 消耗曲线测试（v0.20.0，fix-37）。
 *
 * 曲线组件坐标系里有两组彼此独立的量，改动时最易被互串：
 *   1. 曲线 y        = 累计 output + reasoning（推理是曲线主角）；
 *   2. 峰值上下文    = input + cache.read + cache.write；
 *   3. 分位落点徽标比对的「本会话总量」= input + output + cache.read
 *      （**不含 reasoning**）——必须与分布端点/分位样本
 *      （src/db/session-distribution-queries.ts）及会话列表 Tokens 列
 *      （src/db/queries.ts）同口径。含 reasoning 会系统性高估档位
 *      （推理模型偏差最大），且与同页头部「总量」（summary.tokens）自相矛盾。
 *
 * 本文件锁死第 3 点：构造 reasoning 远大于 入+出+read 的单步，断言徽标引用的
 * 总量恰为 入+出+read、档位不因 reasoning 而虚高；并顺带锁住曲线端点仍是
 * output + reasoning（防反向误改）。
 *
 * 复用 test/helpers/web-dom-shim.ts（与 web-session-scope.test.ts 同款
 * DOM shim）；夹具一律虚构数值。
 */

import { test } from "node:test"
import assert from "node:assert/strict"

import { installDomShim, freshContainer, StubElement } from "./helpers/web-dom-shim.ts"

installDomShim()

test("replay-token-curve: the quantile badge compares 入+出+cache.read (reasoning excluded) and stays out of the inflated tier", async () => {
  const { renderReplayTokenCurve } = await import("../src/web/public/components/replay-token-curve.js")
  const { formatTokens } = await import("../src/web/public/format.js")
  const container = freshContainer()

  const tokensInput = 100
  const tokensOutput = 200
  const tokensCacheRead = 50
  // 显著大于 入+出+read：若被误计入，档位必然越到 p99 之上。
  const reasoningTokens = 10_000

  renderReplayTokenCurve(container, {
    steps: [
      {
        index: 0,
        timeCreated: 1_700_000_000_000,
        tokensInput,
        tokensOutput,
        tokensReasoning: reasoningTokens,
        tokensCacheRead,
        tokensCacheWrite: 0,
      },
    ],
    // 正确总量 350（入+出+read）→ 低于 p50；误含 reasoning 的 10350 会越到 p99 之上。
    distributionPercentiles: { p50: 1000, p90: 5000, p99: 8000 },
  })

  const correctSessionTotal = tokensInput + tokensOutput + tokensCacheRead
  assert.ok(
    container.innerHTML.includes(`本会话 ${formatTokens(correctSessionTotal)} tokens`),
    "the badge's session total is input + output + cache.read (reasoning excluded)",
  )
  assert.ok(
    container.innerHTML.includes("低于 p50"),
    "the tier is judged against the reasoning-excluded total (under p50)",
  )
  assert.ok(
    !container.innerHTML.includes("超过 p99"),
    "reasoning must not inflate the tier to over p99",
  )
  assert.ok(
    container.innerHTML.includes(`>${formatTokens(tokensOutput + reasoningTokens)}<`),
    "the curve endpoint stays cumulative output + reasoning (that axis is untouched)",
  )
})

/* ---------------- 边界：空 / 单点 / 全零 / 脏值（v0.29.0 补测） ---------------- */

/**
 * 容器的最小扩展：真实组件用属性选择器 `button[data-curve-mode]` 找模式切换
 * 按钮，而共享 shim 的 querySelectorAll 只认 class / tag 选择器。这里只为这
 * 一个选择器补上属性过滤（复用底层的 tag 解析），其余选择器一律透传——
 * 不改共享 helper，避免影响其它测试文件。
 */
class ReplayCurveContainer extends StubElement {
  querySelectorAll(elementSelector: string): StubElement[] {
    if (elementSelector === "button[data-curve-mode]") {
      return super
        .querySelectorAll("button")
        .filter((buttonElement) => buttonElement.dataset.curveMode !== undefined)
    }
    return super.querySelectorAll(elementSelector)
  }
}

/** A single well-formed step with the documented wire fields. */
function replayStepFixture(overrides: Record<string, unknown> = {}) {
  return {
    index: 0,
    seq: 1,
    timeCreated: 1_700_000_000_000,
    tokensInput: 100,
    tokensOutput: 200,
    tokensReasoning: 50,
    tokensCacheRead: 40,
    tokensCacheWrite: 10,
    ...overrides,
  }
}

test("replay-token-curve returns null and leaves the container empty for an empty or null step series", async () => {
  const { renderReplayTokenCurve } = await import("../src/web/public/components/replay-token-curve.js")

  const emptyContainer = freshContainer()
  const emptyCleanup = renderReplayTokenCurve(emptyContainer, { steps: [] })
  assert.equal(emptyCleanup, null, "an empty series renders nothing and returns null")
  assert.equal(emptyContainer.innerHTML, "", "the container is left untouched")

  const nullContainer = freshContainer()
  const nullCleanup = renderReplayTokenCurve(nullContainer, null)
  assert.equal(nullCleanup, null, "a null payload renders nothing and returns null")
  assert.equal(nullContainer.innerHTML, "")

  // A payload without a steps array is the same degradation as an empty one.
  const missingStepsContainer = freshContainer()
  const missingCleanup = renderReplayTokenCurve(missingStepsContainer, {
    distributionPercentiles: { p50: 1, p90: 2, p99: 3 },
  })
  assert.equal(missingCleanup, null, "a missing steps key renders nothing and returns null")
  assert.equal(missingStepsContainer.innerHTML, "")
})

test("replay-token-curve renders a single point without NaN and keeps a finite endpoint", async () => {
  const { renderReplayTokenCurve } = await import("../src/web/public/components/replay-token-curve.js")
  const { formatTokens } = await import("../src/web/public/format.js")
  const container = freshContainer()

  const cleanup = renderReplayTokenCurve(container, {
    steps: [replayStepFixture()],
  })

  assert.equal(typeof cleanup, "function", "a one-point series still returns a cleanup")
  const renderedHtml = container.innerHTML
  assert.ok(!renderedHtml.includes("NaN"), "a single point never renders NaN")
  assert.ok(!renderedHtml.includes("Infinity"), "a single point never renders Infinity")
  assert.ok(renderedHtml.includes('class="replay-curve-line"'), "the curve line renders")
  assert.ok(renderedHtml.includes('class="replay-curve-area"'), "the area path renders")
  // Endpoint label = cumulative output + reasoning = 200 + 50 = 250.
  assert.ok(
    renderedHtml.includes(`>${formatTokens(250)}<`),
    "the endpoint label is the single-point cumulative (output + reasoning)",
  )
  assert.ok(
    !renderedHtml.includes("replay-quantile"),
    "no distribution array → the quantile badge line is not rendered",
  )
  cleanup()
})

test("replay-token-curve handles a flat all-zero-increment series without dividing by zero", async () => {
  const { renderReplayTokenCurve } = await import("../src/web/public/components/replay-token-curve.js")
  const container = freshContainer()

  const cleanup = renderReplayTokenCurve(container, {
    // output + reasoning are 0 on every step, so the cumulative curve is flat
    // at the baseline and maxValue is 0 — the y-scale must still be finite.
    steps: [
      replayStepFixture({ index: 0, tokensOutput: 0, tokensReasoning: 0, tokensInput: 500 }),
      replayStepFixture({ index: 1, tokensOutput: 0, tokensReasoning: 0, tokensInput: 600 }),
      replayStepFixture({ index: 2, tokensOutput: 0, tokensReasoning: 0, tokensInput: 400 }),
    ],
    distributionPercentiles: { p50: 100, p90: 200, p99: 300 },
  })

  const renderedHtml = container.innerHTML
  assert.ok(!renderedHtml.includes("NaN"), "the zero-max y-scale must not produce NaN")
  assert.ok(!renderedHtml.includes("Infinity"), "the zero-max y-scale must stay finite")
  assert.ok(renderedHtml.includes('class="replay-curve-line"'), "the flat line still renders")
  // Session total = input + output + cache.read = 500 + 600 + 400 = 1500 > p99.
  assert.ok(renderedHtml.includes("超过 p99"), "the quantile tier uses input + output + cache.read")
  cleanup()
})

test("replay-token-curve clamps negative, NaN, Infinity and non-numeric tokens to zero (no NaN/Infinity reach the SVG)", async () => {
  const { renderReplayTokenCurve } = await import("../src/web/public/components/replay-token-curve.js")
  const { formatTokens } = await import("../src/web/public/format.js")
  const container = freshContainer()

  const cleanup = renderReplayTokenCurve(container, {
    steps: [
      // Every field is dirty: clamped to 0, contributing nothing.
      replayStepFixture({
        index: Number.NaN,
        tokensOutput: -100,
        tokensReasoning: Number.NaN,
        tokensInput: "abc",
        tokensCacheRead: null,
        tokensCacheWrite: -5,
      }),
      // Numeric strings are honoured; Infinity clamps out.
      replayStepFixture({
        index: Number.NaN,
        tokensOutput: "300",
        tokensReasoning: 0,
        tokensInput: 100,
        tokensCacheRead: 50,
        tokensCacheWrite: Number.POSITIVE_INFINITY,
      }),
    ],
  })

  const renderedHtml = container.innerHTML
  assert.ok(!renderedHtml.includes("NaN"), "dirty values never render NaN")
  assert.ok(!renderedHtml.includes("Infinity"), "Infinity clamps out of the curve")
  // Only the second step contributes: cumulative endpoint = 300.
  assert.ok(
    renderedHtml.includes(`>${formatTokens(300)}<`),
    "only the positive numeric step contributes to the cumulative endpoint",
  )
  // NaN indexes fall back to the array position for the x-axis labels.
  assert.ok(/>0<\/text>/.test(renderedHtml), "the first NaN index falls back to position 0")
  assert.ok(/>1<\/text>/.test(renderedHtml), "the second NaN index falls back to position 1")
  cleanup()
})

test("replay-token-curve: Delta mode draws one dot per step and a constant increment is a flat dot row", async () => {
  const { renderReplayTokenCurve } = await import("../src/web/public/components/replay-token-curve.js")
  const container = new ReplayCurveContainer("div")

  const cleanup = renderReplayTokenCurve(container, {
    steps: [
      replayStepFixture({ index: 0, tokensOutput: 100, tokensReasoning: 0 }),
      replayStepFixture({ index: 1, tokensOutput: 100, tokensReasoning: 0 }),
      replayStepFixture({ index: 2, tokensOutput: 100, tokensReasoning: 0 }),
    ],
  })

  // Default Total mode: a monotone cumulative line, no per-step dots.
  assert.equal(
    container.querySelectorAll(".replay-curve-delta-dot").length,
    0,
    "Total mode draws no delta dots",
  )

  const deltaButton = container
    .querySelectorAll("button[data-curve-mode]")
    .find((buttonElement) => buttonElement.dataset.curveMode === "delta")!
  deltaButton.click()

  const deltaDots = container.querySelectorAll(".replay-curve-delta-dot")
  assert.equal(deltaDots.length, 3, "Delta mode draws one dot per step")
  const dotYPositions = deltaDots.map((dotElement) => dotElement.attributes.get("cy"))
  assert.equal(new Set(dotYPositions).size, 1, "a constant increment yields a flat row of dots")
  assert.ok(!container.innerHTML.includes("NaN"), "Delta mode does not render NaN")

  // Leave the module-level mode back on Total for any test that follows.
  const totalButton = container
    .querySelectorAll("button[data-curve-mode]")
    .find((buttonElement) => buttonElement.dataset.curveMode === "total")!
  totalButton.click()
  cleanup()
})

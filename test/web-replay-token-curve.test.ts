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

import { installDomShim, freshContainer } from "./helpers/web-dom-shim.ts"

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

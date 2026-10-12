/**
 * Tests for collectStatusPanelData — the one-scan data acquisition behind
 * the /insight-status dialog (kept from the retired panel route with its
 * behavior contract intact): today totals + hit-rate 口径, today's model
 * TOP5 and the 7-day trend from a single bounded scan of the fake
 * database.
 *
 * CLOCK RULE (fix-24): every timestamp in this file is derived from the
 * live Date.now() — never a hardcoded absolute date. bucketDailyTrend ends
 * its window at real Date.now(), so the retired test/status-panel.test.ts
 * pinned "today" to the calendar date 2026-10-05 and failed deterministically
 * once the machine's today moved seven days past it. Two dynamic anchors
 * keep the window contract locked: the edge (today, window's last point)
 * and an interior day (now minus three days, matching the
 * ses_three_days_ago fixture).
 */

import { test } from "node:test"
import assert from "node:assert/strict"

import { toLocalDateKey } from "../src/stats/daily-buckets.ts"
import { collectStatusPanelData } from "../src/tui/status-panel-data.ts"
import {
  createFakeInsightDatabase,
  type FakeInsightDatabaseScenario,
  type FakeMessageFixture,
} from "./helpers/fake-insight-db.ts"

/** Live "now": bucketDailyTrend windows end at real Date.now(). */
const currentNowMs = Date.now()

function buildAssistantMessageFixture(
  modelId: string,
  tokenCounts: { input: number; output: number; cacheRead: number },
  timeCreated: number,
): FakeMessageFixture {
  return {
    type: "assistant",
    timeCreated,
    data: {
      agent: "fixer",
      model: { id: modelId, providerID: "futureppo" },
      tokens: {
        input: tokenCounts.input,
        output: tokenCounts.output,
        reasoning: 0,
        cache: { read: tokenCounts.cacheRead, write: 0 },
      },
      content: [],
    },
  }
}

function buildDialogScenario(): FakeInsightDatabaseScenario {
  return {
    sessions: [],
    messagesBySessionId: {
      ses_today: [
        buildAssistantMessageFixture("glm-5.3", { input: 700, output: 200, cacheRead: 100 }, currentNowMs),
        buildAssistantMessageFixture("glm-5.3", { input: 100, output: 100, cacheRead: 0 }, currentNowMs),
        buildAssistantMessageFixture("claude-opus-5", { input: 100, output: 100, cacheRead: 0 }, currentNowMs),
        // Yesterday's steps must not count towards today.
        buildAssistantMessageFixture(
          "glm-5.3",
          { input: 999_999, output: 0, cacheRead: 0 },
          currentNowMs - 24 * 60 * 60 * 1000,
        ),
      ],
      ses_three_days_ago: [
        buildAssistantMessageFixture(
          "glm-5.3",
          { input: 400, output: 0, cacheRead: 0 },
          currentNowMs - 3 * 24 * 60 * 60 * 1000,
        ),
      ],
    },
    systemPromptBySessionId: {},
  }
}

test("collectStatusPanelData aggregates today totals, model top5 and a 7-day series", () => {
  const fakeDatabase = createFakeInsightDatabase(buildDialogScenario())
  const dialogData = collectStatusPanelData(fakeDatabase, currentNowMs)

  assert.notEqual(dialogData, null)
  // today: (700+200+100) + (100+100) + (100+100) = 1400; yesterday excluded.
  // hit rate (usage-meter 口径): cacheRead / (cacheRead + input) = 100/1000
  assert.equal(dialogData!.todayTokens, 1400)
  assert.equal(dialogData!.todayHitRate, 0.1)
  assert.deepEqual(dialogData!.todayModelTopFive, [
    { modelId: "glm-5.3", tokens: 1200 },
    { modelId: "claude-opus-5", tokens: 200 },
  ])
  assert.equal(dialogData!.weekTrend.length, 7)
  // Window edge: the window ends at real "now", so the live today point
  // must carry the usage of the (live) today fixtures above.
  const todayTrendPoint = dialogData!.weekTrend.find(
    (trendPoint) => trendPoint.date === toLocalDateKey(currentNowMs),
  )
  assert.ok(todayTrendPoint !== undefined, "today is inside the 7-day window")
  assert.equal(
    todayTrendPoint!.input + todayTrendPoint!.output + todayTrendPoint!.read,
    1400,
    "the today point carries today's usage",
  )
  // Window interior (fix-24 dynamic anchor): the now-minus-three-days
  // fixture must land in its own local-date bucket with its 400 tokens.
  // Looked up by the message's own date key, so a DST transition shifting
  // the bucket by one calendar day cannot break this.
  const threeDaysAgoMs = currentNowMs - 3 * 24 * 60 * 60 * 1000
  const interiorTrendPoint = dialogData!.weekTrend.find(
    (trendPoint) => trendPoint.date === toLocalDateKey(threeDaysAgoMs),
  )
  assert.ok(interiorTrendPoint !== undefined, "the now−3d anchor is inside the 7-day window")
  assert.equal(
    interiorTrendPoint!.input + interiorTrendPoint!.output + interiorTrendPoint!.read,
    400,
    "the interior anchor point carries only the ses_three_days_ago usage",
  )
  assert.equal(interiorTrendPoint!.steps, 1)
})

test("collectStatusPanelData returns null without a database and ignores user messages", () => {
  assert.equal(collectStatusPanelData(null, currentNowMs), null)

  const fakeDatabase = createFakeInsightDatabase({
    sessions: [],
    messagesBySessionId: {
      ses_only_user: [{ type: "user", data: { text: "你好" }, timeCreated: currentNowMs }],
    },
    systemPromptBySessionId: {},
  })
  const emptyDialogData = collectStatusPanelData(fakeDatabase, currentNowMs)!
  assert.equal(emptyDialogData.todayTokens, 0)
  assert.deepEqual(emptyDialogData.todayModelTopFive, [])
  assert.equal(emptyDialogData.weekTrend[6].steps, 0)
})

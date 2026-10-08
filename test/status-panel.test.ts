/**
 * Tests for the /insight-status panel (T6.2/T6.3): the pure line builders
 * (buildStatusPanelLines and friends), the one-scan data collector against
 * the fake database, and the refresh controller — including interval
 * lifecycle via mock timers and every degradation path (missing db,
 * throwing provider, connection cleanup).
 */

import { test } from "node:test"
import assert from "node:assert/strict"

import type { SqliteReadConnection } from "../src/db/types.ts"
import type { DailyTrendPoint } from "../src/stats/daily-buckets.ts"
import {
  buildStatusPanelLines,
  formatCompactTokenCount,
  formatHitRatePercent,
  renderStatusPanelText,
  STATUS_PANEL_MAX_LINE_LENGTH,
  UNAVAILABLE_STATUS_PANEL_TEXT,
} from "../src/tui/status-panel-text.ts"
import { collectStatusPanelData } from "../src/tui/status-panel-data.ts"
import { createStatusPanelController } from "../src/tui/status-panel-controller.ts"
import {
  createFakeInsightDatabase,
  type FakeInsightDatabaseScenario,
  type FakeMessageFixture,
} from "./helpers/fake-insight-db.ts"

// ---------------------------------------------------------------------------
// Formatting helpers.

test("formatCompactTokenCount covers the K/M/G ladder and degenerate inputs", () => {
  assert.equal(formatCompactTokenCount(0), "0")
  assert.equal(formatCompactTokenCount(-5), "0")
  assert.equal(formatCompactTokenCount(Number.NaN), "0")
  assert.equal(formatCompactTokenCount(812), "812")
  assert.equal(formatCompactTokenCount(1234), "1.2K")
  assert.equal(formatCompactTokenCount(949_999), "950K")
  assert.equal(formatCompactTokenCount(1_234_567), "1.2M")
  assert.equal(formatCompactTokenCount(12_345_678_901), "12.3G")
})

test("formatHitRatePercent clamps into [0,100] with one decimal", () => {
  assert.equal(formatHitRatePercent(0), "0%")
  assert.equal(formatHitRatePercent(0.875), "87.5%")
  assert.equal(formatHitRatePercent(1), "100.0%")
  assert.equal(formatHitRatePercent(2), "100%")
  assert.equal(formatHitRatePercent(-0.5), "0%")
  assert.equal(formatHitRatePercent(Number.NaN), "0%")
})

// ---------------------------------------------------------------------------
// buildStatusPanelLines.

function buildTrendPointFixture(dateKey: string, tokens: number): DailyTrendPoint {
  // byModel: {} — the panel ignores the per-model buckets (v0.11.0);
  // the field is required on the wire type but irrelevant to this fixture.
  return { date: dateKey, steps: 1, input: tokens, read: 0, output: 0, hitRate: 0, byModel: {} }
}

test("buildStatusPanelLines renders summary, model top5 and the trend", () => {
  const panelLines = buildStatusPanelLines(
    {
      todayTokens: 1_234_567,
      todayHitRate: 0.875,
      topModels: [
        { modelId: "glm-5.3", tokens: 900_000 },
        { modelId: "claude-opus-5", tokens: 300_000 },
      ],
    },
    [
      buildTrendPointFixture("2026-09-30", 100),
      buildTrendPointFixture("2026-10-01", 400),
      buildTrendPointFixture("2026-10-02", 200),
      buildTrendPointFixture("2026-10-03", 0),
      buildTrendPointFixture("2026-10-04", 100),
      buildTrendPointFixture("2026-10-05", 100),
      buildTrendPointFixture("2026-10-06", 300),
    ],
  )

  assert.ok(panelLines[0].includes("今日"))
  assert.ok(panelLines[0].includes("1.2M"))
  assert.ok(panelLines[0].includes("87.5%"))

  const modelHeaderIndex = panelLines.indexOf("🏆 模型 TOP5（今日）")
  assert.ok(modelHeaderIndex > 0, "model section header must exist")
  assert.ok(panelLines[modelHeaderIndex + 1].includes("glm-5.3"))
  assert.ok(panelLines[modelHeaderIndex + 1].includes("████████"), "top model gets the full bar")
  assert.ok(panelLines[modelHeaderIndex + 2].includes("claude-opus-5"))
  assert.ok(!panelLines[modelHeaderIndex + 2].includes("████████"), "second model gets a shorter bar")

  const trendHeaderIndex = panelLines.indexOf("📈 近 7 日")
  assert.ok(trendHeaderIndex > 0)
  const trendLines = panelLines.slice(trendHeaderIndex + 1)
  assert.equal(trendLines.length, 7)
  assert.ok(trendLines[1].includes("████████████"), "max trend day gets the full bar")

  for (const panelLine of panelLines) {
    assert.ok(
      panelLine.length <= STATUS_PANEL_MAX_LINE_LENGTH,
      `line exceeds ${STATUS_PANEL_MAX_LINE_LENGTH}: ${panelLine}`,
    )
  }
})

test("buildStatusPanelLines caps the leaderboard at five models", () => {
  const panelLines = buildStatusPanelLines(
    {
      todayTokens: 1000,
      todayHitRate: 0,
      topModels: Array.from({ length: 9 }, (_unused, modelIndex) => ({
        modelId: `model-${modelIndex}`,
        tokens: 100,
      })),
    },
    [],
  )

  const modelLines = panelLines.filter((panelLine) => /^\s+\d\./.test(panelLine))
  assert.equal(modelLines.length, 5, "exactly five leaderboard rows")
  assert.equal(modelLines[4], "  5. model-4 ████████ 100")
})

test("buildStatusPanelLines degrades zero usage and empty trend to placeholders", () => {
  const panelLines = buildStatusPanelLines({ todayTokens: 0, todayHitRate: 0, topModels: [] }, [])

  assert.deepEqual(panelLines, ["📊 今日暂无用量"])

  const zeroTrendPanelLines = buildStatusPanelLines(
    { todayTokens: 0, todayHitRate: 0, topModels: [] },
    Array.from({ length: 7 }, (_unused, dayIndex) =>
      buildTrendPointFixture(`2026-10-0${dayIndex}`, 0),
    ),
  )
  assert.equal(zeroTrendPanelLines.length, 3)
  assert.ok(zeroTrendPanelLines.includes("  （近 7 日无用量）"))
})

test("buildStatusPanelLines truncates long model names and keeps lines within the cap", () => {
  const longModelId = "futureppo/glm-5.3-with-a-very-long-variant-suffix-attached"
  const panelLines = buildStatusPanelLines(
    {
      todayTokens: 500,
      todayHitRate: 0.5,
      topModels: [{ modelId: longModelId, tokens: 500 }],
    },
    [],
  )

  const modelLine = panelLines.find((panelLine) => panelLine.includes("futureppo")) ?? ""
  assert.ok(modelLine.length > 0, "the truncated model name must still appear")
  assert.ok(modelLine.length <= STATUS_PANEL_MAX_LINE_LENGTH)
  assert.ok(modelLine.includes("futureppo/glm-"), "prefix is kept")
  assert.ok(!modelLine.includes("attached"), "suffix is cut")
})

test("renderStatusPanelText renders the unavailable line for null data", () => {
  assert.equal(renderStatusPanelText(null), UNAVAILABLE_STATUS_PANEL_TEXT)
  const renderedPanelText = renderStatusPanelText({
    todayTokens: 10,
    todayHitRate: 0,
    todayModelTopFive: [],
    weekTrend: [],
  })
  assert.ok(renderedPanelText.includes("今日"))
})

// ---------------------------------------------------------------------------
// collectStatusPanelData (fake database).

/** Local-noon "now": the same local date in every timezone. */
const pinnedNowMs = new Date(2026, 9, 5, 12, 0).getTime()

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

function buildPanelScenario(): FakeInsightDatabaseScenario {
  return {
    sessions: [],
    messagesBySessionId: {
      ses_today: [
        buildAssistantMessageFixture("glm-5.3", { input: 700, output: 200, cacheRead: 100 }, pinnedNowMs),
        buildAssistantMessageFixture("glm-5.3", { input: 100, output: 100, cacheRead: 0 }, pinnedNowMs),
        buildAssistantMessageFixture("claude-opus-5", { input: 100, output: 100, cacheRead: 0 }, pinnedNowMs),
        // Yesterday's steps must not count towards today.
        buildAssistantMessageFixture(
          "glm-5.3",
          { input: 999_999, output: 0, cacheRead: 0 },
          pinnedNowMs - 24 * 60 * 60 * 1000,
        ),
      ],
      ses_three_days_ago: [
        buildAssistantMessageFixture(
          "glm-5.3",
          { input: 400, output: 0, cacheRead: 0 },
          pinnedNowMs - 3 * 24 * 60 * 60 * 1000,
        ),
      ],
    },
    systemPromptBySessionId: {},
  }
}

test("collectStatusPanelData aggregates today totals, model top5 and a 7-day series", () => {
  const fakeDatabase = createFakeInsightDatabase(buildPanelScenario())
  const panelData = collectStatusPanelData(fakeDatabase, pinnedNowMs)

  assert.notEqual(panelData, null)
  // today: (700+200+100) + (100+100) + (100+100) = 1400; yesterday excluded.
  // hit rate (usage-meter 口径): cacheRead / (cacheRead + input) = 100/1000
  assert.equal(panelData!.todayTokens, 1400)
  assert.equal(panelData!.todayHitRate, 0.1)
  assert.deepEqual(panelData!.todayModelTopFive, [
    { modelId: "glm-5.3", tokens: 1200 },
    { modelId: "claude-opus-5", tokens: 200 },
  ])
  assert.equal(panelData!.weekTrend.length, 7)
  // bucketDailyTrend ends its window at real Date.now(), so the last point
  // is the machine's today; our pinned "today" (2026-10-05) must be inside
  // the window and carry the pinned usage.
  const pinnedTodayTrendPoint = panelData!.weekTrend.find(
    (trendPoint) => trendPoint.date === "2026-10-05",
  )
  assert.ok(pinnedTodayTrendPoint !== undefined, "pinned today is inside the 7-day window")
  assert.equal(
    pinnedTodayTrendPoint!.input +
      pinnedTodayTrendPoint!.output +
      pinnedTodayTrendPoint!.read,
    1400,
    "the pinned today point carries the pinned usage",
  )
})

test("collectStatusPanelData returns null without a database and ignores user messages", () => {
  assert.equal(collectStatusPanelData(null, pinnedNowMs), null)

  const fakeDatabase = createFakeInsightDatabase({
    sessions: [],
    messagesBySessionId: {
      ses_only_user: [{ type: "user", data: { text: "你好" }, timeCreated: pinnedNowMs }],
    },
    systemPromptBySessionId: {},
  })
  const emptyPanelData = collectStatusPanelData(fakeDatabase, pinnedNowMs)!
  assert.equal(emptyPanelData.todayTokens, 0)
  assert.deepEqual(emptyPanelData.todayModelTopFive, [])
  assert.equal(emptyPanelData.weekTrend[6].steps, 0)
})

// ---------------------------------------------------------------------------
// Controller: refresh lifecycle and degradation.

/** Wrap the fake connection so tests can observe close() calls. */
function buildConnectionClosingSpy(connection: SqliteReadConnection) {
  const closeCallCount = { value: 0 }
  const spiedConnection: SqliteReadConnection = {
    prepare: (sql: string) => connection.prepare(sql),
    close: () => {
      closeCallCount.value += 1
    },
  }
  return { spiedConnection, closeCallCount }
}

test("controller computes nothing until beginAutoRefresh starts the loop", () => {
  const fakeDatabase = createFakeInsightDatabase(buildPanelScenario())
  const providerCallCount = { value: 0 }
  const controller = createStatusPanelController({
    databaseProvider: () => {
      providerCallCount.value += 1
      return fakeDatabase
    },
    nowMs: () => pinnedNowMs,
    refreshIntervalMs: 60_000,
  })
  try {
    // Lazy start (P2-13): creating the controller must not scan yet.
    assert.equal(providerCallCount.value, 0)
    assert.equal(controller.currentPanelText(), "")
  } finally {
    controller.dispose()
  }
})

test("controller computes the first text on beginAutoRefresh and notifies its subscriber", () => {
  const fakeDatabase = createFakeInsightDatabase(buildPanelScenario())
  const notifiedTexts: string[] = []
  const controller = createStatusPanelController({
    databaseProvider: () => fakeDatabase,
    nowMs: () => pinnedNowMs,
    refreshIntervalMs: 0,
    onPanelTextChanged: (refreshedText) => {
      notifiedTexts.push(refreshedText)
    },
  })
  try {
    controller.beginAutoRefresh()
    assert.ok(controller.currentPanelText().includes("今日"))
    assert.ok(controller.currentPanelText().includes("1.4K"))
    assert.equal(notifiedTexts.length, 1)

    // Idempotent: a second beginAutoRefresh (panel re-opened) is a no-op.
    controller.beginAutoRefresh()
    assert.equal(notifiedTexts.length, 1)
  } finally {
    controller.dispose()
  }
})

test("controller closes the connection after every refresh", () => {
  const fakeDatabase = createFakeInsightDatabase(buildPanelScenario())
  const { spiedConnection, closeCallCount } = buildConnectionClosingSpy(fakeDatabase)
  const controller = createStatusPanelController({
    databaseProvider: () => spiedConnection,
    nowMs: () => pinnedNowMs,
    refreshIntervalMs: 0,
  })
  try {
    controller.beginAutoRefresh()
    assert.equal(closeCallCount.value, 1)
    controller.refresh()
    assert.equal(closeCallCount.value, 2)
  } finally {
    controller.dispose()
  }
})

test("controller degrades missing databases and throwing providers to the unavailable line", () => {
  const unavailableController = createStatusPanelController({
    databaseProvider: () => null,
    refreshIntervalMs: 0,
  })
  try {
    unavailableController.beginAutoRefresh()
    assert.equal(unavailableController.currentPanelText(), UNAVAILABLE_STATUS_PANEL_TEXT)
  } finally {
    unavailableController.dispose()
  }

  const explodingController = createStatusPanelController({
    databaseProvider: () => {
      throw new Error("provider blew up")
    },
    refreshIntervalMs: 0,
  })
  try {
    explodingController.beginAutoRefresh()
    assert.equal(explodingController.currentPanelText(), UNAVAILABLE_STATUS_PANEL_TEXT)
    explodingController.refresh() // must not throw
    assert.equal(explodingController.currentPanelText(), UNAVAILABLE_STATUS_PANEL_TEXT)
  } finally {
    explodingController.dispose()
  }
})

test("controller refreshes on the interval after beginAutoRefresh and stops after dispose", (testContext) => {
  // Node's mock timers support setInterval; clearInterval is covered by it.
  testContext.mock.timers.enable({ apis: ["setInterval"] })

  const providerCallCount = { value: 0 }
  const controller = createStatusPanelController({
    databaseProvider: () => {
      providerCallCount.value += 1
      return null
    },
    refreshIntervalMs: 60_000,
  })
  try {
    // Before the panel opens nothing is scheduled (P2-13).
    testContext.mock.timers.tick(120_000)
    assert.equal(providerCallCount.value, 0, "no refresh before beginAutoRefresh")

    controller.beginAutoRefresh()
    assert.equal(providerCallCount.value, 1, "first refresh on beginAutoRefresh")
    testContext.mock.timers.tick(60_000)
    assert.equal(providerCallCount.value, 2, "interval refresh")
    testContext.mock.timers.tick(120_000)
    assert.equal(providerCallCount.value, 4, "two more interval refreshes")
  } finally {
    controller.dispose()
  }

  testContext.mock.timers.tick(600_000)
  assert.equal(providerCallCount.value, 4, "no refresh after dispose")
})

test("controller with a zero interval only ever runs the beginAutoRefresh refresh", (testContext) => {
  testContext.mock.timers.enable({ apis: ["setInterval"] })

  const providerCallCount = { value: 0 }
  const controller = createStatusPanelController({
    databaseProvider: () => {
      providerCallCount.value += 1
      return null
    },
    refreshIntervalMs: 0,
  })
  controller.beginAutoRefresh()
  controller.dispose()
  testContext.mock.timers.tick(600_000)
  assert.equal(providerCallCount.value, 1, "only the beginAutoRefresh refresh ever ran")
})

test("controller never starts a stray interval after dispose", (testContext) => {
  testContext.mock.timers.enable({ apis: ["setInterval"] })

  const providerCallCount = { value: 0 }
  const controller = createStatusPanelController({
    databaseProvider: () => {
      providerCallCount.value += 1
      return null
    },
    refreshIntervalMs: 60_000,
  })
  controller.dispose()
  controller.beginAutoRefresh() // disposed controllers ignore late panel-open callbacks
  testContext.mock.timers.tick(600_000)
  assert.equal(providerCallCount.value, 0, "a disposed controller must never refresh or schedule")
})

/**
 * Unit tests for the shared assistant-step scan queryAssistantStepRows
 * (src/db/queries.ts): null-database convention, full-scan parsing, the
 * optional SQL-side time floor, and type filtering — all against the fake
 * connection, no live database needed.
 */

import { test } from "node:test"
import assert from "node:assert/strict"

import { queryAssistantStepRows } from "../src/db/queries.ts"
import {
  createFakeInsightDatabase,
  type FakeInsightDatabaseScenario,
} from "./helpers/fake-insight-db.ts"

/** Local-noon "now": the same local date in every timezone. */
const pinnedNowMs = new Date(2026, 9, 5, 12, 0).getTime()

function buildAssistantFixture(timeCreated: number, modelId = "glm-5.3") {
  return {
    type: "assistant",
    timeCreated,
    data: {
      agent: "fixer",
      model: { id: modelId, providerID: "futureppo" },
      tokens: {
        input: 100,
        output: 40,
        reasoning: 0,
        cache: { read: 60, write: 0 },
      },
      content: [],
    },
  }
}

function buildScanScenario(): FakeInsightDatabaseScenario {
  return {
    sessions: [],
    messagesBySessionId: {
      ses_today: [buildAssistantFixture(pinnedNowMs), { type: "user", data: { text: "你好" }, timeCreated: pinnedNowMs }],
      ses_three_days_ago: [buildAssistantFixture(pinnedNowMs - 3 * 24 * 60 * 60 * 1000, "claude-opus-5")],
      ses_nine_days_ago: [buildAssistantFixture(pinnedNowMs - 9 * 24 * 60 * 60 * 1000)],
    },
    systemPromptBySessionId: {},
  }
}

test("queryAssistantStepRows returns null without a database", () => {
  assert.equal(queryAssistantStepRows(null), null)
  assert.equal(queryAssistantStepRows(null, pinnedNowMs), null)
})

test("queryAssistantStepRows parses every assistant message and skips other types", () => {
  const fakeDatabase = createFakeInsightDatabase(buildScanScenario())
  const stepRows = queryAssistantStepRows(fakeDatabase)!

  assert.equal(stepRows.length, 3, "only assistant messages, the user message is excluded")
  assert.deepEqual(
    stepRows.map((stepRow) => stepRow.modelId),
    ["glm-5.3", "claude-opus-5", "glm-5.3"],
  )
  assert.equal(stepRows[0].tokens.cacheRead, 60)
  assert.equal(stepRows[0].agent, "fixer")
  assert.equal(stepRows[0].providerId, "futureppo")
})

test("queryAssistantStepRows applies the sinceMs floor on the SQL side", () => {
  const fakeDatabase = createFakeInsightDatabase(buildScanScenario())
  const weekRows = queryAssistantStepRows(fakeDatabase, pinnedNowMs - 7 * 24 * 60 * 60 * 1000)!

  assert.equal(weekRows.length, 2, "the nine-day-old step is pruned, today's stays")
  assert.ok(
    weekRows.every((stepRow) => stepRow.timeCreated >= pinnedNowMs - 7 * 24 * 60 * 60 * 1000),
  )

  // A non-finite floor degrades to the full scan instead of filtering.
  const unfilteredRows = queryAssistantStepRows(fakeDatabase, Number.NaN)!
  assert.equal(unfilteredRows.length, 3)
})

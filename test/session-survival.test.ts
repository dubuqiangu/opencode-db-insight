/**
 * Tests for session survival aggregation (DESIGN.md §5 会话存活).
 */

import { test } from "node:test"
import assert from "node:assert/strict"

import {
  computeSessionSurvival,
  type SessionLifetimeSample,
} from "../src/stats/session-survival.ts"

function makeSessionLifetimeSample(
  sessionId: string,
  durationMs: number,
  idleOutcome: string | null = null,
): SessionLifetimeSample {
  const timeCreated = 1_791_200_000_000
  return { sessionId, timeCreated, timeUpdated: timeCreated + durationMs, idleOutcome }
}

test("computeSessionSurvival returns zeroed stats for no sessions", () => {
  assert.deepEqual(computeSessionSurvival([]), {
    totalSessions: 0,
    medianDurationSeconds: 0,
    shortLivedShare: 0,
    idleOutcomeCounts: {},
  })
})

test("computeSessionSurvival reports the nearest-rank median duration in seconds", () => {
  const samples = [
    makeSessionLifetimeSample("ses_10s", 10_000),
    makeSessionLifetimeSample("ses_100s", 100_000),
    makeSessionLifetimeSample("ses_1000s", 1_000_000),
  ]
  const survivalStats = computeSessionSurvival(samples)
  assert.equal(survivalStats.totalSessions, 3)
  assert.equal(survivalStats.medianDurationSeconds, 100)
})

test("computeSessionSurvival computes the share of sessions shorter than five minutes", () => {
  const samples = [
    makeSessionLifetimeSample("ses_short_1", 60_000), // 1 min → short-lived
    makeSessionLifetimeSample("ses_short_2", 299_999), // just under 5 min → short-lived
    makeSessionLifetimeSample("ses_long", 300_000), // exactly 5 min → not short-lived
    makeSessionLifetimeSample("ses_very_long", 3_600_000),
  ]
  const survivalStats = computeSessionSurvival(samples)
  assert.equal(survivalStats.shortLivedShare, 0.5)
})

test("computeSessionSurvival counts idle outcomes and buckets a null outcome as none", () => {
  const samples = [
    makeSessionLifetimeSample("ses_a", 60_000, "archived"),
    makeSessionLifetimeSample("ses_b", 60_000, "archived"),
    makeSessionLifetimeSample("ses_c", 60_000, null),
  ]
  const survivalStats = computeSessionSurvival(samples)
  assert.deepEqual(survivalStats.idleOutcomeCounts, { archived: 2, none: 1 })
})

test("computeSessionSurvival never reports a negative duration for clock-skewed rows", () => {
  const skewedSample: SessionLifetimeSample = {
    sessionId: "ses_skewed",
    timeCreated: 1_791_200_000_000,
    timeUpdated: 1_791_200_000_000 - 5_000, // updated before created
    idleOutcome: null,
  }
  const survivalStats = computeSessionSurvival([skewedSample])
  assert.equal(survivalStats.medianDurationSeconds, 0)
  assert.equal(survivalStats.shortLivedShare, 1)
})

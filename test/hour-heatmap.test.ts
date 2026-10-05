/**
 * Tests for the hour-of-day × weekday step heatmap (DESIGN.md §5 时段习惯).
 */

import { test } from "node:test"
import assert from "node:assert/strict"

import {
  bucketStepsByHourAndWeekday,
  type StepTimestampSample,
} from "../src/stats/hour-heatmap.ts"

test("bucketStepsByHourAndWeekday returns a zero-filled 7x24 grid for no samples", () => {
  const cells = bucketStepsByHourAndWeekday([])
  assert.equal(cells.length, 7 * 24)
  for (const cell of cells) {
    assert.equal(cell.steps, 0)
  }
  // ordering: weekday-major, hour-minor
  assert.deepEqual(cells[0], { weekday: 0, hour: 0, steps: 0 })
  assert.deepEqual(cells[27], { weekday: 1, hour: 3, steps: 0 })
  assert.deepEqual(cells[7 * 24 - 1], { weekday: 6, hour: 23, steps: 0 })
})

test("bucketStepsByHourAndWeekday counts a step in the cell of its local weekday and hour", () => {
  // 2026-10-05 is a Monday (weekday 1); 14:30 local lands in hour 14.
  const samples: StepTimestampSample[] = [
    { timeCreated: new Date(2026, 9, 5, 14, 30).getTime() },
    { timeCreated: new Date(2026, 9, 5, 14, 59).getTime() },
    { timeCreated: new Date(2026, 9, 6, 3, 0).getTime() }, // Tuesday 03:00
  ]
  const cells = bucketStepsByHourAndWeekday(samples)
  const mondayAfternoonCell = cells.find((cell) => cell.weekday === 1 && cell.hour === 14)
  const tuesdayEarlyCell = cells.find((cell) => cell.weekday === 2 && cell.hour === 3)
  assert.notEqual(mondayAfternoonCell, undefined)
  assert.equal(mondayAfternoonCell!.steps, 2)
  assert.notEqual(tuesdayEarlyCell, undefined)
  assert.equal(tuesdayEarlyCell!.steps, 1)

  const totalSteps = cells.reduce((stepSum, cell) => stepSum + cell.steps, 0)
  assert.equal(totalSteps, 3)
})

test("bucketStepsByHourAndWeekday skips samples with invalid timestamps", () => {
  const samples: StepTimestampSample[] = [{ timeCreated: Number.NaN }]
  const cells = bucketStepsByHourAndWeekday(samples)
  assert.equal(cells.reduce((stepSum, cell) => stepSum + cell.steps, 0), 0)
})

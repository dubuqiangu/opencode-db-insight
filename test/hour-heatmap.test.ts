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

test("bucketStepsByHourAndWeekday zero-fills every one of the 168 cells with a unique weekday/hour address", () => {
  const cells = bucketStepsByHourAndWeekday([])
  assert.equal(cells.length, 168)

  const seenAddresses = new Set<string>()
  cells.forEach((cell, cellIndex) => {
    assert.equal(cell.steps, 0)
    assert.equal(cellIndex, cell.weekday * 24 + cell.hour, "the grid is weekday-major, hour-minor")
    seenAddresses.add(`${cell.weekday}:${cell.hour}`)
  })
  assert.equal(seenAddresses.size, 168, "every weekday/hour pair must appear exactly once")
})

test("bucketStepsByHourAndWeekday places Sunday (weekday 0) in the outer row", () => {
  // 2026-10-04 is the Sunday immediately before the Monday used above.
  const sundayMidnight = new Date(2026, 9, 4, 0, 0)
  assert.equal(sundayMidnight.getDay(), 0, "the fixture must actually be a Sunday")

  const cells = bucketStepsByHourAndWeekday([{ timeCreated: sundayMidnight.getTime() }])
  assert.equal(cells[0].steps, 1, "Sunday hour 0 is the very first cell")
  assert.equal(cells[23].steps, 0)
  assert.equal(
    cells.some((cell) => cell.weekday !== 0 && cell.steps > 0),
    false,
    "no step may land outside the Sunday row",
  )
})

test("bucketStepsByHourAndWeekday buckets an exact local midnight into hour 0 of its own day", () => {
  const mondayMidnight = new Date(2026, 9, 5, 0, 0, 0, 0)
  const sundayLastMillisecond = new Date(2026, 9, 4, 23, 59, 59, 999)

  const cells = bucketStepsByHourAndWeekday([
    { timeCreated: mondayMidnight.getTime() },
    { timeCreated: sundayLastMillisecond.getTime() },
  ])

  const mondayMidnightCell = cells.find((cell) => cell.weekday === 1 && cell.hour === 0)
  const sundayLastCell = cells.find((cell) => cell.weekday === 0 && cell.hour === 23)
  assert.equal(mondayMidnightCell!.steps, 1)
  assert.equal(sundayLastCell!.steps, 1)
  assert.equal(cells.reduce((stepSum, cell) => stepSum + cell.steps, 0), 2)
})

test("bucketStepsByHourAndWeekday buckets by local wall-clock hour across a DST offset change", () => {
  // In a DST-observing zone, noon local in winter and noon local in summer sit
  // at different UTC instants. Both must land in their own local hour-12 cell;
  // this would fail for any implementation that buckets by the UTC hour.
  const winterNoon = new Date(2026, 0, 15, 12, 0)
  const summerNoon = new Date(2026, 6, 15, 12, 0)

  const cells = bucketStepsByHourAndWeekday([
    { timeCreated: winterNoon.getTime() },
    { timeCreated: summerNoon.getTime() },
  ])

  const winterNoonCell = cells.find(
    (cell) => cell.weekday === winterNoon.getDay() && cell.hour === winterNoon.getHours(),
  )
  const summerNoonCell = cells.find(
    (cell) => cell.weekday === summerNoon.getDay() && cell.hour === summerNoon.getHours(),
  )
  assert.equal(winterNoonCell!.steps, 1)
  assert.equal(summerNoonCell!.steps, 1)
  assert.equal(cells.reduce((stepSum, cell) => stepSum + cell.steps, 0), 2)
})

test("bucketStepsByHourAndWeekday accumulates multiple steps in a single cell", () => {
  const sameHourSamples: StepTimestampSample[] = Array.from({ length: 5 }, (_unused, minuteOffset) => ({
    timeCreated: new Date(2026, 9, 5, 14, minuteOffset).getTime(),
  }))

  const cells = bucketStepsByHourAndWeekday(sameHourSamples)
  const mondayAfternoonCell = cells.find((cell) => cell.weekday === 1 && cell.hour === 14)
  assert.equal(mondayAfternoonCell!.steps, 5)
})

test("bucketStepsByHourAndWeekday drops samples before the window start but keeps the boundary", () => {
  const windowStartEpochMs = new Date(2026, 9, 5, 0, 0, 0, 0).getTime()
  const samples: StepTimestampSample[] = [
    { timeCreated: windowStartEpochMs - 1 },
    { timeCreated: windowStartEpochMs },
    { timeCreated: windowStartEpochMs + 60_000 },
  ]

  const cells = bucketStepsByHourAndWeekday(samples, windowStartEpochMs)
  assert.equal(cells.reduce((stepSum, cell) => stepSum + cell.steps, 0), 2)
})

test("bucketStepsByHourAndWeekday with no window keeps every positive timestamp", () => {
  const cells = bucketStepsByHourAndWeekday([
    { timeCreated: 1 },
    { timeCreated: new Date(2020, 0, 1).getTime() },
  ])
  assert.equal(cells.reduce((stepSum, cell) => stepSum + cell.steps, 0), 2)
})

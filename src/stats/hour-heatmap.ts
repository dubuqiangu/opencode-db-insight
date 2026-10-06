/**
 * Hour-of-day × day-of-week step heatmap (DESIGN.md §5 时段习惯).
 * Pure functions, zero IO. Bucketing uses local time.
 */

/** One cell of the 7×24 heatmap grid. */
export interface HourWeekdayCell {
  /** 0 = Sunday ... 6 = Saturday, matching Date.getDay(). */
  weekday: number
  /** 0-23, local hour. */
  hour: number
  steps: number
}

/** Minimal sample: anything with a creation timestamp counts as one step. */
export interface StepTimestampSample {
  timeCreated: number
}

/**
 * Bucket steps into a full 7×24 grid (168 cells, zero-filled), ordered by
 * weekday then hour. Invalid timestamps (NaN) and non-positive timestamps
 * (coerceNumber degrades malformed rows to 0 → epoch 0) are skipped;
 * out-of-range hour/weekday can never occur because values come from
 * Date directly.
 *
 * windowStartEpochMs (optional): lower bound of the statistics window,
 * the local midnight of its oldest day — the same bound bucketDailyTrend
 * enforces via its date-key map. Rows at or above the SQL scan floor but
 * below this bound are the floor's +1-day DST slack and must NOT land in
 * cells, or the heatmap silently counts one more day than requested.
 */
export function bucketStepsByHourAndWeekday(
  samples: StepTimestampSample[],
  windowStartEpochMs: number = Number.NEGATIVE_INFINITY,
): HourWeekdayCell[] {
  const stepCounts = new Array<number>(7 * 24).fill(0)
  for (const sample of samples) {
    if (!Number.isFinite(sample.timeCreated) || sample.timeCreated <= 0) continue
    if (sample.timeCreated < windowStartEpochMs) continue
    const sampleDate = new Date(sample.timeCreated)
    if (Number.isNaN(sampleDate.getTime())) continue
    const cellIndex = sampleDate.getDay() * 24 + sampleDate.getHours()
    stepCounts[cellIndex] += 1
  }

  const cells: HourWeekdayCell[] = []
  for (let weekday = 0; weekday < 7; weekday += 1) {
    for (let hour = 0; hour < 24; hour += 1) {
      cells.push({ weekday, hour, steps: stepCounts[weekday * 24 + hour] })
    }
  }
  return cells
}

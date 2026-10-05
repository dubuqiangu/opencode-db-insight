/**
 * Session survival stats (DESIGN.md §5 会话存活): lifetime distribution and
 * idle outcome counts. Pure functions, zero IO.
 */

/** Session is considered "short-lived" below 5 minutes of wall time. */
export const SHORT_LIVED_SESSION_THRESHOLD_MS = 5 * 60_000

/** One session's lifetime sample (from session_v2). */
export interface SessionLifetimeSample {
  sessionId: string
  timeCreated: number
  timeUpdated: number
  idleOutcome: string | null
}

/** Survival aggregates for the dashboard. */
export interface SessionSurvivalStats {
  totalSessions: number
  /** Median of (timeUpdated - timeCreated) in seconds, nearest-rank. */
  medianDurationSeconds: number
  /** Share of sessions shorter than SHORT_LIVED_SESSION_THRESHOLD_MS. */
  shortLivedShare: number
  /** idle_outcome value → session count; null outcome is bucketed as "none". */
  idleOutcomeCounts: Record<string, number>
}

/**
 * Compute survival stats over session lifetime samples. Empty input yields
 * zeroed stats. Sessions with timeUpdated < timeCreated (clock skew or
 * ongoing writes) are treated as zero-duration, never negative.
 */
export function computeSessionSurvival(samples: SessionLifetimeSample[]): SessionSurvivalStats {
  if (samples.length === 0) {
    return { totalSessions: 0, medianDurationSeconds: 0, shortLivedShare: 0, idleOutcomeCounts: {} }
  }

  const durationSamples: number[] = []
  const idleOutcomeCounts: Record<string, number> = {}
  let shortLivedCount = 0

  for (const sample of samples) {
    const durationMs = Math.max(sample.timeUpdated - sample.timeCreated, 0)
    durationSamples.push(durationMs)
    if (durationMs < SHORT_LIVED_SESSION_THRESHOLD_MS) shortLivedCount += 1
    const outcomeKey = sample.idleOutcome === null || sample.idleOutcome === "" ? "none" : sample.idleOutcome
    idleOutcomeCounts[outcomeKey] = (idleOutcomeCounts[outcomeKey] ?? 0) + 1
  }

  durationSamples.sort((left: number, right: number) => left - right)
  const medianRank = Math.min(Math.max(Math.ceil(durationSamples.length / 2), 1), durationSamples.length)

  return {
    totalSessions: samples.length,
    medianDurationSeconds: Math.round(durationSamples[medianRank - 1] / 1000),
    shortLivedShare: shortLivedCount / samples.length,
    idleOutcomeCounts,
  }
}

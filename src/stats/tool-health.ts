/**
 * Per-tool success/error aggregation for GET /api/tool-health
 * (DESIGN.md §5 tool health). Pure functions, zero IO; style mirrors
 * model-metrics.ts.
 *
 * 口径: one sample is one tool call part of one assistant message
 * (type === "tool"), with the tool name resolved from the wire fields
 * (`$.name`, legacy fallback `$.tool`) and the status taken verbatim from
 * `$.state.status` by the query layer. Statuses other than the three
 * known wire values ("completed", "error", "running") — including the
 * query layer's "unknown" fallback for non-string status values —
 * count towards `total` but towards no bucket, exactly like the
 * compaction reason "unknown" bucket.
 */

/** One tool row of GET /api/tool-health. */
export interface ToolHealthStat {
  tool: string
  completed: number
  error: number
  running: number
  total: number
  /**
   * error / total, raw 0..1 fraction — never rounded, scaled or
   * formatted (the display side owns formatting). 0 when total is 0
   * (a row can never carry total 0 in practice since every sample
   * increments it; the guard keeps the function total).
   */
  errorRate: number
}

/**
 * One tool call part extracted from an assistant message, already
 * coerced: `tool` is the resolved non-empty name, `status` is the wire
 * status string or the query layer's "unknown" fallback.
 */
export interface ToolHealthSample {
  tool: string
  status: string
}

/** Mutable per-tool counters accumulated during the single grouping scan. */
interface ToolHealthCounters {
  completed: number
  error: number
  running: number
  total: number
}

function emptyToolHealthCounters(): ToolHealthCounters {
  return { completed: 0, error: 0, running: 0, total: 0 }
}

/**
 * Aggregate tool call samples into per-tool health rows, sorted by
 * total descending with the tool name ascending as the tie-break
 * (deterministic order regardless of sample insertion order).
 */
export function computeToolHealth(samples: ToolHealthSample[]): ToolHealthStat[] {
  const countersByTool = new Map<string, ToolHealthCounters>()
  for (const sample of samples) {
    const counters = countersByTool.get(sample.tool) ?? emptyToolHealthCounters()
    counters.total += 1
    if (sample.status === "completed") counters.completed += 1
    else if (sample.status === "error") counters.error += 1
    else if (sample.status === "running") counters.running += 1
    // Any other status value (unknown wire values, the "unknown"
    // non-string fallback) stays in total only — no bucket.
    countersByTool.set(sample.tool, counters)
  }

  const toolHealthStats: ToolHealthStat[] = []
  for (const [tool, counters] of countersByTool) {
    toolHealthStats.push({
      tool,
      completed: counters.completed,
      error: counters.error,
      running: counters.running,
      total: counters.total,
      errorRate: counters.total > 0 ? counters.error / counters.total : 0,
    })
  }

  toolHealthStats.sort(
    (left: ToolHealthStat, right: ToolHealthStat) =>
      right.total - left.total || (left.tool < right.tool ? -1 : 1),
  )
  return toolHealthStats
}

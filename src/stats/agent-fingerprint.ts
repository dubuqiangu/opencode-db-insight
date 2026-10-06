/**
 * Per-agent usage and tool-preference fingerprint (DESIGN.md §5 agent 指纹).
 * Pure functions, zero IO.
 */

import { totalUsageTokens } from "./hit-rate.ts"

/** One agent row of GET /api/agents. */
export interface AgentStat {
  agent: string
  sessions: number
  /** Σ total usage (input+output+cache.read) of the agent's assistant steps. */
  tokens: number
  /** Tool name → call count, most-used first. */
  toolFingerprint: Record<string, number>
}

/**
 * One (agent, session) membership from session_v2. Passed separately from
 * the step rows so agents that only ever had user messages (zero assistant
 * steps) still show up with their session count.
 */
export interface AgentSessionMembershipSample {
  agent: string
  sessionId: string
}

/**
 * Minimal per-step shape computeAgentStats needs. Deliberately structural:
 * the SQL-side lightweight rows satisfy it without carrying the full
 * AssistantStepRow, and full step rows keep satisfying it too — both the
 * old scan pipeline and the SQL-side aggregation (P0-1) share this one
 * aggregation function, which is what keeps their 口径 identical.
 */
export interface AgentStepUsageSample {
  agent: string
  sessionId: string
  tokens: { input: number; output: number; cacheRead: number }
  /** Name of every tool call part contained in this message. */
  toolNames: string[]
}

/**
 * Aggregate per-agent stats:
 * - sessions: distinct session ids attributed to the agent (from the
 *   membership samples, plus any session that appears in step rows but has
 *   no session_v2 row — defensive against partial writes);
 * - tokens: Σ total usage of the agent's assistant steps;
 * - toolFingerprint: tool name → call count across the agent's steps.
 * Result is sorted by tokens descending.
 */
export function computeAgentStats(
  sessionMemberships: AgentSessionMembershipSample[],
  stepRows: AgentStepUsageSample[],
): AgentStat[] {
  const sessionIdsByAgent = new Map<string, Set<string>>()
  const addSessionToAgent = (agent: string, sessionId: string): void => {
    const existingSet = sessionIdsByAgent.get(agent)
    if (existingSet === undefined) {
      sessionIdsByAgent.set(agent, new Set<string>([sessionId]))
    } else {
      existingSet.add(sessionId)
    }
  }

  const tokenSumByAgent = new Map<string, number>()
  const toolCountsByAgent = new Map<string, Map<string, number>>()

  for (const membership of sessionMemberships) {
    addSessionToAgent(membership.agent, membership.sessionId)
  }

  for (const stepRow of stepRows) {
    const { agent } = stepRow
    addSessionToAgent(agent, stepRow.sessionId)
    tokenSumByAgent.set(agent, (tokenSumByAgent.get(agent) ?? 0) + totalUsageTokens(stepRow.tokens))

    let toolCounts = toolCountsByAgent.get(agent)
    if (toolCounts === undefined) {
      toolCounts = new Map<string, number>()
      toolCountsByAgent.set(agent, toolCounts)
    }
    for (const toolName of stepRow.toolNames) {
      toolCounts.set(toolName, (toolCounts.get(toolName) ?? 0) + 1)
    }
  }

  const agentNames = new Set<string>([...sessionIdsByAgent.keys(), ...tokenSumByAgent.keys()])
  const agentStats: AgentStat[] = []
  for (const agent of agentNames) {
    const sessionSet = sessionIdsByAgent.get(agent)
    const toolCounts = toolCountsByAgent.get(agent)
    const sortedToolCounts =
      toolCounts === undefined
        ? []
        : [...toolCounts.entries()].sort((left, right) => right[1] - left[1])
    agentStats.push({
      agent,
      sessions: sessionSet === undefined ? 0 : sessionSet.size,
      tokens: tokenSumByAgent.get(agent) ?? 0,
      toolFingerprint: Object.fromEntries(sortedToolCounts),
    })
  }

  agentStats.sort((left: AgentStat, right: AgentStat) => right.tokens - left.tokens)
  return agentStats
}

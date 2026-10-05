/**
 * Tests for per-agent usage and tool-preference fingerprint (DESIGN.md §5 agent 指纹).
 */

import { test } from "node:test"
import assert from "node:assert/strict"

import {
  computeAgentStats,
  type AgentSessionMembershipSample,
} from "../src/stats/agent-fingerprint.ts"
import { makeAssistantStepRow, makeTokenUsage } from "./helpers/step-factories.ts"

test("computeAgentStats returns an empty array for no memberships and no steps", () => {
  assert.deepEqual(computeAgentStats([], []), [])
})

test("computeAgentStats counts distinct sessions for agents that never produced a step", () => {
  const memberships: AgentSessionMembershipSample[] = [
    { agent: "build", sessionId: "ses_build_1" },
    { agent: "build", sessionId: "ses_build_2" },
    { agent: "review", sessionId: "ses_review_1" },
  ]

  const agentStats = computeAgentStats(memberships, [])
  assert.equal(agentStats.length, 2)
  const buildStat = agentStats.find((stat) => stat.agent === "build")
  const reviewStat = agentStats.find((stat) => stat.agent === "review")
  assert.notEqual(buildStat, undefined)
  assert.notEqual(reviewStat, undefined)
  assert.equal(buildStat!.sessions, 2)
  assert.equal(buildStat!.tokens, 0)
  assert.deepEqual(buildStat!.toolFingerprint, {})
  assert.equal(reviewStat!.sessions, 1)
})

test("computeAgentStats counts a session only once even when it has many steps", () => {
  const memberships: AgentSessionMembershipSample[] = [
    { agent: "build", sessionId: "ses_build_1" },
  ]
  const stepRows = [
    makeAssistantStepRow({ agent: "build", sessionId: "ses_build_1" }),
    makeAssistantStepRow({ agent: "build", sessionId: "ses_build_1" }),
    makeAssistantStepRow({ agent: "build", sessionId: "ses_build_1" }),
  ]

  const agentStats = computeAgentStats(memberships, stepRows)
  assert.equal(agentStats[0].sessions, 1)
})

test("computeAgentStats sums token usage and tool calls per agent", () => {
  const memberships: AgentSessionMembershipSample[] = [
    { agent: "build", sessionId: "ses_build_1" },
    { agent: "review", sessionId: "ses_review_1" },
  ]
  const stepRows = [
    makeAssistantStepRow({
      agent: "build",
      sessionId: "ses_build_1",
      tokens: makeTokenUsage({ input: 100, output: 50, cacheRead: 50 }),
      toolNames: ["read", "edit"],
    }),
    makeAssistantStepRow({
      agent: "build",
      sessionId: "ses_build_1",
      tokens: makeTokenUsage({ input: 0, output: 50, cacheRead: 50 }),
      toolNames: ["read"],
    }),
    makeAssistantStepRow({
      agent: "review",
      sessionId: "ses_review_1",
      tokens: makeTokenUsage({ input: 10 }),
      toolNames: ["grep"],
    }),
  ]

  const agentStats = computeAgentStats(memberships, stepRows)
  const buildStat = agentStats.find((stat) => stat.agent === "build")
  const reviewStat = agentStats.find((stat) => stat.agent === "review")

  assert.equal(buildStat!.tokens, 300) // 200 + 100
  assert.deepEqual(buildStat!.toolFingerprint, { read: 2, edit: 1 })
  assert.equal(reviewStat!.tokens, 10)
  assert.deepEqual(reviewStat!.toolFingerprint, { grep: 1 })
})

test("computeAgentStats attributes steps of sessions missing from session_v2 defensively", () => {
  const stepRows = [
    makeAssistantStepRow({ agent: "build", sessionId: "ses_orphan_1" }),
  ]
  const agentStats = computeAgentStats([], stepRows)
  assert.equal(agentStats.length, 1)
  assert.equal(agentStats[0].agent, "build")
  assert.equal(agentStats[0].sessions, 1)
})

test("computeAgentStats sorts agents by total tokens descending", () => {
  const memberships: AgentSessionMembershipSample[] = [
    { agent: "quiet-agent", sessionId: "ses_quiet" },
    { agent: "busy-agent", sessionId: "ses_busy" },
  ]
  const stepRows = [
    makeAssistantStepRow({ agent: "busy-agent", sessionId: "ses_busy", tokens: makeTokenUsage({ input: 500 }) }),
  ]

  const agentStats = computeAgentStats(memberships, stepRows)
  assert.equal(agentStats[0].agent, "busy-agent")
  assert.equal(agentStats[1].agent, "quiet-agent")
})

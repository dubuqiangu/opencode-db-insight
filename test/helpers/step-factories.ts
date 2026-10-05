/**
 * Shared fixture factories for the stats/db tests.
 * Not named *.test.ts so the node:test runner does not pick it up as a test.
 */

import type { AssistantStepRow, TokenUsage } from "../../src/db/types.ts"

/** Token usage fixture; zeroed defaults, overridable per test case. */
export function makeTokenUsage(overrides: Partial<TokenUsage> = {}): TokenUsage {
  return { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, ...overrides }
}

/** Assistant step fixture; defaults describe a minimal step, overridable per test case. */
export function makeAssistantStepRow(overrides: Partial<AssistantStepRow> = {}): AssistantStepRow {
  return {
    messageId: "msg_sample",
    sessionId: "ses_sample",
    timeCreated: Date.now(),
    modelId: "model/sample",
    providerId: "provider-sample",
    agent: "build",
    tokens: makeTokenUsage(),
    toolNames: [],
    ...overrides,
  }
}

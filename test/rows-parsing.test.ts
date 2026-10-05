/**
 * Unit tests for the raw-row coercion and JSON parsing helpers (src/db/rows.ts).
 * These run without a database; the fixtures mirror the real wire shapes
 * probed from opencode.db (2026-10-05).
 */

import { test } from "node:test"
import assert from "node:assert/strict"

import {
  asRecord,
  coerceNumber,
  coerceText,
  parseAssistantStepRow,
  parseSessionModelColumn,
  readAgentName,
} from "../src/db/rows.ts"

test("coerceNumber keeps finite numbers and degrades everything else to zero", () => {
  assert.equal(coerceNumber(42), 42)
  assert.equal(coerceNumber("42"), 42)
  assert.equal(coerceNumber(null), 0)
  assert.equal(coerceNumber(undefined), 0)
  assert.equal(coerceNumber("not-a-number"), 0)
  assert.equal(coerceNumber(Number.POSITIVE_INFINITY), 0)
  assert.equal(coerceNumber(Number.NaN), 0)
})

test("coerceText keeps strings and maps null/undefined to the empty string", () => {
  assert.equal(coerceText("build"), "build")
  assert.equal(coerceText(null), "")
  assert.equal(coerceText(undefined), "")
})

test("readAgentName maps missing or empty agent columns to unknown", () => {
  assert.equal(readAgentName("fixer"), "fixer")
  assert.equal(readAgentName(null), "unknown")
  assert.equal(readAgentName(""), "unknown")
})

test("asRecord accepts plain objects and rejects arrays, null and primitives", () => {
  assert.notEqual(asRecord({ id: 1 }), null)
  assert.equal(asRecord([1, 2]), null)
  assert.equal(asRecord(null), null)
  assert.equal(asRecord("text"), null)
})

test("parseAssistantStepRow extracts model, tokens, agent and tool names from a full wire row", () => {
  const wireData = {
    time: { created: 1_791_200_000_000 },
    agent: "fixer",
    model: { id: "z-ai/glm-5.3", providerID: "futureppo", variant: "high" },
    tokens: { input: 272, output: 726, reasoning: 24, cache: { read: 91_532, write: 0 } },
    content: [
      { type: "text", text: "working on it" },
      { type: "reasoning", text: "thinking..." },
      { type: "tool", id: "call_1", name: "shell", state: { status: "completed" } },
      { type: "tool", id: "call_2", name: "read", state: { status: "completed" } },
    ],
  }
  const stepRow = parseAssistantStepRow({
    id: "msg_1",
    session_id: "ses_1",
    time_created: 1_791_200_000_000,
    data: JSON.stringify(wireData),
  })

  assert.notEqual(stepRow, null)
  assert.equal(stepRow!.messageId, "msg_1")
  assert.equal(stepRow!.sessionId, "ses_1")
  assert.equal(stepRow!.modelId, "z-ai/glm-5.3")
  assert.equal(stepRow!.providerId, "futureppo")
  assert.equal(stepRow!.agent, "fixer")
  assert.deepEqual(stepRow!.tokens, {
    input: 272,
    output: 726,
    reasoning: 24,
    cacheRead: 91_532,
    cacheWrite: 0,
  })
  assert.deepEqual(stepRow!.toolNames, ["shell", "read"])
})

test("parseAssistantStepRow yields zeroed tokens for messages without a tokens block", () => {
  const stepRow = parseAssistantStepRow({
    id: "msg_2",
    session_id: "ses_1",
    time_created: 1,
    data: JSON.stringify({ agent: "fixer", model: { id: "model/x" }, content: [] }),
  })
  assert.notEqual(stepRow, null)
  assert.deepEqual(stepRow!.tokens, { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 })
})

test("parseAssistantStepRow returns null for unparseable or non-object data JSON", () => {
  assert.equal(parseAssistantStepRow({ id: "msg_3", data: "{not json" }), null)
  assert.equal(parseAssistantStepRow({ id: "msg_4", data: JSON.stringify([1, 2]) }), null)
  assert.equal(parseAssistantStepRow({ id: "msg_5", data: null }), null)
})

test("parseAssistantStepRow falls back to the legacy tool key and the unknown model/agent names", () => {
  const stepRow = parseAssistantStepRow({
    id: "msg_6",
    session_id: "ses_1",
    time_created: 1,
    data: JSON.stringify({
      content: [{ type: "tool", tool: "legacy-tool-name" }],
    }),
  })
  assert.notEqual(stepRow, null)
  assert.equal(stepRow!.modelId, "unknown")
  assert.equal(stepRow!.agent, "unknown")
  assert.deepEqual(stepRow!.toolNames, ["legacy-tool-name"])
})

test("parseSessionModelColumn reads the wire providerID key and falls back to unknown", () => {
  const parsedModel = parseSessionModelColumn(JSON.stringify({ id: "space-bunny-free", providerID: "opencode" }))
  assert.deepEqual(parsedModel, { modelId: "space-bunny-free", providerId: "opencode" })

  assert.deepEqual(parseSessionModelColumn("{broken json"), {
    modelId: "unknown",
    providerId: "",
  })
  assert.deepEqual(parseSessionModelColumn(null), { modelId: "unknown", providerId: "" })
})

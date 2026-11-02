/**
 * Tests for defineInsightPlugin (src/plugin-definition.ts).
 *
 * The host validates the plugin entry's default export shape ({ id, setup })
 * directly, and the upstream Plugin.define() is an identity function, so this
 * helper must preserve object identity and the exact shape.
 */

import { test } from "node:test"
import assert from "node:assert/strict"

import {
  defineInsightPlugin,
  type InsightPluginDefinition,
} from "../src/plugin-definition.ts"

test("defineInsightPlugin returns the very same definition object", () => {
  const definition: InsightPluginDefinition = {
    id: "db-insight",
    setup: async () => async () => {},
  }
  assert.equal(defineInsightPlugin(definition), definition)
})

test("defineInsightPlugin preserves a synchronous setup function reference", () => {
  const setup = () => {}
  const returned = defineInsightPlugin({ id: "db-insight", setup })
  assert.equal(returned.setup, setup, "the setup reference must not be wrapped or cloned")
})

test("defineInsightPlugin keeps the id and setup callable on the returned shape", async () => {
  let teardownCallCount = 0
  const returned = defineInsightPlugin({
    id: "db-insight-tui",
    setup: () => () => {
      teardownCallCount += 1
    },
  })

  assert.equal(returned.id, "db-insight-tui")
  assert.equal(typeof returned.setup, "function")

  const cleanup = returned.setup({})
  assert.equal(typeof cleanup, "function")
  ;(cleanup as () => void)()
  assert.equal(teardownCallCount, 1)
})

test("defineInsightPlugin tolerates a setup that resolves to nothing", async () => {
  const returned = defineInsightPlugin({ id: "db-insight", setup: async () => {} })
  assert.equal(await returned.setup({}), undefined)
})

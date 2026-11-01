/**
 * Tests for GET /api/session-lineage (B6 Agent 血缘图): the pure
 * computeSessionLineage aggregation (src/stats/session-lineage.ts) runs
 * everywhere — cycle / self-parent / orphan normalisation, depth, the
 * deterministic subtree-size BFS budget and focus mode; the query layer's
 * one-row-per-session extraction is locked against a real node:sqlite
 * :memory: fixture and skips cleanly when node:sqlite is unavailable.
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import { createRequire } from "node:module"

import type { SqliteReadConnection } from "../src/db/types.ts"
import { querySessionLineage } from "../src/db/session-lineage-queries.ts"
import {
  computeSessionLineage,
  LINEAGE_NODE_BUDGET,
  MAX_LINEAGE_NODE_BUDGET,
  type SessionLineageSample,
} from "../src/stats/session-lineage.ts"
import { matchApiRoute } from "../src/web/router.ts"
import { handleApiRequest } from "../src/web/api.ts"
import { clearResultCache } from "../src/stats/cache.ts"

/** A sample with every field defaulted; override the ones a case cares about. */
function makeLineageSample(
  overrides: Partial<SessionLineageSample> = {},
): SessionLineageSample {
  return {
    sessionId: "ses_sample",
    parentSessionId: null,
    title: "",
    agent: "",
    tokens: 0,
    timeCreated: 0,
    childCount: 0,
    ...overrides,
  }
}

/** A four-session tree: root → {a → c, b}. */
const TREE_SAMPLES: SessionLineageSample[] = [
  makeLineageSample({ sessionId: "ses_root", childCount: 2, tokens: 10 }),
  makeLineageSample({ sessionId: "ses_a", parentSessionId: "ses_root", childCount: 1 }),
  makeLineageSample({ sessionId: "ses_b", parentSessionId: "ses_root" }),
  makeLineageSample({ sessionId: "ses_c", parentSessionId: "ses_a" }),
]

// ---------------------------------------------------------------------------
// computeSessionLineage — pure function, zero IO
// ---------------------------------------------------------------------------

test("computeSessionLineage returns zero stats and empty graph for empty input", () => {
  assert.deepEqual(computeSessionLineage([]), {
    focusSessionId: null,
    nodes: [],
    edges: [],
    stats: {
      totalSessions: 0,
      graphSessions: 0,
      rootCount: 0,
      childCount: 0,
      orphanParentCount: 0,
      selfParentCount: 0,
      cycleCount: 0,
      maxDepth: 0,
    },
    omittedNodeCount: 0,
  })
})

test("computeSessionLineage lays out a deterministic layered tree with BFS node order", () => {
  const graph = computeSessionLineage(TREE_SAMPLES)
  assert.equal(graph.focusSessionId, null)
  // Seed = the single root; siblings ordered by subtree size desc then id.
  assert.deepEqual(
    graph.nodes.map((node) => node.sessionId),
    ["ses_root", "ses_a", "ses_b", "ses_c"],
  )
  assert.deepEqual(graph.edges, [
    { parentSessionId: "ses_a", childSessionId: "ses_c" },
    { parentSessionId: "ses_root", childSessionId: "ses_a" },
    { parentSessionId: "ses_root", childSessionId: "ses_b" },
  ])
  assert.deepEqual(graph.stats, {
    totalSessions: 4,
    graphSessions: 4,
    rootCount: 1,
    childCount: 3,
    orphanParentCount: 0,
    selfParentCount: 0,
    cycleCount: 0,
    maxDepth: 2,
  })
  assert.equal(graph.omittedNodeCount, 0)
})

test("computeSessionLineage forces self-parent and orphan pointers to roots", () => {
  const graph = computeSessionLineage([
    makeLineageSample({ sessionId: "ses_self", parentSessionId: "ses_self" }),
    makeLineageSample({ sessionId: "ses_orphan", parentSessionId: "ses_missing" }),
  ])
  assert.equal(graph.stats.selfParentCount, 1)
  assert.equal(graph.stats.orphanParentCount, 1)
  assert.equal(graph.stats.rootCount, 2)
  assert.equal(graph.stats.childCount, 0)
  assert.equal(graph.stats.maxDepth, 0)
  assert.deepEqual(graph.edges, [])
  assert.ok(
    graph.nodes.every((node) => node.parentSessionId === null),
    "self-parent and orphan nodes both surface as roots",
  )
})

test("computeSessionLineage breaks a two-node cycle exactly once and reports it", () => {
  const graph = computeSessionLineage([
    makeLineageSample({ sessionId: "ses_x", parentSessionId: "ses_y" }),
    makeLineageSample({ sessionId: "ses_y", parentSessionId: "ses_x" }),
  ])
  assert.equal(graph.stats.cycleCount, 1)
  assert.equal(graph.stats.rootCount, 1)
  assert.equal(graph.stats.childCount, 1)
  assert.equal(graph.stats.maxDepth, 1)
  // The break lands on the second node's inbound edge → ses_y becomes root.
  assert.deepEqual(graph.edges, [{ parentSessionId: "ses_y", childSessionId: "ses_x" }])
})

test("computeSessionLineage truncates to the node budget and reports omittedNodeCount", () => {
  const graph = computeSessionLineage(TREE_SAMPLES, { nodeBudget: 3 })
  assert.equal(graph.stats.graphSessions, 3)
  assert.deepEqual(
    graph.nodes.map((node) => node.sessionId),
    ["ses_root", "ses_a", "ses_b"],
  )
  assert.equal(graph.omittedNodeCount, 1)
  // Stats stay structural (not truncated).
  assert.equal(graph.stats.totalSessions, 4)
  assert.equal(graph.stats.maxDepth, 2)
})

test("computeSessionLineage keeps the focus node, its ancestors and its descendants", () => {
  const graph = computeSessionLineage(TREE_SAMPLES, { focusSessionId: "ses_c" })
  assert.equal(graph.focusSessionId, "ses_c")
  // Candidate set = {c, a, root}; b (a sibling) drops out.
  assert.deepEqual(
    graph.nodes.map((node) => node.sessionId),
    ["ses_root", "ses_a", "ses_c"],
  )
  assert.deepEqual(graph.edges, [
    { parentSessionId: "ses_a", childSessionId: "ses_c" },
    { parentSessionId: "ses_root", childSessionId: "ses_a" },
  ])
  assert.equal(graph.omittedNodeCount, 0)
})

test("computeSessionLineage falls back to the full view for an unknown focus id", () => {
  const graph = computeSessionLineage(TREE_SAMPLES, { focusSessionId: "ses_nope" })
  assert.equal(graph.focusSessionId, null)
  assert.equal(graph.stats.graphSessions, 4)
})

test("computeSessionLineage omits empty-id samples and defaults the budget", () => {
  const graph = computeSessionLineage([
    makeLineageSample({ sessionId: "" }),
    ...TREE_SAMPLES,
  ])
  assert.equal(graph.stats.totalSessions, 4, "empty session id is dropped")
  assert.equal(LINEAGE_NODE_BUDGET, 400)
  assert.equal(MAX_LINEAGE_NODE_BUDGET, 1000)
})

// ---------------------------------------------------------------------------
// route matching
// ---------------------------------------------------------------------------

test("matchApiRoute recognizes the session-lineage route; near-miss shapes do not match", () => {
  assert.deepEqual(matchApiRoute("/api/session-lineage"), { routeName: "session-lineage" })
  assert.deepEqual(matchApiRoute("/api/session-lineage/"), { routeName: "session-lineage" })
  assert.equal(matchApiRoute("/api/session-lineage/extra"), null, "no sub-path")
  assert.equal(matchApiRoute("/api/session-lineages"), null, "plural misspelling")
})

// ---------------------------------------------------------------------------
// querySessionLineage — db-null contract + real node:sqlite fixture
// ---------------------------------------------------------------------------

test("querySessionLineage returns null when the db connection is missing", () => {
  assert.equal(querySessionLineage(null), null)
})

/** Structural type of a read-write node:sqlite connection for fixtures. */
interface SqliteReadWriteStatement {
  all(...parameters: unknown[]): unknown[]
  get(...parameters: unknown[]): unknown
  run(...parameters: unknown[]): unknown
}

interface SqliteReadWriteConnection extends SqliteReadConnection {
  prepare(sql: string): SqliteReadWriteStatement
  exec(sql: string): void
}

type SqliteReadWriteConstructor = new (
  databasePath: string,
  options?: { readOnly?: boolean },
) => SqliteReadWriteConnection

/** Resolve DatabaseSync defensively so machines without it skip cleanly. */
function resolveReadWriteConstructor(): SqliteReadWriteConstructor | null {
  try {
    const requireNodeModule = createRequire(import.meta.url)
    const sqliteModule = requireNodeModule("node:sqlite") as {
      DatabaseSync: SqliteReadWriteConstructor
    }
    return sqliteModule.DatabaseSync
  } catch {
    return null
  }
}

const readWriteConstructor = resolveReadWriteConstructor()
const skipReason: string | false =
  readWriteConstructor === null
    ? "node:sqlite unavailable — skipping session-lineage query fixture tests"
    : false

/** One fixture session_v2 row (only the columns the lineage query reads). */
interface SessionLineageRowFixture {
  id: string
  parentId: string | null
  title: string
  agent: string | null
  timeCreated: number
  tokensInput: number
  tokensOutput: number
  tokensCacheRead: number
}

/** Plant the fixture into a real :memory: SQLite with the wire shapes. */
function createSessionLineageFixtureDatabase(
  sessionFixtures: SessionLineageRowFixture[],
): SqliteReadWriteConnection {
  const fixtureDatabase = new readWriteConstructor!(":memory:")
  fixtureDatabase.exec(
    `CREATE TABLE session_v2 (
       id TEXT PRIMARY KEY,
       parent_id TEXT,
       title TEXT,
       agent TEXT,
       time_created INTEGER,
       tokens_input INTEGER,
       tokens_output INTEGER,
       tokens_cache_read INTEGER
     )`,
  )
  const insertSessionStatement = fixtureDatabase.prepare(
    `INSERT INTO session_v2
       (id, parent_id, title, agent, time_created, tokens_input, tokens_output, tokens_cache_read)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  for (const sessionFixture of sessionFixtures) {
    insertSessionStatement.run(
      sessionFixture.id,
      sessionFixture.parentId,
      sessionFixture.title,
      sessionFixture.agent,
      sessionFixture.timeCreated,
      sessionFixture.tokensInput,
      sessionFixture.tokensOutput,
      sessionFixture.tokensCacheRead,
    )
  }
  return fixtureDatabase
}

const LINEAGE_FIXTURE_SESSIONS: SessionLineageRowFixture[] = [
  {
    id: "ses_root",
    parentId: null,
    title: "Root session",
    agent: "Sisyphus - Ultraworker",
    timeCreated: 100,
    tokensInput: 1,
    tokensOutput: 2,
    tokensCacheRead: 3,
  },
  {
    id: "ses_child",
    parentId: "ses_root",
    title: "Child session",
    agent: "",
    timeCreated: 200,
    tokensInput: 0,
    tokensOutput: 0,
    tokensCacheRead: 0,
  },
  {
    id: "ses_orphan",
    parentId: "ses_missing",
    title: "Orphan session",
    agent: null as unknown as string,
    timeCreated: 300,
    tokensInput: 4,
    tokensOutput: 0,
    tokensCacheRead: 0,
  },
]

test("querySessionLineage extracts one row per session with tokens sum and child_count", { skip: skipReason }, () => {
  const fixtureDatabase = createSessionLineageFixtureDatabase(LINEAGE_FIXTURE_SESSIONS)
  try {
    const samples = querySessionLineage(fixtureDatabase)!
    assert.notEqual(samples, null)
    assert.equal(samples.length, 3)
    const sampleById = new Map(samples.map((sample) => [sample.sessionId, sample]))
    assert.deepEqual(sampleById.get("ses_root"), {
      sessionId: "ses_root",
      parentSessionId: null,
      title: "Root session",
      agent: "Sisyphus - Ultraworker",
      tokens: 6,
      timeCreated: 100,
      childCount: 1,
    })
    // NULL agent degrades to "".
    assert.equal(sampleById.get("ses_orphan")!.agent, "")
    assert.equal(sampleById.get("ses_orphan")!.parentSessionId, "ses_missing")
    assert.equal(sampleById.get("ses_orphan")!.tokens, 4)
    assert.equal(sampleById.get("ses_child")!.childCount, 0)
  } finally {
    fixtureDatabase.close()
  }
})

test("computeSessionLineage folds the query fixture into a rooted graph", { skip: skipReason }, () => {
  const fixtureDatabase = createSessionLineageFixtureDatabase(LINEAGE_FIXTURE_SESSIONS)
  try {
    const graph = computeSessionLineage(querySessionLineage(fixtureDatabase)!)
    assert.equal(graph.stats.totalSessions, 3)
    assert.equal(graph.stats.rootCount, 2, "root + resolved orphan")
    assert.equal(graph.stats.childCount, 1)
    assert.equal(graph.stats.orphanParentCount, 1)
    assert.equal(graph.stats.maxDepth, 1)
    assert.deepEqual(graph.edges, [{ parentSessionId: "ses_root", childSessionId: "ses_child" }])
  } finally {
    fixtureDatabase.close()
  }
})

// ---------------------------------------------------------------------------
// endpoint shape — GET /api/session-lineage
// ---------------------------------------------------------------------------

test(
  "the session-lineage route serves the full { focusSessionId, nodes, edges, stats, omittedNodeCount } body",
  { skip: skipReason },
  () => {
    const fixtureDatabase = createSessionLineageFixtureDatabase(LINEAGE_FIXTURE_SESSIONS)
    clearResultCache()
    try {
      const response = handleApiRequest({
        route: matchApiRoute("/api/session-lineage")!,
        searchParams: new URLSearchParams(),
        database: fixtureDatabase,
        databasePath: ":memory:",
        serverPort: 18793,
      })
      assert.equal(response.statusCode, 200)
      const body = response.body as {
        focusSessionId: string | null
        nodes: Array<{ sessionId: string; parentSessionId: string | null; tokens: number }>
        edges: unknown[]
        stats: Record<string, number>
        omittedNodeCount: number
      }
      assert.deepEqual(Object.keys(body).sort(), [
        "edges",
        "focusSessionId",
        "nodes",
        "omittedNodeCount",
        "stats",
      ])
      assert.equal(body.focusSessionId, null)
      assert.equal(body.nodes.length, 3)
      assert.equal(body.edges.length, 1)
      assert.equal(body.omittedNodeCount, 0)
      assert.deepEqual(Object.keys(body.stats).sort(), [
        "childCount",
        "cycleCount",
        "graphSessions",
        "maxDepth",
        "orphanParentCount",
        "rootCount",
        "selfParentCount",
        "totalSessions",
      ])
    } finally {
      clearResultCache()
      fixtureDatabase.close()
    }
  },
)

test("the session-lineage route focuses on ?session= when the id exists", { skip: skipReason }, () => {
  const fixtureDatabase = createSessionLineageFixtureDatabase(LINEAGE_FIXTURE_SESSIONS)
  clearResultCache()
  try {
    const response = handleApiRequest({
      route: matchApiRoute("/api/session-lineage")!,
      searchParams: new URLSearchParams("session=ses_child"),
      database: fixtureDatabase,
      databasePath: ":memory:",
      serverPort: 18794,
    })
    assert.equal(response.statusCode, 200)
    const body = response.body as {
      focusSessionId: string | null
      nodes: Array<{ sessionId: string }>
    }
    assert.equal(body.focusSessionId, "ses_child")
    assert.deepEqual(
      body.nodes.map((node) => node.sessionId).sort(),
      ["ses_child", "ses_root"],
      "focus keeps the node + its ancestor only",
    )
  } finally {
    clearResultCache()
    fixtureDatabase.close()
  }
})

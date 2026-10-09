/**
 * Tests for the per-directory usage statistics (v0.3-A,
 * GET /api/directories): fixture covers multi-directory grouping,
 * NULL / empty-string directory exclusion, Windows backslash paths,
 * zero-step directories, and the deterministic ordering contract
 * (steps desc → sessions desc → directory asc).
 *
 * Conservation locks (P1-1 lesson): with a full unclamped grouping the
 * per-directory session sum must equal totalSessions, the per-directory
 * step sum must equal the assistant-object rows attributed to
 * non-empty-directory sessions, and (v0.15.0) the three per-directory
 * token sums must equal the listed sessions' session_v2 token columns
 * once per session — no join fan-out, no slack leaks.
 */

import { test } from "node:test"
import assert from "node:assert/strict"

import {
  DEFAULT_DIRECTORY_LIMIT,
  directoryDisplayName,
  MAX_DIRECTORY_LIMIT,
  queryDirectoryStats,
  type DirectoryStat,
} from "../src/db/directory-queries.ts"
import {
  buildFakeSessionSummary,
  createFakeInsightDatabase,
  type FakeInsightDatabaseScenario,
  type FakeMessageFixture,
} from "./helpers/fake-insight-db.ts"

function emptyScenario(): FakeInsightDatabaseScenario {
  return {
    sessions: [],
    messagesBySessionId: {},
    systemPromptBySessionId: {},
  }
}

/** Repeat an assistant-object step fixture n times for a session. */
function assistantStepFixtures(stepCount: number): FakeMessageFixture[] {
  const stepFixtures: FakeMessageFixture[] = []
  for (let stepIndex = 0; stepIndex < stepCount; stepIndex += 1) {
    stepFixtures.push({ type: "assistant", data: {} })
  }
  return stepFixtures
}

/**
 * The v0.3-A fixture: six listed directories with deliberate step ties,
 * a sessions tie, a zero-step directory, a drive-root display name, and
 * two excluded sessions (NULL / empty directory) that still carry
 * assistant steps — proving exclusion rather than vacuous equality.
 */
function buildDirectoryScenario(): FakeInsightDatabaseScenario {
  return {
    sessions: [
      buildFakeSessionSummary({
        id: "ses_alpha",
        directory: "D:/alpha",
        timeCreated: 4000,
        timeUpdated: 5000,
      }),
      buildFakeSessionSummary({
        id: "ses_beta",
        directory: "D:/beta",
        timeCreated: 4000,
        timeUpdated: 6000,
      }),
      buildFakeSessionSummary({
        id: "ses_beta_1",
        directory: "D:\\projects\\example-beta",
        timeCreated: 6000,
        timeUpdated: 7000,
      }),
      buildFakeSessionSummary({
        id: "ses_beta_2",
        directory: "D:\\projects\\example-beta",
        timeCreated: 7500,
        timeUpdated: 8000,
      }),
      buildFakeSessionSummary({
        id: "ses_gamma",
        directory: "D:/projects/example-gamma",
        timeCreated: 500,
        timeUpdated: 1000,
      }),
      buildFakeSessionSummary({
        id: "ses_quiet",
        directory: "D:/quiet-project",
        timeCreated: 1500,
        timeUpdated: 2000,
      }),
      buildFakeSessionSummary({
        id: "ses_home_root",
        directory: "C:/Users/example-user",
        timeCreated: 8500,
        timeUpdated: 9000,
      }),
      buildFakeSessionSummary({
        id: "ses_null_directory",
        directory: "D:/overridden-to-null",
        timeCreated: 9500,
        timeUpdated: 9900,
      }),
      buildFakeSessionSummary({
        id: "ses_empty_directory",
        directory: "D:/overridden-to-empty",
        timeCreated: 3000,
        timeUpdated: 3500,
      }),
    ],
    messagesBySessionId: {
      ses_alpha: assistantStepFixtures(1),
      ses_beta: assistantStepFixtures(1),
      ses_beta_1: assistantStepFixtures(2),
      ses_beta_2: assistantStepFixtures(2),
      ses_gamma: assistantStepFixtures(4),
      // Only a user message: zero assistant steps, but the session
      // still counts toward its directory.
      ses_quiet: [{ type: "user", data: { text: "no assistant reply yet" } }],
      ses_home_root: assistantStepFixtures(3),
      // Excluded sessions that still carry steps — the exclusion must
      // drop these rows out of every bucket and both totals.
      ses_null_directory: assistantStepFixtures(3),
      ses_empty_directory: assistantStepFixtures(1),
    },
    systemPromptBySessionId: {},
    directoryColumnBySessionId: {
      ses_null_directory: null,
      ses_empty_directory: "",
    },
  }
}

/**
 * The full expected listing, in the contract's deterministic order. The
 * token components follow the fake builder's defaults (100000/20000/3456
 * per session, never multiplied by step count), summed per directory.
 */
const EXPECTED_DIRECTORY_ORDER: DirectoryStat[] = [
  {
    directory: "D:\\projects\\example-beta",
    name: "example-beta", // backslash path: last \ segment
    sessions: 2, // COUNT(DISTINCT s.id) survives the LEFT JOIN fan-out
    steps: 4,
    // two sessions × defaults, NOT steps(4) × defaults — the fan-out
    // regression face (a per-step-row join would answer 400000).
    tokensInput: 200000,
    tokensOutput: 40000,
    tokensCacheRead: 6912,
    lastActiveMs: 8000,
  },
  {
    directory: "D:/projects/example-gamma",
    name: "example-gamma",
    sessions: 1,
    steps: 4, // ties with example-beta on steps → sessions desc puts beta first
    // one session with 4 steps: tokens stay the row-level value, not 4×.
    tokensInput: 100000,
    tokensOutput: 20000,
    tokensCacheRead: 3456,
    lastActiveMs: 1000,
  },
  {
    directory: "C:/Users/example-user",
    name: "example-user", // drive-root style path: last / segment
    sessions: 1,
    steps: 3,
    tokensInput: 100000,
    tokensOutput: 20000,
    tokensCacheRead: 3456,
    lastActiveMs: 9000,
  },
  {
    directory: "D:/alpha",
    name: "alpha",
    sessions: 1,
    steps: 1, // ties with beta on steps AND sessions → directory asc
    tokensInput: 100000,
    tokensOutput: 20000,
    tokensCacheRead: 3456,
    lastActiveMs: 5000,
  },
  {
    directory: "D:/beta",
    name: "beta",
    sessions: 1,
    steps: 1,
    tokensInput: 100000,
    tokensOutput: 20000,
    tokensCacheRead: 3456,
    lastActiveMs: 6000,
  },
  {
    directory: "D:/quiet-project",
    name: "quiet-project",
    sessions: 1,
    steps: 0, // session with zero assistant steps still listed
    // zero steps → LEFT JOIN NULL row, but the session's tokens still
    // count exactly once.
    tokensInput: 100000,
    tokensOutput: 20000,
    tokensCacheRead: 3456,
    lastActiveMs: 2000,
  },
]

// ---------------------------------------------------------------------------
// basics
// ---------------------------------------------------------------------------

test("queryDirectoryStats returns null when the db connection is missing", () => {
  assert.equal(queryDirectoryStats(null), null)
})

test("queryDirectoryStats answers an empty database with zero totals and an empty list", () => {
  const directoryStats = queryDirectoryStats(createFakeInsightDatabase(emptyScenario()))
  assert.deepEqual(directoryStats, {
    totalDirectories: 0,
    totalSessions: 0,
    directories: [],
  })
})

// ---------------------------------------------------------------------------
// grouping, ordering, naming
// ---------------------------------------------------------------------------

test("queryDirectoryStats groups per directory in the deterministic contract order", () => {
  const directoryStats = queryDirectoryStats(
    createFakeInsightDatabase(buildDirectoryScenario()),
  )!
  assert.equal(directoryStats.totalDirectories, 6)
  assert.equal(directoryStats.totalSessions, 7)
  // 6 groups ≤ default limit 10 → the full listing, order locked exactly.
  assert.deepEqual(directoryStats.directories, EXPECTED_DIRECTORY_ORDER)
})

test("queryDirectoryStats clamps limit into 1..50 (limit above the group count is a no-op)", () => {
  const fakeDatabase = createFakeInsightDatabase(buildDirectoryScenario())

  // 999 clamps to 50, above the 6 groups → identical to default.
  const clampedStats = queryDirectoryStats(fakeDatabase, 999)!
  assert.deepEqual(clampedStats.directories, EXPECTED_DIRECTORY_ORDER)
  assert.equal(clampedStats.totalDirectories, 6)

  // limit=2 keeps the totals full while truncating the list.
  const topTwoStats = queryDirectoryStats(fakeDatabase, 2)!
  assert.equal(topTwoStats.totalDirectories, 6)
  assert.equal(topTwoStats.totalSessions, 7)
  assert.deepEqual(topTwoStats.directories, EXPECTED_DIRECTORY_ORDER.slice(0, 2))

  // limit=1 → a single row, still the strongest directory.
  const topOneStats = queryDirectoryStats(fakeDatabase, 1)!
  assert.deepEqual(topOneStats.directories, [EXPECTED_DIRECTORY_ORDER[0]])

  // Direct calls with a non-positive limit clamp to 1 (the route's
  // parsePositiveIntegerParam already falls back to the default first).
  const floorStats = queryDirectoryStats(fakeDatabase, 0)!
  assert.equal(floorStats.directories.length, 1)
})

test("queryDirectoryStats defaults and clamps match the wire contract constants", () => {
  assert.equal(DEFAULT_DIRECTORY_LIMIT, 10)
  assert.equal(MAX_DIRECTORY_LIMIT, 50)
  const defaultStats = queryDirectoryStats(createFakeInsightDatabase(buildDirectoryScenario()))!
  // Default equals an explicit 10 here (6 groups either way) — assert via
  // a non-finite input instead, which takes the default path.
  assert.deepEqual(
    queryDirectoryStats(createFakeInsightDatabase(buildDirectoryScenario()), Number.NaN)!
      .directories,
    defaultStats.directories,
  )
})

// ---------------------------------------------------------------------------
// conservation (P1-1-class lock)
// ---------------------------------------------------------------------------

test("directory list conserves totalSessions and the step rows of listed sessions", () => {
  const directoryStats = queryDirectoryStats(
    createFakeInsightDatabase(buildDirectoryScenario()),
    MAX_DIRECTORY_LIMIT,
  )!

  // Expected values derived straight from the fixture, independent of
  // the query: sessions with a non-empty directory, and their
  // assistant-object step rows only (the excluded sessions carry 3+1).
  const expectedSessionTotal = 7
  const expectedStepTotal = 13
  // Every listed session carries the builder's default token components
  // (100000/20000/3456) — the excluded two would add 200000/40000/6912.
  const expectedTokensInputTotal = 7 * 100000
  const expectedTokensOutputTotal = 7 * 20000
  const expectedTokensCacheReadTotal = 7 * 3456

  const listedSessionSum = directoryStats.directories.reduce(
    (sessionAccumulator, directoryRow) => sessionAccumulator + directoryRow.sessions,
    0,
  )
  const listedStepSum = directoryStats.directories.reduce(
    (stepAccumulator, directoryRow) => stepAccumulator + directoryRow.steps,
    0,
  )
  const listedTokensInputSum = directoryStats.directories.reduce(
    (tokensInputAccumulator, directoryRow) => tokensInputAccumulator + directoryRow.tokensInput,
    0,
  )
  const listedTokensOutputSum = directoryStats.directories.reduce(
    (tokensOutputAccumulator, directoryRow) => tokensOutputAccumulator + directoryRow.tokensOutput,
    0,
  )
  const listedTokensCacheReadSum = directoryStats.directories.reduce(
    (tokensCacheReadAccumulator, directoryRow) =>
      tokensCacheReadAccumulator + directoryRow.tokensCacheRead,
    0,
  )

  assert.equal(directoryStats.totalSessions, expectedSessionTotal)
  assert.equal(listedSessionSum, expectedSessionTotal, "Σ sessions === totalSessions")
  assert.equal(listedStepSum, expectedStepTotal, "Σ steps === non-empty-directory step rows")
  // The three token components conserve per component (三分守恒):
  // Σ目录 tokens === the listed sessions' session_v2 values, once per
  // session — no step-count multiplication, no NULL/empty leak.
  assert.equal(listedTokensInputSum, expectedTokensInputTotal, "Σ tokensInput conserved")
  assert.equal(listedTokensOutputSum, expectedTokensOutputTotal, "Σ tokensOutput conserved")
  assert.equal(
    listedTokensCacheReadSum,
    expectedTokensCacheReadTotal,
    "Σ tokensCacheRead conserved",
  )
  // The excluded sessions' steps (3 + 1) must not leak into any bucket.
  assert.notEqual(listedStepSum, 17)
  // ...and neither must their tokens.
  assert.notEqual(listedTokensInputSum, 9 * 100000)
})

test("directory steps conserve the whole assistant-object row count when no session is excluded", () => {
  const allListedScenario = buildDirectoryScenario()
  delete allListedScenario.directoryColumnBySessionId
  // Give the two previously-excluded sessions real directories so every
  // session is listed — then Σ steps must equal the full row count.
  for (const sessionSummary of allListedScenario.sessions) {
    if (sessionSummary.id === "ses_null_directory") sessionSummary.directory = "D:/recovered-one"
    if (sessionSummary.id === "ses_empty_directory") sessionSummary.directory = "D:/recovered-two"
  }

  const directoryStats = queryDirectoryStats(createFakeInsightDatabase(allListedScenario), 50)!
  const listedStepSum = directoryStats.directories.reduce(
    (stepAccumulator, directoryRow) => stepAccumulator + directoryRow.steps,
    0,
  )
  const listedTokensInputSum = directoryStats.directories.reduce(
    (tokensInputAccumulator, directoryRow) => tokensInputAccumulator + directoryRow.tokensInput,
    0,
  )

  assert.equal(directoryStats.totalDirectories, 8)
  assert.equal(directoryStats.totalSessions, 9)
  assert.equal(listedStepSum, 17, "Σ steps === the full assistant-object row count (1+1+2+2+4+0+3+3+1)")
  // With nobody excluded the token sum covers the whole fixture: every
  // session's default tokens, once each.
  assert.equal(listedTokensInputSum, 9 * 100000, "Σ tokensInput === every session, exactly once")
})

// ---------------------------------------------------------------------------
// display name derivation
// ---------------------------------------------------------------------------

test("directoryDisplayName splits on both separators and falls back to the original path", () => {
  assert.equal(directoryDisplayName("C:/Users/example-user"), "example-user")
  assert.equal(directoryDisplayName("D:/projects/example-alpha"), "example-alpha")
  assert.equal(directoryDisplayName("D:\\projects\\example-beta"), "example-beta")
  assert.equal(directoryDisplayName("D:/work/"), "work", "trailing separator dropped")
  assert.equal(
    directoryDisplayName("D:/mixed\\path/parts"),
    "parts",
    "both separators in one path",
  )
  // No non-empty segment to extract → the original string, not "".
  assert.equal(directoryDisplayName("///"), "///")
  assert.equal(directoryDisplayName(""), "")
})

/**
 * Tests for GET /api/token-ledger (A1 记账守恒): the pure computeTokenLedger
 * aggregation (src/stats/token-ledger.ts) runs everywhere; the query layer's
 * LEFT JOIN / GROUP BY SUM / json_extract extraction is locked against a real
 * node:sqlite :memory: fixture (the fake insight database does not mirror
 * SQL aggregation semantics — see fake-insight-db.ts file header) and skips
 * cleanly when node:sqlite is unavailable.
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import { createRequire } from "node:module"

import type { SqliteReadConnection } from "../src/db/types.ts"
import { queryTokenLedger } from "../src/db/token-ledger-queries.ts"
import {
  computeTokenLedger,
  TOKEN_LEDGER_RECONCILIATION_TOLERANCE,
  type TokenLedgerSample,
} from "../src/stats/token-ledger.ts"
import { matchApiRoute } from "../src/web/router.ts"
import { handleApiRequest } from "../src/web/api.ts"

/** A sample with every field defaulted; override the ones a case cares about. */
function makeTokenLedgerSample(
  overrides: Partial<TokenLedgerSample> = {},
): TokenLedgerSample {
  return {
    sessionId: "ses_sample",
    messages: 0,
    promptInput: 0,
    promptCacheRead: 0,
    promptCacheWrite: 0,
    output: 0,
    reasoning: 0,
    v2Input: 0,
    v2CacheRead: 0,
    v2CacheWrite: 0,
    v2Output: 0,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// computeTokenLedger — pure function, zero IO
// ---------------------------------------------------------------------------

test("computeTokenLedger returns a zero, balanced ledger for empty input", () => {
  assert.deepEqual(computeTokenLedger([]), {
    totals: {
      promptInput: 0,
      promptCacheRead: 0,
      promptCacheWrite: 0,
      promptTotal: 0,
      output: 0,
      reasoning: 0,
      cacheHitRate: null,
      sessions: 0,
    },
    conservation: {
      anomalies: { negativeComponents: 0, cacheReadExceedsPrompt: 0 },
      balanced: true,
    },
    reconciliation: {
      residualTokens: 0,
      residualRatio: null,
      withinTolerance: false,
      tolerance: TOKEN_LEDGER_RECONCILIATION_TOLERANCE,
    },
    sessions: [],
  })
})

test("computeTokenLedger aggregates totals, hit rate and the message/session split", () => {
  const stats = computeTokenLedger([
    makeTokenLedgerSample({
      sessionId: "ses_a",
      messages: 2,
      promptInput: 300,
      promptCacheRead: 90,
      promptCacheWrite: 10,
      output: 40,
      reasoning: 5,
      v2Input: 320,
      v2CacheRead: 95,
      v2CacheWrite: 10,
      v2Output: 45,
    }),
    makeTokenLedgerSample({
      sessionId: "ses_b",
      messages: 1,
      promptInput: 100,
      promptCacheRead: 400,
      promptCacheWrite: 0,
      output: 20,
      reasoning: 0,
      v2Input: 100,
      v2CacheRead: 405,
      v2CacheWrite: 0,
      v2Output: 20,
    }),
  ])

  assert.deepEqual(stats.totals, {
    promptInput: 400,
    promptCacheRead: 490,
    promptCacheWrite: 10,
    promptTotal: 900,
    output: 60,
    reasoning: 5,
    cacheHitRate: 490 / 900,
    sessions: 2,
  })

  // 完整性只看异常计数：无异常 → balanced true（跨源对照不参与）。
  assert.deepEqual(stats.conservation, {
    anomalies: { negativeComponents: 0, cacheReadExceedsPrompt: 0 },
    balanced: true,
  })

  // messageSide = 900; sessionTable = (320+95+10) + (100+405+0) = 930.
  assert.deepEqual(stats.reconciliation, {
    residualTokens: 30,
    residualRatio: 30 / 930,
    withinTolerance: Math.abs(30 / 930) <= TOKEN_LEDGER_RECONCILIATION_TOLERANCE,
    tolerance: TOKEN_LEDGER_RECONCILIATION_TOLERANCE,
  })
})

test("computeTokenLedger sorts sessions by promptTotal desc then sessionId asc", () => {
  const stats = computeTokenLedger([
    makeTokenLedgerSample({ sessionId: "ses_zeta", promptInput: 50 }),
    makeTokenLedgerSample({ sessionId: "ses_alpha", promptInput: 50 }),
    makeTokenLedgerSample({ sessionId: "ses_mid", promptInput: 90 }),
  ])
  assert.deepEqual(
    stats.sessions.map((sessionStat) => sessionStat.sessionId),
    ["ses_mid", "ses_alpha", "ses_zeta"],
  )
})

test("computeTokenLedger gives each session its own promptTotal and cache hit rate", () => {
  const stats = computeTokenLedger([
    makeTokenLedgerSample({ sessionId: "ses_a", promptInput: 0, promptCacheRead: 0, promptCacheWrite: 0 }),
    makeTokenLedgerSample({ sessionId: "ses_b", promptInput: 10, promptCacheRead: 30, promptCacheWrite: 0 }),
  ])
  const statBySessionId = new Map(
    stats.sessions.map((sessionStat) => [sessionStat.sessionId, sessionStat]),
  )
  // Zero prompt → null hit rate (never a fabricated 0/0 = 1).
  assert.equal(statBySessionId.get("ses_a")!.promptTotal, 0)
  assert.equal(statBySessionId.get("ses_a")!.cacheHitRate, null)
  assert.equal(statBySessionId.get("ses_b")!.promptTotal, 40)
  assert.equal(statBySessionId.get("ses_b")!.cacheHitRate, 30 / 40)
})

test("computeTokenLedger counts negative components and cache-read-over-prompt anomalies", () => {
  const stats = computeTokenLedger([
    // Negative on the message side (a non-prompt component, so this row does
    // not also trip cacheReadExceedsPrompt: promptTotal stays 0).
    makeTokenLedgerSample({ sessionId: "ses_negative", output: -1 }),
    // Negative on the session_v2 side.
    makeTokenLedgerSample({ sessionId: "ses_negative_v2", v2Output: -5 }),
    // cacheRead > promptTotal (hit rate above 100%): only reachable with a
    // negative sibling component, but still counted independently.
    makeTokenLedgerSample({ sessionId: "ses_overread", promptInput: -10, promptCacheRead: 5 }),
    makeTokenLedgerSample({ sessionId: "ses_clean", promptInput: 1, promptCacheRead: 1 }),
  ])
  assert.deepEqual(stats.conservation.anomalies, {
    negativeComponents: 3,
    cacheReadExceedsPrompt: 1,
  })
  assert.equal(stats.conservation.balanced, false)
})

test("computeTokenLedger reports the residual against the reconciliation tolerance without gating balanced on it", () => {
  const withinTolerance = computeTokenLedger([
    makeTokenLedgerSample({ sessionId: "ses_a", promptInput: 1000, v2Input: 1005 }),
  ])
  assert.equal(withinTolerance.reconciliation.residualRatio, 5 / 1005)
  assert.equal(withinTolerance.reconciliation.withinTolerance, true)

  // Beyond tolerance: the cross-source residual is large (v2 keeps
  // compaction-pruned history), yet with zero anomalies this is a KNOWN
  // difference, NOT an integrity failure — balanced must stay true.
  const beyondTolerance = computeTokenLedger([
    makeTokenLedgerSample({ sessionId: "ses_a", promptInput: 1000, v2Input: 1200 }),
  ])
  assert.equal(beyondTolerance.reconciliation.residualRatio, 200 / 1200)
  assert.equal(beyondTolerance.reconciliation.withinTolerance, false)
  assert.equal(
    Math.abs(beyondTolerance.reconciliation.residualRatio!) >
      TOKEN_LEDGER_RECONCILIATION_TOLERANCE,
    true,
  )
  assert.deepEqual(beyondTolerance.conservation.anomalies, {
    negativeComponents: 0,
    cacheReadExceedsPrompt: 0,
  })
  assert.equal(beyondTolerance.conservation.balanced, true)
})

// ---------------------------------------------------------------------------
// route matching
// ---------------------------------------------------------------------------

test("matchApiRoute recognizes the token-ledger route; near-miss shapes do not match", () => {
  assert.deepEqual(matchApiRoute("/api/token-ledger"), { routeName: "token-ledger" })
  assert.deepEqual(matchApiRoute("/api/token-ledger/"), { routeName: "token-ledger" })
  assert.equal(matchApiRoute("/api/token-ledger/extra"), null, "no sub-path")
  assert.equal(matchApiRoute("/api/token-ledgers"), null, "plural misspelling")
})

// ---------------------------------------------------------------------------
// queryTokenLedger — db-null contract + real node:sqlite fixture
// ---------------------------------------------------------------------------

test("queryTokenLedger returns null when the db connection is missing", () => {
  assert.equal(queryTokenLedger(null), null)
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
    ? "node:sqlite unavailable — skipping token-ledger query fixture tests"
    : false

/** One fixture session_v2 row: id + the four 对照 token columns. */
interface TokenLedgerSessionFixture {
  id: string
  tokensInput?: number
  tokensCacheRead?: number
  tokensCacheWrite?: number
  tokensOutput?: number
}

/** One fixture session_message row, before it is turned into a wire row. */
interface TokenLedgerMessageFixture {
  sessionId: string
  type: string
  seq?: number
  data: unknown
}

/** Plant the fixture into a real :memory: SQLite with the wire shapes. */
function createTokenLedgerFixtureDatabase(
  sessionFixtures: TokenLedgerSessionFixture[],
  messageFixtures: TokenLedgerMessageFixture[],
): SqliteReadWriteConnection {
  const fixtureDatabase = new readWriteConstructor!(":memory:")
  fixtureDatabase.exec(
    `CREATE TABLE session_v2 (
       id TEXT PRIMARY KEY,
       tokens_input REAL,
       tokens_cache_read REAL,
       tokens_cache_write REAL,
       tokens_output REAL
     )`,
  )
  fixtureDatabase.exec(
    `CREATE TABLE session_message (
       id TEXT PRIMARY KEY,
       session_id TEXT,
       type TEXT,
       seq INTEGER,
       time_created INTEGER,
       time_updated INTEGER,
       data TEXT
     )`,
  )
  const insertSessionStatement = fixtureDatabase.prepare(
    "INSERT INTO session_v2 (id, tokens_input, tokens_cache_read, tokens_cache_write, tokens_output) " +
      "VALUES (?, ?, ?, ?, ?)",
  )
  for (const sessionFixture of sessionFixtures) {
    insertSessionStatement.run(
      sessionFixture.id,
      sessionFixture.tokensInput ?? 0,
      sessionFixture.tokensCacheRead ?? 0,
      sessionFixture.tokensCacheWrite ?? 0,
      sessionFixture.tokensOutput ?? 0,
    )
  }
  const insertMessageStatement = fixtureDatabase.prepare(
    "INSERT INTO session_message (id, session_id, type, seq, data) VALUES (?, ?, ?, ?, ?)",
  )
  messageFixtures.forEach((messageFixture, messageIndex) => {
    insertMessageStatement.run(
      `msg_${messageIndex}`,
      messageFixture.sessionId,
      messageFixture.type,
      messageFixture.seq ?? messageIndex,
      JSON.stringify(messageFixture.data),
    )
  })
  return fixtureDatabase
}

test("queryTokenLedger pairs message-side sums with the session_v2 对照 columns", { skip: skipReason }, () => {
  const fixtureDatabase = createTokenLedgerFixtureDatabase(
    [
      { id: "ses_alpha", tokensInput: 1000, tokensCacheRead: 5000, tokensCacheWrite: 88, tokensOutput: 200 },
      // No assistant rows: still one row, message side all zero (LEFT JOIN).
      { id: "ses_beta", tokensInput: 7, tokensCacheRead: 8, tokensCacheWrite: 9, tokensOutput: 10 },
    ],
    [
      {
        sessionId: "ses_alpha",
        type: "assistant",
        data: { tokens: { input: 100, output: 40, reasoning: 10, cache: { read: 60, write: 5 } } },
      },
      {
        sessionId: "ses_alpha",
        type: "assistant",
        data: { tokens: { input: 200, output: 50, reasoning: 0, cache: { read: 30, write: 0 } } },
      },
      // Non-assistant rows never count.
      { sessionId: "ses_alpha", type: "user", data: { text: "hi" } },
      // Orphan message: session_id absent from session_v2 → excluded by the anchor.
      {
        sessionId: "ses_orphan",
        type: "assistant",
        data: { tokens: { input: 9999, cache: { read: 9999 } } },
      },
    ],
  )
  try {
    const samples = queryTokenLedger(fixtureDatabase)!
    assert.notEqual(samples, null)
    assert.equal(samples.length, 2, "one row per session_v2 session, orphans dropped")
    const sampleBySessionId = new Map(
      samples.map((sample) => [sample.sessionId, sample]),
    )

    assert.deepEqual(sampleBySessionId.get("ses_alpha"), {
      sessionId: "ses_alpha",
      messages: 2,
      promptInput: 300,
      promptCacheRead: 90,
      promptCacheWrite: 5,
      output: 90,
      reasoning: 10,
      v2Input: 1000,
      v2CacheRead: 5000,
      v2CacheWrite: 88,
      v2Output: 200,
    })
    assert.deepEqual(sampleBySessionId.get("ses_beta"), {
      sessionId: "ses_beta",
      messages: 0,
      promptInput: 0,
      promptCacheRead: 0,
      promptCacheWrite: 0,
      output: 0,
      reasoning: 0,
      v2Input: 7,
      v2CacheRead: 8,
      v2CacheWrite: 9,
      v2Output: 10,
    })
  } finally {
    fixtureDatabase.close()
  }
})

test("queryTokenLedger scopes to a single session when sessionFilterId is passed", { skip: skipReason }, () => {
  const fixtureDatabase = createTokenLedgerFixtureDatabase(
    [
      { id: "ses_alpha", tokensInput: 30 },
      { id: "ses_beta", tokensInput: 70 },
    ],
    [
      { sessionId: "ses_alpha", type: "assistant", data: { tokens: { input: 30 } } },
      { sessionId: "ses_beta", type: "assistant", data: { tokens: { input: 70 } } },
    ],
  )
  try {
    const alphaSamples = queryTokenLedger(fixtureDatabase, "ses_alpha")!
    assert.equal(alphaSamples.length, 1)
    assert.equal(alphaSamples[0].sessionId, "ses_alpha")
    assert.equal(alphaSamples[0].promptInput, 30)

    // Empty string = the no-filter default (both sessions).
    const defaultLabels = queryTokenLedger(fixtureDatabase, "")!
    assert.deepEqual(
      defaultLabels.map((sample) => sample.sessionId).sort(),
      ["ses_alpha", "ses_beta"],
    )
  } finally {
    fixtureDatabase.close()
  }
})

// ---------------------------------------------------------------------------
// endpoint shape — GET /api/token-ledger
// ---------------------------------------------------------------------------

test(
  "the token-ledger route serves the aggregated { totals, conservation, reconciliation, sessions } body",
  { skip: skipReason },
  () => {
    const fixtureDatabase = createTokenLedgerFixtureDatabase(
      [
        { id: "ses_alpha", tokensInput: 1000, tokensCacheRead: 5000, tokensCacheWrite: 88, tokensOutput: 200 },
      ],
      [
        { sessionId: "ses_alpha", type: "assistant", data: { tokens: { input: 100, output: 40, cache: { read: 60, write: 5 } } } },
      ],
    )
    try {
      const response = handleApiRequest({
        route: matchApiRoute("/api/token-ledger")!,
        searchParams: new URLSearchParams(),
        database: fixtureDatabase,
        databasePath: ":memory:",
        serverPort: 18790,
      })
      assert.equal(response.statusCode, 200)
      const body = response.body as {
        totals: unknown
        conservation: { anomalies: unknown; balanced: boolean }
        reconciliation: { residualRatio: number | null; withinTolerance: boolean }
        sessions: unknown[]
      }
      // The query layer alone returns a bare sample array; the route must
      // aggregate it into the four-key payload the contract fixes.
      assert.deepEqual(
        Object.keys(body).sort(),
        ["conservation", "reconciliation", "sessions", "totals"],
      )
      assert.deepEqual(body.conservation.anomalies, {
        negativeComponents: 0,
        cacheReadExceedsPrompt: 0,
      })
      // Cross-source residual is informational only: balanced is true.
      assert.equal(body.conservation.balanced, true)
      assert.equal(body.sessions.length, 1)
      // messageSide = 165; sessionTable = 1000+5000+88 = 6088.
      assert.equal(body.reconciliation.residualRatio, (6088 - 165) / 6088)
    } finally {
      fixtureDatabase.close()
    }
  },
)

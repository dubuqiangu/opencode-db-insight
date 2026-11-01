/**
 * Tests for GET /api/file-activity (B5 文件活动): the pure computeFileActivity
 * aggregation and the path normalisation / homedir redaction helpers
 * (src/stats/file-activity.ts) run everywhere; the query layer's
 * json_each walk, COALESCE path resolution and JS re-aggregation are locked
 * against a real node:sqlite :memory: fixture and skip cleanly when
 * node:sqlite is unavailable.
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import { createRequire } from "node:module"

import type { SqliteReadConnection } from "../src/db/types.ts"
import { queryFileActivity } from "../src/db/file-activity-queries.ts"
import {
  applyHomeRedaction,
  computeFileActivity,
  fileNameFromPath,
  normalizeFilePath,
  MAX_FILE_ACTIVITY_LIMIT,
  type FileActivitySample,
} from "../src/stats/file-activity.ts"
import { matchApiRoute } from "../src/web/router.ts"
import { handleApiRequest } from "../src/web/api.ts"
import { clearResultCache } from "../src/stats/cache.ts"

/** A sample with every field defaulted; override the ones a case cares about. */
function makeFileActivitySample(overrides: Partial<FileActivitySample> = {}): FileActivitySample {
  return {
    path: "~/sample.ts",
    reads: 0,
    edits: 0,
    writes: 0,
    sessions: 0,
    lastActiveMs: 0,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// pure helpers — zero IO
// ---------------------------------------------------------------------------

test("normalizeFilePath unifies separators, collapses slashes and uppercases the drive letter", () => {
  assert.equal(normalizeFilePath("D:\\work\\a.ts"), "D:/work/a.ts")
  assert.equal(normalizeFilePath("d:\\work\\a.ts"), "D:/work/a.ts")
  assert.equal(normalizeFilePath("d:/work//a.ts"), "D:/work/a.ts")
  assert.equal(normalizeFilePath("D:/work/a.ts/"), "D:/work/a.ts")
  assert.equal(normalizeFilePath("~/x.ts"), "~/x.ts")
  // Case beyond the drive letter is preserved.
  assert.equal(normalizeFilePath("/Home/User/x.ts"), "/Home/User/x.ts")
})

test("fileNameFromPath returns the last non-empty segment", () => {
  assert.equal(fileNameFromPath("~/a/b.ts"), "b.ts")
  assert.equal(fileNameFromPath("D:/x/y.ts"), "y.ts")
  assert.equal(fileNameFromPath("~/dir/"), "dir")
  assert.equal(fileNameFromPath("noext"), "noext")
  assert.equal(fileNameFromPath(""), "")
})

test("applyHomeRedaction replaces a homedir prefix with ~ on a path boundary", () => {
  assert.equal(applyHomeRedaction("D:/work/a.ts", "D:\\work"), "~/a.ts")
  assert.equal(applyHomeRedaction("D:/work", "D:\\work"), "~")
  // Prefix must end on a separator boundary, not a bare string prefix.
  assert.equal(applyHomeRedaction("D:/works/a.ts", "D:\\work"), "D:/works/a.ts")
  // Case-sensitive beyond the drive letter.
  assert.equal(applyHomeRedaction("D:/Work/a.ts", "D:/work"), "D:/Work/a.ts")
  // An empty homedir never redacts.
  assert.equal(applyHomeRedaction("/other/x.ts", ""), "/other/x.ts")
})

test("computeFileActivity returns zero totals and an empty list for empty input", () => {
  assert.deepEqual(computeFileActivity([]), { totalFiles: 0, totalOps: 0, files: [] })
})

test("computeFileActivity derives names, sums ops and sorts ops desc then path asc", () => {
  const stats = computeFileActivity([
    makeFileActivitySample({ path: "~/b.ts", reads: 1, sessions: 1, lastActiveMs: 10 }),
    makeFileActivitySample({ path: "~/a.ts", reads: 2, edits: 1, sessions: 2, lastActiveMs: 20 }),
    makeFileActivitySample({ path: "~/c.ts", reads: 3, sessions: 3, lastActiveMs: 30 }),
  ])
  assert.equal(stats.totalFiles, 3)
  assert.equal(stats.totalOps, 2 + 1 + 1 + 3)
  assert.deepEqual(
    stats.files.map((file) => [file.path, file.name, file.reads + file.edits + file.writes]),
    [
      ["~/a.ts", "a.ts", 3],
      ["~/c.ts", "c.ts", 3],
      ["~/b.ts", "b.ts", 1],
    ],
    "tie on ops broken by path asc",
  )
})

// ---------------------------------------------------------------------------
// route matching
// ---------------------------------------------------------------------------

test("matchApiRoute recognizes the file-activity route; near-miss shapes do not match", () => {
  assert.deepEqual(matchApiRoute("/api/file-activity"), { routeName: "file-activity" })
  assert.deepEqual(matchApiRoute("/api/file-activity/"), { routeName: "file-activity" })
  assert.equal(matchApiRoute("/api/file-activity/extra"), null, "no sub-path")
  assert.equal(matchApiRoute("/api/file-activities"), null, "plural misspelling")
})

// ---------------------------------------------------------------------------
// queryFileActivity — db-null contract + real node:sqlite fixture
// ---------------------------------------------------------------------------

test("queryFileActivity returns null when the db connection is missing", () => {
  assert.equal(queryFileActivity(null, 20), null)
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
    ? "node:sqlite unavailable — skipping file-activity query fixture tests"
    : false

/** One fixture assistant tool part, before it is turned into a wire message. */
interface FileActivityToolFixture {
  sessionId: string
  toolName: string
  /** The single raw path key the tool part carries (path / filePath / file_path). */
  inputPathKey: "path" | "filePath" | "file_path"
  rawPath: string
  timeCreated: number
}

/** Plant the fixture into a real :memory: SQLite with the wire shapes. */
function createFileActivityFixtureDatabase(
  sessionIds: string[],
  toolFixtures: FileActivityToolFixture[],
): SqliteReadWriteConnection {
  const fixtureDatabase = new readWriteConstructor!(":memory:")
  fixtureDatabase.exec("CREATE TABLE session_v2 (id TEXT PRIMARY KEY)")
  fixtureDatabase.exec(
    `CREATE TABLE session_message (
       id TEXT PRIMARY KEY,
       session_id TEXT,
       type TEXT,
       time_created INTEGER,
       data TEXT
     )`,
  )
  const insertSessionStatement = fixtureDatabase.prepare("INSERT INTO session_v2 (id) VALUES (?)")
  for (const sessionId of sessionIds) insertSessionStatement.run(sessionId)

  const insertMessageStatement = fixtureDatabase.prepare(
    "INSERT INTO session_message (id, session_id, type, time_created, data) VALUES (?, ?, ?, ?, ?)",
  )
  toolFixtures.forEach((toolFixture, fixtureIndex) => {
    const toolPart = {
      type: "tool",
      name: toolFixture.toolName,
      state: { input: { [toolFixture.inputPathKey]: toolFixture.rawPath } },
    }
    insertMessageStatement.run(
      `msg_${fixtureIndex}`,
      toolFixture.sessionId,
      "assistant",
      toolFixture.timeCreated,
      JSON.stringify({ content: [toolPart] }),
    )
  })
  const insertNonAssistantStatement = fixtureDatabase.prepare(
    "INSERT INTO session_message (id, session_id, type, time_created, data) VALUES (?, ?, ?, ?, ?)",
  )
  insertNonAssistantStatement.run("msg_user", "ses_a", "user", 500, JSON.stringify({ text: "hi" }))
  return fixtureDatabase
}

const FIXTURE_SESSIONS = ["ses_a", "ses_b"]
const FIXTURE_TOOLS: FileActivityToolFixture[] = [
  // ses_a: read + edit on the same file via two different raw path keys,
  // then a write on another file; a grep on the same file must be excluded.
  { sessionId: "ses_a", toolName: "read", inputPathKey: "path", rawPath: "D:\\work\\a.ts", timeCreated: 1000 },
  { sessionId: "ses_a", toolName: "edit", inputPathKey: "filePath", rawPath: "D:\\work\\a.ts", timeCreated: 2000 },
  { sessionId: "ses_a", toolName: "write", inputPathKey: "file_path", rawPath: "D:\\work\\b.ts", timeCreated: 3000 },
  { sessionId: "ses_a", toolName: "grep", inputPathKey: "path", rawPath: "D:\\work\\a.ts", timeCreated: 3500 },
  // ses_b: same physical file in forward-slash form → folds into the same key.
  { sessionId: "ses_b", toolName: "read", inputPathKey: "path", rawPath: "D:/work/a.ts", timeCreated: 4000 },
  // Orphan: session absent from session_v2 → excluded by the anchor.
  { sessionId: "ses_orphan", toolName: "read", inputPathKey: "path", rawPath: "D:\\work\\a.ts", timeCreated: 9000 },
]

test("queryFileActivity folds path forms, redacts homedir and keeps only read/edit/write", { skip: skipReason }, () => {
  const fixtureDatabase = createFileActivityFixtureDatabase(FIXTURE_SESSIONS, FIXTURE_TOOLS)
  try {
    const stats = queryFileActivity(fixtureDatabase, 20, null, "D:\\work")!
    assert.notEqual(stats, null)
    assert.equal(stats.totalFiles, 2, "orphan dropped, grep excluded, path forms folded")
    assert.equal(stats.totalOps, 4) // 2 read + 1 edit + 1 write
    assert.deepEqual(stats.files, [
      {
        path: "~/a.ts",
        name: "a.ts",
        reads: 2,
        edits: 1,
        writes: 0,
        sessions: 2,
        lastActiveMs: 4000,
      },
      {
        path: "~/b.ts",
        name: "b.ts",
        reads: 0,
        edits: 0,
        writes: 1,
        sessions: 1,
        lastActiveMs: 3000,
      },
    ])
  } finally {
    fixtureDatabase.close()
  }
})

test("queryFileActivity clamps limit and truncates files while keeping full totals", { skip: skipReason }, () => {
  const fixtureDatabase = createFileActivityFixtureDatabase(FIXTURE_SESSIONS, FIXTURE_TOOLS)
  try {
    const truncated = queryFileActivity(fixtureDatabase, 1, null, "D:\\work")!
    assert.equal(truncated.files.length, 1)
    assert.equal(truncated.files[0].path, "~/a.ts")
    assert.equal(truncated.totalFiles, 2, "totals stay pre-truncation")
    assert.equal(truncated.totalOps, 4)

    // limit 0 clamps up to 1; a huge limit clamps down to MAX (both files fit).
    assert.equal(queryFileActivity(fixtureDatabase, 0, null, "D:\\work")!.files.length, 1)
    assert.equal(
      queryFileActivity(fixtureDatabase, MAX_FILE_ACTIVITY_LIMIT + 1000, null, "D:\\work")!.files.length,
      2,
    )
  } finally {
    fixtureDatabase.close()
  }
})

test("queryFileActivity scopes to a single session when sessionFilterId is passed", { skip: skipReason }, () => {
  const fixtureDatabase = createFileActivityFixtureDatabase(FIXTURE_SESSIONS, FIXTURE_TOOLS)
  try {
    const betaStats = queryFileActivity(fixtureDatabase, 20, "ses_b", "D:\\work")!
    assert.equal(betaStats.totalFiles, 1)
    assert.equal(betaStats.files[0].path, "~/a.ts")
    assert.equal(betaStats.files[0].reads, 1)
    assert.equal(betaStats.files[0].sessions, 1)
  } finally {
    fixtureDatabase.close()
  }
})

// ---------------------------------------------------------------------------
// endpoint shape — GET /api/file-activity
// ---------------------------------------------------------------------------

test(
  "the file-activity route serves the { totalFiles, totalOps, files } body with a bounded limit",
  { skip: skipReason },
  () => {
    const fixtureDatabase = createFileActivityFixtureDatabase(FIXTURE_SESSIONS, FIXTURE_TOOLS)
    clearResultCache()
    try {
      const response = handleApiRequest({
        route: matchApiRoute("/api/file-activity")!,
        searchParams: new URLSearchParams("limit=1"),
        database: fixtureDatabase,
        databasePath: ":memory:",
        serverPort: 18792,
      })
      assert.equal(response.statusCode, 200)
      const body = response.body as { totalFiles: number; totalOps: number; files: unknown[] }
      assert.deepEqual(Object.keys(body).sort(), ["files", "totalFiles", "totalOps"])
      assert.equal(body.totalFiles, 2)
      assert.equal(body.totalOps, 4)
      assert.equal(body.files.length, 1)
    } finally {
      clearResultCache()
      fixtureDatabase.close()
    }
  },
)

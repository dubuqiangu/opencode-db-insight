/**
 * Tests for the ?day=YYYY-MM-DD calendar-day filter (v0.24.0) on the
 * session list. The filter is a closed window
 * [dayStartMs, dayStartMs + 86400000) on session_v2.time_updated, computed
 * server-side in api.ts (parseDayStartMs) and AND-composed with the
 * directory / range filters in querySessionList.
 *
 * This file locks the real-SQL semantics against a node:sqlite :memory:
 * fixture (发布清单 #2 — SQL semantics locked against real SQLite, never
 * a fake JS mirror): only sessions whose time_updated falls in the pinned
 * local calendar day are returned; rows a day either side drop out; the
 * day filter composes with the directory filter (intersection).
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import { createRequire } from "node:module"

import type { SqliteReadConnection } from "../src/db/types.ts"
import { querySessionList } from "../src/db/queries.ts"

/** Structural type of a read-write node:sqlite connection for fixtures. */
interface SqliteReadWriteConnection extends SqliteReadConnection {
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
    ? "node:sqlite unavailable — skipping session day-filter tests"
    : false

/** One session_v2 fixture row, before column mapping. */
interface SessionDayFixtureRow {
  id: string
  directory: string
  timeUpdated: number
}

/** A fresh in-memory database carrying the given fixture rows. */
function createDayFixtureDatabase(
  fixtureRows: SessionDayFixtureRow[],
): SqliteReadWriteConnection {
  const database = new readWriteConstructor!(":memory:")
  database.exec(
    "CREATE TABLE session_v2 (" +
      "id TEXT, title TEXT, model TEXT, agent TEXT, directory TEXT, " +
      "time_created INTEGER, time_updated INTEGER, " +
      "tokens_input REAL, tokens_output REAL, tokens_cache_read REAL, cost REAL);" +
      // v0.19.0 起会话列表还会扫 session_message 聚合 step 级模型 id
      // （modelIds），空表即可——本文件的日期语义与 step 数据无关。
      "CREATE TABLE session_message (" +
      "id TEXT, session_id TEXT, type TEXT, seq INTEGER, " +
      "time_created INTEGER, time_updated INTEGER, data TEXT);",
  )
  const insertSession = database.prepare(
    "INSERT INTO session_v2 (id, title, model, agent, directory, time_created, time_updated, " +
      "tokens_input, tokens_output, tokens_cache_read, cost) " +
      "VALUES (?, 'fixture title', '{}', 'fixer', ?, 1000, ?, 0, 0, 0, 0)",
  )
  for (const fixtureRow of fixtureRows) {
    insertSession.run(fixtureRow.id, fixtureRow.directory, fixtureRow.timeUpdated)
  }
  return database
}

/** One day in milliseconds, matching the query's own constant. */
const DAY_MS = 86_400_000

/** The local calendar day start this fixture pins (2026-10-07 UTC). */
const PINNED_DAY_START_MS = Date.UTC(2026, 9, 7, 0, 0, 0)

test(
  "real-SQL: only sessions whose time_updated falls in the pinned local day return",
  { skip: skipReason },
  () => {
    const database = createDayFixtureDatabase([
      // 正好在当天（2026-10-07）内。
      { id: "ses_day_in", directory: "", timeUpdated: PINNED_DAY_START_MS + 1 },
      // 前一天最后一毫秒：落在 [start - 1, start) 之外。
      { id: "ses_day_previous", directory: "", timeUpdated: PINNED_DAY_START_MS - 1 },
      // 后一天第一毫秒：落在 [start, start + DAY_MS) 之外。
      { id: "ses_day_next", directory: "", timeUpdated: PINNED_DAY_START_MS + DAY_MS },
      // 当天末尾（start + DAY_MS - 1）仍在窗口内。
      { id: "ses_day_end", directory: "", timeUpdated: PINNED_DAY_START_MS + DAY_MS - 1 },
    ])
    try {
      const sessionPage = querySessionList(
        database as unknown as SqliteReadConnection,
        500,
        0,
        undefined,
        undefined,
        null,
        null,
        PINNED_DAY_START_MS,
      )
      assert.ok(sessionPage !== null)
      assert.deepEqual(
        sessionPage.map((sessionSummary) => sessionSummary.id),
        // 默认排序 time_updated DESC，所以时间靠后的 ses_day_end 在前。
        ["ses_day_end", "ses_day_in"],
        "只有落在 [dayStart, dayStart + 86400000) 内的会话返回",
      )
    } finally {
      database.close()
    }
  },
)

test(
  "real-SQL: the day filter composes with the directory filter (intersection)",
  { skip: skipReason },
  () => {
    const database = createDayFixtureDatabase([
      { id: "ses_day_stack_alpha_in", directory: "D:/projects/example-alpha", timeUpdated: PINNED_DAY_START_MS + 1 },
      { id: "ses_day_stack_alpha_out", directory: "D:/projects/example-alpha", timeUpdated: PINNED_DAY_START_MS + DAY_MS },
      { id: "ses_day_stack_beta_in", directory: "D:/projects/example-beta", timeUpdated: PINNED_DAY_START_MS + 2 },
    ])
    try {
      const sessionPage = querySessionList(
        database as unknown as SqliteReadConnection,
        500,
        0,
        undefined,
        undefined,
        "D:/projects/example-alpha",
        null,
        PINNED_DAY_START_MS,
      )
      assert.ok(sessionPage !== null)
      assert.deepEqual(
        sessionPage.map((sessionSummary) => sessionSummary.id),
        ["ses_day_stack_alpha_in"],
        "directory 与 day 是交集：alpha 目录里只有当天那条存活",
      )
    } finally {
      database.close()
    }
  },
)

test("null dayStartMs applies no day filter (full list)", { skip: skipReason }, () => {
  const database = createDayFixtureDatabase([
    { id: "ses_day_unfiltered_a", directory: "", timeUpdated: PINNED_DAY_START_MS + 1 },
    { id: "ses_day_unfiltered_b", directory: "", timeUpdated: PINNED_DAY_START_MS + DAY_MS },
  ])
  try {
    const sessionPage = querySessionList(
      database as unknown as SqliteReadConnection,
      500,
      0,
      undefined,
      undefined,
      null,
      null,
      null,
    )
    assert.ok(sessionPage !== null)
    assert.equal(sessionPage.length, 2, "缺省 dayStartMs 不过滤")
  } finally {
    database.close()
  }
})
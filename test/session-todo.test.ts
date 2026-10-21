/**
 * Per-session todo view tests:
 * - 纯函数（src/stats/session-todo.ts）：状态秩排序优先于 position、多条
 *   in_progress 按 position 升序、cancelled / 未知状态被丢弃、隐藏规则
 *   （只剩 completed 或空 → null，有 pending → 非 null）、分页 pageCount
 *   与 pageIndex 的取整 / clamp；
 * - 查询层（src/db/session-todo-queries.ts）：真实 :memory: SQLite 夹具，
 *   验证按 session_id 收窄、position ASC 排序、字段名映射
 *   （time_created → timeCreated / time_updated → timeUpdated）、db 缺失
 *   → []（不是 null）。
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import { createRequire } from "node:module"

import type { SqliteReadConnection } from "../src/db/types.ts"
import { querySessionTodos, type SessionTodoItem } from "../src/db/session-todo-queries.ts"
import {
  buildSessionTodoView,
  SESSION_TODO_PAGE_SIZE,
} from "../src/stats/session-todo.ts"
import { clipToColumns, SIDEBAR_TODO_LABEL_MAX_COLUMNS } from "../src/tui/clip-columns.ts"

/** Build one raw todo row with the field shape the query layer emits. */
function todoItem(content: string, status: string, position: number): SessionTodoItem {
  return {
    content,
    status,
    priority: "medium",
    position,
    timeCreated: 0,
    timeUpdated: 0,
  }
}

// ---------------------------------------------------------------------------
// Pure-function layer.

test("SESSION_TODO_PAGE_SIZE is 4", () => {
  assert.equal(SESSION_TODO_PAGE_SIZE, 4)
})

test("buildSessionTodoView ranks by status before position", () => {
  // position order (0,1,2) conflicts with rank order: the completed row sits
  // first by position but must render last.
  const view = buildSessionTodoView(
    [
      todoItem("done", "completed", 0),
      todoItem("todo", "pending", 1),
      todoItem("doing", "in_progress", 2),
    ],
    0,
  )
  assert.notEqual(view, null)
  assert.deepEqual(
    view!.entries.map((entry) => entry.content),
    ["doing", "todo", "done"],
  )
})

test("buildSessionTodoView orders multiple in_progress rows by position ascending", () => {
  const view = buildSessionTodoView(
    [
      todoItem("second", "in_progress", 20),
      todoItem("first", "in_progress", 10),
    ],
    0,
  )
  assert.notEqual(view, null)
  assert.deepEqual(
    view!.entries.map((entry) => entry.content),
    ["first", "second"],
  )
})

test("buildSessionTodoView drops cancelled and unknown statuses", () => {
  const view = buildSessionTodoView(
    [
      todoItem("keep", "pending", 1),
      todoItem("gone-cancelled", "cancelled", 2),
      todoItem("gone-unknown", "archived", 3),
    ],
    0,
  )
  assert.notEqual(view, null)
  assert.deepEqual(
    view!.entries.map((entry) => entry.content),
    ["keep"],
  )
})

test("buildSessionTodoView hides the view when no open work remains", () => {
  // Only completed → null.
  assert.equal(
    buildSessionTodoView(
      [todoItem("done-a", "completed", 1), todoItem("done-b", "completed", 2)],
      0,
    ),
    null,
  )
  // Empty → null.
  assert.equal(buildSessionTodoView([], 0), null)
  // cancelled + completed (no open work) → null.
  assert.equal(
    buildSessionTodoView(
      [todoItem("gone", "cancelled", 1), todoItem("done", "completed", 2)],
      0,
    ),
    null,
  )
  // A single pending keeps the view alive.
  assert.notEqual(buildSessionTodoView([todoItem("todo", "pending", 1)], 0), null)
})

test("buildSessionTodoView paginates and clamps the page index", () => {
  // 10 rows: 1 pending + 9 completed → pageCount 3.
  const items: SessionTodoItem[] = [todoItem("open", "pending", 0)]
  for (let index = 1; index < 10; index += 1) {
    items.push(todoItem(`done-${index}`, "completed", index))
  }

  const firstPage = buildSessionTodoView(items, 0)
  assert.notEqual(firstPage, null)
  assert.equal(firstPage!.pageCount, 3)
  assert.equal(firstPage!.pageIndex, 0)
  assert.equal(firstPage!.entries.length, SESSION_TODO_PAGE_SIZE)

  // Last page holds the remaining 2 entries.
  const lastPage = buildSessionTodoView(items, 2)
  assert.equal(lastPage!.pageIndex, 2)
  assert.equal(lastPage!.entries.length, 2)

  // Negative index clamps to 0.
  assert.equal(buildSessionTodoView(items, -5)!.pageIndex, 0)
  // Above the upper bound clamps to pageCount - 1.
  assert.equal(buildSessionTodoView(items, 99)!.pageIndex, 2)
  // Rounding happens before clamping (1.6 → 2).
  assert.equal(buildSessionTodoView(items, 1.6)!.pageIndex, 2)
})

test("buildSessionTodoView page boundaries at the page-size edges", () => {
  const fourItems: SessionTodoItem[] = [todoItem("open", "pending", 0)]
  for (let index = 1; index < 4; index += 1) {
    fourItems.push(todoItem(`done-${index}`, "completed", index))
  }
  const onePageView = buildSessionTodoView(fourItems, 0)
  assert.notEqual(onePageView, null)
  assert.equal(onePageView!.pageCount, 1)

  const fiveItems: SessionTodoItem[] = [...fourItems, todoItem("done-4", "completed", 4)]
  const twoPageView = buildSessionTodoView(fiveItems, 0)
  assert.notEqual(twoPageView, null)
  assert.equal(twoPageView!.pageCount, 2)
})

// ---------------------------------------------------------------------------
// Query layer against real SQLite.

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
    ? "node:sqlite unavailable — skipping session-todo SQL tests"
    : false

test("querySessionTodos returns [] when the db connection is missing", () => {
  assert.deepEqual(querySessionTodos(null, "ses_any"), [])
})

interface TodoFixtureRow {
  content: string
  status: string
  priority: string
  position: number
  timeCreated: number
  timeUpdated: number
}

function createTodoFixtureDatabase(
  rowsBySessionId: Record<string, TodoFixtureRow[]>,
): SqliteReadWriteConnection {
  const fixtureDatabase = new readWriteConstructor!(":memory:")
  fixtureDatabase.exec(
    `CREATE TABLE todo (
       session_id TEXT,
       content TEXT,
       status TEXT,
       priority TEXT,
       position INTEGER,
       time_created INTEGER,
       time_updated INTEGER
     )`,
  )
  const insertTodo = fixtureDatabase.prepare(
    "INSERT INTO todo (session_id, content, status, priority, position, time_created, time_updated) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?)",
  )
  for (const [sessionId, todoRows] of Object.entries(rowsBySessionId)) {
    for (const todoRow of todoRows) {
      insertTodo.run(
        sessionId,
        todoRow.content,
        todoRow.status,
        todoRow.priority,
        todoRow.position,
        todoRow.timeCreated,
        todoRow.timeUpdated,
      )
    }
  }
  return fixtureDatabase
}

function createSessionV2Table(
  fixtureDatabase: SqliteReadWriteConnection,
  sessionIds: readonly string[],
): void {
  fixtureDatabase.exec("CREATE TABLE session_v2 (id TEXT PRIMARY KEY)")
  const insertSession = fixtureDatabase.prepare("INSERT INTO session_v2 (id) VALUES (?)")
  for (const sessionId of sessionIds) insertSession.run(sessionId)
}

test("querySessionTodos scopes by session_id, orders by position, maps columns", { skip: skipReason }, () => {
  const fixtureDatabase = createTodoFixtureDatabase({
    ses_target: [
      // Insertion order (written last-to-first by position) proves ORDER BY
      // position ASC rather than insertion order.
      { content: "second", status: "pending", priority: "high", position: 2, timeCreated: 300, timeUpdated: 330 },
      { content: "first", status: "in_progress", priority: "medium", position: 1, timeCreated: 100, timeUpdated: 130 },
    ],
    ses_other: [
      { content: "not-mine", status: "pending", priority: "low", position: 1, timeCreated: 900, timeUpdated: 930 },
    ],
  })
  try {
    const todoItems = querySessionTodos(fixtureDatabase, "ses_target")
    assert.deepEqual(todoItems, [
      {
        content: "first",
        status: "in_progress",
        priority: "medium",
        position: 1,
        timeCreated: 100,
        timeUpdated: 130,
      },
      {
        content: "second",
        status: "pending",
        priority: "high",
        position: 2,
        timeCreated: 300,
        timeUpdated: 330,
      },
    ])

    // A session with no rows yields an empty list, not null.
    assert.deepEqual(querySessionTodos(fixtureDatabase, "ses_absent"), [])
  } finally {
    fixtureDatabase.close()
  }
})

test("querySessionTodos anchors on session_v2 so a session removed from it cannot keep a Todos block", { skip: skipReason }, () => {
  const fixtureDatabase = createTodoFixtureDatabase({
    ses_live: [
      { content: "still here", status: "in_progress", priority: "high", position: 1, timeCreated: 100, timeUpdated: 130 },
    ],
    // Present in the legacy `session` table but gone from `session_v2`: the todo
    // row survives because the foreign key points at `session`, not `session_v2`.
    ses_stray: [
      { content: "orphan work", status: "pending", priority: "high", position: 1, timeCreated: 200, timeUpdated: 230 },
    ],
  })
  try {
    createSessionV2Table(fixtureDatabase, ["ses_live"])

    assert.deepEqual(
      querySessionTodos(fixtureDatabase, "ses_live").map((item) => item.content),
      ["still here"],
    )
    // Without the anchor this returned the orphan row, and the sidebar showed a
    // Todos block for a session whose replay page reports "旧表会话".
    assert.deepEqual(querySessionTodos(fixtureDatabase, "ses_stray"), [])
  } finally {
    fixtureDatabase.close()
  }
})

test("querySessionTodos degrades to the unanchored query when the database has no session_v2 table", { skip: skipReason }, () => {
  const fixtureDatabase = createTodoFixtureDatabase({
    ses_legacy: [
      { content: "legacy work", status: "pending", priority: "medium", position: 1, timeCreated: 100, timeUpdated: 130 },
    ],
  })
  try {
    // No createSessionV2Table call: this is the old-schema / fixture shape.
    // Throwing here would take the whole sidebar block down with it.
    assert.deepEqual(
      querySessionTodos(fixtureDatabase, "ses_legacy").map((item) => item.content),
      ["legacy work"],
    )
  } finally {
    fixtureDatabase.close()
  }
})

// ---------------------------------------------------------------------------
// Sidebar label clipping (src/tui/clip-columns.ts).
//
// The sidebar is ~44 columns wide; a long todo used to push its caret glyph
// off-screen. These pin the two invariants the block relies on: never exceed
// the column budget, and always mark where the text was cut.

test("clipToColumns leaves short ASCII labels untouched", () => {
  assert.equal(clipToColumns("run the tests"), "run the tests")
})

test("clipToColumns counts CJK as two columns", () => {
  // 24 CJK glyphs = 48 columns, over the 44 budget, although the string is
  // only 24 UTF-16 code units long.
  const label = "把".repeat(24)
  const clipped = clipToColumns(label, 44)
  // 21 glyphs (42 columns) + ellipsis (1 column) is the longest that fits.
  assert.equal(clipped, `${"把".repeat(21)}…`)
})

test("clipToColumns never exceeds the budget for mixed text", () => {
  const budget = 20
  const clipped = clipToColumns("修复 sidebar todo 的折叠状态与分页复位缺陷，并补充测试", budget)
  let columns = 0
  for (const glyph of clipped) {
    columns += /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFF00-\uFF60]/.test(glyph) ? 2 : 1
  }
  assert.ok(columns <= budget, `expected <= ${budget} columns, got ${columns}`)
  assert.equal(clipped.endsWith("…"), true)
})

test("clipToColumns returns empty output for a non-positive budget", () => {
  assert.equal(clipToColumns("anything", 0), "")
})

test("SIDEBAR_TODO_LABEL_MAX_COLUMNS fits a typical sidebar", () => {
  assert.ok(SIDEBAR_TODO_LABEL_MAX_COLUMNS >= 20)
  assert.ok(SIDEBAR_TODO_LABEL_MAX_COLUMNS <= 60)
})

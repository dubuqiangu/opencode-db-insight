/**
 * Tests for the session-summary CSV export (v0.8.0,
 * GET /api/export/sessions.csv):
 *
 * 1. Pure-function torture of renderSessionSummaryCsv / escapeCsvField
 *    (RFC 4180): comma / double-quote / CRLF / LF / CJK / comma-in-path /
 *    empty-field / numeric columns, plus an exact-document byte-level
 *    assertion and a round-trip through a mini RFC-4180 parser written
 *    here (quoted fields, doubled quotes, embedded newlines).
 * 2. Structural locks: UTF-8 BOM prefix, CRLF record ends (last one
 *    included), header row exactly the nine contract literals.
 * 3. End-to-end integration against a REAL node:sqlite :memory: fixture
 *    (发布清单 #2 discipline; the fake database serves insertion order,
 *    which would hide the export's default time_updated desc + id ASC
 *    ordering — so the integration runs on real SQLite): full export,
 *    ?directory= subset, miss → header-only 200, multi-page pull past
 *    the 500-row clamp ceiling.
 *
 * All fixture paths/titles are fictional placeholders (example-alpha
 * series, release checklist #3). The fixture part skips when
 * node:sqlite is unavailable; the pure-function part runs everywhere.
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import { createRequire } from "node:module"

import type {
  SessionSummary,
  SqliteReadConnection,
} from "../src/db/types.ts"
import {
  escapeCsvField,
  renderSessionSummaryCsv,
  SESSION_SUMMARY_CSV_CONTENT_TYPE,
  SESSION_SUMMARY_CSV_FILENAME,
  SESSION_SUMMARY_CSV_HEADER,
} from "../src/web/session-summary-csv.ts"
import {
  handleApiRequest,
  type ApiRequestContext,
} from "../src/web/api.ts"
import { matchApiRoute } from "../src/web/router.ts"

// ---------------------------------------------------------------------------
// Pure-function helpers

/** Convenience: a session summary fixture in the wire-derived shape. */
function buildCsvFixtureSummary(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id: "ses_csv_normal",
    title: "normal title",
    modelId: "glm-5.3",
    agent: "fixer",
    directory: "D:/projects/example-alpha",
    timeCreated: 1000,
    timeUpdated: 2000,
    tokens: 123,
    cost: 0.5,
    ...overrides,
  }
}

/**
 * Mini RFC 4180 parser for the round-trip assertions: strips the BOM,
 * understands quoted fields, doubled quotes, embedded CR/LF and the
 * CRLF record separator. Deliberately independent of the writer — a
 * bug where escaping and parsing agree on the same mistake cannot
 * hide (the expected values below are hand-written literals).
 */
function parseCsvDocument(csvDocument: string): string[][] {
  const documentText = csvDocument.startsWith("\uFEFF") ? csvDocument.slice(1) : csvDocument
  const parsedRecords: string[][] = []
  let parsedRecord: string[] = []
  let currentField = ""
  let insideQuotedField = false
  let characterIndex = 0
  const pushField = () => {
    parsedRecord.push(currentField)
    currentField = ""
  }
  while (characterIndex < documentText.length) {
    const currentCharacter = documentText[characterIndex]
    if (insideQuotedField) {
      if (currentCharacter === '"') {
        if (documentText[characterIndex + 1] === '"') {
          currentField += '"'
          characterIndex += 2
          continue
        }
        insideQuotedField = false
        characterIndex += 1
        continue
      }
      currentField += currentCharacter
      characterIndex += 1
      continue
    }
    if (currentCharacter === '"') {
      insideQuotedField = true
      characterIndex += 1
      continue
    }
    if (currentCharacter === ",") {
      pushField()
      characterIndex += 1
      continue
    }
    if (currentCharacter === "\r" && documentText[characterIndex + 1] === "\n") {
      pushField()
      parsedRecords.push(parsedRecord)
      parsedRecord = []
      characterIndex += 2
      continue
    }
    currentField += currentCharacter
    characterIndex += 1
  }
  if (parsedRecord.length > 0 || currentField !== "") {
    pushField()
    parsedRecords.push(parsedRecord)
  }
  return parsedRecords
}

// ---------------------------------------------------------------------------
// 1. Pure-function torture

test("escapeCsvField follows RFC 4180: quote only structural characters", () => {
  assert.equal(escapeCsvField("plain"), "plain")
  assert.equal(escapeCsvField("hello, world"), '"hello, world"', "comma → wrap")
  assert.equal(escapeCsvField('say "hi"'), '"say ""hi"""', "quotes → wrap and double")
  assert.equal(escapeCsvField("line one\r\nline two"), '"line one\r\nline two"', "CRLF → wrap")
  assert.equal(escapeCsvField("unix\nline"), '"unix\nline"', "bare LF → wrap too")
  assert.equal(escapeCsvField("导出测试会话"), "导出测试会话", "CJK alone stays bare")
  assert.equal(escapeCsvField(""), "", "empty field stays empty, unquoted")
})

test("renderSessionSummaryCsv emits byte-exact rows for every torture shape", () => {
  const singleRowDocument = (sessionSummary: SessionSummary) =>
    renderSessionSummaryCsv([sessionSummary])

  // Normal row: nothing quoted, numeric columns bare.
  assert.equal(
    singleRowDocument(buildCsvFixtureSummary()),
    "\uFEFF" +
      SESSION_SUMMARY_CSV_HEADER +
      "\r\n" +
      "ses_csv_normal,normal title,glm-5.3,fixer,D:/projects/example-alpha,1000,2000,123,0.5" +
      "\r\n",
  )

  // Comma title.
  assert.equal(
    singleRowDocument(buildCsvFixtureSummary({ id: "ses_csv_comma", title: "hello, world" })),
    "\uFEFF" +
      SESSION_SUMMARY_CSV_HEADER +
      "\r\n" +
      'ses_csv_comma,"hello, world",glm-5.3,fixer,D:/projects/example-alpha,1000,2000,123,0.5' +
      "\r\n",
  )

  // Embedded double quotes double up inside the wrap.
  assert.equal(
    singleRowDocument(buildCsvFixtureSummary({ id: "ses_csv_quote", title: 'say "hi"' })),
    "\uFEFF" +
      SESSION_SUMMARY_CSV_HEADER +
      "\r\n" +
      'ses_csv_quote,"say ""hi""",glm-5.3,fixer,D:/projects/example-alpha,1000,2000,123,0.5' +
      "\r\n",
  )

  // CRLF and bare-LF titles ride inside the quoted wrap.
  assert.equal(
    singleRowDocument(
      buildCsvFixtureSummary({ id: "ses_csv_crlf", title: "line one\r\nline two" }),
    ),
    "\uFEFF" +
      SESSION_SUMMARY_CSV_HEADER +
      "\r\n" +
      'ses_csv_crlf,"line one\r\nline two",glm-5.3,fixer,D:/projects/example-alpha,1000,2000,123,0.5' +
      "\r\n",
  )
  assert.equal(
    singleRowDocument(buildCsvFixtureSummary({ id: "ses_csv_lf", title: "unix\nline" })),
    "\uFEFF" +
      SESSION_SUMMARY_CSV_HEADER +
      "\r\n" +
      'ses_csv_lf,"unix\nline",glm-5.3,fixer,D:/projects/example-alpha,1000,2000,123,0.5' +
      "\r\n",
  )

  // CJK title: bare, readable, Excel-decodable via the BOM.
  assert.equal(
    singleRowDocument(buildCsvFixtureSummary({ id: "ses_csv_cjk", title: "导出测试会话" })),
    "\uFEFF" +
      SESSION_SUMMARY_CSV_HEADER +
      "\r\n" +
      "ses_csv_cjk,导出测试会话,glm-5.3,fixer,D:/projects/example-alpha,1000,2000,123,0.5" +
      "\r\n",
  )

  // A comma inside the directory path wraps that field only.
  assert.equal(
    singleRowDocument(
      buildCsvFixtureSummary({
        id: "ses_csv_dir_comma",
        directory: "D:/projects/example-a,b",
      }),
    ),
    "\uFEFF" +
      SESSION_SUMMARY_CSV_HEADER +
      "\r\n" +
      'ses_csv_dir_comma,normal title,glm-5.3,fixer,"D:/projects/example-a,b",1000,2000,123,0.5' +
      "\r\n",
  )

  // Empty title and empty agent stay unquoted empty fields.
  assert.equal(
    singleRowDocument(buildCsvFixtureSummary({ id: "ses_csv_empty", title: "", agent: "" })),
    "\uFEFF" +
      SESSION_SUMMARY_CSV_HEADER +
      "\r\n" +
      "ses_csv_empty,,glm-5.3,,D:/projects/example-alpha,1000,2000,123,0.5" +
      "\r\n",
  )

  // Numeric columns never quote, whatever the magnitude.
  assert.equal(
    singleRowDocument(
      buildCsvFixtureSummary({ id: "ses_csv_numbers", tokens: 456, cost: 1.25 }),
    ),
    "\uFEFF" +
      SESSION_SUMMARY_CSV_HEADER +
      "\r\n" +
      "ses_csv_numbers,normal title,glm-5.3,fixer,D:/projects/example-alpha,1000,2000,456,1.25" +
      "\r\n",
  )
})

// ---------------------------------------------------------------------------
// 2. Structural locks: BOM, CRLF, header

test("the document starts with the BOM + nine-literal header and ends with CRLF", () => {
  const csvDocument = renderSessionSummaryCsv([
    buildCsvFixtureSummary(),
    buildCsvFixtureSummary({ id: "ses_csv_second" }),
  ])

  assert.ok(csvDocument.startsWith("\uFEFF"), "UTF-8 BOM prefixes the document")
  assert.ok(csvDocument.endsWith("\r\n"), "the last record is CRLF-terminated too")
  // Header row byte-level: BOM + the nine contract literals.
  assert.equal(csvDocument.split("\r\n")[0], "\uFEFF" + SESSION_SUMMARY_CSV_HEADER)
  assert.equal(
    SESSION_SUMMARY_CSV_HEADER,
    "id,title,modelId,agent,directory,timeCreated,timeUpdated,tokens,cost",
  )
  // Two data rows + header + trailing CRLF ⇒ four split fragments.
  assert.equal(csvDocument.split("\r\n").length, 4)

  // The header-only document (empty summary list).
  const headerOnlyDocument = renderSessionSummaryCsv([])
  assert.equal(headerOnlyDocument, "\uFEFF" + SESSION_SUMMARY_CSV_HEADER + "\r\n")
})

test("torture batch round-trips through the mini parser field by field", () => {
  const tortureSummaries: SessionSummary[] = [
    buildCsvFixtureSummary(),
    buildCsvFixtureSummary({ id: "ses_csv_comma", title: "hello, world" }),
    buildCsvFixtureSummary({ id: "ses_csv_quote", title: 'say "hi"' }),
    buildCsvFixtureSummary({ id: "ses_csv_crlf", title: "line one\r\nline two" }),
    buildCsvFixtureSummary({ id: "ses_csv_lf", title: "unix\nline" }),
    buildCsvFixtureSummary({ id: "ses_csv_cjk", title: "导出测试会话" }),
    buildCsvFixtureSummary({
      id: "ses_csv_dir_comma",
      directory: "D:/projects/example-a,b",
    }),
    buildCsvFixtureSummary({ id: "ses_csv_empty", title: "", agent: "" }),
    buildCsvFixtureSummary({ id: "ses_csv_numbers", tokens: 456, cost: 1.25 }),
  ]

  const parsedRecords = parseCsvDocument(renderSessionSummaryCsv(tortureSummaries))
  assert.equal(parsedRecords.length, tortureSummaries.length + 1)
  assert.deepEqual(parsedRecords[0], SESSION_SUMMARY_CSV_HEADER.split(","))

  for (let summaryIndex = 0; summaryIndex < tortureSummaries.length; summaryIndex += 1) {
    const sourceSummary = tortureSummaries[summaryIndex]
    assert.deepEqual(
      parsedRecords[summaryIndex + 1],
      [
        sourceSummary.id,
        sourceSummary.title,
        sourceSummary.modelId,
        sourceSummary.agent,
        sourceSummary.directory,
        String(sourceSummary.timeCreated),
        String(sourceSummary.timeUpdated),
        String(sourceSummary.tokens),
        String(sourceSummary.cost),
      ],
      `row ${summaryIndex} must round-trip every field, embedded newlines included`,
    )
  }
})

// ---------------------------------------------------------------------------
// 3. Real-SQLite end-to-end integration

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
    ? "node:sqlite unavailable — skipping CSV export integration tests"
    : false

const MODEL_COLUMN_TEXT = '{"id":"glm-5.3","providerID":"futureppo"}'

/** A fresh in-memory database with the multi-directory fixture rows. */
function createCsvFixtureDatabase(): SqliteReadWriteConnection {
  const database = new readWriteConstructor!(":memory:")
  database.exec(
    "CREATE TABLE session_v2 (" +
      "id TEXT, title TEXT, model TEXT, agent TEXT, directory TEXT, " +
      "time_created INTEGER, time_updated INTEGER, " +
      "tokens_input REAL, tokens_output REAL, tokens_cache_read REAL, cost REAL);",
  )
  const insertSession = database.prepare(
    "INSERT INTO session_v2 (id, title, model, agent, directory, time_created, time_updated, " +
      "tokens_input, tokens_output, tokens_cache_read, cost) " +
      "VALUES (?, ?, ?, 'fixer', ?, 1000, ?, 100, 20, 30, 0.5)",
  )
  const fixtureRows: { id: string; directory: string; timeUpdated: number }[] = [
    { id: "ses_csv_int_alpha", directory: "D:/projects/example-alpha", timeUpdated: 5000 },
    { id: "ses_csv_int_bravo", directory: "D:/projects/example-alpha", timeUpdated: 9000 },
    { id: "ses_csv_int_charlie", directory: "D:/projects/example-beta", timeUpdated: 7000 },
    { id: "ses_csv_int_delta", directory: "D:/projects/example-beta", timeUpdated: 7000 },
    { id: "ses_csv_int_echo", directory: "D:/projects/example 中文", timeUpdated: 6000 },
  ]
  for (const fixtureRow of fixtureRows) {
    insertSession.run(fixtureRow.id, `标题 ${fixtureRow.id}`, MODEL_COLUMN_TEXT, fixtureRow.directory, fixtureRow.timeUpdated)
  }
  return database
}

function csvContextFor(database: SqliteReadConnection, queryString: string): ApiRequestContext {
  const sessionsCsvRoute = matchApiRoute("/api/export/sessions.csv")
  assert.notEqual(sessionsCsvRoute, null)
  return {
    route: sessionsCsvRoute!,
    searchParams: new URLSearchParams(queryString),
    database,
    databasePath: "test://csv-fixture",
    serverPort: 18789,
  }
}

test(
  "real-SQL integration: the export route serves the default snapshot, the directory subset and the header-only miss",
  { skip: skipReason },
  () => {
    const database = createCsvFixtureDatabase()
    try {
      const readOnlyConnection = database as unknown as SqliteReadConnection

      // Default: the whole list in the fixed snapshot order — newest
      // first, the 7000 tie decided by id ASC. (Real SQLite, because
      // the fake serves insertion order and would hide this.)
      const defaultResponse = handleApiRequest(csvContextFor(readOnlyConnection, ""))
      assert.equal(defaultResponse.statusCode, 200)
      assert.equal(defaultResponse.rawText!.contentType, SESSION_SUMMARY_CSV_CONTENT_TYPE)
      assert.equal(
        defaultResponse.rawText!.headers["Content-Disposition"],
        `attachment; filename="${SESSION_SUMMARY_CSV_FILENAME}"`,
      )
      const defaultRecords = parseCsvDocument(defaultResponse.rawText!.text)
      assert.deepEqual(
        defaultRecords.slice(1).map((record) => record[0]),
        [
          "ses_csv_int_bravo", // 9000
          "ses_csv_int_charlie", // 7000 tie → id ASC
          "ses_csv_int_delta",
          "ses_csv_int_echo", // 6000
          "ses_csv_int_alpha", // 5000
        ],
        "rows follow the sessions default order, not insertion order",
      )

      // ?directory= reuses the drill-down contract: exact-match subset.
      const alphaResponse = handleApiRequest(
        csvContextFor(readOnlyConnection, "directory=D%3A%2Fprojects%2Fexample-alpha"),
      )
      assert.equal(alphaResponse.statusCode, 200)
      const alphaRecords = parseCsvDocument(alphaResponse.rawText!.text)
      assert.deepEqual(
        alphaRecords.slice(1).map((record) => record[0]),
        ["ses_csv_int_bravo", "ses_csv_int_alpha"],
        "the filtered export contains only same-directory rows",
      )

      // An empty ?directory= is the same "no filter" request.
      const emptyFilterResponse = handleApiRequest(
        csvContextFor(readOnlyConnection, "directory="),
      )
      assert.equal(emptyFilterResponse.rawText!.text, defaultResponse.rawText!.text)

      // A miss yields a header-only CSV with 200 — filter semantics, not
      // fallback, not an error.
      const missResponse = handleApiRequest(
        csvContextFor(readOnlyConnection, "directory=D%3A%2Fprojects%2Fexample-nowhere"),
      )
      assert.equal(missResponse.statusCode, 200)
      assert.equal(missResponse.rawText!.text, "\uFEFF" + SESSION_SUMMARY_CSV_HEADER + "\r\n")
    } finally {
      database.close()
    }
  },
)

test(
  "real-SQL integration: the export pages past the 500-row clamp ceiling and terminates on a short page",
  { skip: skipReason },
  () => {
    const database = new readWriteConstructor!(":memory:")
    try {
      database.exec(
        "CREATE TABLE session_v2 (" +
          "id TEXT, title TEXT, model TEXT, agent TEXT, directory TEXT, " +
          "time_created INTEGER, time_updated INTEGER, " +
          "tokens_input REAL, tokens_output REAL, tokens_cache_read REAL, cost REAL);",
      )
      const insertSession = database.prepare(
        "INSERT INTO session_v2 (id, title, model, agent, directory, time_created, time_updated, " +
          "tokens_input, tokens_output, tokens_cache_read, cost) " +
          "VALUES (?, 'snapshot row', ?, 'fixer', 'D:/projects/example-alpha', 1000, ?, 1, 1, 1, 0.1)",
      )
      // 502 rows: page 1 (500) + a 2-row short page.
      for (let rowIndex = 0; rowIndex < 502; rowIndex += 1) {
        insertSession.run(
          `ses_csv_page_${String(rowIndex).padStart(3, "0")}`,
          MODEL_COLUMN_TEXT,
          rowIndex,
        )
      }

      const readOnlyConnection = database as unknown as SqliteReadConnection
      const exportResponse = handleApiRequest(csvContextFor(readOnlyConnection, ""))
      assert.equal(exportResponse.statusCode, 200)
      const exportRecords = parseCsvDocument(exportResponse.rawText!.text)
      assert.equal(exportRecords.length, 503, "header + every one of the 502 rows")
      assert.equal(
        exportRecords[1][0],
        "ses_csv_page_501",
        "the first data row is the newest (time_updated desc)",
      )
      assert.equal(exportRecords[502][0], "ses_csv_page_000", "the oldest row closes the export")
    } finally {
      database.close()
    }
  },
)

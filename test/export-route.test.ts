/**
 * Tests for the export API route (T5.1): router matching, the
 * handleApiRequest sessionExport handler (against a fake database), the
 * by-id session lookup, and one live-server fetch of the real route.
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { matchApiRoute } from "../src/web/router.ts"
import {
  handleApiRequest,
  findSessionSummaryById,
  SESSION_NOT_FOUND_MESSAGE,
  SESSION_EMPTY_MESSAGE,
  DATABASE_UNAVAILABLE_MESSAGE,
} from "../src/web/api.ts"
import { openOpencodeDb, querySessionList, querySessionMessages } from "../src/db/queries.ts"
import { startInsightServer } from "../src/web/server.ts"
import {
  buildFakeSessionSummary,
  createFakeInsightDatabase,
} from "./helpers/fake-insight-db.ts"

test("router matches /api/export/session/:id.md and tolerates encoded ids", () => {
  assert.deepEqual(matchApiRoute("/api/export/session/ses_abc.md"), {
    routeName: "sessionExport",
    sessionId: "ses_abc",
  })
  assert.deepEqual(matchApiRoute("/api/export/session/ses%20abc.md/"), {
    routeName: "sessionExport",
    sessionId: "ses abc",
  })
})

test("router rejects malformed export paths", () => {
  assert.equal(matchApiRoute("/api/export/session/ses_abc"), null, "missing .md suffix")
  assert.equal(matchApiRoute("/api/export/session/ses_abc.txt"), null, "wrong extension")
  assert.equal(matchApiRoute("/api/export/session/.md"), null, "empty session id")
  assert.equal(matchApiRoute("/api/export/session/ses_abc.md/extra"), null, "extra segment")
  assert.equal(matchApiRoute("/api/export/other/ses_abc.md"), null, "unknown collection")
  assert.equal(matchApiRoute("/api/export/session/ses_%zz.md"), null, "malformed encoding")
})

function buildExportRequestContext(database: Parameters<typeof handleApiRequest>[0]["database"]) {
  return {
    route: matchApiRoute("/api/export/session/ses_export_fixture.md")!,
    searchParams: new URLSearchParams(),
    database,
    databasePath: "fake",
    serverPort: 18789,
  }
}

test("sessionExport handler renders markdown with download headers", () => {
  const fakeDatabase = createFakeInsightDatabase({
    sessions: [buildFakeSessionSummary()],
    messagesBySessionId: {
      ses_export_fixture: [
        { type: "user", data: { text: "帮我修复登录 bug" } },
        {
          type: "assistant",
          data: {
            agent: "fixer",
            model: { id: "glm-5.3", providerID: "futureppo" },
            content: [{ type: "text", text: "已定位问题。" }],
          },
        },
      ],
    },
    systemPromptBySessionId: {
      ses_export_fixture: { "core/environment": "环境提示词" },
    },
  })

  const apiResponse = handleApiRequest(buildExportRequestContext(fakeDatabase))
  assert.equal(apiResponse.statusCode, 200)
  assert.ok(apiResponse.rawText, "export must bypass the JSON body convention")

  assert.equal(apiResponse.rawText!.contentType, "text/markdown; charset=utf-8")
  const dispositionHeader = apiResponse.rawText!.headers["Content-Disposition"] ?? ""
  assert.ok(dispositionHeader.startsWith("attachment;"))
  assert.ok(
    dispositionHeader.includes(`filename*=UTF-8''${encodeURIComponent("2026-10-05-导出测试会话.md")}`),
    `the real UTF-8 filename must travel via filename*: ${dispositionHeader}`,
  )
  assert.match(dispositionHeader, /filename="[^"]*\.md"/, "an ASCII fallback must be present")

  assert.ok(apiResponse.rawText!.text.includes("# 导出测试会话"))
  assert.ok(apiResponse.rawText!.text.includes("## 🧑 用户"))
  assert.ok(apiResponse.rawText!.text.includes("## 🤖 助手"))
  assert.ok(apiResponse.rawText!.text.includes("## 📋 系统提示词"))
})

test("sessionExport handler 404s unknown ids and sessions without messages", () => {
  const fakeDatabase = createFakeInsightDatabase({
    sessions: [buildFakeSessionSummary()],
    messagesBySessionId: {},
    systemPromptBySessionId: {},
  })

  const unknownRouteContext = {
    ...buildExportRequestContext(fakeDatabase),
    route: matchApiRoute("/api/export/session/ses_missing.md")!,
  }
  const unknownResponse = handleApiRequest(unknownRouteContext)
  assert.equal(unknownResponse.statusCode, 404)
  assert.deepEqual(unknownResponse.body, { error: SESSION_NOT_FOUND_MESSAGE })
  assert.equal(unknownResponse.rawText, undefined)

  // The session exists in session_v2 but has no messages: a different 404
  // message so callers can tell it apart from unknown ids (P2-7).
  const noMessagesResponse = handleApiRequest(buildExportRequestContext(fakeDatabase))
  assert.equal(noMessagesResponse.statusCode, 404)
  assert.deepEqual(noMessagesResponse.body, { error: SESSION_EMPTY_MESSAGE })
})

test("sessionExport handler answers 503 while the database is unavailable", () => {
  const apiResponse = handleApiRequest(buildExportRequestContext(null))
  assert.equal(apiResponse.statusCode, 503)
  assert.deepEqual(apiResponse.body, { error: DATABASE_UNAVAILABLE_MESSAGE })
})

test("findSessionSummaryById answers by direct id lookup, however many sessions exist", () => {
  // 600 sessions: the target sits past the first page of the old scan.
  const manySessions = Array.from({ length: 600 }, (_unused, sessionIndex) =>
    buildFakeSessionSummary({ id: `ses_scan_${sessionIndex}` }),
  )
  manySessions[520] = buildFakeSessionSummary({ id: "ses_scan_target" })
  const fakeDatabase = createFakeInsightDatabase({
    sessions: manySessions,
    messagesBySessionId: {},
    systemPromptBySessionId: {},
  })

  assert.equal(findSessionSummaryById(fakeDatabase, "ses_scan_target")?.id, "ses_scan_target")
  assert.equal(findSessionSummaryById(fakeDatabase, "ses_absent_everywhere") ?? null, null)
  assert.equal(
    findSessionSummaryById(fakeDatabase, "ses_scan_0")?.id,
    "ses_scan_0",
    "the first session is found too",
  )
})

// ---------------------------------------------------------------------------
// Live-server integration (skips when opencode.db is absent on the machine).

const databaseProbeConnection = openOpencodeDb()
const skipReasonForLiveDatabase: string | false =
  databaseProbeConnection === null
    ? "opencode.db not found on this machine — skipping live export integration tests"
    : false
databaseProbeConnection?.close()

/** Find a recent session that actually has a user message to export. */
function findLiveSessionWithUserMessage(): string | null {
  const databaseConnection = openOpencodeDb()
  if (databaseConnection === null) return null
  try {
    const recentSessions = querySessionList(databaseConnection, 20, 0) ?? []
    for (const sessionSummary of recentSessions) {
      const messageRecords = querySessionMessages(databaseConnection, sessionSummary.id) ?? []
      if (messageRecords.some((messageRecord) => messageRecord.type === "user")) {
        return sessionSummary.id
      }
    }
    return null
  } finally {
    databaseConnection.close()
  }
}

test("live server serves the export route with markdown body and headers", {
  skip: skipReasonForLiveDatabase,
}, async () => {
  const exportableSessionId = findLiveSessionWithUserMessage()
  if (exportableSessionId === null) return // no exportable session in this db

  const serverHandle = await startInsightServer({ port: 0 })
  try {
    const exportResponse = await fetch(
      `http://127.0.0.1:${serverHandle.port}/api/export/session/${encodeURIComponent(exportableSessionId)}.md`,
    )
    assert.equal(exportResponse.status, 200)
    assert.equal(
      exportResponse.headers.get("content-type"),
      "text/markdown; charset=utf-8",
    )
    const dispositionHeader = exportResponse.headers.get("content-disposition") ?? ""
    assert.ok(dispositionHeader.startsWith("attachment;"), dispositionHeader)
    assert.ok(dispositionHeader.includes(".md"))

    const markdownBody = await exportResponse.text()
    assert.ok(markdownBody.includes("## 🧑 用户"), "role sections must be present")
    assert.ok(/^# /m.test(markdownBody), "the header heading must be present")

    const unknownExportResponse = await fetch(
      `http://127.0.0.1:${serverHandle.port}/api/export/session/ses_does_not_exist_anywhere.md`,
    )
    assert.equal(unknownExportResponse.status, 404)
    assert.deepEqual(JSON.parse(await unknownExportResponse.text()), {
      error: SESSION_NOT_FOUND_MESSAGE,
    })
  } finally {
    await serverHandle.close()
  }
})

test("live server keeps /api/export unavailable-safe when the database is missing", async () => {
  const missingDatabasePath = join(tmpdir(), "opencode-insight-missing-database.sqlite")
  const serverHandle = await startInsightServer({ port: 0, databasePath: missingDatabasePath })
  try {
    const exportResponse = await fetch(
      `http://127.0.0.1:${serverHandle.port}/api/export/session/ses_any.md`,
    )
    assert.equal(exportResponse.status, 503)
    const errorBody = JSON.parse(await exportResponse.text()) as { error: string }
    assert.ok(typeof errorBody.error === "string")
  } finally {
    await serverHandle.close()
  }
})

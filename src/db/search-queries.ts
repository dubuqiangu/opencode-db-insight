/**
 * 跨会话全文搜索（v0.24.0 GET /api/search）。
 *
 * 后端侧做子串 / 正则匹配：SELECT 全部 user/assistant 消息行，解析 data
 * JSON，经 message-text-extract.ts 构建可搜索文本，然后逐条匹配。搜索命中
 * 的文本与回放页渲染的文本同源（同一提取函数），不存在「搜得到却渲染
 * 不出来」的错位。
 *
 * 契约要点：
 * - 只扫 type IN ('user','assistant')；其它类型（system / idle / synthetic /
 *   compaction ...）不在搜索范围。
 * - 子串模式大小写不敏感；正则模式构造不区分大小写的 RegExp，语法非法
 *   时返回 { hits:[], total:0, error:"invalid regex" }（200，不是 500）。
 * - 命中上限 200（按 messageId 去重）；total 是真实全量匹配数。
 * - snippet 是首个命中点附近 ~120 字符的窗口，截断侧补 "…"。
 * - db 为 null（库不可用）时返回 null，调用方（api.ts）在 503 短接处理。
 */

import type { SqliteReadConnection } from "./types.ts"
import { asRecord } from "./rows.ts"
import { buildSearchableMessageText } from "./message-text-extract.ts"

/** 单个搜索命中载荷（契约定稿，与前端 wire 形状一致）。 */
export interface CrossSessionSearchHit {
  sessionId: string
  sessionTitle: string
  messageId: string
  messageType: string
  snippet: string
  hitCount: number
}

/** GET /api/search 的完整载荷。 */
export interface CrossSessionSearchResult {
  query: string
  mode: "substring" | "regex"
  hits: CrossSessionSearchHit[]
  total: number
  error?: string
}

/** 命中上限：超出只返回前 200 条，total 仍是全量匹配数。 */
const SEARCH_HIT_CAP = 200

/** snippet 目标长度（~120 字符窗口）。 */
const SNIPPET_WINDOW_CHARS = 120

/**
 * 在原始文本中构造首个命中点的 ~120 字符窗口。中心对齐命中点，两侧
 * 截断处补 "…"。返回 HTML 安全的 snippet：文本先 escapeHtml，再把首个
 * 命中段包进 <mark>（前端契约：snippet 是「除 <mark> 外无其他标签的安全
 * 富文本」，见 search-panel.js）。命中词来自外部消息文本，必须转义后才能
 * 原样透传给 innerHTML，否则消息里的 "<" 会当标签解析（XSS 面）。
 */
function buildSnippetAroundMatch(
  originalText: string,
  matchIndex: number,
  matchLength: number,
): string {
  const windowRadius = Math.floor((SNIPPET_WINDOW_CHARS - matchLength) / 2)
  const windowStart = Math.max(0, matchIndex - windowRadius)
  const windowEnd = Math.min(
    originalText.length,
    windowStart + SNIPPET_WINDOW_CHARS,
  )
  const prefixEllipsis = windowStart > 0 ? "…" : ""
  const suffixEllipsis = windowEnd < originalText.length ? "…" : ""
  // 命中段落在原始码元位置 [matchIndex, matchIndex+matchLength)。转义整段
  // 窗口后，命中段的位置不变（escapeHtml 对 &<>"' 是 1:1 码元替换），把
  // 该子区间包进 <mark>。命中段可能跨出窗口（窗口半径按命中长收缩后
  // 必然包住），也可能因窗口左/右侧截断而部分可见——仍按完整命中区间包。
  const escapedWindow = escapeHtml(originalText.slice(windowStart, windowEnd))
  const localMatchStart = matchIndex - windowStart
  const localMatchEnd = localMatchStart + matchLength
  const beforeMatch = escapedWindow.slice(0, localMatchStart)
  const matchSegment = escapedWindow.slice(localMatchStart, localMatchEnd)
  const afterMatch = escapedWindow.slice(localMatchEnd)
  return `${prefixEllipsis}${beforeMatch}<mark>${matchSegment}</mark>${afterMatch}${suffixEllipsis}`
}

/** 转义 HTML 特殊字符（< > & " '），与前端 format.js escapeHtml 同语义。 */
function escapeHtml(text: string): string {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}

/** 在原始大小写文本里定位子串匹配（大小写不敏感），返回首个命中或 -1。 */
function findSubstringMatchIndex(originalText: string, rawQuery: string): number {
  const loweredText = originalText.toLowerCase()
  const loweredQuery = rawQuery.toLowerCase()
  const loweredIndex = loweredText.indexOf(loweredQuery)
  if (loweredIndex === -1) return -1
  // 大小写转换不改变码元偏移（toLowerCase 是 1:1 的码元映射），因此
  // 小写文本里的命中偏移可直接用于原始文本切片。
  return loweredIndex
}

/** 在原始文本里定位正则首个命中，返回 { index, length } 或 null。 */
function findRegexMatch(
  originalText: string,
  caseInsensitiveRegExp: RegExp,
): { index: number; length: number } | null {
  const firstMatch = caseInsensitiveRegExp.exec(originalText)
  if (firstMatch === null) return null
  return {
    index: firstMatch.index,
    length: firstMatch[0].length,
  }
}

/**
 * 跨会话搜索主函数。db 为 null 时返回 null（调用方走 503 短接）。
 * 正则非法时返回 { query, mode, hits:[], total:0, error:"invalid regex" }。
 */
export function queryCrossSessionSearch(
  db: SqliteReadConnection | null,
  rawQuery: string,
  mode: "substring" | "regex",
): CrossSessionSearchResult | null {
  if (db === null) return null

  const query = rawQuery ?? ""
  const safeMode: "substring" | "regex" = mode === "regex" ? "regex" : "substring"

  // 空查询 / 空串：直接返回空载荷（200，不是 400）。
  if (query === "") {
    return { query: "", mode: safeMode, hits: [], total: 0 }
  }

  // 正则模式：预先编译一次，非法立即降级（200 + error，不是 500）。
  let compiledRegExp: RegExp | null = null
  if (safeMode === "regex") {
    try {
      compiledRegExp = new RegExp(query, "i")
    } catch {
      return {
        query,
        mode: safeMode,
        hits: [],
        total: 0,
        error: "invalid regex",
      }
    }
  }

  const rawRows = db
    .prepare(
      "SELECT id, session_id, type, seq, data FROM session_message " +
        "WHERE type IN ('user', 'assistant')",
    )
    .all()

  const matchedRows: Array<{
    messageId: string
    sessionId: string
    messageType: string
    snippet: string
    hitCount: number
  }> = []
  let totalMatchCount = 0
  const seenMessageIds = new Set<string>()

  for (const rawRow of rawRows) {
    const rowRecord = asRecord(rawRow)
    if (rowRecord === null) continue
    const messageId = String(rowRecord["id"] ?? "")
    if (seenMessageIds.has(messageId)) continue
    const sessionId = String(rowRecord["session_id"] ?? "")
    const messageType = String(rowRecord["type"] ?? "")
    const parsedData = parseMessageData(rowRecord["data"])
    const searchableText = buildSearchableMessageText({
      type: messageType,
      data: parsedData,
    })
    if (searchableText === "") continue

    let hitCount = 0
    let snippet: string
    if (safeMode === "substring") {
      const matchIndex = findSubstringMatchIndex(searchableText, query)
      if (matchIndex === -1) continue
      hitCount = countSubstringOccurrences(
        searchableText.toLowerCase(),
        query.toLowerCase(),
      )
      snippet = buildSnippetAroundMatch(searchableText, matchIndex, query.length)
    } else {
      const matchPosition = findRegexMatch(searchableText, compiledRegExp!)
      if (matchPosition === null) continue
      hitCount = countRegExpOccurrences(searchableText, compiledRegExp!)
      snippet = buildSnippetAroundMatch(
        searchableText,
        matchPosition.index,
        matchPosition.length,
      )
    }

    seenMessageIds.add(messageId)
    totalMatchCount += 1
    if (matchedRows.length < SEARCH_HIT_CAP) {
      matchedRows.push({
        messageId,
        sessionId,
        messageType,
        snippet,
        hitCount,
      })
    }
  }

  const hits: CrossSessionSearchHit[] = []
  if (matchedRows.length > 0) {
    const sessionTitlesBySessionId = resolveSessionTitlesByIds(
      db,
      matchedRows.map((matchedRow) => matchedRow.sessionId),
    )
    for (const matchedRow of matchedRows) {
      hits.push({
        sessionId: matchedRow.sessionId,
        sessionTitle: sessionTitlesBySessionId.get(matchedRow.sessionId) ?? "",
        messageId: matchedRow.messageId,
        messageType: matchedRow.messageType,
        snippet: matchedRow.snippet,
        hitCount: matchedRow.hitCount,
      })
    }
  }

  return { query, mode: safeMode, hits, total: totalMatchCount }
}

/** data 列：字符串 JSON.parse，否则原样对象（与 queries.ts 同口径）。 */
function parseMessageData(rawData: unknown): unknown {
  if (typeof rawData !== "string") return rawData ?? null
  try {
    return JSON.parse(rawData)
  } catch {
    return null
  }
}

/** 统计子串在（已小写的）文本中的出现次数。 */
function countSubstringOccurrences(loweredText: string, loweredQuery: string): number {
  if (loweredQuery === "") return 0
  let occurrenceCount = 0
  let searchFromIndex = 0
  for (;;) {
    const foundIndex = loweredText.indexOf(loweredQuery, searchFromIndex)
    if (foundIndex === -1) break
    occurrenceCount += 1
    searchFromIndex = foundIndex + loweredQuery.length
  }
  return occurrenceCount
}

/** 统计正则匹配在文本中的出现次数（全局扫描，不改变匹配状态机）。 */
function countRegExpOccurrences(text: string, caseInsensitiveRegExp: RegExp): number {
  let occurrenceCount = 0
  const globalRegExp = new RegExp(caseInsensitiveRegExp.source, "gi")
  let currentMatch: RegExpExecArray | null
  while ((currentMatch = globalRegExp.exec(text)) !== null) {
    occurrenceCount += 1
    if (currentMatch[0] === "") globalRegExp.lastIndex += 1
  }
  return occurrenceCount
}

/**
 * 批量解析一批会话 id 的 title（IN 下推，单条 SELECT 一次拉全）。
 * 未知 id 在结果 Map 中缺失，调用方兜底 ""。
 */
function resolveSessionTitlesByIds(
  db: SqliteReadConnection,
  sessionIds: string[],
): Map<string, string> {
  const distinctSessionIds = [...new Set(sessionIds)]
  const sessionTitlesBySessionId = new Map<string, string>()
  if (distinctSessionIds.length === 0) return sessionTitlesBySessionId
  const idPlaceholders = distinctSessionIds.map(() => "?").join(", ")
  const titleRows = db
    .prepare(`SELECT id, title FROM session_v2 WHERE id IN (${idPlaceholders})`)
    .all(...distinctSessionIds)
  for (const titleRow of titleRows) {
    const rowRecord = asRecord(titleRow)
    if (rowRecord === null) continue
    const sessionId = String(rowRecord["id"] ?? "")
    if (sessionId === "") continue
    sessionTitlesBySessionId.set(sessionId, String(rowRecord["title"] ?? ""))
  }
  return sessionTitlesBySessionId
}
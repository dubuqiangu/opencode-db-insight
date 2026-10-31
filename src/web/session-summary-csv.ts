/**
 * RFC 4180 CSV rendering of SessionSummary rows for
 * GET /api/export/sessions.csv (v0.8.0). Pure module: takes already-
 * fetched summaries, returns the complete CSV document text — no IO,
 * no db, fully unit-testable (the SQL face it rides on is locked by the
 * real-SQLite fixtures in test/session-list-sorting.test.ts and
 * test/session-directory-filter.test.ts).
 *
 * Escaping rules (RFC 4180):
 * - a field starting with a spreadsheet formula trigger (=, +, -, @,
 *   tab, CR) is prefixed with a single quote so Excel/Sheets treat it as
 *   literal text instead of executing it (CSV injection defense);
 * - a field containing a comma, a double quote, CR or LF is wrapped in
 *   double quotes as a whole;
 * - embedded double quotes are doubled inside the wrapping;
 * - every record ends with CRLF, including the last one;
 * - the document starts with a UTF-8 BOM (U+FEFF) so Excel detects the
 *   encoding and renders CJK titles correctly — without it Excel guesses
 *   ANSI and mojibakes every non-ASCII cell.
 */

import type { SessionSummary } from "../db/types.ts"

/**
 * Fixed column order of the export; the header row is exactly these
 * nine literals, comma-joined (contract: byte-level pinned by tests).
 */
export const SESSION_SUMMARY_CSV_HEADER =
  "id,title,modelId,agent,directory,timeCreated,timeUpdated,tokens,cost"

/** Content type of the CSV response body. */
export const SESSION_SUMMARY_CSV_CONTENT_TYPE = "text/csv; charset=utf-8"

/** Fixed ASCII download filename — no unicode filename* dance needed. */
export const SESSION_SUMMARY_CSV_FILENAME = "sessions.csv"

/** UTF-8 BOM prefixing the whole document (see module doc). */
const UTF8_BOM = "\uFEFF"

/**
 * Spreadsheet formula triggers: a field that *starts* with one of these
 * is interpreted as a formula (or a number) by Excel / LibreOffice /
 * Google Sheets, even inside a quoted CSV field. `title` is fully
 * user-controlled, so a title like `=HYPERLINK("http://evil")` would
 * execute on open — prefixing a single quote neutralizes it as literal
 * text.
 */
const FORMULA_TRIGGER_PATTERN = /^[=+\-@\t\r]/

/**
 * Escape one CSV field per RFC 4180. Only the three structural
 * characters trigger quoting — CJK text stays bare, which keeps the
 * file small and the diff readable. Formula triggers are neutralized
 * first (leading `'`) so the RFC-4180 quoting decision sees the final
 * text.
 */
export function escapeCsvField(fieldText: string): string {
  const neutralizedText = FORMULA_TRIGGER_PATTERN.test(fieldText) ? `'${fieldText}` : fieldText
  if (/["\r\n,]/.test(neutralizedText)) {
    return `"${neutralizedText.replace(/"/g, '""')}"`
  }
  return neutralizedText
}

/**
 * Render the full CSV document: BOM + header row + one row per session
 * summary, every record CRLF-terminated. Numeric columns come from
 * String(number) and never contain structural characters, so they are
 * never quoted; text columns (title/agent/directory) go through the
 * escaping rule above.
 */
export function renderSessionSummaryCsv(sessionSummaries: SessionSummary[]): string {
  const csvLines: string[] = [UTF8_BOM + SESSION_SUMMARY_CSV_HEADER]
  for (const sessionSummary of sessionSummaries) {
    csvLines.push(
      [
        sessionSummary.id,
        sessionSummary.title,
        sessionSummary.modelId,
        sessionSummary.agent,
        sessionSummary.directory,
        String(sessionSummary.timeCreated),
        String(sessionSummary.timeUpdated),
        String(sessionSummary.tokens),
        String(sessionSummary.cost),
      ]
        .map(escapeCsvField)
        .join(","),
    )
  }
  // RFC 4180: every record ends with CRLF, the last one included.
  return `${csvLines.join("\r\n")}\r\n`
}

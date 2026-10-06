/**
 * Fault guard around the live read-only db connection (P1-4).
 *
 * node:sqlite connections break at runtime when the database file is
 * deleted, replaced or corrupted while the server is up. Two distinct
 * failure points exist (verified against real node:sqlite, Node 24):
 * - prepare() on a closed connection throws "database is not open";
 * - statements of a closed connection throw "statement has been
 *   finalized" from all()/get() — both with code ERR_INVALID_STATE;
 * - a corrupt/foreign file throws "database disk image is malformed" /
 *   "file is not a database" with code ERR_SQLITE_ERROR and a SQLite
 *   result code in errcode.
 * Instead of failing forever, the server needs to drop the dead
 * connection so its databaseProvider can reopen on the next request.
 * This wrapper watches statement errors for exactly those signatures
 * and reports the broken connection once.
 */

import type { SqliteReadConnection, SqliteStatement } from "../db/types.ts"

/**
 * SQLite result codes (the numeric `errcode` property of node:sqlite
 * errors with code ERR_SQLITE_ERROR) that mean the connection is dead:
 * SQLITE_CORRUPT (11) and SQLITE_NOTADB (26).
 */
const FATAL_SQLITE_RESULT_CODES: ReadonlySet<number> = new Set([11, 26])

/**
 * Error message fallbacks for "this connection is dead, reopen the
 * database on the next request". Structural matching (error.code /
 * errcode) runs first; these texts are only the fallback for hosts or
 * wrappers that stringify the cause.
 */
const FATAL_ERROR_MESSAGE_SIGNATURES: ReadonlyArray<string> = [
  "database is not open",
  "database is closed",
  "statement has been finalized",
  "database disk image is malformed",
  "file is not a database",
  "database_corrupt",
]

/**
 * Whether this error means "the connection is dead, reopen the database
 * on the next request". Structural signals win: ERR_INVALID_STATE is
 * what node:sqlite throws for every closed-connection/statement
 * failure, and ERR_SQLITE_ERROR with a corruption result code means the
 * file itself is unusable. Message texts are the last resort only.
 */
export function isFatalDatabaseConnectionError(queryError: unknown): boolean {
  if (typeof queryError !== "object" || queryError === null) return false
  const errorCode = (queryError as { code?: unknown }).code
  if (errorCode === "ERR_INVALID_STATE") return true
  if (errorCode === "ERR_SQLITE_ERROR") {
    const sqliteResultCode = (queryError as { errcode?: unknown }).errcode
    if (typeof sqliteResultCode === "number" && FATAL_SQLITE_RESULT_CODES.has(sqliteResultCode)) {
      return true
    }
  }
  const errorMessage =
    queryError instanceof Error ? queryError.message : String(queryError)
  return FATAL_ERROR_MESSAGE_SIGNATURES.some((signature) => errorMessage.includes(signature))
}

/**
 * Wrap one connection so that fatal statement errors notify
 * onConnectionBroken (exactly once per breakage) before rethrowing.
 * Non-fatal errors pass through untouched.
 *
 * The callback receives the guarded connection object that this
 * function returns — the same reference the caller holds — so callers
 * can compare it against the connection they currently use and ignore
 * late errors from connections they have already replaced (P2-2).
 */
export function guardDatabaseConnection(
  connection: SqliteReadConnection,
  onConnectionBroken: (brokenConnection: SqliteReadConnection) => void,
): SqliteReadConnection {
  let guardedConnection: SqliteReadConnection | undefined
  const reportBrokenConnection = (): void => {
    // prepare() is only reachable through the returned wrapper, so the
    // binding below is always assigned by the time a statement can fail.
    if (guardedConnection !== undefined) onConnectionBroken(guardedConnection)
  }
  const reportStatement = (statement: SqliteStatement): SqliteStatement => {
    const reportIfFatal = (queryError: unknown): void => {
      if (isFatalDatabaseConnectionError(queryError)) reportBrokenConnection()
    }
    return {
      all: (...parameters: unknown[]) => {
        try {
          return statement.all(...parameters)
        } catch (queryError) {
          reportIfFatal(queryError)
          throw queryError
        }
      },
      get: (...parameters: unknown[]) => {
        try {
          return statement.get(...parameters)
        } catch (queryError) {
          reportIfFatal(queryError)
          throw queryError
        }
      },
    }
  }

  guardedConnection = {
    prepare: (sql: string): SqliteStatement => {
      try {
        return reportStatement(connection.prepare(sql))
      } catch (prepareError) {
        if (isFatalDatabaseConnectionError(prepareError)) reportBrokenConnection()
        throw prepareError
      }
    },
    close: (): void => {
      connection.close()
    },
  }
  return guardedConnection
}

/**
 * Fault guard around the live read-only db connection (P1-4).
 *
 * node:sqlite connections break at runtime when the database file is
 * deleted, replaced or corrupted while the server is up; every statement
 * then throws ("database is not open" / "database disk image is
 * malformed" / "file is not a database"). Instead of failing forever, the
 * server needs to drop the dead connection so its databaseProvider can
 * reopen on the next request. This wrapper watches statement errors for
 * exactly those signatures and reports the broken connection once.
 */

import type { SqliteReadConnection, SqliteStatement } from "../db/types.ts"

/**
 * Error signatures that mean "this connection is dead, reopen the
 * database on the next request". Matched on the message because
 * node:sqlite and SQLite itself expose no stable error code for them.
 */
export function isFatalDatabaseConnectionError(queryError: unknown): boolean {
  if (typeof queryError !== "object" || queryError === null) return false
  const errorMessage =
    queryError instanceof Error ? queryError.message : String(queryError)
  return (
    errorMessage.includes("database is not open") ||
    errorMessage.includes("database is closed") ||
    errorMessage.includes("database disk image is malformed") ||
    errorMessage.includes("file is not a database") ||
    errorMessage.includes("database_corrupt")
  )
}

/**
 * Wrap one connection so that fatal statement errors notify
 * onConnectionBroken (exactly once per breakage) before rethrowing.
 * Non-fatal errors pass through untouched.
 */
export function guardDatabaseConnection(
  connection: SqliteReadConnection,
  onConnectionBroken: (brokenConnection: SqliteReadConnection) => void,
): SqliteReadConnection {
  const reportStatement = (statement: SqliteStatement): SqliteStatement => {
    const reportIfFatal = (queryError: unknown): void => {
      if (isFatalDatabaseConnectionError(queryError)) onConnectionBroken(connection)
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

  return {
    prepare: (sql: string): SqliteStatement => {
      try {
        return reportStatement(connection.prepare(sql))
      } catch (prepareError) {
        if (isFatalDatabaseConnectionError(prepareError)) onConnectionBroken(connection)
        throw prepareError
      }
    },
    close: (): void => {
      connection.close()
    },
  }
}

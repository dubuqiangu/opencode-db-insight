/** @jsxImportSource @opentui/solid */
/**
 * Session todo block for the host TUI right sidebar (v0.23.0).
 *
 * Slot: `sidebar.content` (official channel, see the host's own
 * `packages/tui/src/feature-plugins/sidebar/mcp.tsx`).
 *
 * Rules kept from the official plugin and from real-machine history:
 * - Collapsed flag lives in `context.storage.store` and is read reactively.
 *   No local mirror, no time window, no `requestRender`.
 * - Every dynamic read sits in a JSX function child (`{() => ...}`).
 *   Eager interpolations are evaluated once at mount under `--jsx=automatic`.
 * - Data comes from the read-only query layer directly, not over HTTP.
 */

import { createEffect, createMemo, createSignal, onCleanup } from "solid-js"

import { openOpencodeDb } from "../db/queries.ts"
import { querySessionTodos } from "../db/session-todo-queries.ts"
import { clipToColumns } from "./clip-columns.ts"
import { buildSessionTodoView } from "../stats/session-todo.ts"
import type { SessionTodoEntry } from "../stats/session-todo.ts"

/** Refresh interval for the todo snapshot, in milliseconds. */
export const SIDEBAR_TODO_REFRESH_MS = 1_000

/** Storage key holding the collapsed flag. */
export const SIDEBAR_TODO_STORAGE_KEY = "session-todo.view"

const GLYPH_COMPLETED = "✓"
const GLYPH_IN_PROGRESS = "∼"
const GLYPH_PENDING = "·"

/** Minimal view of the `storage.store` result we consume. */
interface CollapsedStore {
  readonly isCollapsed: () => boolean
  readonly setCollapsed: (collapsed: boolean) => void
}

interface SidebarSlotInput {
  readonly sessionID?: string
}

function readCollapsedStore(context: unknown): CollapsedStore | null {
  try {
    const storage = (context as { storage?: { store?: unknown } } | null)?.storage
    const storeFactory = storage?.store
    if (typeof storeFactory !== "function") return null

    const [readView, updateView] = storeFactory.call(storage, SIDEBAR_TODO_STORAGE_KEY, {
      initial: { collapsed: false },
    }) as [
      () => { collapsed?: boolean },
      (mutate: (draft: { collapsed?: boolean }) => void) => void,
    ]

    if (typeof readView !== "function" || typeof updateView !== "function") return null

    return {
      isCollapsed: () => readView()?.collapsed === true,
      setCollapsed: (collapsed: boolean) => {
        try {
          updateView((draft) => {
            draft.collapsed = collapsed
          })
        } catch {}
      },
    }
  } catch {
    return null
  }
}

function readGlyph(entry: SessionTodoEntry): string {
  if (entry.status === "completed") return GLYPH_COMPLETED
  if (entry.status === "in_progress") return GLYPH_IN_PROGRESS
  return GLYPH_PENDING
}

/**
 * The sidebar is narrow and todo text is free-form (the model writes it): one
 * long line used to push the caret glyph off-screen and stretch the block.
 * Clipping lives in clip-columns.ts (no JSX deps), so tests can import it.
 */

/**
 * Mark a JSX child as a live accessor.
 *
 * `@opentui/solid`'s runtime `insert()` special-cases `typeof child ===
 * "function"` and wraps it in `createRenderEffect` (`index.js:6523`), so a
 * function child IS re-evaluated on every signal change. Its published types
 * (`TextChildren` / `Element`) do not describe that, hence the one cast below.
 *
 * Keeping this in a single named helper means: the divergence from the public
 * types is documented once, and every live read in this file goes through the
 * same path — a reader can see at a glance which children are reactive.
 */
function live<T>(read: () => T): T {
  return read as unknown as T
}

function SessionTodoBlock(props: { context: unknown; sessionId: string; store: CollapsedStore | null }) {
  const [tick, setTick] = createSignal(0)
  const [pageIndex, setPageIndex] = createSignal(0)

  const timer = setInterval(() => setTick(tick() + 1), SIDEBAR_TODO_REFRESH_MS)
  onCleanup(() => clearInterval(timer))

  const todoPage = createMemo(() => {
    tick()
    let database
    try {
      database = openOpencodeDb()
      if (database === null) return null
      return buildSessionTodoView(querySessionTodos(database, props.sessionId), pageIndex())
    } catch {
      return null
    } finally {
      try {
        database?.close()
      } catch {}
    }
  })

  const theme = (props.context as { theme?: Record<string, Record<string, string>> } | null)?.theme
  const baseColor = theme?.text?.base
  const mutedColor = theme?.text?.muted
  const accentColor = theme?.text?.accent ?? theme?.text?.primary

  const collapsed = () => props.store?.isCollapsed() === true
  const toggleCollapsed = () => {
    props.store?.setCollapsed(!collapsed())
    // The store is a live solid store, so flipping it re-runs the thunks below
    // on the next reactive pass, and the 1s tick repaints. Do NOT call
    // requestRender here: the official sidebar plugins never do, and nudging
    // the renderer mid-handler is what made an earlier version flicker.
  }

  // A newer session means a different todo list: page index back to the first
  // page. This must be an effect (not a memo that writes a signal): writing a
  // signal inside a memo re-enters reactive tracking and can loop once the
  // page index feeds back into the same memo above.
  let previousSessionId = props.sessionId
  createEffect(() => {
    if (props.sessionId === previousSessionId) return
    previousSessionId = props.sessionId
    setPageIndex(0)
  })

  // The whole block — header included — must vanish once every todo is done.
  // `buildSessionTodoView` already answers that question (null == no open
  // work), so the header is gated on it too: otherwise an orphan "▼ Todos"
  // row sits in the sidebar with nothing under it. A collapsed block is gated
  // the same way — collapsing hides the list, not the fact that work remains.
  return (
    <box flexDirection="column" width="100%">
      {live(() => {
        if (todoPage() === null) return null
        return (
          <box flexDirection="row" width="100%" onMouseUp={toggleCollapsed}>
            <text fg={baseColor} selectable={false}>
              {live(() => `${collapsed() ? "▶" : "▼"} Todos`)}
            </text>
          </box>
        )
      })}
      {live(() => {
        if (collapsed()) return null
        const currentPage = todoPage()
        if (currentPage === null) return null

        return (
          <box flexDirection="column" width="100%">
            {currentPage.entries.map((entry) => (
              <box flexDirection="row" gap={1} minWidth={0}>
                <text
                  fg={entry.status === "completed" ? mutedColor : accentColor}
                  selectable={false}
                  wrapMode="none"
                >
                  {readGlyph(entry)}
                </text>
                <text
                  fg={entry.status === "completed" ? mutedColor : baseColor}
                  selectable={false}
                  wrapMode="none"
                >
                  {live(() => clipToColumns(entry.content))}
                </text>
              </box>
            ))}
            {currentPage.pageCount > 1
              ? (() => {
                  // Read the memo once per render pass instead of re-reading it
                  // inside every handler: `currentPage` here IS the snapshot
                  // the arrows are drawn from, so the click can never act on a
                  // page number that differs from the one on screen.
                  const pageIndexNow = currentPage.pageIndex
                  const pageCountNow = currentPage.pageCount
                  return (
                    <box flexDirection="row" gap={1}>
                      <text
                        fg={mutedColor}
                        selectable={false}
                        onMouseUp={() => {
                          if (pageIndexNow > 0) setPageIndex(pageIndexNow - 1)
                        }}
                      >
                        {pageIndexNow > 0 ? "‹" : " "}
                      </text>
                      <text fg={mutedColor} selectable={false}>
                        {`${pageIndexNow + 1}/${pageCountNow}`}
                      </text>
                      <text
                        fg={mutedColor}
                        selectable={false}
                        onMouseUp={() => {
                          if (pageIndexNow < pageCountNow - 1) setPageIndex(pageIndexNow + 1)
                        }}
                      >
                        {pageIndexNow < pageCountNow - 1 ? "›" : " "}
                      </text>
                    </box>
                  )
                })()
              : null}
          </box>
        )
      })}
    </box>
  )
}

/** Register the block. Returns a dispose function that unregisters the slot. */
export function registerSessionTodoSidebar(context: unknown): () => void {
  try {
    const ui = (context as { ui?: { slot?: unknown } } | null)?.ui
    const slotRegistrar = ui?.slot
    if (typeof slotRegistrar !== "function") return () => {}

    const store = readCollapsedStore(context)
    // The slot is claimed synchronously inside setup, so the host always has a
    // disposer to call. The dynamic import in src/tui.tsx resolves later; keep
    // the "已卸载" flag here (not there) so both paths agree on one owner.
    let isDisposed = false
    const unregisterSlot = (
      slotRegistrar as (claim: {
        append: "sidebar.content"
        render: (input: SidebarSlotInput) => unknown
      }) => () => void
    ).call(ui, {
      append: "sidebar.content",
      render: (input) => {
        const sessionId = input?.sessionID
        if (typeof sessionId !== "string" || sessionId.length === 0) return null
        if (isDisposed) return null
        return <SessionTodoBlock context={context} sessionId={sessionId} store={store} />
      },
    })

    return () => {
      isDisposed = true
      if (typeof unregisterSlot === "function") unregisterSlot()
    }
  } catch (slotError) {
    console.error("db-insight: 侧栏 todo 注册失败", slotError)
    return () => {}
  }
}
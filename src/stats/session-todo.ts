/**
 * Pure view-model for a single session's todo list (zero IO): the SQL layer
 * hands over the raw rows (already ordered by position) and this module
 * filters, orders, hides and paginates them into one page of entries.
 *
 * 语义（契约定稿，逐条实现）：
 * 1. 丢弃 `status === "cancelled"` 的条目；丢弃 `status` 不在
 *    {in_progress, pending, completed, cancelled} 四值内的条目（防御未知
 *    状态，不让脏数据冒泡到 UI）。
 * 2. 排序：先按状态秩 `in_progress=0, pending=1, completed=2` 升序，秩相同
 *    再按 `position` 升序——`in_progress` 恒在最前，多条并行（同为
 *    in_progress）时按 position 依次靠前。
 * 3. **隐藏规则**：若过滤后**不存在** `in_progress` 或 `pending` 的条目
 *    （即只剩 `completed`，或一个都没有），返回 `null`——「所有 todo 做完
 *    了就消失」。注意过滤已丢弃 cancelled，故「存在 in_progress 或
 *    pending」等价于「还有未完成的工作」。
 * 4. 分页：`pageCount = Math.ceil(entries.length / SESSION_TODO_PAGE_SIZE)`；
 *    传入的 `pageIndex` 先四舍五入取整再 clamp 到 `[0, pageCount - 1]`；
 *    返回当前页切片。
 * 5. 返回值里 `pageIndex` 是 clamp 后的**实际**值（调用方据此回写状态，
 *    避免下次仍带越界的页码）。
 */

import type { SessionTodoItem } from "../db/session-todo-queries.ts"

/** 每页展示的条目数（契约常量，调用方与测试据此分页）。 */
export const SESSION_TODO_PAGE_SIZE = 4

/** 四值状态域（含 cancelled；cancelled 在视图里被丢弃）。 */
export type SessionTodoStatus = "in_progress" | "pending" | "completed" | "cancelled"

/** 会出现在视图里的状态：差掉 cancelled。 */
type VisibleSessionTodoStatus = Exclude<SessionTodoStatus, "cancelled">

/** One entry of a rendered todo page. */
export interface SessionTodoEntry {
  readonly content: string
  readonly status: SessionTodoStatus
  readonly position: number
}

/** One page of the session todo view. */
export interface SessionTodoPage {
  readonly entries: readonly SessionTodoEntry[]
  /** clamp 后的实际页号（调用方据此回写状态）。 */
  readonly pageIndex: number
  readonly pageCount: number
}

/**
 * 状态秩：in_progress 最前，其次 pending，最后 completed。cancelled 的秩
 * 永不被使用（过滤阶段已丢弃），仅为满足 `Record` 完整性而给出。
 */
const TODO_STATUS_RANK: Record<SessionTodoStatus, number> = {
  in_progress: 0,
  pending: 1,
  completed: 2,
  cancelled: 3,
}

/**
 * Narrow a raw status string to a renderable status: the three known values
 * minus cancelled. Unknown strings (and "cancelled") return false so the
 * caller drops them.
 */
function isVisibleSessionTodoStatus(value: string): value is VisibleSessionTodoStatus {
  return value === "in_progress" || value === "pending" || value === "completed"
}

/**
 * Build one page of the todo view from raw rows. Returns `null` when there is
 * no open work left (no in_progress / pending after filtering) — the "所有
 * todo 做完了就消失" rule; otherwise returns the clamped page. See the module
 * header for the full ordering / filtering / pagination contract.
 */
export function buildSessionTodoView(
  items: readonly SessionTodoItem[],
  pageIndex: number,
): SessionTodoPage | null {
  // 1. 过滤：丢弃 cancelled 与未知状态。
  const visibleEntries: SessionTodoEntry[] = []
  for (const item of items) {
    if (!isVisibleSessionTodoStatus(item.status)) continue
    visibleEntries.push({
      content: item.content,
      status: item.status,
      position: item.position,
    })
  }

  // 3. 隐藏规则：没有任何未完成工作 → 整个视图消失。
  const hasOpenWork = visibleEntries.some(
    (entry) => entry.status === "in_progress" || entry.status === "pending",
  )
  if (!hasOpenWork) return null

  // 2. 排序：状态秩升序，秩相同再按 position 升序。
  visibleEntries.sort(
    (leftEntry, rightEntry) =>
      TODO_STATUS_RANK[leftEntry.status] - TODO_STATUS_RANK[rightEntry.status] ||
      leftEntry.position - rightEntry.position,
  )

  // 4. 分页：先四舍五入取整，再 clamp 到合法页区间。
  const pageCount = Math.ceil(visibleEntries.length / SESSION_TODO_PAGE_SIZE)
  const requestedPageIndex = Math.round(pageIndex)
  const clampedPageIndex = Math.min(Math.max(requestedPageIndex, 0), pageCount - 1)
  const pageStart = clampedPageIndex * SESSION_TODO_PAGE_SIZE

  // 5. 回传 clamp 后的实际页号。
  return {
    entries: visibleEntries.slice(pageStart, pageStart + SESSION_TODO_PAGE_SIZE),
    pageIndex: clampedPageIndex,
    pageCount,
  }
}

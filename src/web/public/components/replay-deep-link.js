/**
 * 回放页消息级深链（v0.24.0）：让 `#/session/<id>?msg=<messageID>` 能直接
 * 定位到某一条消息。
 *
 * 为什么需要单独的模块：路由（app.js 的 routeByHash）只认 `#/session/:id`，
 * 而消息定位要经过时间线的分页控制器（目标可能在 200 条之后），这件事不该
 * 塞回路由正则里。
 *
 * 契约（改动前先读）：
 * 1. **定位单位 = 消息 id**，不是序号：seq 在会话内可能重排，id 才稳定。
 * 2. **id → 可见下标**用 `isVisibleReplayMessageType` 过滤后的顺序来算，与
 *    renderTimeline / buildReplaySearchIndex 严格同一口径（见
 *    replay-message-text.js 顶部的对齐不变量）。算错一档就会定位到隔壁消息，
 *    所以这里复用那个过滤函数而不另写一份。
 * 3. **目标可能在未渲染分页区**：连续 appendNextChunk 直到渲染到它，再
 *    scrollIntoView，与 replay-search 的导航路径同语义。
 * 4. **不认识的 id**（会话变了 / 链接被手改）不滚动、不报错，只返回
 *    notFound —— 深链是便利功能，坏了不该让整个回放页失败。
 */

import { isVisibleReplayMessageType } from "./replay-message-text.js";

/** 深链查询参数名（写进 hash：`#/session/<id>?msg=<messageID>`）。 */
export const DEEP_LINK_MESSAGE_PARAM = "msg";

/** 定位后的高亮类：与搜索的 .replay-hit-current 分开，避免互相清除。 */
export const DEEP_LINK_TARGET_CLASS = "replay-deep-link-target";

/** 高亮保留时长：够用户看清落点，之后自然消隐。 */
export const DEEP_LINK_FLASH_MS = 2000;

/**
 * 从 hash 里取出消息 id。hash 形如 `#/session/ses_x?msg=msg_y`。
 *
 * 返回 null 表示「没有消息深链」——空串、空白、无该参数都按无深链处理，
 * 而不是当成一个找不到的 id（那会白跑一次 notFound 分支）。
 */
export function readDeepLinkMessageId(hashText) {
  const normalizedHash = typeof hashText === "string" ? hashText : "";
  const queryStart = normalizedHash.indexOf("?");
  if (queryStart === -1) return null;
  // URLSearchParams 自带 %XX 解码；手拆字符串会在 id 含 % 时出错。
  const queryParameters = new URLSearchParams(normalizedHash.slice(queryStart + 1));
  const rawMessageId = queryParameters.get(DEEP_LINK_MESSAGE_PARAM);
  if (rawMessageId === null) return null;
  const trimmedMessageId = rawMessageId.trim();
  return trimmedMessageId === "" ? null : trimmedMessageId;
}

/**
 * 给会话 id 拼出带消息参数的 hash（供「复制链接」用）。
 * 会话 id 与消息 id 都走 encodeURIComponent，与 session-list.js 的写入端一致。
 */
export function buildDeepLinkedSessionHash(sessionId, messageId) {
  const encodedSessionId = encodeURIComponent(String(sessionId ?? ""));
  if (messageId === null || messageId === undefined) {
    return `#/session/${encodedSessionId}`;
  }
  const trimmedMessageId = String(messageId).trim();
  if (trimmedMessageId === "") return `#/session/${encodedSessionId}`;
  return `#/session/${encodedSessionId}?${DEEP_LINK_MESSAGE_PARAM}=${encodeURIComponent(trimmedMessageId)}`;
}

/**
 * 在可见消息序列里找 `messageId` 的下标；找不到返回 -1。
 * 过滤口径必须与 renderTimeline 一致，否则下标会整体错位。
 */
export function findVisibleMessageIndex(messageRecords, messageId) {
  if (messageId === null || messageId === undefined) return -1;
  const wantedMessageId = String(messageId);
  let visibleIndex = 0;
  for (const messageRecord of Array.isArray(messageRecords) ? messageRecords : []) {
    if (!isVisibleReplayMessageType(String(messageRecord?.type ?? ""))) continue;
    if (String(messageRecord?.id ?? "") === wantedMessageId) return visibleIndex;
    visibleIndex += 1;
  }
  return -1;
}

/**
 * 滚到目标消息并给一个短暂高亮。返回 { status, visibleIndex }：
 * - `located`：找到了并已定位（节点可能因分页而刚被追加出来）；
 * - `notFound`：id 不在本会话的可见消息里（含空 id）。
 *
 * paginationController 即 renderTimeline 的返回值，用到 renderedCount /
 * nodeAt / hasMore / appendNextChunk 四项。
 */
export function revealMessageNode({ paginationController, messageRecords, messageId }) {
  const visibleIndex = findVisibleMessageIndex(messageRecords, messageId);
  if (visibleIndex < 0 || paginationController === null || paginationController === undefined) {
    return { status: "notFound", visibleIndex: -1 };
  }

  // 目标在未渲染分页区：逐块追加直到它被渲染出来。上限靠 hasMore 兜底，
  // 不另设循环计数 —— controller 保证 hasMore 为 false 时已渲染全部。
  while (paginationController.hasMore && paginationController.renderedCount <= visibleIndex) {
    paginationController.appendNextChunk();
  }

  const targetNode = paginationController.nodeAt(visibleIndex);
  if (targetNode === null || targetNode === undefined) {
    return { status: "notFound", visibleIndex };
  }

  if (typeof targetNode.scrollIntoView === "function") {
    targetNode.scrollIntoView({ block: "center" });
  }

  if (typeof targetNode.classList?.add === "function") {
    targetNode.classList.add(DEEP_LINK_TARGET_CLASS);
    // 高亮自动消隐：深链是一次性落点提示，不该长期占着视觉权重。
    const clearTimer = setTimeout(() => {
      if (typeof targetNode.classList?.remove === "function") {
        targetNode.classList.remove(DEEP_LINK_TARGET_CLASS);
      }
    }, DEEP_LINK_FLASH_MS);
    if (typeof clearTimer?.unref === "function") clearTimer.unref();
  }

  return { status: "located", visibleIndex };
}
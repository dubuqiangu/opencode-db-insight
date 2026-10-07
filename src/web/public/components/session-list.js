/**
 * 会话列表：标题 / 模型 / agent / 创建时间 / tokens。
 * 行 hover 高亮，点击跳 #/session/:id（M4 回放页，暂为占位路由）。
 * 支持按模型过滤（模型排行榜行下钻）。
 *
 * 列头点击排序（v0.5.0 接线 v0.4.0 的 /api/sessions 服务端排序）：
 * 排序归属服务端（分页确定性契约）——点击只产出下一组 sort/order 交给
 * onSessionSortChange 回调，由 app.js 带 ?sort=/?order= 重新请求 API，
 * 本组件不做客户端重排。交互范式与 model-table 列头一致：点新列默认
 * desc，再点同列切方向。列 → sort 键映射以可见列为准：标题列 → title、
 * 创建时间列 → time_created、Tokens 列 → tokens（模型/Agent 无对应
 * 白名单键，不可排序）。默认 time_updated desc 没有对应的可见列
 * （列表展示的是创建时间），初始态无箭头，由脚注文字说明当前排序。
 */

import { formatTokens, formatDateTime, formatRelative, escapeHtml } from "../format.js";
import { modelPalette } from "../theme.js";
import { renderEmpty, renderLoading } from "./state-views.js";
import { DEFAULT_SESSION_SORT_KEY, DEFAULT_SESSION_SORT_ORDER } from "../data-source.js";

const VISIBLE_ROWS = 15;

/** 列定义：sortKey 与后端 ?sort= 白名单（db/queries.ts）一一对应；null 不可排序。 */
const COLUMNS = [
  { label: "标题", sortKey: "title", numeric: false },
  { label: "模型", sortKey: null, numeric: false },
  { label: "Agent", sortKey: null, numeric: false },
  { label: "创建时间", sortKey: "time_created", numeric: true },
  { label: "Tokens", sortKey: "tokens", numeric: true },
];

/** 脚注的排序描述：真实源 total 未知时用它说明服务端当前的 sort/order。 */
const SORT_LABEL_BY_KEY = {
  time_updated: "最近更新时间",
  time_created: "创建时间",
  tokens: "token 用量",
  cost: "成本",
  title: "标题",
};

/**
 * 渲染会话列表。
 * sessionPayload = { total, sessions: SessionSummary[] } 或 null。
 * modelFilter：非 null 时只显示该模型的会话。
 * sortKey / sortOrder：当前服务端排序（默认与后端契约默认一致）。
 * onSessionSortChange(nextSortKey, nextSortOrder)：列头点击回调，
 * 传 null 时列头不挂排序交互（纯展示用法）。
 */
export function renderSessionList(
  container,
  sessionPayload,
  modelFilter,
  sortKey = DEFAULT_SESSION_SORT_KEY,
  sortOrder = DEFAULT_SESSION_SORT_ORDER,
  onSessionSortChange = null,
) {
  if (sessionPayload === null) {
    renderLoading(container, 4);
    return;
  }

  const allSessions = sessionPayload.sessions ?? [];
  const sessions = modelFilter === null
    ? allSessions
    : allSessions.filter((session) => session.modelId === modelFilter);

  if (sessions.length === 0) {
    renderEmpty(
      container,
      modelFilter === null ? "没有会话记录" : `没有 ${escapeHtml(modelFilter)} 的会话`,
      modelFilter === null ? "数据库里还没有 session_v2 记录" : "这个模型在最近的会话里没出现过，试试取消过滤",
    );
    return;
  }

  const palette = modelPalette();
  const modelNames = [...new Set(allSessions.map((session) => session.modelId))];
  const modelColor = new Map(
    modelNames.map((modelName, rank) => [modelName, palette[rank % palette.length]]),
  );

  const headCells = COLUMNS.map((column) => {
    const isSorted = column.sortKey !== null && column.sortKey === sortKey;
    const isInteractive = column.sortKey !== null && onSessionSortChange !== null;
    const classTokens = [
      isInteractive ? "sortable" : "",
      column.numeric ? "num" : "",
      isSorted ? "sorted" : "",
    ].filter((classToken) => classToken !== "").join(" ");
    const arrow = isSorted ? `<span class="sort-arrow">${sortOrder === "asc" ? "▲" : "▼"}</span>` : "";
    return `
      <th class="${classTokens}"${column.sortKey !== null ? ` data-sort-key="${column.sortKey}"` : ""}${isInteractive ? ' title="点击排序"' : ""}>
        ${column.label}${arrow}
      </th>`;
  }).join("");

  const now = Date.now();
  const rowsHtml = sessions.slice(0, VISIBLE_ROWS).map((session) => `
    <tr class="session-row" data-session-id="${escapeHtml(session.id)}" title="查看会话回放（M4）">
      <td class="primary"><span class="session-title-cell" title="${escapeHtml(session.title)}">${escapeHtml(session.title)}</span></td>
      <td><span class="model-cell"><span class="dot" style="background:${modelColor.get(session.modelId) ?? "transparent"}"></span><span class="name">${escapeHtml(session.modelId)}</span></span></td>
      <td><span class="badge">${escapeHtml(session.agent)}</span></td>
      <td class="num" title="${formatDateTime(session.timeCreated)}">${formatRelative(session.timeCreated, now)}</td>
      <td class="num primary">${formatTokens(session.tokens)}</td>
    </tr>`).join("");

  const hiddenAfterFilterCount = allSessions.length - sessions.length;
  const remainingCount = Math.max(0, sessions.length - VISIBLE_ROWS);
  const footNoteParts = [];
  if (modelFilter !== null) footNoteParts.push(`已过滤掉 ${hiddenAfterFilterCount} 条非 ${escapeHtml(modelFilter)} 会话`);
  if (remainingCount > 0) footNoteParts.push(`还有 ${remainingCount} 条更早的会话未展示`);
  if (sessionPayload.total === null || sessionPayload.total === undefined) {
    const sortLabel = SORT_LABEL_BY_KEY[sortKey] ?? SORT_LABEL_BY_KEY[DEFAULT_SESSION_SORT_KEY];
    footNoteParts.push(`按${sortLabel}${sortOrder === "asc" ? "正序" : "倒序"}`);
  } else {
    footNoteParts.push(`全库共 <b class="num">${sessionPayload.total.toLocaleString("en-US")}</b> 个会话`);
  }

  container.innerHTML = `
    <table class="data-table" aria-label="会话列表">
      <thead><tr>${headCells}</tr></thead>
      <tbody>${rowsHtml}</tbody>
    </table>
    <div class="heatmap-meta">
      <span>${footNoteParts.join(" · ")}</span>
    </div>`;

  if (onSessionSortChange !== null) {
    for (const headerCell of container.querySelectorAll("th.sortable")) {
      headerCell.addEventListener("click", () => {
        const clickedSortKey = headerCell.dataset.sortKey;
        // 交互范式与 model-table 一致：同列点击切方向，新列从 desc 起步
        if (clickedSortKey === sortKey) {
          onSessionSortChange(clickedSortKey, sortOrder === "asc" ? "desc" : "asc");
        } else {
          onSessionSortChange(clickedSortKey, "desc");
        }
      });
    }
  }

  for (const row of container.querySelectorAll("tr.session-row")) {
    row.addEventListener("click", () => {
      // id 里若出现 URL 保留字符（/、?、#、%…）必须编码，否则 hash 会被截断或误解析；
      // 读取端 app.js routeByHash 用 decodeURIComponent 还原，往返一致。
      window.location.hash = `/session/${encodeURIComponent(row.dataset.sessionId)}`;
    });
  }
}

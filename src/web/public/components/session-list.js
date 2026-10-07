/**
 * 会话列表：标题 / 模型 / agent / 创建时间 / 更新时间 / tokens / cost。
 * 行 hover 高亮，点击跳 #/session/:id（M4 回放页，暂为占位路由）。
 * 支持按模型过滤（模型排行榜行下钻）。
 *
 * 列头点击排序（v0.5.0 接线 v0.4.0 的 /api/sessions 服务端排序）：
 * 排序归属服务端（分页确定性契约）——点击只产出下一组 sort/order 交给
 * onSessionSortChange 回调，由 app.js 带 ?sort=/?order= 重新请求 API，
 * 本组件不做客户端重排。交互范式与 model-table 列头一致：点新列默认
 * desc，再点同列切方向。v0.6.0 补齐 更新时间/Cost 两列后，后端五个
 * 排序白名单键全部有可见列头（title / time_created / time_updated /
 * tokens / cost 与五列一一对应），默认 time_updated desc 初始渲染即
 * 带 desc 箭头与 .sorted 高亮；模型/Agent 无对应白名单键，不可排序。
 *
 * P2-3（v0.5.1）：默认排序无回路——非默认排序态下，脚注的排序描述
 * 同时是「恢复默认排序」入口（.sort-reset，点击走同一个
 * onSessionSortChange 回调与缓存路径，零新列零新组件）；默认态只显
 * 纯文本。本组件是导出函数，sortKey 不能假设来自白名单：查表一律
 * Object.hasOwn（P2-1），原型链键回退默认 label，不渲染继承函数串。
 *
 * v0.7.0 目录下钻：directoryFilter 非空时脚注标注当前过滤目录
 * （服务端 ?directory= 精确匹配，行序仍等于 payload 序——过滤同样
 * 归属服务端）；与 modelFilter 可叠加（目录=服务端参数、模型=客户
 * 端行过滤，正交），空态文案按叠加组合给出。
 *
 * v0.8.0：脚注末尾追加 CSV 导出入口（components/session-csv-export.js，
 * 原生 <a download>，href 随 directoryFilter 在渲染期构造）。空态与
 * 加载骨架没有脚注，也就没有导出入口。
 */

import { formatTokens, formatDateTime, formatRelative, escapeHtml } from "../format.js";
import { modelPalette } from "../theme.js";
import { renderEmpty, renderLoading } from "./state-views.js";
import { sessionsCsvExportEntryHtml } from "./session-csv-export.js";
import { DEFAULT_SESSION_SORT_KEY, DEFAULT_SESSION_SORT_ORDER } from "../data-source.js";

const VISIBLE_ROWS = 15;

/** 列定义：sortKey 与后端 ?sort= 白名单（db/queries.ts）一一对应；null 不可排序。 */
const COLUMNS = [
  { label: "标题", sortKey: "title", numeric: false },
  { label: "模型", sortKey: null, numeric: false },
  { label: "Agent", sortKey: null, numeric: false },
  { label: "创建时间", sortKey: "time_created", numeric: true },
  { label: "更新时间", sortKey: "time_updated", numeric: true },
  { label: "Tokens", sortKey: "tokens", numeric: true },
  { label: "Cost", sortKey: "cost", numeric: true },
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
 * Cost 单元格：口径与 KPI 卡一致（$ + 原始值，参照 kpi-card 的
 * $todayCostEstimateUsd），浮点噪声截到两位小数。0 / null / 非有限数
 * 降级 "—"——本库 cost 字段常为 0（DESIGN §5），0 与「未记录」同义，
 * 降级惯例同 model-table hitRateCell 的「通道无缓存」（— + 说明 title）。
 */
function costCell(costValue) {
  if (!Number.isFinite(costValue)) {
    return `<span title="无成本记录（本库 cost 字段常为 0，DESIGN §5）">—</span>`;
  }
  // 降级判定取在舍入之后：亚分值（如 0.004）舍入为 0，与精确 0 同走降级，
  // 否则会渲染出降级设计想避免的 "$0"（0.6.0 审查 P2-1）。
  const roundedCost = Number(costValue.toFixed(2));
  if (roundedCost === 0) {
    return `<span title="无成本记录（本库 cost 字段常为 0，DESIGN §5）">—</span>`;
  }
  return `$${String(roundedCost)}`;
}

/**
 * 渲染会话列表。
 * sessionPayload = { total, sessions: SessionSummary[] } 或 null。
 * modelFilter：非 null 时只显示该模型的会话（客户端行过滤）。
 * sortKey / sortOrder：当前服务端排序（默认与后端契约默认一致）。
 * onSessionSortChange(nextSortKey, nextSortOrder)：列头点击回调，
 * 传 null 时列头不挂排序交互（纯展示用法）。
 * directoryFilter（v0.7.0）：非 null/"" 时当前会话列表已由服务端按
 * 该目录精确匹配过滤（?directory=），本组件只负责把它说出来——
 * 过滤本身不在此发生，行序仍等于 payload 序。
 */
export function renderSessionList(
  container,
  sessionPayload,
  modelFilter,
  sortKey = DEFAULT_SESSION_SORT_KEY,
  sortOrder = DEFAULT_SESSION_SORT_ORDER,
  onSessionSortChange = null,
  directoryFilter = null,
) {
  if (sessionPayload === null) {
    renderLoading(container, 4);
    return;
  }

  const allSessions = sessionPayload.sessions ?? [];
  const sessions = modelFilter === null
    ? allSessions
    : allSessions.filter((session) => session.modelId === modelFilter);
  const hasDirectoryFilter = directoryFilter !== null && directoryFilter !== "";

  if (sessions.length === 0) {
    // 空态文案按过滤叠加组合给出：目录（服务端过滤）与模型（客户端
    // 过滤）正交可叠加，各自「可能不是原因」要说清楚，避免空结果被
    // 误读成"库是空的"。
    let emptyTitle;
    let emptyHint;
    if (modelFilter !== null && hasDirectoryFilter) {
      emptyTitle = `没有 ${escapeHtml(modelFilter)} 在该目录下的会话`;
      emptyHint = "目录和模型的过滤是叠加的，试试取消其中一个";
    } else if (modelFilter !== null) {
      emptyTitle = `没有 ${escapeHtml(modelFilter)} 的会话`;
      emptyHint = "这个模型在最近的会话里没出现过，试试取消过滤";
    } else if (hasDirectoryFilter) {
      emptyTitle = "该目录没有会话记录";
      emptyHint = "这个目录在最近的会话里没出现过，试试点击其他目录行或取消过滤";
    } else {
      emptyTitle = "没有会话记录";
      emptyHint = "数据库里还没有 session_v2 记录";
    }
    renderEmpty(container, emptyTitle, emptyHint);
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
      <td class="num" title="${formatDateTime(session.timeUpdated)}">${formatRelative(session.timeUpdated, now)}</td>
      <td class="num primary">${formatTokens(session.tokens)}</td>
      <td class="num">${costCell(session.cost)}</td>
    </tr>`).join("");

  const hiddenAfterFilterCount = allSessions.length - sessions.length;
  const remainingCount = Math.max(0, sessions.length - VISIBLE_ROWS);
  const footNoteParts = [];
  // v0.7.0：目录过滤态先说目录（服务端参数，语义上先于客户端模型过滤）
  if (hasDirectoryFilter) footNoteParts.push(`目录：${escapeHtml(directoryFilter)}`);
  if (modelFilter !== null) footNoteParts.push(`已过滤掉 ${hiddenAfterFilterCount} 条非 ${escapeHtml(modelFilter)} 会话`);
  if (remainingCount > 0) footNoteParts.push(`还有 ${remainingCount} 条更早的会话未展示`);  if (sessionPayload.total === null || sessionPayload.total === undefined) {
    // P2-1：hasOwn 先行——"toString"/"__proto__" 等原型链键在 ?? 语义下
    // 取到的是继承函数，脚注会渲染出 "[native code]" 串；回退默认 label。
    const sortLabel = Object.hasOwn(SORT_LABEL_BY_KEY, sortKey)
      ? SORT_LABEL_BY_KEY[sortKey]
      : SORT_LABEL_BY_KEY[DEFAULT_SESSION_SORT_KEY];
    const sortDescription = `按${sortLabel}${sortOrder === "asc" ? "正序" : "倒序"}`;
    const isDefaultSort = sortKey === DEFAULT_SESSION_SORT_KEY && sortOrder === DEFAULT_SESSION_SORT_ORDER;
    // P2-3：非默认排序 + 有回调时，脚注描述即重置入口（回默认组合）；
    // 默认态与纯展示用法（无回调）保持纯文本，不造不可点的假入口。
    footNoteParts.push(isDefaultSort || onSessionSortChange === null
      ? sortDescription
      : `<span class="sort-reset" title="恢复默认排序（最近更新时间倒序）">${sortDescription}</span>`);
  } else {
    footNoteParts.push(`全库共 <b class="num">${sessionPayload.total.toLocaleString("en-US")}</b> 个会话`);
  }
  // v0.8.0：CSV 导出入口（真实模式常显 / mock 模式渲染期即无，见
  // session-csv-export.js）。href 经 data-source 单点构造，directoryFilter
  // 即 controller 透传的当前下钻值——不另存状态。原生 <a download>，
  // 无需 JS 点击处理器。
  const csvExportEntryHtml = sessionsCsvExportEntryHtml(directoryFilter);
  if (csvExportEntryHtml !== "") footNoteParts.push(csvExportEntryHtml);

  container.innerHTML = `
    <table class="data-table" aria-label="会话列表">
      <thead><tr>${headCells}</tr></thead>
      <tbody>${rowsHtml}</tbody>
    </table>
    <div class="heatmap-meta">
      <span>${footNoteParts.join(" · ")}</span>
    </div>`;

  if (onSessionSortChange !== null) {
    // P2-3：重置入口——回默认组合，与列头共用同一个回调/缓存路径
    const resetEntry = container.querySelector(".sort-reset");
    if (resetEntry !== null) {
      resetEntry.addEventListener("click", () => {
        onSessionSortChange(DEFAULT_SESSION_SORT_KEY, DEFAULT_SESSION_SORT_ORDER);
      });
    }
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

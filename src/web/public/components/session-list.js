/**
 * 会话列表：标题 / 模型 / agent / 创建时间 / 更新时间 / 入 / 出 / tokens /
 * 命中率 / Reasoning / 步数 / cost。
 * 行 hover 高亮，点击跳 #/session/:id（M4 回放页，暂为占位路由）。
 * 支持按模型过滤（模型排行榜行下钻）。
 *
 * v0.13.0 入/出双指标列：紧邻既有 Tokens 折叠总量列左侧（分项 → 总量的
 * 聚合读序，绝对量相邻对照），口径与 KPI 卡同名指标严格一致——
 * 入 = tokensInput（纯实付输入，不含 cache.read；KPI todayInput 取趋势点
 * 的 $.tokens.input，同为纯输入三分口径）；出 = tokensOutput（KPI
 * todayOutput 取 $.tokens.output）。cache.read 不混进入列，只在 Tokens
 * 总量单元格的 title 里提示分项（总量 = 入 + 出 + cache.read）。两列不挂
 * 排序：后端 ?sort= 白名单不扩（排序确定性契约归服务端），列头用 title
 * 说明口径代替「点击排序」。宿主更新窗口期的旧 wire 可能缺三字段，
 * 渲染一律 `?? 0` 兜底——tokens 0 是真数据，诚实渲染 "0"，不复刻 cost
 * 的 "—" 降级（那是「未记录」语义，0.6.1 P2-1）。
 *
 * 列头点击排序（v0.5.0 接线 v0.4.0 的 /api/sessions 服务端排序）：
 * 排序归属服务端（分页确定性契约）——点击只产出下一组 sort/order 交给
 * onSessionSortChange 回调，由 app.js 带 ?sort=/?order= 重新请求 API，
 * 本组件不做客户端重排。交互范式与 model-table 列头一致：点新列默认
 * desc，再点同列切方向。v0.6.0 补齐 更新时间/Cost 两列后，后端五个
 * 排序白名单键全部有可见列头（title / time_created / time_updated /
 * tokens / cost 与五列一一对应），默认 time_updated desc 初始渲染即
 * 带 desc 箭头与 .sorted 高亮；模型/Agent/入/出无对应白名单键，不可排序。
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
 *
 * v0.9.0 时间范围：面板顶部一枚胶囊分段控件（复用趋势图 .range-switch
 * 的既有语言，零新样式体系），词表 = data-source.SESSION_RANGE_OPTIONS
 * （7d/30d/90d + All），点击产出 onSessionRangeChange 回调由控制器带
 * ?range= 重新请求（服务端过滤 timeUpdated，与客户端模型过滤、服务端
 * 目录过滤三者 AND 叠加）。范围选择器贯穿加载/空态/表格三态——空结果
 * 时用户仍能切回更宽的范围，不把自己锁死在空态里。
 *
 * v0.20.0 会话作用域 + 子代理归总：三根新列（命中率/Reasoning/步数）
 * 紧跟 Tokens 列之后；父会话行加「+N 子会话」徽标、子会话行加 ↳ 层级
 * 标记（归总显示，不做可展开树）；行内「只看此会话」小按钮把会话 id
 * 上抛给 app 层进入作用域。作用域锁定视图（renderOptions.sessionScopeId）
 * 只显示该会话自身一行，排序/范围/导出全部锁定。
 */

import { formatTokens, formatCount, formatPercent, formatDateTime, formatRelative, formatDurationMs, escapeHtml, shortenSessionId } from "../format.js";
import { MISSING_REASON, renderMissingValue } from "../precision.js";
import { modelPalette } from "../theme.js";
import { buildEmptyHtml, buildLoadingHtml } from "./state-views.js";
import { sessionsCsvExportEntryHtml } from "./session-csv-export.js";
import {
  DEFAULT_SESSION_SORT_KEY,
  DEFAULT_SESSION_SORT_ORDER,
  DEFAULT_SESSION_RANGE,
  SESSION_RANGE_OPTIONS,
  sessionRangeLabel,
} from "../data-source.js";

const VISIBLE_ROWS = 15;

/**
 * 列定义：sortKey 与后端 ?sort= 白名单（db/queries.ts）一一对应；null 不可排序。
 * 入/出（v0.13.0）：sortKey 恒 null——白名单不扩；title 字段是纯展示列的
 * 口径提示（不可排序的列头没有「点击排序」可说，改说口径）。
 * 命中率/Reasoning/步数（v0.20.0）：紧跟 Tokens 折叠总量之后、Cost 之前，
 * 同为纯展示列（白名单不扩）；三列都在非冻结区，表头复用 .num 右对齐。
 */
const COLUMNS = [
  { label: "标题", sortKey: "title", numeric: false },
  // 会话 ID（v0.22.0）：列表原先只把 id 写在 <tr data-session-id> 属性里，
  // 表面上一行身份不明——窗口标题/日志/URL 里给的 ID 无法与某一行对上。
  // 不可排序：后端 ?sort= 白名单没有 id，加进来只能做假交互；display-only
  // 列与 入/出/命中率 同待遇，只挂口径说明。
  { label: "会话 ID", sortKey: null, numeric: false, extraClass: "col-session-id", title: "会话 ID（session_v2.id）· 表内截断展示，悬浮看完整值，点行体进回放" },
  { label: "模型", sortKey: null, numeric: false },
  { label: "Agent", sortKey: null, numeric: false },
  { label: "创建时间", sortKey: "time_created", numeric: true },
  { label: "更新时间", sortKey: "time_updated", numeric: true },
  { label: "入", sortKey: null, numeric: true, title: "入 = 纯输入 tokens.input（不含 cache.read，与 KPI 卡「入」同口径）" },
  { label: "出", sortKey: null, numeric: true, title: "出 = tokens.output（与 KPI 卡「出」同口径）" },
  { label: "Tokens", sortKey: "tokens", numeric: true },
  { label: "命中率", sortKey: null, numeric: true, title: "严格口径 = cache.read / (input + cache.read + cache.write) · 分母为 0 或旧数据缺字段时无值（—）" },
  { label: "Reasoning", sortKey: null, numeric: true, title: "本会话 tokens.reasoning 累计（v0.20.0 富化字段，旧数据缺列时显示 —）" },
  { label: "步数", sortKey: null, numeric: true, title: "本会话的 assistant 消息数（v0.20.0 富化字段）" },
  { label: "墙钟", sortKey: null, numeric: true, extraClass: "col-duration", title: "time_updated - time_created（毫秒→formatDurationMs；无正时长显示 —）" },
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
 * 降级为不可得——本库 cost 字段常为 0（DESIGN §5），0 与「未记录」同义，
 * 原因统一取自 `MISSING_REASON`（见 `precision.js`）。
 */
function costCell(costValue) {
  if (!Number.isFinite(costValue)) {
    return renderMissingValue(MISSING_REASON.costNotRecorded);
  }
  // 降级判定取在舍入之后：亚分值（如 0.004）舍入为 0，与精确 0 同走降级，
  // 否则会渲染出降级设计想避免的 "$0"（0.6.0 审查 P2-1）。
  const roundedCost = Number(costValue.toFixed(2));
  if (roundedCost === 0) {
    return renderMissingValue(MISSING_REASON.costNotRecorded);
  }
  return `$${String(roundedCost)}`;
}

/**
 * 命中率单元格（v0.20.0）：严格口径 cacheRead / (input + cacheRead +
 * cacheWrite)。旧 wire 缺任一字段 → 不可计算，渲染占位 "—"（区分于
 * 0：0 是真数据诚实渲染，缺失是「未记录」语义，同 costCell 降级惯例）；
 * 三字段齐全但分母为 0 同样 "—"。
 */
function strictHitRateCell(session) {
  const cacheRead = session.tokensCacheRead;
  const paidInput = session.tokensInput;
  const cacheWrite = session.tokensCacheWrite;
  if (![cacheRead, paidInput, cacheWrite].every((tokenValue) => Number.isFinite(tokenValue))) {
    return renderMissingValue(MISSING_REASON.legacyField);
  }
  const denominator = cacheRead + paidInput + cacheWrite;
  if (denominator === 0) {
    return renderMissingValue(MISSING_REASON.zeroDenominator);
  }
  return formatPercent(cacheRead / denominator);
}

/**
 * Reasoning 单元格（v0.20.0）：字段缺失（旧 wire/旧库缺列）渲染 "—"，
 * 不把 undefined 喂给 formatTokens 出 NaN。
 */
function reasoningTokensCell(session) {
  if (!Number.isFinite(session.tokensReasoning)) {
    return renderMissingValue(MISSING_REASON.legacyField);
  }
  return formatTokens(session.tokensReasoning);
}

/** 步数单元格（v0.20.0）：assistant 消息数；字段缺失渲染 "—"。 */
function stepCountCell(session) {
  if (!Number.isFinite(session.stepCount)) {
    return renderMissingValue(MISSING_REASON.legacyField);
  }
  return formatCount(session.stepCount);
}

/** 墙钟时长仅展示正值；旧 wire 缺字段时不冒充零时长。 */
function wallClockCell(session) {
  const durationMilliseconds = session.durationMilliseconds;
  return Number.isFinite(durationMilliseconds) && durationMilliseconds > 0
    ? formatDurationMs(durationMilliseconds)
    : renderMissingValue(MISSING_REASON.nonPositiveDuration);
}

/**
 * 标题单元格（v0.20.0 子代理归总 + 行内「只看此会话」动作）：
 * - 子会话行（parentSessionId 非 null）：标题前加 ↳ 层级标记（极小、
 *   悬浮说明语义），不做可展开树——递归展开留给后续版本；
 * - 父会话行（childSessionCount > 0）：标题旁加「+N 直接子会话」小徽标，
 *   悬浮报直接子代数量与合计 tokens（childTokensTotal 缺失时只报数量），
 *   并说明「仅直接子代，不含孙代」——多级树真实存在（会话可同时是子与父），
 *   只报直接子代，不报整棵子树；
 * - 「只看此会话」：克制的文本小按钮，复用 .badge 描边徽标语言
 *   （行内无先例按钮，badge 是本表既有的最小可点击视觉单位；点击
 *   上抛 onSessionScopeChange，且必须 stopPropagation——行本体点击
 *   是进回放页，两个动作不能同时触发）。
 *   作用域已激活时（sessionScopeId 非 null）列表锁定为单会话视图，
 *   不再渲染该按钮。
 */
function buildTitleCellHtml(session, sessionScopeId, onSessionScopeChange) {
  const titleCellParts = [];
  if (session.parentSessionId !== null && session.parentSessionId !== undefined) {
    titleCellParts.push(
      `<span class="session-child-marker" style="margin-right:4px" title="子代理会话（由父会话派生）">↳</span>`,
    );
  }
  titleCellParts.push(
    `<span class="session-title-cell" title="${escapeHtml(session.title)}">${escapeHtml(session.title)}</span>`,
  );
  if (Number.isFinite(session.childSessionCount) && session.childSessionCount > 0) {
    const childTokensNote = Number.isFinite(session.childTokensTotal)
      ? ` · 合计 tokens ${formatTokens(session.childTokensTotal)}`
      : "";
    titleCellParts.push(
      `<span class="badge session-child-count-badge" title="${escapeHtml(`${session.childSessionCount} 个直接子代理会话 · 仅直接子代，不含孙代${childTokensNote}`)}">+${session.childSessionCount} 直接子会话</span>`,
    );
  }
  if (onSessionScopeChange !== null && sessionScopeId === null) {
    titleCellParts.push(
      `<button type="button" class="badge session-scope-button" data-session-scope-id="${escapeHtml(session.id)}" data-session-scope-title="${escapeHtml(session.title)}" title="把看板各统计切换为只统计此会话（顶栏 ✕ 退出）">只看此会话</button>`,
    );
  }
  return titleCellParts.join("");
}

/**
 * 渲染会话列表。
 * sessionPayload = { total, sessions: SessionSummary[] } 或 null。
 * modelFilter：非 null 时只显示该模型的会话（客户端行过滤；口径 =
 * 会话内 step 级出现过的模型集合 modelIds——与模型排行榜同源，旧 wire
 * 缺 modelIds 时回退 session.modelId 启动模型精确匹配）。
 * sortKey / sortOrder：当前服务端排序（默认与后端契约默认一致）。
 * onSessionSortChange(nextSortKey, nextSortOrder)：列头点击回调，
 * 传 null 时列头不挂排序交互（纯展示用法）。
 * directoryFilter（v0.7.0）：非 null/"" 时当前会话列表已由服务端按
 * 该目录精确匹配过滤（?directory=），本组件只负责把它说出来——
 * 过滤本身不在此发生，行序仍等于 payload 序。
 */
/**
 * 时间范围选择器（v0.9.0）：复用趋势图 .range-switch 胶囊分段控件的
 * 既有语言与样式，词表/label 从 data-source.SESSION_RANGE_OPTIONS 取
 * （不在此复制词表）。每个按钮带 .session-range-button 钩子类，取值在
 * data-session-range（All = ""，与「缺省即全量」的契约归一）。
 */
function sessionRangeSelectorHtml(rangeFilter) {
  const rangeButtonsHtml = SESSION_RANGE_OPTIONS.map((rangeOption) => {
    const isRangeActive = (rangeFilter ?? "") === rangeOption.rangeValue;
    return `<button type="button" class="session-range-button${isRangeActive ? " active" : ""}" data-session-range="${rangeOption.rangeValue}" title="时间范围：${rangeOption.label}">${rangeOption.label}</button>`;
  }).join("");
  return `<div class="session-toolbar"><div class="range-switch" aria-label="会话时间范围">${rangeButtonsHtml}</div></div>`;
}

function bindSessionRangeSelector(container, onSessionRangeChange) {
  if (onSessionRangeChange === null) return;
  for (const rangeButton of container.querySelectorAll("button.session-range-button")) {
    rangeButton.addEventListener("click", () => {
      onSessionRangeChange(rangeButton.dataset.sessionRange ?? "");
    });
  }
}

/**
 * 渲染会话列表。
 * sessionPayload = { total, sessions: SessionSummary[] } 或 null。
 * modelFilter：非 null 时只显示该模型的会话（客户端行过滤；口径 =
 * 会话内 step 级出现过的模型集合 modelIds，与模型排行榜同源——按启动
 * 模型过滤会让 top 榜模型点出空列表，v0.19.0 修复；旧 wire 缺
 * modelIds 时回退启动模型精确匹配）。
 * sortKey / sortOrder：当前服务端排序（默认与后端契约默认一致）。
 * onSessionSortChange(nextSortKey, nextSortOrder)：列头点击回调，
 * 传 null 时列头不挂排序交互（纯展示用法）。
 * directoryFilter（v0.7.0）：非 null/"" 时当前会话列表已由服务端按
 * 该目录精确匹配过滤（?directory=），本组件只负责把它说出来——
 * 过滤本身不在此发生，行序仍等于 payload 序。
 * rangeFilter / onSessionRangeChange（v0.9.0）：当前时间范围（""=All）
 * 与切换回调；回调为 null 时不渲染范围选择器（纯展示用法）。
 * renderOptions（v0.20.0）：{ sessionScopeId, onSessionScopeChange }——
 * sessionScopeId 非 null 表示列表已锁定为该会话的单行视图（排序/范围
 * 选择器与 CSV 导出入口一并锁定不渲染，行内「只看此会话」按钮也不出
 * 现）；onSessionScopeChange(sessionId, sessionTitle) 是行内按钮回调，
 * null 时不渲染按钮（纯展示用法）。
 */
export function renderSessionList(
  container,
  sessionPayload,
  modelFilter,
  sortKey = DEFAULT_SESSION_SORT_KEY,
  sortOrder = DEFAULT_SESSION_SORT_ORDER,
  onSessionSortChange = null,
  directoryFilter = null,
  rangeFilter = DEFAULT_SESSION_RANGE,
  onSessionRangeChange = null,
  renderOptions = {},
) {
  const sessionScopeId = renderOptions.sessionScopeId ?? null;
  const onSessionScopeChange = renderOptions.onSessionScopeChange ?? null;
  const isScopeLocked = sessionScopeId !== null;
  const hasDirectoryFilter = directoryFilter !== null && directoryFilter !== "";
  const rangeLabelText = sessionRangeLabel(rangeFilter);
  const hasRangeFilter = rangeFilter !== null && rangeFilter !== "" && rangeLabelText !== null;
  // 选择器贯穿三态（加载/空态/表格）：空结果时用户仍能切回更宽范围。
  // 作用域锁定视图不渲染：列表只剩一个会话，时间范围切换没有对象。
  const rangeSelectorHtml =
    onSessionRangeChange === null || isScopeLocked ? "" : sessionRangeSelectorHtml(rangeFilter);

  if (sessionPayload === null) {
    container.innerHTML = `${rangeSelectorHtml}${buildLoadingHtml(4)}`;
    bindSessionRangeSelector(container, onSessionRangeChange);
    return;
  }

  const allSessions = sessionPayload.sessions ?? [];
  // 模型下钻口径（v0.19.0 修复）：排行榜行来自 step 级 $.model.id，而
  // session.modelId 只是会话启动模型——按启动模型过滤会让「明明有使用」
  // 的模型点出空列表。改按 modelIds（会话内 step 级出现过的模型集合，
  // 含启动模型）命中过滤；旧宿主 wire 缺 modelIds 时回退启动模型精确
  // 匹配（向后兼容降级，行为不劣于修复前）。
  const sessions = modelFilter === null
    ? allSessions
    : allSessions.filter((session) =>
        Array.isArray(session.modelIds)
          ? session.modelIds.includes(modelFilter)
          : session.modelId === modelFilter);

  if (sessions.length === 0) {
    // 空态文案按过滤叠加组合给出：目录/时间范围（服务端过滤）与模型
    // （客户端过滤）三者 AND 叠加，各自「可能不是原因」要说清楚，避免
    // 空结果被误读成"库是空的"。
    let emptyTitle;
    let emptyHint;
    if (modelFilter !== null && hasDirectoryFilter && hasRangeFilter) {
      emptyTitle = `没有 ${escapeHtml(modelFilter)} 在该目录下且最近 ${rangeLabelText}有更新的会话`;
      emptyHint = "目录、时间范围与模型的过滤是叠加的，试试取消其中一个";
    } else if (modelFilter !== null && hasDirectoryFilter) {
      emptyTitle = `没有 ${escapeHtml(modelFilter)} 在该目录下的会话`;
      emptyHint = "目录和模型的过滤是叠加的，试试取消其中一个";
    } else if (modelFilter !== null && hasRangeFilter) {
      emptyTitle = `没有 ${escapeHtml(modelFilter)} 最近 ${rangeLabelText}有更新的会话`;
      emptyHint = "时间范围和模型的过滤是叠加的，试试放宽范围或取消过滤";
    } else if (hasDirectoryFilter && hasRangeFilter) {
      emptyTitle = `该目录最近 ${rangeLabelText}没有会话更新`;
      emptyHint = "试试切换更长的时间范围，或取消目录过滤";
    } else if (modelFilter !== null) {
      emptyTitle = `没有 ${escapeHtml(modelFilter)} 的会话`;
      emptyHint = "这个模型在最近的会话里没出现过，试试取消过滤";
    } else if (hasDirectoryFilter) {
      emptyTitle = "该目录没有会话记录";
      emptyHint = "这个目录在最近的会话里没出现过，试试点击其他目录行或取消过滤";
    } else if (hasRangeFilter) {
      emptyTitle = `最近 ${rangeLabelText}没有会话更新`;
      emptyHint = "试试切换到更长的时间范围，或选择「All」";
    } else {
      emptyTitle = "没有会话记录";
      emptyHint = "数据库里还没有 session_v2 记录";
    }
    container.innerHTML = `${rangeSelectorHtml}${buildEmptyHtml(emptyTitle, emptyHint)}`;
    bindSessionRangeSelector(container, onSessionRangeChange);
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
      column.extraClass ?? "",
      isSorted ? "sorted" : "",
    ].filter((classToken) => classToken !== "").join(" ");
    const arrow = isSorted ? `<span class="sort-arrow">${sortOrder === "asc" ? "▲" : "▼"}</span>` : "";
    // 可排序列头提示交互；纯展示列（模型/Agent/入/出）改挂口径说明。
    const headerTitle = isInteractive ? "点击排序" : (column.title ?? "");
    return `
      <th class="${classTokens}"${column.sortKey !== null ? ` data-sort-key="${column.sortKey}"` : ""}${headerTitle !== "" ? ` title="${headerTitle}"` : ""}>
        ${column.label}${arrow}
      </th>`;
  }).join("");

  const now = Date.now();
  const rowsHtml = sessions.slice(0, VISIBLE_ROWS).map((session) => {
    // 窗口期旧 wire 可能缺三字段：?? 0 兜底，0 是真数据诚实渲染（非 cost 的
    // "—" 未记录降级）。cache.read 已知时在 Tokens 总量 title 里报分项。
    const tokensInput = session.tokensInput ?? 0;
    const tokensOutput = session.tokensOutput ?? 0;
    const tokensCacheRead = session.tokensCacheRead ?? 0;
    const totalCellTitle = Number.isFinite(session.tokensCacheRead)
      ? `总量 = 入 + 出 + cache.read（本会话 cache.read ${formatTokens(tokensCacheRead)}）`
      : "总量 = 入 + 出 + cache.read";
    return `
    <tr class="session-row" data-session-id="${escapeHtml(session.id)}" title="查看会话回放（M4）">
      <td class="primary">${buildTitleCellHtml(session, sessionScopeId, onSessionScopeChange)}</td>
      <td class="col-session-id"><span class="session-id-cell" title="${escapeHtml(session.id)}">${escapeHtml(shortenSessionId(session.id))}</span></td>
      <td><span class="model-cell"><span class="dot" style="background:${modelColor.get(session.modelId) ?? "transparent"}"></span><span class="name">${escapeHtml(session.modelId)}</span></span></td>
      <td><span class="badge">${escapeHtml(session.agent)}</span></td>
      <td class="num" title="${formatDateTime(session.timeCreated)}">${formatRelative(session.timeCreated, now)}</td>
      <td class="num" title="${formatDateTime(session.timeUpdated)}">${formatRelative(session.timeUpdated, now)}</td>
      <td class="num" title="入 = 纯输入 tokens.input · cache.read 另计 · 与 KPI 卡「入」同口径">${formatTokens(tokensInput)}</td>
      <td class="num" title="出 = tokens.output · 与 KPI 卡「出」同口径">${formatTokens(tokensOutput)}</td>
      <td class="num primary" title="${totalCellTitle}">${formatTokens(session.tokens)}</td>
      <td class="num">${strictHitRateCell(session)}</td>
      <td class="num">${reasoningTokensCell(session)}</td>
      <td class="num">${stepCountCell(session)}</td>
      <td class="num col-duration">${wallClockCell(session)}</td>
      <td class="num">${costCell(session.cost)}</td>
    </tr>`;
  }).join("");

  const hiddenAfterFilterCount = allSessions.length - sessions.length;
  const remainingCount = Math.max(0, sessions.length - VISIBLE_ROWS);
  const footNoteParts = [];
  if (isScopeLocked) {
    // 锁定视图的脚注首要信息：说明这不是「只剩一条」的全量列表，而是
    // 作用域收窄后的单会话视图（排序/导出锁定原因也一并说清）。
    footNoteParts.push(`只看此会话 · 排序与导出已锁定`);
  }
  // v0.7.0/v0.9.0：目录与时间范围都是服务端参数，先于客户端模型过滤说
  if (hasDirectoryFilter) footNoteParts.push(`目录：${escapeHtml(directoryFilter)}`);
  if (hasRangeFilter) footNoteParts.push(`最近 ${rangeLabelText}`);
  if (modelFilter !== null) footNoteParts.push(`已过滤掉 ${hiddenAfterFilterCount} 条非 ${escapeHtml(modelFilter)} 会话`);
  if (remainingCount > 0) footNoteParts.push(`还有 ${remainingCount} 条更早的会话未展示`);
  if (sessionPayload.total === null || sessionPayload.total === undefined) {
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
  // session-csv-export.js）。href 经 data-source 单点构造，directoryFilter/
  // rangeFilter 即 controller 透传的当前过滤值——不另存状态。原生
  // <a download>，无需 JS 点击处理器。作用域锁定视图不渲染：导出端点
  // 不吃 ?session=，此刻入口导出的是全量列表，与锁定视图口径错位。
  const csvExportEntryHtml = isScopeLocked
    ? ""
    : sessionsCsvExportEntryHtml(directoryFilter, rangeFilter);
  if (csvExportEntryHtml !== "") footNoteParts.push(csvExportEntryHtml);

  container.innerHTML = `
    ${rangeSelectorHtml}<table class="data-table session-table" aria-label="会话列表">
      <colgroup>
        <col style="width:200px"><col style="width:150px"><col style="width:140px"><col style="width:110px">
        <col style="width:112px"><col style="width:112px">
        <col style="width:72px"><col style="width:72px"><col style="width:88px">
        <col style="width:76px"><col style="width:80px"><col style="width:64px">
        <col style="width:72px"><col style="width:76px">
      </colgroup>
      <thead><tr>${headCells}</tr></thead>
      <tbody>${rowsHtml}</tbody>
    </table>
    <div class="heatmap-meta">
      <span>${footNoteParts.join(" · ")}</span>
    </div>`;

  bindSessionRangeSelector(container, onSessionRangeChange);

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

  // v0.20.0 行内「只看此会话」：stopPropagation 是硬要求——不拦的话点击
  // 会冒泡到行本体，进回放页与进入作用域两个动作同时触发（真实 DOM 语义；
  // 事件对象缺失的测试环境降级为直接上抛，不影响回放路由的既有行为）。
  if (onSessionScopeChange !== null) {
    for (const scopeButton of container.querySelectorAll("button.session-scope-button")) {
      scopeButton.addEventListener("click", (event) => {
        if (event !== null && typeof event === "object" && typeof event.stopPropagation === "function") {
          event.stopPropagation();
        }
        onSessionScopeChange(
          scopeButton.dataset.sessionScopeId ?? "",
          scopeButton.dataset.sessionScopeTitle ?? "",
        );
      });
    }
  }
}

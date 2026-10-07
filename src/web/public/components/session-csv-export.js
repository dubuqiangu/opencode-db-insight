/**
 * 会话面板的 CSV 导出入口（v0.8.0；v0.9.0 增时间范围联动）：
 * 脚注里的一枚文字链接动作。
 *
 * 下载机制选了**原生锚点**：`<a href download>`——同源 attachment 由
 * 浏览器原生处理（后端 Content-Disposition: attachment 双保险），
 * 不动全局地址、不经过 window.open（会被弹窗拦截）、不动态拼 URL 再
 * 脚本触发。href 在渲染期经 data-source.sessionsExportCsvPath 单点
 * 构造（directory / range 参数编码与拼接都只在 data-source 一处）。
 *
 * 可用性：mock 预览模式隐藏入口（dev 无真实路由，点了 404）。可用性
 * 是渲染期常量，初始渲染即定，无"先显后藏"闪现；isAvailable 作为
 * 带默认值的参数暴露，生产由 session-list 以真实常量接线，测试可
 * 双态驱动（同 renderSessionList 的 onSessionSortChange=null 纯展示
 * 注入模式）。
 */

import { sessionsExportCsvPath, SESSIONS_CSV_EXPORT_AVAILABLE, sessionRangeLabel } from "../data-source.js";
import { escapeHtml } from "../format.js";

/**
 * 导出入口的脚注 HTML 片段；不可用 → ""（调用方直接跳过）。
 * directoryFilter / rangeFilter 为当前下钻过滤与时间范围（null/"" =
 * 不过滤），来自 session-sort-controller 的渲染参数——不另存状态副本。
 * title 按过滤态组合说明导出范围（服务端视图：目录 + 时间范围都生效，
 * 与列表分页/模型客户端过滤无关）。
 */
export function sessionsCsvExportEntryHtml(
  directoryFilter,
  rangeFilter = "",
  isAvailable = SESSIONS_CSV_EXPORT_AVAILABLE,
) {
  if (!isAvailable) return "";
  const hasDirectoryFilter = directoryFilter !== null && directoryFilter !== "";
  const rangeLabelText = sessionRangeLabel(rangeFilter);
  const hasRangeFilter = rangeFilter !== null && rangeFilter !== "" && rangeLabelText !== null;
  let scopeTitle;
  if (hasDirectoryFilter && hasRangeFilter) {
    scopeTitle = `导出当前目录下最近 ${rangeLabelText}有更新的会话为 CSV（服务端过滤视图，与列表分页无关）`;
  } else if (hasDirectoryFilter) {
    scopeTitle = "导出当前目录过滤下的会话为 CSV（服务端全量九列，与列表分页无关）";
  } else if (hasRangeFilter) {
    scopeTitle = `导出最近 ${rangeLabelText}有更新的会话为 CSV（服务端过滤视图，与列表分页无关）`;
  } else {
    scopeTitle = "导出全部会话为 CSV（九列）";
  }
  return `<a class="export-csv" href="${escapeHtml(sessionsExportCsvPath(directoryFilter, rangeFilter))}" download="sessions.csv" title="${scopeTitle}">导出 CSV</a>`;
}

/**
 * 会话面板的 CSV 导出入口（v0.8.0）：脚注里的一枚文字链接动作。
 *
 * 下载机制选了**原生锚点**：`<a href download>`——同源 attachment 由
 * 浏览器原生处理（后端 Content-Disposition: attachment 双保险），
 * 不动全局地址、不经过 window.open（会被弹窗拦截）、不动态拼 URL 再
 * 脚本触发。href 在渲染期经 data-source.sessionsExportCsvPath 单点
 * 构造（directory 参数编码与 fetchSessions 同源，见其注释）。
 *
 * 可用性：mock 预览模式隐藏入口（dev 无真实路由，点了 404）。可用性
 * 是渲染期常量，初始渲染即定，无"先显后藏"闪现；isAvailable 作为
 * 带默认值的参数暴露，生产由 session-list 以真实常量接线，测试可
 * 双态驱动（同 renderSessionList 的 onSessionSortChange=null 纯展示
 * 注入模式）。
 */

import { sessionsExportCsvPath, SESSIONS_CSV_EXPORT_AVAILABLE } from "../data-source.js";
import { escapeHtml } from "../format.js";

/**
 * 导出入口的脚注 HTML 片段；不可用 → ""（调用方直接跳过）。
 * directoryFilter 为当前下钻过滤（null/"" = 全量导出），来自
 * session-sort-controller 的渲染参数——不另存状态副本。
 */
export function sessionsCsvExportEntryHtml(directoryFilter, isAvailable = SESSIONS_CSV_EXPORT_AVAILABLE) {
  if (!isAvailable) return "";
  const hasDirectoryFilter = directoryFilter !== null && directoryFilter !== "";
  const hintTitle = hasDirectoryFilter
    ? "导出当前目录过滤下的会话为 CSV（服务端全量九列，与列表分页无关）"
    : "导出全部会话为 CSV（九列）";
  return `<a class="export-csv" href="${escapeHtml(sessionsExportCsvPath(directoryFilter))}" download="sessions.csv" title="${hintTitle}">导出 CSV</a>`;
}

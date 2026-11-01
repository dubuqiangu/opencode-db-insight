/**
 * 回放页导出动作（v0.29.0 B8）：会话头部的一对文字链接——「导出 Markdown」
 * 「导出 SVG」，指向后端的 DOM-free 导出路由
 * （GET /api/export/session/:id.md / .svg，均回 Content-Disposition: attachment）。
 *
 * 下载机制选了**原生锚点**：`<a href download>`——同源 attachment 由浏览器
 * 原生处理（后端 Content-Disposition 双保险），不动全局地址、不经
 * window.open（会被弹窗拦截）、不动态拼 URL 再脚本触发（同
 * session-csv-export.js 的纪律）。href 在渲染期经 data-source.sessionExportPath
 * 单点构造，本组件不自行拼串。
 *
 * 可用性：mock 预览模式隐藏入口（dev 无真实路由，点了 404）。可用性是
 * 渲染期常量，初始渲染即定，无"先显后藏"闪现；isAvailable 作为带默认值的
 * 参数暴露，生产由 session-replay 以真实常量接线，测试可双态驱动。
 *
 * 纯字符串构建器、无 DOM：返回一段锚点 HTML；不可用 → ""（调用方直接跳过）。
 * sessionId 为外部数据——进 href 前在 data-source 内 encodeURIComponent，
 * 进 title 前 escapeHtml。
 */

import { sessionExportPath, REPLAY_EXPORT_AVAILABLE } from "../data-source.js";
import { escapeHtml } from "../format.js";

/**
 * 两个导出格式的展示元数据，顺序即渲染顺序。filename 是中性下载名
 * （后端还会用 Content-Disposition 里的自身文件名覆盖，这里是兜底）。
 */
const EXPORT_FORMATS = [
  { format: "md", label: "导出 Markdown", filename: "session.md", title: "下载该会话的 Markdown 导出（附件）" },
  { format: "svg", label: "导出 SVG", filename: "session.svg", title: "下载该会话的 SVG 导出（附件）" },
];

/**
 * 导出动作的锚点 HTML 片段；不可用 → ""（调用方直接跳过）。
 * @param {string} sessionId 会话 id（外部数据）
 * @param {boolean} [isAvailable] 渲染期可用性常量（默认接真实模式）
 * @returns {string}
 */
export function sessionExportLinksHtml(sessionId, isAvailable = REPLAY_EXPORT_AVAILABLE) {
  if (!isAvailable) return "";
  return EXPORT_FORMATS
    .map(({ format, label, filename, title }) => {
      const href = escapeHtml(sessionExportPath(sessionId, format));
      return `<a class="replay-export-link" href="${href}" download="${filename}" title="${escapeHtml(title)}">${label}</a>`;
    })
    .join("");
}

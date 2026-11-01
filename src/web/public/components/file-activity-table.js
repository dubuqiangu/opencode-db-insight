/**
 * 文件活动表（v0.29.0，Wave 2A / B5）。
 *
 * 数据 = GET /api/file-activity?limit=N[&session=]（合同 §5.3 冻结响应体）：
 *   {
 *     totalFiles: number,
 *     totalOps: number,
 *     files: [{ path, name, reads, edits, writes, sessions, lastActiveMs }],
 *   }
 * files 已由后端按 ops desc、path asc 排序（ops = reads + edits + writes）；
 * 本组件按契约顺序渲染，不客户端重排。
 *
 * 纯渲染函数：不 fetch、不碰全局 state；数据由接线 lane（app.js）传入。
 *
 * 口径（合同 §5.2 点 2 / 4）：只统计 `read` / `edit` / `write`（grep / glob /
 * shell / bash / patch / ast_grep 已由后端排除）；路径由服务端把
 * `os.homedir()` 前缀换成 `~` 后给出——这里只展示，不二次脱敏。
 *
 * 每行：可见单元格显示 `name`，完整 `path` 一律进 `escapeHtml` 过的 `title`；
 * 一个读/改/写迷你比例条复用 `.todo-seg` 分段语言（宽度 = 本行三分占比）。
 * 配色走纯 CSS 变量（classes），不读 JS 侧 cssVar，故无需 onSchemeChange 重渲。
 */

import { formatCount, escapeHtml, pathLastSegment } from "../format.js";
import { renderMissingValue, MISSING_REASON } from "../precision.js";
import { renderEmpty } from "./state-views.js";

/** 迷你比例条的三段（读 / 改 / 写）及其分段色 class。 */
const OPERATION_SEGMENTS = [
  { field: "reads", label: "读", colorClass: "file-activity-seg-read" },
  { field: "edits", label: "改", colorClass: "file-activity-seg-edit" },
  { field: "writes", label: "写", colorClass: "file-activity-seg-write" },
];

/**
 * 渲染文件活动表。
 * @param {HTMLElement} container #file-activity 挂载点
 * @param {object|null} fileActivity 契约对象（见文件头）
 */
export function renderFileActivityTable(container, fileActivity) {
  if (fileActivity === null || typeof fileActivity !== "object" || Array.isArray(fileActivity)) {
    renderEmpty(container, "还没有文件活动", "数据库里没有 read / edit / write 文件操作记录");
    return;
  }

  const files = readFiles(fileActivity.files);
  if (files.length === 0) {
    renderEmpty(container, "还没有文件活动", "这段范围内没有 read / edit / write 文件操作记录");
    return;
  }

  const totalFiles = readCountOrNull(fileActivity.totalFiles);
  const totalOps = readCountOrNull(fileActivity.totalOps);

  container.innerHTML = `
    <div class="file-activity">
      <div class="file-activity-scroll">
        <table class="data-table file-activity-table" aria-label="文件活动排行：可见名为文件名，完整路径在悬浮提示里">
          <colgroup>
            <col style="width:280px">
            <col style="width:120px">
            <col style="width:64px">
            <col style="width:64px">
            <col style="width:64px">
            <col style="width:72px">
          </colgroup>
          <thead>
            <tr>
              <th scope="col">文件</th>
              <th scope="col">读 / 改 / 写</th>
              <th scope="col" class="num">读</th>
              <th scope="col" class="num">改</th>
              <th scope="col" class="num">写</th>
              <th scope="col" class="num">会话</th>
            </tr>
          </thead>
          <tbody>${files.map(buildFileRowHtml).join("")}</tbody>
        </table>
      </div>
      ${buildMetaHtml(files.length, totalFiles, totalOps)}
    </div>`;
}

/* ---------------- 数据整形 ---------------- */

/**
 * 行清洗：path 非串的行丢弃；name 缺失时用 pathLastSegment(path) 兜底；
 * 四个计数一律非负数值化（0 是真实读数，诚实渲染）。
 */
function readFiles(rawFiles) {
  const cleanedFiles = [];
  for (const rawFile of Array.isArray(rawFiles) ? rawFiles : []) {
    if (rawFile === null || typeof rawFile !== "object") continue;
    const path = typeof rawFile.path === "string" ? rawFile.path : "";
    if (path === "") continue;
    const name = typeof rawFile.name === "string" && rawFile.name !== ""
      ? rawFile.name
      : pathLastSegment(path);
    cleanedFiles.push({
      path,
      name,
      reads: nonNegativeCount(rawFile.reads),
      edits: nonNegativeCount(rawFile.edits),
      writes: nonNegativeCount(rawFile.writes),
      sessions: nonNegativeCount(rawFile.sessions),
    });
  }
  return cleanedFiles;
}

/** 汇总计数（totalFiles / totalOps）：有限非负数 → 值，否则 null。 */
function readCountOrNull(value) {
  const numericValue = Number(value);
  return Number.isFinite(numericValue) && numericValue >= 0 ? numericValue : null;
}

function nonNegativeCount(value) {
  const numericValue = Number(value);
  return Number.isFinite(numericValue) && numericValue > 0 ? numericValue : 0;
}

/* ---------------- HTML 组装 ---------------- */

/** 一行：可见名 + 完整路径 title + 迷你比例条 + 四个计数列。 */
function buildFileRowHtml(file) {
  return `
    <tr>
      <td class="primary"><span class="file-activity-name" title="${escapeHtml(file.path)}">${escapeHtml(file.name)}</span></td>
      <td class="file-activity-bar-cell">${buildMiniBarHtml(file)}</td>
      <td class="num">${formatCount(file.reads)}</td>
      <td class="num">${formatCount(file.edits)}</td>
      <td class="num">${formatCount(file.writes)}</td>
      <td class="num">${formatCount(file.sessions)}</td>
    </tr>`;
}

/**
 * 读/改/写迷你比例条：宽度 = 本行三分占比（分母 = 本行三数之和；为 0 时
 * 整条留空，不回退到别处口径）。仅装饰层，读屏走四个计数列。
 */
function buildMiniBarHtml(file) {
  const operationTotal = file.reads + file.edits + file.writes;
  const segmentHtml = operationTotal > 0
    ? OPERATION_SEGMENTS
      .filter((segment) => file[segment.field] > 0)
      .map((segment) => {
        const sharePercent = (file[segment.field] / operationTotal) * 100;
        return `<span class="todo-seg ${segment.colorClass}" style="width:${sharePercent.toFixed(3)}%" title="${segment.label} ${formatCount(file[segment.field])}"></span>`;
      })
      .join("")
    : "";
  return `<span class="file-activity-bar" aria-hidden="true">${segmentHtml}</span>`;
}

/** 脚注：全量文件数 / 操作数，截断时说明「显示前 N 个」。 */
function buildMetaHtml(shownCount, totalFiles, totalOps) {
  const fileCountHtml = totalFiles === null
    ? renderMissingValue(MISSING_REASON.notRecorded)
    : formatCount(totalFiles);
  const operationCountHtml = totalOps === null
    ? renderMissingValue(MISSING_REASON.notRecorded)
    : formatCount(totalOps);
  const truncatedNote = totalFiles !== null && totalFiles > shownCount
    ? ` · 显示前 ${shownCount} 个`
    : "";
  return `
    <div class="file-activity-meta">
      <span>共 <b class="num">${fileCountHtml}</b> 个文件 · <b class="num">${operationCountHtml}</b> 次 read/edit/write 操作${truncatedNote}</span>
    </div>`;
}

/**
 * 项目目录用量区块（v0.3-A）：按目录聚合的会话/步骤长尾排行。
 * 数据 = GET /api/directories?limit=10：
 *   { totalDirectories, totalSessions, directories: [{directory, name,
 *     sessions, steps, lastActiveMs|null}] }（排序 steps desc 已由后端保证）。
 *
 * 长尾形态下的条宽基准：steps / 榜首 steps（榜首满格、尾部 2px 保底，
 * 与工具调用条形图同款比例语义——总步数占比会把尾部压成不可见线）。
 * directory / name 是外部字符串：innerHTML 与 title 属性插入点一律
 * escapeHtml；name 缺失时用 pathLastSegment(directory) 兜底切分。
 */

import { formatCount, formatRelative, escapeHtml, pathLastSegment } from "../format.js";
import { renderEmpty } from "./state-views.js";

/**
 * 渲染目录用量区块。directoryStats 为契约对象或 null。
 * totalDirectories 为 0 / 列表为空时渲染空占位（不是白块）。
 */
export function renderDirectoryPanel(container, directoryStats) {
  const directoryRows = Array.isArray(directoryStats?.directories) ? directoryStats.directories : [];
  const totalDirectories = Number(directoryStats?.totalDirectories);
  if (directoryStats === null || directoryRows.length === 0 || !Number.isFinite(totalDirectories) || totalDirectories <= 0) {
    renderEmpty(container, "还没有目录统计", "数据库里没有带目录字段的会话记录");
    return;
  }

  // 榜首 steps（契约排序保证首行最大）：条形比例基准
  const topSteps = Math.max(1, Number(directoryRows[0]?.steps) || 0);
  const totalSessions = Number(directoryStats.totalSessions);

  const rowParts = directoryRows.map((rowRecord, rowIndex) => {
    const directoryPath = String(rowRecord?.directory ?? "");
    const displayName = typeof rowRecord?.name === "string" && rowRecord.name !== ""
      ? rowRecord.name
      : pathLastSegment(directoryPath);
    const sessionCount = Math.max(0, Number(rowRecord?.sessions) || 0);
    const stepCount = Math.max(0, Number(rowRecord?.steps) || 0);
    const lastActiveMs = Number(rowRecord?.lastActiveMs);
    const lastActiveText = Number.isFinite(lastActiveMs) && lastActiveMs > 0
      ? formatRelative(lastActiveMs)
      : "—";
    const barWidthPercent = Math.max(2, (stepCount / topSteps) * 100);

    return `
      <div class="directory-row">
        <div class="directory-name-cell" title="${escapeHtml(directoryPath)}">
          <span class="directory-name">${escapeHtml(displayName)}</span>
          <span class="directory-path">${escapeHtml(directoryPath)}</span>
        </div>
        <span class="directory-bar-track"><span class="directory-bar${rowIndex === 0 ? " top" : ""}" style="width:${barWidthPercent.toFixed(1)}%"></span></span>
        <span class="directory-count num" title="会话数">${formatCount(sessionCount)}</span>
        <span class="directory-count num" title="步骤数">${formatCount(stepCount)}</span>
        <span class="directory-last-active num"${Number.isFinite(lastActiveMs) && lastActiveMs > 0 ? ` title="${escapeHtml(new Date(lastActiveMs).toLocaleString())}"` : ""}>${escapeHtml(lastActiveText)}</span>
      </div>`;
  });

  container.innerHTML = `
    <div class="directory-head-row" aria-hidden="true">
      <span>目录</span>
      <span></span>
      <span class="num">会话</span>
      <span class="num">步骤</span>
      <span>最近活跃</span>
    </div>
    <div class="directory-list">${rowParts.join("")}</div>
    <div class="directory-meta">
      <span>共 <b class="num">${formatCount(totalDirectories)}</b> 个目录 · <b class="num">${formatCount(Number.isFinite(totalSessions) ? totalSessions : 0)}</b> 个会话${totalDirectories > directoryRows.length ? ` · 显示前 ${directoryRows.length} 个` : ""}</span>
    </div>`;
}

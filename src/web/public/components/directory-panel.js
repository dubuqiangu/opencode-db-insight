/**
 * 项目目录用量区块（v0.3-A）：按目录聚合的会话/步骤/token 长尾排行。
 * 数据 = GET /api/directories?limit=10：
 *   { totalDirectories, totalSessions, directories: [{directory, name,
 *     sessions, steps, tokensInput, tokensOutput, tokensCacheRead,
 *     lastActiveMs|null}] }（排序 steps desc 已由后端保证）。
 *
 * v0.15.0 入/出双指标列：口径与 v0.13.0 会话列表的入/出列完全一致——
 * 入 = tokensInput 纯实付输入（不含 cache.read，与 KPI 卡「入」同口径），
 * 出 = tokensOutput（与 KPI 卡「出」同口径）。cache.read 不混进入列，
 * 在入单元格的 title 里提示分项值（旧 wire 未知分项时只说「另计」，
 * 不编造 0 值）。目录聚合是会话级汇总（v2），与消息级统计存在约
 * 0.36% 系统差，且无目录的会话被排除——各目录入/出相加不等于全库
 * KPI，列头 title 已注明，避免用户拿两处数字自以为对账。目录面板没有
 * 排序控制器，新列纯展示，行序仍是后端 steps desc 定序。旧 wire 缺
 * 三字段时 `?? 0` 兜底不炸（窗口期契约，0 是兜底真渲染，同会话列）。
 *
 * 长尾形态下的条宽基准：steps / 榜首 steps（榜首满格、尾部 2px 保底，
 * 与工具调用条形图同款比例语义——总步数占比会把尾部压成不可见线）。
 * directory / name 是外部字符串：innerHTML 与 title 属性插入点一律
 * escapeHtml；name 缺失时用 pathLastSegment(directory) 兜底切分。
 *
 * v0.7.0 目录→会话下钻：行点击过滤下方会话列表（服务端 ?directory=
 * 精确匹配），交互范式对齐模型排行榜的 onModelSelected——点选中行
 * 再点取消，选中行 .selected 高亮。空串目录行（v0.3 已知有 1 个）不
 * 挂下钻：后端契约空串=不过滤，点击只会表现为「伪装成过滤的取消」，
 * 不如不做；显示沿用既有空目录降级形态，不因交互能力改变外观。
 */

import { formatCount, formatTokens, formatRelative, escapeHtml, pathLastSegment } from "../format.js";
import { renderEmpty } from "./state-views.js";

/**
 * 渲染目录用量区块。directoryStats 为契约对象或 null。
 * totalDirectories 为 0 / 列表为空时渲染空占位（不是白块）。
 * selectedDirectory：当前下钻过滤的目录（null = 无过滤）。
 * onDirectorySelect(directory | null)：行点击回调（toggle 语义由本
 * 组件内部处理，调用方只管应用）；传 null 时行不挂交互（纯展示用法）。
 */
export function renderDirectoryPanel(container, directoryStats, selectedDirectory = null, onDirectorySelect = null) {
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
    // v0.15.0 三分 tokens：?? 0 兜底旧 wire（同会话列），0 是真数据诚实
    // 渲染。cache.read 未知时入单元格 title 只说「另计」，不编造 0 值。
    const tokensInput = rowRecord?.tokensInput ?? 0;
    const tokensOutput = rowRecord?.tokensOutput ?? 0;
    const tokensCacheRead = rowRecord?.tokensCacheRead ?? 0;
    const isCacheReadKnown = Number.isFinite(rowRecord?.tokensCacheRead);
    const inputCellTitle = isCacheReadKnown
      ? `入 = 纯输入 tokens.input · cache.read ${formatTokens(tokensCacheRead)} 另计 · 与 KPI 卡「入」同口径`
      : "入 = 纯输入 tokens.input · cache.read 另计 · 与 KPI 卡「入」同口径";
    const lastActiveMs = Number(rowRecord?.lastActiveMs);
    const lastActiveText = Number.isFinite(lastActiveMs) && lastActiveMs > 0
      ? formatRelative(lastActiveMs)
      : "—";
    const barWidthPercent = Math.max(2, (stepCount / topSteps) * 100);
    // 空串目录不挂下钻（见头部注释）；有回调且非空串的行才可点。
    const isSelectable = onDirectorySelect !== null && directoryPath !== "";
    const isSelected = selectedDirectory !== null && directoryPath === selectedDirectory;

    return `
      <div class="directory-row${isSelectable ? " selectable" : ""}${isSelected ? " selected" : ""}"${isSelectable ? ` data-directory="${escapeHtml(directoryPath)}" title="点击过滤下方会话列表"` : ""}>
        <div class="directory-name-cell" title="${escapeHtml(directoryPath)}">
          <span class="directory-name">${escapeHtml(displayName)}</span>
          <span class="directory-path">${escapeHtml(directoryPath)}</span>
        </div>
        <span class="directory-bar-track"><span class="directory-bar${rowIndex === 0 ? " top" : ""}" style="width:${barWidthPercent.toFixed(1)}%"></span></span>
        <span class="directory-count num" title="会话数">${formatCount(sessionCount)}</span>
        <span class="directory-count num" title="步骤数">${formatCount(stepCount)}</span>
        <span class="directory-count num" title="${inputCellTitle}">${formatTokens(tokensInput)}</span>
        <span class="directory-count num" title="出 = tokens.output · 与 KPI 卡「出」同口径">${formatTokens(tokensOutput)}</span>
        <span class="directory-last-active num"${Number.isFinite(lastActiveMs) && lastActiveMs > 0 ? ` title="${escapeHtml(new Date(lastActiveMs).toLocaleString())}"` : ""}>${escapeHtml(lastActiveText)}</span>
      </div>`;
  });

  container.innerHTML = `
    <div class="directory-head-row" aria-hidden="true">
      <span>目录</span>
      <span></span>
      <span class="num">会话</span>
      <span class="num">步骤</span>
      <span class="num" title="入 = 纯输入 tokens.input（不含 cache.read，与 KPI 卡「入」同口径）· 目录聚合为会话级汇总，与消息级统计存在约 0.36% 系统差 · 无目录的会话不计入，各目录相加不等于全库">入</span>
      <span class="num" title="出 = tokens.output（与 KPI 卡「出」同口径）· 目录聚合为会话级汇总（v2）">出</span>
      <span>最近活跃</span>
    </div>
    <div class="directory-list">${rowParts.join("")}</div>
    <div class="directory-meta">
      <span>共 <b class="num">${formatCount(totalDirectories)}</b> 个目录 · <b class="num">${formatCount(Number.isFinite(totalSessions) ? totalSessions : 0)}</b> 个会话${totalDirectories > directoryRows.length ? ` · 显示前 ${directoryRows.length} 个` : ""}</span>
    </div>`;

  if (onDirectorySelect !== null) {
    for (const directoryRowElement of container.querySelectorAll(".directory-row.selectable")) {
      directoryRowElement.addEventListener("click", () => {
        // toggle 语义同模型排行榜：点选中行 → null（取消过滤）
        const clickedDirectory = directoryRowElement.dataset.directory;
        onDirectorySelect(clickedDirectory === selectedDirectory ? null : clickedDirectory);
      });
    }
  }
}

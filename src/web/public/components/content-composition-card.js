/**
 * 会话内容构成卡片（v0.29.0，Wave 2A / A4）。
 *
 * 数据 = GET /api/content-composition[?session=]（合同 §5.3 冻结响应体）：
 *   {
 *     totalChars: number,
 *     categories: [{ key, chars, share }],   // chars desc, key asc
 *     toolEstimatedTokens: number,           // 🟡 tokenWeight 覆盖工具字符+字节
 *     sessions: number,
 *   }
 * key 白名单：userText / assistantText / reasoning / toolInput / toolOutput /
 * other。
 *
 * 纯渲染函数：不 fetch、不碰全局 state；数据由接线 lane（app.js）传入。
 *
 * 口径（合同 §5.2 点 1）：构成按 `length()` **字符量**归因——真实 token 无法
 * 归因到内容分类，所以**分类一律以「字符」为单位**，绝不出现「每分类 token
 * 数」。唯一许可的估算 `tokenWeight` 只授权给工具 token，单独占一行并挂
 * `renderPrecisionBadge("estimate")`（🟡）。
 *
 * 占比与条宽都由 `chars / 合计` 重算（不信任 wire 上的独立 `share` 字段）：
 * 既保证图例与堆叠条严格自洽（分段宽之和 = 100%），也避免 `share` 是分数
 * 还是百分数的口径漂移。
 *
 * 配色走纯 CSS 变量（classes），不读 JS 侧 cssVar——主题切换时浏览器自动
 * 重着色，无需 onSchemeChange 重渲。
 */

import { formatCount, formatPercent, escapeHtml } from "../format.js";
import { renderPrecisionBadge, renderMissingValue, MISSING_REASON } from "../precision.js";
import { renderEmpty } from "./state-views.js";

/**
 * key → { 展示名, 分段色 class }。class 同时用在堆叠条分段与图例色块上
 * （同一 key 同色，读图例即认色段）。未知 key 归到 other 的中性色。
 */
const CATEGORY_PRESENTATION = {
  userText: { label: "用户文本", colorClass: "content-composition-seg-user-text" },
  assistantText: { label: "助手文本", colorClass: "content-composition-seg-assistant-text" },
  reasoning: { label: "推理", colorClass: "content-composition-seg-reasoning" },
  toolInput: { label: "工具输入", colorClass: "content-composition-seg-tool-input" },
  toolOutput: { label: "工具输出", colorClass: "content-composition-seg-tool-output" },
  other: { label: "其他", colorClass: "content-composition-seg-other" },
};

const UNKNOWN_CATEGORY_PRESENTATION = CATEGORY_PRESENTATION.other;

/** key → 展示项；未知 key 用原 key 当标签、中性色。 */
function categoryPresentation(key) {
  return CATEGORY_PRESENTATION[key] ?? {
    label: key,
    colorClass: UNKNOWN_CATEGORY_PRESENTATION.colorClass,
  };
}

/**
 * 渲染内容构成卡片。
 * @param {HTMLElement} container #content-composition 挂载点
 * @param {object|null} contentComposition 契约对象（见文件头）
 */
export function renderContentCompositionCard(container, contentComposition) {
  if (contentComposition === null || typeof contentComposition !== "object" || Array.isArray(contentComposition)) {
    renderEmpty(container, "还没有内容构成数据", "数据库里没有可归因的文本或工具内容");
    return;
  }

  const categories = readCategories(contentComposition.categories);
  const totalChars = categories.reduce((sum, category) => sum + category.chars, 0);
  if (categories.length === 0 || totalChars <= 0) {
    renderEmpty(container, "还没有内容构成数据", "这段范围内没有可归因的文本或工具内容");
    return;
  }

  const sessions = readSessionCount(contentComposition.sessions);
  const toolEstimatedTokens = readToolEstimatedTokens(contentComposition.toolEstimatedTokens);

  container.innerHTML = `
    <div class="content-composition">
      ${buildHeadHtml(totalChars, sessions)}
      ${buildStackedBarHtml(categories, totalChars)}
      ${buildLegendTableHtml(categories, totalChars)}
      ${buildToolEstimateHtml(toolEstimatedTokens)}
    </div>`;
}

/* ---------------- 数据整形 ---------------- */

/**
 * 分类清洗：chars 数值化后只收 > 0 的行；key 非串或空 → "other"。
 * 按 chars desc、key asc 重排（与后端契约一致），保证渲染确定性。
 */
function readCategories(rawCategories) {
  const cleanedCategories = [];
  for (const rawCategory of Array.isArray(rawCategories) ? rawCategories : []) {
    if (rawCategory === null || typeof rawCategory !== "object") continue;
    const chars = nonNegativeNumber(rawCategory.chars);
    if (chars <= 0) continue;
    const key = typeof rawCategory.key === "string" && rawCategory.key !== "" ? rawCategory.key : "other";
    cleanedCategories.push({ key, chars });
  }
  cleanedCategories.sort(
    (left, right) => right.chars - left.chars || (left.key < right.key ? -1 : left.key > right.key ? 1 : 0),
  );
  return cleanedCategories;
}

/** 会话数：有限非负数 → 值，否则 null（渲染走不可得占位）。 */
function readSessionCount(rawSessions) {
  const numericSessions = Number(rawSessions);
  return Number.isFinite(numericSessions) && numericSessions >= 0 ? numericSessions : null;
}

/** 工具 token 估算：有限非负数 → 值，否则 null（渲染走不可得占位）。 */
function readToolEstimatedTokens(rawEstimate) {
  const numericEstimate = Number(rawEstimate);
  return Number.isFinite(numericEstimate) && numericEstimate >= 0 ? numericEstimate : null;
}

function nonNegativeNumber(value) {
  const numericValue = Number(value);
  return Number.isFinite(numericValue) && numericValue > 0 ? numericValue : 0;
}

/* ---------------- HTML 组装 ---------------- */

function buildHeadHtml(totalChars, sessions) {
  const sessionsHtml = sessions === null
    ? renderMissingValue(MISSING_REASON.notRecorded)
    : formatCount(sessions);
  return `
    <div class="content-composition-head">
      <span>按内容分类 · 合计 <b class="num">${formatCount(totalChars)}</b> 字符</span>
      <span>会话 <b class="num">${sessionsHtml}</b></span>
    </div>`;
}

/**
 * 单个水平堆叠条：每分类一段 `<span class="todo-seg …">`，宽度 = chars/合计。
 * 段悬浮示意（`title`）报分类名 / 字符数 / 占比。整条仅 aria-hidden 的
 * 装饰层，读屏走右侧图例表。
 */
function buildStackedBarHtml(categories, totalChars) {
  const segmentHtml = categories.map((category) => {
    const presentation = categoryPresentation(category.key);
    const sharePercent = (category.chars / totalChars) * 100;
    const segmentTitle = `${presentation.label} ${formatCount(category.chars)} 字符 · ${formatPercent(category.chars / totalChars, 1)}`;
    return `<span class="todo-seg ${presentation.colorClass}" style="width:${sharePercent.toFixed(3)}%" title="${escapeHtml(segmentTitle)}"></span>`;
  }).join("");
  return `<div class="content-composition-bar" aria-hidden="true">${segmentHtml}</div>`;
}

/** 图例表（分类 / 字符数 / 占比）：colgroup 定宽，窄屏横向滚动。 */
function buildLegendTableHtml(categories, totalChars) {
  const rowHtml = categories.map((category) => {
    const presentation = categoryPresentation(category.key);
    return `
      <tr>
        <td class="primary"><span class="content-composition-swatch ${presentation.colorClass}"></span>${escapeHtml(presentation.label)}</td>
        <td class="num">${formatCount(category.chars)}</td>
        <td class="num">${formatPercent(category.chars / totalChars, 1)}</td>
      </tr>`;
  }).join("");
  return `
    <div class="content-composition-scroll">
      <table class="data-table content-composition-table" aria-label="内容构成：分类 / 字符数 / 占比">
        <colgroup>
          <col style="width:180px">
          <col style="width:120px">
          <col style="width:90px">
        </colgroup>
        <thead>
          <tr>
            <th scope="col">分类</th>
            <th scope="col" class="num">字符数</th>
            <th scope="col" class="num">占比</th>
          </tr>
        </thead>
        <tbody>${rowHtml}</tbody>
      </table>
    </div>`;
}

/**
 * 工具 token 估算行（🟡）：单位是 tokens（不是字符）——它是唯一的
 * `tokenWeight` 估算，单独一条并挂 `renderPrecisionBadge("estimate")`，
 * 与上面的字符构成刻意区分。
 */
function buildToolEstimateHtml(toolEstimatedTokens) {
  const estimateHtml = toolEstimatedTokens === null
    ? renderMissingValue(MISSING_REASON.noSamples)
    : formatCount(toolEstimatedTokens);
  return `
    <div class="content-composition-estimate">
      <span>工具 token 估算 <b class="num">${estimateHtml}</b> tokens ${renderPrecisionBadge("estimate")}</span>
      <span class="content-composition-estimate-note">由工具输入/输出的字符与字节按 tokenWeight 换算，非实值</span>
    </div>`;
}

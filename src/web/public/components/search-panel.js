/**
 * 全文搜索面板（Milestone A，v0.25.0）：跨全部会话搜索消息正文 / 工具
 * 入出参 / 思考过程。纯渲染组件——不感知数据获取，app.js 拥有 fetch，
 * 这里只把 query + mode 上抛给 onSearch(query, mode) 回调，命中结果由
 * app.js 通过 renderSearchResults(container, searchPayload) 回填。
 *
 * 数据契约（GET /api/search，由后端 lane 提供）：
 *   { query, mode, hits: [{ sessionId, sessionTitle, messageId,
 *     messageType, snippet, hitCount }], total }
 * - mode ∈ 子串（substring）| 正则（regex）；
 * - snippet 是后端已高亮好的文本，命中词包在 <mark> 里（外部文本，
 *   渲染前必须 escapeHtml；<mark> 标签由后端返回、本组件信任地原样透传，
 *   其他 HTML 一律转义）；
 * - hit 行点击跳 #/session/<sessionId>（用 encodeURIComponent 编码，
 *   读取端 app.js 用 decodeURIComponent 还原，与 session-list 一致）。
 *
 * 状态机：
 * - 未搜索（初次渲染）：只显示输入框 + 模式选择 + 提交按钮，无结果区；
 * - 加载中：searchPayload 为 null 且正在请求——骨架行占位；
 * - 有结果：计数行「共 N 条命中」+ 命中行列表；
 * - 空结果：温和的空态文案；
 * - 正则错误：后端对非法正则返回 { error } 载荷，本组件渲染专门的错误行
 *   （不弹区块错误卡——搜索是用户可控的输入，错在输入不在数据源）。
 *
 * 本组件导入即无副作用（只 import escapeHtml），可在 node:test 的
 * StubElement 下测试。
 */

import { escapeHtml } from "../format.js";

/** 模式词表：与后端 ?mode= 契约一一对应，不许改。 */
export const SEARCH_MODE_OPTIONS = [
  { modeValue: "substring", label: "子串" },
  { modeValue: "regex", label: "正则" },
];
export const DEFAULT_SEARCH_MODE = "substring";

/**
 * 渲染搜索面板（纯展示 + 回调上抛）。
 * container：面板挂载点。
 * searchState：{ status, payload, error }——
 *   - status: "idle" | "loading" | "done" | "error"
 *   - payload: GET /api/search 成功返回体（或 null）
 *   - error: 正则错误等输入性错误文案（仅 status==="error" 时非空）
 * onSearch(query, mode)：提交回调（Enter 与按钮点击共用）。
 * 传 null 时输入框禁用（纯展示用法）。
 */
export function renderSearchPanel(container, searchState, onSearch = null) {
  const status = searchState?.status ?? "idle";
  const payload = searchState?.payload ?? null;
  const errorMessage = searchState?.error ?? null;
  const isInteractive = onSearch !== null;

  const modeOptionsHtml = SEARCH_MODE_OPTIONS.map((modeOption) => {
    const currentMode = searchState?.mode ?? DEFAULT_SEARCH_MODE;
    const isSelected = modeOption.modeValue === currentMode;
    return `<option value="${modeOption.modeValue}"${isSelected ? " selected" : ""}>${modeOption.label}</option>`;
  }).join("");

  const inputDisabled = isInteractive ? "" : " disabled";
  const resultsHtml = buildSearchResultsHtml(status, payload, errorMessage);

  container.innerHTML = `
    <form class="search-panel-form" data-search-panel-form>
      <input class="search-panel-input" type="search" placeholder="搜索消息正文 / 工具入出参 / 思考过程" aria-label="全文搜索关键词"${inputDisabled}>
      <select class="search-panel-mode" aria-label="搜索模式"${inputDisabled}>${modeOptionsHtml}</select>
      <button type="submit" class="search-panel-submit"${inputDisabled}>搜索</button>
    </form>
    ${resultsHtml}`;

  if (isInteractive) {
    const formElement = container.querySelector("form[data-search-panel-form]");
    const inputElement = container.querySelector("input.search-panel-input");
    const modeElement = container.querySelector("select.search-panel-mode");
    const submitForm = () => {
      const query = (inputElement?.value ?? "").trim();
      if (query === "") return; // 空查询不上抛，与后端 400 语义对齐
      onSearch(query, modeElement?.value ?? DEFAULT_SEARCH_MODE);
    };
    formElement.addEventListener("submit", (event) => {
      if (event !== null && typeof event === "object" && typeof event.preventDefault === "function") {
        event.preventDefault();
      }
      submitForm();
    });
  }
}

/**
 * 结果区 HTML：按状态渲染计数行 / 命中行 / 空态 / 错误行。
 * 命中行的 sessionId 是外部字符串，进 href 前必须 encodeURIComponent；
 * sessionTitle / messageType 是外部字符串，插 innerHTML 前必须
 * escapeHtml。snippet 由后端负责转义并把命中词包进 <mark>（契约承诺
 * snippet 是「安全富文本」：除 <mark>/</mark> 外无其他标签，文本已
 * 转义），这里按契约原样透传，不做二次转义。
 */
function buildSearchResultsHtml(status, payload, errorMessage) {
  if (status === "loading") {
    return `<div class="search-panel-results" aria-busy="true">正在搜索…</div>`;
  }
  if (status === "error") {
    return `<div class="search-panel-results search-panel-error">${escapeHtml(errorMessage)}</div>`;
  }
  if (status === "idle" || payload === null) {
    return `<div class="search-panel-results search-panel-idle">输入关键词开始搜索</div>`;
  }
  const hits = Array.isArray(payload.hits) ? payload.hits : [];
  if (hits.length === 0) {
    return `<div class="search-panel-results search-panel-empty">没有命中「${escapeHtml(payload.query ?? "")}」的结果</div>`;
  }
  const totalCount = Number.isFinite(payload.total) ? payload.total : hits.length;
  const hitRowsHtml = hits.map((hitRecord) => {
    const sessionTitle = typeof hitRecord.sessionTitle === "string"
      ? escapeHtml(hitRecord.sessionTitle)
      : escapeHtml(hitRecord.sessionId ?? "");
    const snippetText = typeof hitRecord.snippet === "string" ? hitRecord.snippet : "";
    const messageType = escapeHtml(hitRecord.messageType ?? "");
    return `
      <a class="search-hit" href="#/session/${encodeURIComponent(hitRecord.sessionId)}">
        <div class="search-hit-head">
          <span class="search-hit-title">${sessionTitle}</span>
          <span class="search-hit-type">${messageType}</span>
        </div>
        <div class="search-hit-snippet">${snippetText}</div>
        <div class="search-hit-count">命中 ${hitRecord.hitCount ?? 1} 处</div>
      </a>`;
  }).join("");
  return `
    <div class="search-panel-results">
      <div class="search-panel-count">共 <b class="num">${totalCount}</b> 条命中</div>
      <div class="search-hit-list">${hitRowsHtml}</div>
    </div>`;
}
/**
 * 组件状态占位：加载骨架 / 空数据 / 错误（API 挂了不白屏）。
 * 所有 mount 型组件在数据未就绪时用这些占位填充容器。
 */

/** 加载骨架：若干条微光文本块。 */
export function renderLoading(container, blockCount = 3) {
  const blocks = [];
  for (let index = 0; index < blockCount; index += 1) {
    const widthPercent = index === blockCount - 1 ? 55 : 88 - index * 12;
    blocks.push(`<div class="skeleton-block skeleton-text" style="width:${widthPercent}%"></div>`);
  }
  container.innerHTML = `<div aria-busy="true">${blocks.join("")}</div>`;
}

/** 空数据占位。hint 可选补充说明。 */
export function renderEmpty(container, message = "这段范围内没有数据", hint = "") {
  container.innerHTML = `
    <div class="state-view">
      <svg class="state-icon" width="34" height="34" viewBox="0 0 24 24" aria-hidden="true">
        <path d="M4 7h16M4 12h10M4 17h7" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>
      </svg>
      <div>${message}</div>
      ${hint ? `<div class="state-hint">${hint}</div>` : ""}
    </div>`;
}

/**
 * 错误占位（含重试按钮）。onRetry 为点击回调。
 * error 预期是 Error 实例，其他值显示通用文案。
 */
export function renderError(container, error, onRetry) {
  const message = error instanceof Error ? error.message : String(error);
  container.innerHTML = `
    <div class="state-view error">
      <strong>这块数据没加载出来</strong>
      <div class="state-hint">${message}</div>
      <button type="button" class="retry-button">重试</button>
    </div>`;
  const retryButton = container.querySelector(".retry-button");
  retryButton.addEventListener("click", onRetry);
}

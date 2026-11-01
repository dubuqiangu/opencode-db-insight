/**
 * 记账守恒卡片（v0.29.0，Wave 1 / A1）。
 *
 * 数据 = GET /api/token-ledger（合同 §3.1 冻结响应体）：
 *   {
 *     totals: { promptInput, promptCacheRead, promptCacheWrite, promptTotal,
 *               output, reasoning, cacheHitRate|null, sessions },
 *     conservation: { anomalies: { negativeComponents, cacheReadExceedsPrompt },
 *                     balanced },
 *     reconciliation: { residualTokens, residualRatio|null, withinTolerance,
 *                       tolerance },
 *     sessions: TokenLedgerSessionStat[],
 *   }
 *
 * 纯渲染函数：不 fetch、不碰全局 state；数据由接线 lane（app.js）传入。
 * 命中率 / 差值率等缺失用 precision.js 的 renderMissingValue，不折算成 0。
 *
 * 口径（合同 §3.2）：
 * - 完整性判定只看 conservation.anomalies（balanced = 两个异常计数均为 0）；
 *   跨源残差绝不参与判定。
 * - reconciliation 是与 session_v2 的**信息性**对照：session_v2 总额含被
 *   compaction 剪掉的历史，message 侧天然偏小，超差是已知差值而非异常。
 *   它以单独的 🟡 中性行呈现，绝不显示「记账偏差 / 错误」。
 *
 * 面板口径：会话作用域感知（端点吃 ?session=），单会话视图下退化为一行
 * 对照，仍成立，故不随作用域隐藏。
 */

import { formatTokens, formatPercent, formatCount, escapeHtml, shortenSessionId } from "../format.js";
import { renderMissingValue, MISSING_REASON } from "../precision.js";
import { renderEmpty } from "./state-views.js";

/**
 * 渲染记账守恒卡片。
 * @param {HTMLElement} container #token-ledger 挂载点
 * @param {object|null} tokenLedger 契约对象（见文件头）
 */
export function renderTokenLedgerCard(container, tokenLedger) {
  if (tokenLedger === null || typeof tokenLedger !== "object" || Array.isArray(tokenLedger)) {
    renderEmpty(container, "还没有记账数据", "数据库里还没有 assistant 消息的 token 记录");
    return;
  }

  const totals = readTotals(tokenLedger.totals);
  const conservation = readConservation(tokenLedger.conservation);
  const reconciliation = readReconciliation(tokenLedger.reconciliation);
  const sessions = readSessions(tokenLedger.sessions);

  if (totals === null || (totals.promptTotal <= 0 && totals.output <= 0 && sessions.length === 0)) {
    renderEmpty(container, "还没有记账数据", "数据库里还没有 assistant 消息的 token 记录");
    return;
  }

  container.innerHTML = buildLedgerHtml(totals, conservation, reconciliation, sessions);
}

/* ---------------- 数据整形 ---------------- */

/** totals 数值化：核心三分/output/reasoning 缺失按 0 计，命中率缺分母 → null。 */
function readTotals(rawTotals) {
  if (rawTotals === null || typeof rawTotals !== "object" || Array.isArray(rawTotals)) return null;
  const promptInput = nonNegativeNumber(rawTotals.promptInput);
  const promptCacheRead = nonNegativeNumber(rawTotals.promptCacheRead);
  const promptCacheWrite = nonNegativeNumber(rawTotals.promptCacheWrite);
  const output = nonNegativeNumber(rawTotals.output);
  const reasoning = nonNegativeNumber(rawTotals.reasoning);
  const promptTotal = promptInput + promptCacheRead + promptCacheWrite;
  const rawHitRate = Number(rawTotals.cacheHitRate);
  return {
    promptInput,
    promptCacheRead,
    promptCacheWrite,
    // promptTotal 由三分重算（不信任 wire 上的独立字段），保证堆叠条与数字自洽。
    promptTotal,
    output,
    reasoning,
    cacheHitRate: Number.isFinite(rawHitRate) && promptTotal > 0 ? rawHitRate : null,
    sessions: Number.isFinite(Number(rawTotals.sessions)) ? Number(rawTotals.sessions) : null,
  };
}

/** conservation 数值化（只有异常计数与 balanced）；缺失时返回 null。 */
function readConservation(rawConservation) {
  if (rawConservation === null || typeof rawConservation !== "object" || Array.isArray(rawConservation)) {
    return null;
  }
  const anomaliesRecord = rawConservation.anomalies !== null && typeof rawConservation.anomalies === "object"
    ? rawConservation.anomalies
    : {};
  return {
    anomalies: {
      negativeComponents: nonNegativeNumber(anomaliesRecord.negativeComponents),
      cacheReadExceedsPrompt: nonNegativeNumber(anomaliesRecord.cacheReadExceedsPrompt),
    },
    balanced: rawConservation.balanced === true,
  };
}

/** reconciliation 数值化（信息性跨源对照）；缺失时返回 null（对照行整体降级）。 */
function readReconciliation(rawReconciliation) {
  if (rawReconciliation === null || typeof rawReconciliation !== "object" || Array.isArray(rawReconciliation)) {
    return null;
  }
  const residualTokens = Number(rawReconciliation.residualTokens);
  const residualRatio = Number(rawReconciliation.residualRatio);
  const tolerance = Number(rawReconciliation.tolerance);
  return {
    residualTokens: Number.isFinite(residualTokens) ? residualTokens : null,
    residualRatio: Number.isFinite(residualRatio) ? residualRatio : null,
    withinTolerance: rawReconciliation.withinTolerance === true,
    tolerance: Number.isFinite(tolerance) ? tolerance : null,
  };
}

/** 逐会话行：保留数值化后的字段，丢弃 sessionId 非串的脏行。 */
function readSessions(rawSessions) {
  const ledgerSessions = [];
  for (const rawSession of Array.isArray(rawSessions) ? rawSessions : []) {
    if (rawSession === null || typeof rawSession !== "object" || typeof rawSession.sessionId !== "string") continue;
    ledgerSessions.push({
      sessionId: rawSession.sessionId,
      messages: nonNegativeNumber(rawSession.messages),
      promptInput: nonNegativeNumber(rawSession.promptInput),
      promptCacheRead: nonNegativeNumber(rawSession.promptCacheRead),
      promptCacheWrite: nonNegativeNumber(rawSession.promptCacheWrite),
      output: nonNegativeNumber(rawSession.output),
      reasoning: nonNegativeNumber(rawSession.reasoning),
      v2Input: nonNegativeNumber(rawSession.v2Input),
      v2CacheRead: nonNegativeNumber(rawSession.v2CacheRead),
      v2CacheWrite: nonNegativeNumber(rawSession.v2CacheWrite),
      v2Output: nonNegativeNumber(rawSession.v2Output),
    });
  }
  return ledgerSessions;
}

function nonNegativeNumber(value) {
  const numericValue = Number(value);
  return Number.isFinite(numericValue) && numericValue > 0 ? numericValue : 0;
}

/* ---------------- HTML 组装 ---------------- */

function buildLedgerHtml(totals, conservation, reconciliation, sessions) {
  return `
    <div class="ledger-card">
      ${buildVerdictHtml(conservation, totals)}
      ${buildPromptSplitHtml(totals)}
      ${buildMetricsHtml(totals)}
      ${buildConservationHtml(conservation, totals)}
      ${buildReconciliationHtml(reconciliation)}
      ${buildSessionsDetailsHtml(sessions)}
    </div>`;
}

/**
 * 判定行：只由 conservation.anomalies 驱动。balanced → 「记账完整」绿；
 * 有异常 → 「记账异常」红并列出异常行数。跨源残差移到独立的中性对照行
 * （见 buildReconciliationHtml），绝不参与此判定。
 */
function buildVerdictHtml(conservation, totals) {
  if (conservation === null) {
    return `
      <div class="ledger-verdict ledger-verdict-unknown">
        <span class="ledger-verdict-badge">守恒未知</span>
        <span class="ledger-verdict-note">${renderMissingValue(MISSING_REASON.notRecorded)} 缺少守恒校验数据</span>
      </div>`;
  }
  const verdictClass = conservation.balanced ? "ledger-verdict-balanced" : "ledger-verdict-anomaly";
  const verdictText = conservation.balanced ? "记账完整" : "记账异常";
  const verdictNoteHtml = conservation.balanced
    ? `共 <b class="num">${formatCount(totals.sessions ?? 0)}</b> 个会话`
    : `分量异常：${summarizeAnomalies(conservation.anomalies)}`;
  return `
    <div class="ledger-verdict ${verdictClass}">
      <span class="ledger-verdict-badge">${verdictText}</span>
      <span class="ledger-verdict-note">${verdictNoteHtml}</span>
    </div>`;
}

/** prompt 三分堆叠条 + 图例（新输入 / 缓存读 / 缓存写 + 命中率）。 */
function buildPromptSplitHtml(totals) {
  const segments = [
    { className: "ledger-seg-input", label: "新输入", value: totals.promptInput, colorHint: "amber" },
    { className: "ledger-seg-read", label: "缓存读", value: totals.promptCacheRead, colorHint: "accent" },
    { className: "ledger-seg-write", label: "缓存写", value: totals.promptCacheWrite, colorHint: "blue" },
  ];
  const segmentHtml = totals.promptTotal > 0
    ? segments.map((segment) => {
      const sharePercent = (segment.value / totals.promptTotal) * 100;
      return `<span class="ledger-seg ${segment.className}" style="width:${sharePercent.toFixed(3)}%" title="${segment.label} ${formatTokens(segment.value)} tokens"></span>`;
    }).join("")
    : `<span class="ledger-seg ledger-seg-empty" style="width:100%"></span>`;

  const legendHtml = segments.map((segment) => `
    <span class="ledger-legend-item">
      <span class="ledger-legend-swatch ${segment.className}"></span>
      ${segment.label} <b class="num">${formatTokens(segment.value)}</b>
      <span class="ledger-legend-share">${totals.promptTotal > 0 ? formatPercent(segment.value / totals.promptTotal, 1) : renderMissingValue(MISSING_REASON.zeroDenominator)}</span>
    </span>`).join("");

  const hitRateHtml = totals.cacheHitRate === null
    ? renderMissingValue(MISSING_REASON.zeroDenominator)
    : escapeHtml(formatPercent(totals.cacheHitRate, 1));

  return `
    <div class="ledger-split">
      <div class="ledger-split-head">
        <span>prompt 供给三分 · 合计 <b class="num">${formatTokens(totals.promptTotal)}</b> tokens</span>
        <span class="ledger-split-hit">缓存命中率 <b class="num">${hitRateHtml}</b></span>
      </div>
      <div class="ledger-split-bar" role="img" aria-label="prompt 供给三级分解：新输入 / 缓存读 / 缓存写">${segmentHtml}</div>
      <div class="ledger-legend">${legendHtml}</div>
    </div>`;
}

/** 关键数值网格：输出 / reasoning / 会话数。 */
function buildMetricsHtml(totals) {
  const metrics = [
    { label: "输出", value: formatTokens(totals.output), unit: "tokens" },
    { label: "reasoning", value: formatTokens(totals.reasoning), unit: "tokens" },
    { label: "会话数", value: totals.sessions === null ? renderMissingValue(MISSING_REASON.notRecorded) : formatCount(totals.sessions), unit: "" },
  ];
  return `
    <div class="ledger-metrics">
      ${metrics.map((metric) => `
        <div class="ledger-metric">
          <span class="ledger-metric-label">${metric.label}</span>
          <span class="ledger-metric-value num">${metric.value} <span class="ledger-metric-unit">${metric.unit}</span></span>
        </div>`).join("")}
    </div>`;
}

/** 完整性明细：消息侧读数 + 分量异常检查（pass/fail 只看异常计数）。 */
function buildConservationHtml(conservation, totals) {
  if (conservation === null) return "";
  return `
    <dl class="ledger-conservation">
      <div class="ledger-conservation-row">
        <dt>消息侧 prompt 合计</dt>
        <dd class="num">${formatTokens(totals.promptTotal)} <span class="ledger-conservation-unit">tokens</span></dd>
      </div>
      <div class="ledger-conservation-row">
        <dt>输出 / reasoning（消息侧）</dt>
        <dd class="num">${formatTokens(totals.output)} / ${formatTokens(totals.reasoning)}</dd>
      </div>
      ${buildAnomalyRowHtml(conservation.anomalies)}
    </dl>`;
}

/** 异常计数 → 逐项报数文案（判定行与明细行共用同一口径）。 */
function summarizeAnomalies(anomalies) {
  const parts = [];
  if (anomalies.negativeComponents > 0) {
    parts.push(`负分项 <b class="num">${formatCount(anomalies.negativeComponents)}</b> 会话`);
  }
  if (anomalies.cacheReadExceedsPrompt > 0) {
    parts.push(`缓存读超 prompt <b class="num">${formatCount(anomalies.cacheReadExceedsPrompt)}</b> 会话`);
  }
  return parts.join(" · ");
}

/** anomalies 行：全为 0 → 绿色「无异常」；有值 → 红色逐项报数。 */
function buildAnomalyRowHtml(anomalies) {
  const hasAnomaly = anomalies.negativeComponents > 0 || anomalies.cacheReadExceedsPrompt > 0;
  if (!hasAnomaly) {
    return `
      <div class="ledger-conservation-row ledger-anomaly-row ledger-anomaly-clear">
        <dt>分量异常检查</dt>
        <dd>无异常</dd>
      </div>`;
  }
  return `
    <div class="ledger-conservation-row ledger-anomaly-row ledger-anomaly-hit">
      <dt>分量异常检查</dt>
      <dd>${summarizeAnomalies(anomalies)}</dd>
    </div>`;
}

/**
 * 跨源对照行（信息性，非 pass/fail）：与 session_v2 的对照差值率 + 容差
 * 状态。session_v2 总额含被 compaction 剪掉的历史，message 侧天然偏小，
 * 故这里只作中性提示，绝不显示「记账偏差 / 错误」，也绝不驱动判定。
 */
function buildReconciliationHtml(reconciliation) {
  const residualRatio = reconciliation === null ? null : reconciliation.residualRatio;
  const residualTokens = reconciliation === null ? null : reconciliation.residualTokens;

  const ratioHtml = residualRatio === null
    ? renderMissingValue(MISSING_REASON.zeroDenominator)
    : escapeHtml(formatPercent(residualRatio, 2));
  const residualTokensHtml = residualTokens === null
    ? renderMissingValue(MISSING_REASON.notRecorded)
    : escapeHtml(`${residualTokens >= 0 ? "+" : "−"}${formatTokens(Math.abs(residualTokens))}`);

  // 容差文案保持中性：比值为缺值时给出缺值占位，不冒充「超出容差」。
  const toleranceStatusHtml = reconciliation === null || residualRatio === null
    ? renderMissingValue(MISSING_REASON.zeroDenominator)
    : (reconciliation.withinTolerance ? "在容差内" : "超出容差（已知差值）");

  return `
    <div class="ledger-reconciliation">
      <span class="ledger-reconciliation-tag">🟡 与 session_v2 对照；含 compaction 剪枝，天然偏小</span>
      <span class="ledger-reconciliation-metric">对照差值率 <b class="num">${ratioHtml}</b></span>
      <span class="ledger-reconciliation-metric">残差 <b class="num">${residualTokensHtml}</b> tokens</span>
      <span class="ledger-reconciliation-status">${toleranceStatusHtml}</span>
    </div>`;
}

/** 逐会话明细（默认收起）：会话 / 消息 / 缓存读 / prompt 合计 / 对照残差。 */
function buildSessionsDetailsHtml(sessions) {
  if (sessions.length === 0) return "";
  const rowsHtml = sessions.map((session) => {
    const messageSide = session.promptInput + session.promptCacheRead + session.promptCacheWrite;
    const sessionTableSide = session.v2Input + session.v2CacheRead + session.v2CacheWrite;
    const rowResidual = sessionTableSide - messageSide;
    const residualClass = rowResidual === 0 ? "" : " ledger-session-residual";
    return `
      <tr>
        <td class="primary" title="${escapeHtml(session.sessionId)}"><code>${escapeHtml(shortenSessionId(session.sessionId))}</code></td>
        <td class="num">${formatCount(session.messages)}</td>
        <td class="num">${formatTokens(session.promptCacheRead)}</td>
        <td class="num">${formatTokens(messageSide)}</td>
        <td class="num${residualClass}">${rowResidual >= 0 ? "+" : "−"}${formatTokens(Math.abs(rowResidual))}</td>
      </tr>`;
  }).join("");

  return `
    <details class="ledger-sessions-details">
      <summary>逐会话对照（${sessions.length} 行）</summary>
      <div class="ledger-sessions-scroll">
        <table class="data-table ledger-sessions-table">
          <colgroup>
            <col style="width:150px">
            <col style="width:64px">
            <col style="width:88px">
            <col style="width:96px">
            <col style="width:88px">
          </colgroup>
          <thead>
            <tr>
              <th scope="col">会话</th>
              <th scope="col" class="num">消息</th>
              <th scope="col" class="num">缓存读</th>
              <th scope="col" class="num">prompt 合计</th>
              <th scope="col" class="num">残差</th>
            </tr>
          </thead>
          <tbody>${rowsHtml}</tbody>
        </table>
      </div>
    </details>`;
}

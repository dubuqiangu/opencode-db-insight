/**
 * 回放页消耗曲线（v0.20.0，Wave 1 / A3 扩展 v0.29.0）：累计 (output +
 * reasoning) 折线 / Delta（相邻请求差值）+ 峰值上下文徽标行 + 全部会话
 * 分位落点徽标 + 事件标记（压缩 ✂ / 模型切换竖线，A2 压缩前峰值标注）。
 *
 * 数据契约（接线 lane 组装后传入）：
 *   stepTokens = {
 *     steps: [{ index, seq, timeCreated,
 *               tokensOutput, tokensReasoning,
 *               tokensInput, tokensCacheRead, tokensCacheWrite }],
 *     distributionPercentiles: { p50, p90, p99 } | null,
 *   }
 *   sessionEvents = { events: [{ seq, timeCreated, type, detail }] } | events[] | null
 *
 * 纯渲染函数：不 fetch、不碰全局 state（Total/Delta 模式是模块级状态，
 * 沿用 trend-chart.js 的 hiddenModelIds / hitRateVisible 做法）。steps 为空
 * 数组 → 不渲染返回 null（接线层不挂）；distributionPercentiles 为 null →
 * 分位徽标整行不渲染；sessionEvents 为空 → 不画任何标记。
 */

import { formatTokens, formatDateTime } from "../format.js";
import { cssVar } from "../theme.js";
import { bindHoverTooltip, hideTooltip } from "../tooltip.js";

const VIEWBOX_WIDTH = 760;
const VIEWBOX_HEIGHT = 200;
const PLOT_LEFT = 48;
const PLOT_RIGHT = 56; // 右侧留白：终点数值标在曲线右方（累计曲线单调不降，右侧恒空）
const PLOT_TOP = 12;
const X_AXIS_Y = VIEWBOX_HEIGHT - 24;
const MAX_X_TICKS = 6;

/**
 * 曲线模式（模块级，跨重渲染/跨会话保留，与 trend-chart 的图例开关同纪律）：
 *   "total" —— 累计 (output + reasoning)；
 *   "delta" —— 相邻请求差值 = 本步 (output + reasoning)。
 */
let curveMode = "total";

/**
 * 渲染 Token 消耗曲线面板。
 * @param {HTMLElement} container 接线 lane 插入回放页的容器 div
 * @param {object} stepTokens 契约对象（见文件头）
 * @param {object|Array|null} sessionEvents 会话事件（见文件头；空则不画标记）
 * @returns {(() => void)|null} cleanup；steps 为空时不渲染返回 null
 */
export function renderReplayTokenCurve(container, stepTokens, sessionEvents = null) {
  const stepPoints = buildStepPoints(stepTokens);
  if (stepPoints === null) return null;

  const peakContextTokens = stepPoints.reduce((largest, point) => Math.max(largest, point.contextTokens), 0);
  const sessionTotalTokens = stepPoints.reduce((sum, point) => sum + point.sessionTotalContribution, 0);
  const distributionPercentiles = stepTokens?.distributionPercentiles;
  const eventMarkers = buildEventMarkers(stepPoints, sessionEvents);

  // 重绘闭包：模式切换只重写容器 innerHTML 并重挂 tooltip/切换监听，
  // 不重建面板外壳结构（trend-chart 的 rebuild 同款）。innerHTML 重建会
  // 丢掉旧按钮与其监听器，无需显式解绑。
  const repaint = () => {
    container.innerHTML = buildPanelHtml(
      stepPoints,
      eventMarkers,
      distributionPercentiles,
      sessionTotalTokens,
      peakContextTokens,
    );
    bindStepTooltips(container, stepPoints);
    bindEventTooltips(container, eventMarkers);
    bindModeToggle(container, repaint);
  };
  repaint();

  return () => hideTooltip();
}

/* ---------------- 面板外壳 ---------------- */

function buildPanelHtml(stepPoints, eventMarkers, distributionPercentiles, sessionTotalTokens, peakContextTokens) {
  return `
    <article class="panel replay-curve-panel">
      <header class="panel-head">
        <div>
          <h2>Token 消耗曲线</h2>
          <p class="panel-sub">${curveMode === "delta" ? "逐步差值 · 本步 output + reasoning" : "逐步累计 · output + reasoning"}</p>
        </div>
        ${buildModeToggleHtml()}
      </header>
      <div class="panel-body">
        <div class="replay-curve-stats">
          <p class="replay-curve-peak" title="各步 (input + cache.read + cache.write) 的最大值，即本会话最重的单步上下文供给">峰值上下文 <b class="num">${formatTokens(peakContextTokens)}</b> tokens</p>
          ${buildQuantileBadgeHtml(distributionPercentiles, sessionTotalTokens)}
          ${buildMarkerLegendHtml(eventMarkers)}
        </div>
        ${buildCurveSvgHtml(stepPoints, eventMarkers)}
      </div>
    </article>`;
}

/** Total / Delta 切换：复用 .range-switch 胶囊（与其它窗口切换器同语言）。 */
function buildModeToggleHtml() {
  return `
    <nav class="range-switch replay-curve-mode" aria-label="曲线模式">
      <button type="button" data-curve-mode="total" class="${curveMode === "total" ? "active" : ""}" aria-pressed="${curveMode === "total"}">Total</button>
      <button type="button" data-curve-mode="delta" class="${curveMode === "delta" ? "active" : ""}" aria-pressed="${curveMode === "delta"}">Delta</button>
    </nav>`;
}

function bindModeToggle(container, repaint) {
  for (const modeButton of container.querySelectorAll("button[data-curve-mode]")) {
    modeButton.addEventListener("click", () => {
      const nextMode = modeButton.dataset.curveMode;
      if ((nextMode !== "total" && nextMode !== "delta") || nextMode === curveMode) return;
      curveMode = nextMode;
      repaint();
    });
  }
}

/* ---------------- 数据整形 ---------------- */

/**
 * steps → 绘图点（按 index 升序）。每点四组量：
 *   cumulative              累计 output + reasoning（Total 模式 y 值）
 *   stepIncrement           本步 output + reasoning（Delta 模式 y 值）
 *   contextTokens           本步 input + cache.read + cache.write（峰值上下文 / A2 标注）
 *   sessionTotalContribution 本步 input + output + cache.read
 *                           （分位比对总量口径 = 会话列表 Tokens 列「入+出+cache.read」，
 *                             与分布端点/分位样本一致，不含 reasoning）
 * 另带 seq / timeCreated 供事件锚点用。空/全脏 → null。
 */
function buildStepPoints(stepTokens) {
  const rawSteps = Array.isArray(stepTokens?.steps) ? stepTokens.steps : [];
  const stepPoints = rawSteps.map((rawStep, position) => {
    const tokensOutput = nonNegativeTokens(rawStep?.tokensOutput);
    const tokensReasoning = nonNegativeTokens(rawStep?.tokensReasoning);
    const tokensInput = nonNegativeTokens(rawStep?.tokensInput);
    const tokensCacheRead = nonNegativeTokens(rawStep?.tokensCacheRead);
    const tokensCacheWrite = nonNegativeTokens(rawStep?.tokensCacheWrite);
    const stepIndex = Number.isFinite(Number(rawStep?.index)) ? Number(rawStep.index) : position;
    return {
      index: stepIndex,
      seq: Number(rawStep?.seq),
      timeCreated: Number(rawStep?.timeCreated),
      cumulative: 0,
      stepIncrement: tokensOutput + tokensReasoning,
      stepOutput: tokensOutput,
      stepReasoning: tokensReasoning,
      contextTokens: tokensInput + tokensCacheRead + tokensCacheWrite,
      sessionTotalContribution: tokensInput + tokensOutput + tokensCacheRead,
    };
  });
  if (stepPoints.length === 0) return null;

  stepPoints.sort((left, right) => left.index - right.index);
  let runningTotal = 0;
  for (const stepPoint of stepPoints) {
    runningTotal += stepPoint.stepIncrement;
    stepPoint.cumulative = runningTotal;
  }
  return stepPoints;
}

/** wire 上缺 key / 负值一律按 0 计。 */
function nonNegativeTokens(value) {
  const numericValue = Number(value);
  return Number.isFinite(numericValue) && numericValue > 0 ? numericValue : 0;
}

/** 当前模式下的 y 值。 */
function modeValue(stepPoint, mode) {
  return mode === "delta" ? stepPoint.stepIncrement : stepPoint.cumulative;
}

/* ---------------- 事件标记（A3 / A2） ---------------- */

/**
 * sessionEvents → 清洗后的事件数组。接受 { events:[...] } 或裸数组；只保留
 * seq/timeCreated/type/detail 四项，type 不认识的丢弃。
 */
function normalizeEvents(sessionEvents) {
  const rawEvents = Array.isArray(sessionEvents)
    ? sessionEvents
    : Array.isArray(sessionEvents?.events) ? sessionEvents.events : [];
  const events = [];
  for (const rawEvent of rawEvents) {
    if (rawEvent === null || typeof rawEvent !== "object") continue;
    const eventType = String(rawEvent.type ?? "");
    if (eventType !== "compaction" && eventType !== "model-switched" && eventType !== "system") continue;
    events.push({
      seq: Number(rawEvent.seq),
      timeCreated: Number(rawEvent.timeCreated),
      type: eventType,
      detail: typeof rawEvent.detail === "string" ? rawEvent.detail : "",
    });
  }
  return events;
}

/**
 * 事件 → 绘图标记，钉在**其后的第一个请求点**。锚点优先用 seq（与消息
 * 同序列空间，精确）；步点缺 seq 时退回 timeCreated。其后无请求点 → 丢弃
 * （不画无落点的标记）。compaction / model-switched 才画（system 事件不进
 * 曲线，避免噪声）。
 */
function buildEventMarkers(stepPoints, sessionEvents) {
  const markers = [];
  for (const event of normalizeEvents(sessionEvents)) {
    if (event.type === "system") continue;
    const pinnedPosition = findPinnedPosition(stepPoints, event);
    if (pinnedPosition === null) continue;
    const pinnedPoint = stepPoints[pinnedPosition];
    const precedingPoint = pinnedPosition > 0 ? stepPoints[pinnedPosition - 1] : null;
    markers.push({
      type: event.type,
      detail: event.detail,
      timeCreated: event.timeCreated,
      stepIndex: pinnedPoint.index,
      precedingPromptTokens: precedingPoint === null ? null : precedingPoint.contextTokens,
    });
  }
  return markers;
}

/** 找其后第一个请求点位置：seq 优先（全部步点都有 seq 时），否则按 timeCreated。 */
function findPinnedPosition(stepPoints, event) {
  const stepsAllHaveSeq = stepPoints.every((point) => Number.isFinite(point.seq));
  const eventSeq = Number(event.seq);
  if (stepsAllHaveSeq && Number.isFinite(eventSeq)) {
    for (let position = 0; position < stepPoints.length; position += 1) {
      if (stepPoints[position].seq >= eventSeq) return position;
    }
    return null;
  }
  const eventTime = Number(event.timeCreated);
  if (!Number.isFinite(eventTime)) return null;
  for (let position = 0; position < stepPoints.length; position += 1) {
    if (Number.isFinite(stepPoints[position].timeCreated) && stepPoints[position].timeCreated >= eventTime) return position;
  }
  return null;
}

/* ---------------- 徽标行 ---------------- */

/** 分位落点徽标一句化：tier 配色对齐 .precision / badge.no-cache 的
 * 描边小徽标语言。percentiles 为 null → 整行不渲染（返回空串）。 */
function buildQuantileBadgeHtml(distributionPercentiles, sessionTotalTokens) {
  const percentileValues = readPercentiles(distributionPercentiles);
  if (percentileValues === null) return "";

  const { p50, p90, p99 } = percentileValues;
  const quantileTier =
    sessionTotalTokens >= p99 ? { className: "over-p99", label: "超过 p99" }
    : sessionTotalTokens >= p90 ? { className: "over-p90", label: "超过 p90" }
    : sessionTotalTokens >= p50 ? { className: "over-p50", label: "超过 p50" }
    : { className: "under-p50", label: "低于 p50" };

  return `
    <p class="replay-curve-quantile-line">
      <span class="badge replay-quantile ${quantileTier.className}"
        title="本会话 ${formatTokens(sessionTotalTokens)} tokens · 全部会话分布：p50 ${formatTokens(p50)} / p90 ${formatTokens(p90)} / p99 ${formatTokens(p99)}">${quantileTier.label}</span>
    </p>`;
}

/** percentiles 三值齐全且有限才启用徽标；否则视为无分布数据。 */
function readPercentiles(rawPercentiles) {
  if (rawPercentiles === null || typeof rawPercentiles !== "object") return null;
  const percentileValues = {};
  for (const quantileKey of ["p50", "p90", "p99"]) {
    const quantileValue = Number(rawPercentiles[quantileKey]);
    if (!Number.isFinite(quantileValue) || quantileValue < 0) return null;
    percentileValues[quantileKey] = quantileValue;
  }
  return percentileValues;
}

/**
 * 标记图例行：有压缩标记才出 ✂ 说明（含 A2 「压缩前峰值 ≈ N」语义 +
 * 🟡 推断），有切换标记才出竖线说明。两者皆无 → 整行不渲染。
 */
function buildMarkerLegendHtml(eventMarkers) {
  const entries = [];
  if (eventMarkers.some((marker) => marker.type === "compaction")) {
    entries.push(`<span class="replay-curve-marker-legend-item"><span class="replay-curve-marker-glyph">✂</span> 压缩点 · 标注 = 压缩前峰值 <span class="replay-curve-inferred">🟡 推断</span></span>`);
  }
  if (eventMarkers.some((marker) => marker.type === "model-switched")) {
    entries.push(`<span class="replay-curve-marker-legend-item"><span class="replay-curve-marker-line-swatch"></span> 模型切换</span>`);
  }
  if (entries.length === 0) return "";
  return `<p class="replay-curve-marker-legend">${entries.join("")}</p>`;
}

/* ---------------- 曲线 SVG ---------------- */

function buildCurveSvgHtml(stepPoints, eventMarkers) {
  const mode = curveMode;
  const firstIndex = stepPoints[0].index;
  const lastIndex = stepPoints[stepPoints.length - 1].index;
  const indexSpan = Math.max(1, lastIndex - firstIndex);
  const maxValue = stepPoints.reduce((largest, point) => Math.max(largest, modeValue(point, mode)), 0);
  const yTickStep = niceTokenStep(maxValue);
  const yMax = Math.max(yTickStep, Math.ceil(maxValue / yTickStep) * yTickStep);
  const plotWidth = VIEWBOX_WIDTH - PLOT_LEFT - PLOT_RIGHT;

  const indexToX = (stepIndex) => PLOT_LEFT + ((stepIndex - firstIndex) / indexSpan) * plotWidth;
  const valueToY = (tokenValue) => X_AXIS_Y - (tokenValue / yMax) * (X_AXIS_Y - PLOT_TOP);

  const curvePath = stepPoints
    .map((point, pointPosition) => `${pointPosition === 0 ? "M" : "L"}${indexToX(point.index).toFixed(1)},${valueToY(modeValue(point, mode)).toFixed(1)}`)
    .join(" ");
  const areaPath = `${curvePath} L${indexToX(lastIndex).toFixed(1)},${X_AXIS_Y} L${indexToX(firstIndex).toFixed(1)},${X_AXIS_Y} Z`;

  const lastPoint = stepPoints[stepPoints.length - 1];
  const lastPointX = indexToX(lastIndex);
  const lastPointY = valueToY(modeValue(lastPoint, mode));

  const svgParts = [];
  // y 轴：基线 + 好数刻度网格
  svgParts.push(`<line x1="${PLOT_LEFT}" y1="${X_AXIS_Y}" x2="${VIEWBOX_WIDTH - PLOT_RIGHT}" y2="${X_AXIS_Y}" stroke="${cssVar("--grid-line")}"/>`);
  for (let tickValue = yTickStep; tickValue <= yMax; tickValue += yTickStep) {
    const tickY = valueToY(tickValue);
    svgParts.push(`<line x1="${PLOT_LEFT}" y1="${tickY.toFixed(1)}" x2="${VIEWBOX_WIDTH - PLOT_RIGHT}" y2="${tickY.toFixed(1)}" stroke="${cssVar("--grid-line")}"/>`);
    svgParts.push(`<text x="${PLOT_LEFT - 8}" y="${(tickY + 3.5).toFixed(1)}" text-anchor="end" font-size="10" fill="${cssVar("--text-faint")}" font-family="ui-monospace, Consolas, monospace">${formatTokens(tickValue)}</text>`);
  }
  // x 轴：步 index 刻度（含首尾）
  const xTickStride = Math.max(1, Math.ceil(stepPoints.length / (MAX_X_TICKS - 1)));
  const xTickIndices = new Set();
  for (let pointPosition = 0; pointPosition < stepPoints.length; pointPosition += xTickStride) {
    xTickIndices.add(pointPosition);
  }
  xTickIndices.add(stepPoints.length - 1);
  for (const pointPosition of xTickIndices) {
    const point = stepPoints[pointPosition];
    const textAnchor = pointPosition === stepPoints.length - 1 ? "end" : "middle";
    svgParts.push(`<text x="${indexToX(point.index).toFixed(1)}" y="${VIEWBOX_HEIGHT - 6}" text-anchor="${textAnchor}" font-size="10" fill="${cssVar("--text-faint")}" font-family="ui-monospace, Consolas, monospace">${point.index}</text>`);
  }
  // 面积 + 曲线 + 终点
  svgParts.push(`<path class="replay-curve-area" d="${areaPath}" fill="${cssVar("--accent-soft")}"/>`);
  svgParts.push(`<path class="replay-curve-line" d="${curvePath}" fill="none" stroke="${cssVar("--accent")}" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round"/>`);
  if (mode === "delta") {
    // Delta 模式：每步一个点，读出「单步差值」的离散感（Total 单调不降，无需点）。
    for (const point of stepPoints) {
      svgParts.push(`<circle class="replay-curve-delta-dot" cx="${indexToX(point.index).toFixed(1)}" cy="${valueToY(modeValue(point, mode)).toFixed(1)}" r="1.8" fill="${cssVar("--accent")}"/>`);
    }
  }
  // 事件标记（A3）：压缩 ✂ + 压缩前峰值（A2，🟡 推断）；模型切换竖线
  svgParts.push(buildMarkerParts(eventMarkers, indexToX));
  svgParts.push(`<circle cx="${lastPointX.toFixed(1)}" cy="${lastPointY.toFixed(1)}" r="3" fill="${cssVar("--accent")}"/>`);
  svgParts.push(`<text x="${(lastPointX + 6).toFixed(1)}" y="${(lastPointY + 3.5).toFixed(1)}" font-size="11" font-weight="600" fill="${cssVar("--accent")}" font-family="ui-monospace, Consolas, monospace">${formatTokens(modeValue(lastPoint, mode))}</text>`);

  // 步级悬浮热区：透明圆挂在数据点上（fill="transparent" 吃指针事件），
  // tooltip 报累计与单步分项
  stepPoints.forEach((point, pointPosition) => {
    svgParts.push(`<circle class="replay-curve-hit" data-step-position="${pointPosition}" cx="${indexToX(point.index).toFixed(1)}" cy="${valueToY(modeValue(point, mode)).toFixed(1)}" r="7" fill="transparent"/>`);
  });
  // 事件悬浮热区：覆盖标记竖线的透明矩形（比圆更好命中竖线）
  eventMarkers.forEach((marker, markerPosition) => {
    const markerX = indexToX(marker.stepIndex);
    svgParts.push(`<rect class="replay-curve-event-hit" data-event-position="${markerPosition}" x="${(markerX - 6).toFixed(1)}" y="${PLOT_TOP}" width="12" height="${X_AXIS_Y - PLOT_TOP}" fill="transparent"/>`);
  });

  const modeLabel = mode === "delta" ? "增量" : "累计";
  return `<svg class="replay-curve-svg" viewBox="0 0 ${VIEWBOX_WIDTH} ${VIEWBOX_HEIGHT}" role="img" aria-label="本会话 token 逐步${modeLabel}消耗曲线">${svgParts.join("")}</svg>`;
}

/** 事件标记绘制：竖线 + ✂ 字形 + 压缩前峰值标注（🟡 推断）。 */
function buildMarkerParts(eventMarkers, indexToX) {
  const parts = [];
  const amberColor = cssVar("--amber");
  const blueColor = cssVar("--blue");
  const panelColor = cssVar("--panel");
  for (const marker of eventMarkers) {
    const markerX = indexToX(marker.stepIndex).toFixed(1);
    if (marker.type === "compaction") {
      parts.push(`<line class="replay-curve-marker-line" x1="${markerX}" y1="${PLOT_TOP}" x2="${markerX}" y2="${X_AXIS_Y}" stroke="${amberColor}" stroke-width="1" stroke-dasharray="4 3"/>`);
      parts.push(`<text class="replay-curve-marker-glyph" x="${markerX}" y="${PLOT_TOP + 10}" text-anchor="middle" font-size="12" fill="${amberColor}">✂</text>`);
      if (marker.precedingPromptTokens !== null) {
        // A2 推断标注：该标记前最近一次 assistant 请求的 prompt tokens（🟡）。
        // 描边同底色做光晕，压在面积填充上仍清晰。
        parts.push(`<text class="replay-curve-marker-label" x="${markerX}" y="${PLOT_TOP + 22}" text-anchor="middle" font-size="9" fill="${amberColor}" stroke="${panelColor}" stroke-width="2.5" paint-order="stroke" font-family="ui-monospace, Consolas, monospace">≈${formatTokens(marker.precedingPromptTokens)}</text>`);
      }
    } else {
      parts.push(`<line class="replay-curve-marker-line" x1="${markerX}" y1="${PLOT_TOP}" x2="${markerX}" y2="${X_AXIS_Y}" stroke="${blueColor}" stroke-width="1" stroke-dasharray="2 3"/>`);
    }
  }
  return parts.join("");
}

/* ---------------- 悬浮提示 ---------------- */

function bindStepTooltips(container, stepPoints) {
  for (const hitElement of container.querySelectorAll(".replay-curve-hit")) {
    const point = stepPoints[Number(hitElement.dataset.stepPosition)];
    bindHoverTooltip(hitElement, () => ({
      title: Number.isFinite(point.timeCreated)
        ? `步 ${point.index} · ${formatDateTime(point.timeCreated)}`
        : `步 ${point.index}`,
      rows: [
        { label: "累计", value: formatTokens(point.cumulative) },
        { label: "本步 output", value: formatTokens(point.stepOutput) },
        { label: "本步 reasoning", value: formatTokens(point.stepReasoning) },
        { label: "上下文供给", value: formatTokens(point.contextTokens) },
      ],
    }));
  }
}

function bindEventTooltips(container, eventMarkers) {
  for (const hitElement of container.querySelectorAll(".replay-curve-event-hit")) {
    const marker = eventMarkers[Number(hitElement.dataset.eventPosition)];
    bindHoverTooltip(hitElement, () => buildEventTooltipContent(marker));
  }
}

/** 事件 tooltip：类型 + 时间 + detail；压缩点补 A2 推断峰值说明。 */
function buildEventTooltipContent(marker) {
  const timeText = Number.isFinite(marker.timeCreated) ? formatDateTime(marker.timeCreated) : "";
  if (marker.type === "model-switched") {
    return {
      title: "模型切换",
      rows: [
        ...(marker.detail === "" ? [] : [{ label: "切换", value: marker.detail }]),
        ...(timeText === "" ? [] : [{ label: "时间", value: timeText }]),
        { label: "锚点", value: `其后第 ${marker.stepIndex} 步请求` },
      ],
    };
  }
  const rows = [];
  if (marker.detail !== "") rows.push({ label: "原因", value: marker.detail });
  if (timeText !== "") rows.push({ label: "时间", value: timeText });
  rows.push({ label: "锚点", value: `其后第 ${marker.stepIndex} 步请求` });
  if (marker.precedingPromptTokens !== null) {
    rows.push({
      label: "压缩前峰值（🟡 推断）",
      value: `≈ ${formatTokens(marker.precedingPromptTokens)} tokens`,
    });
    rows.push({ label: "口径", value: "该点前最近一次请求的 prompt tokens（input + cache.read + cache.write）" });
  }
  return { title: "上下文压缩 ✂", rows };
}

/* ---------------- 小工具 ---------------- */

/** 1/2/5×10^k 步进中取 ≥ range/3 的最小者，保证 y 轴刻度是「好数」。 */
function niceTokenStep(range) {
  const rawStep = Math.max(1, range / 3);
  const magnitude = Math.pow(10, Math.floor(Math.log10(rawStep)));
  for (const multiplier of [1, 2, 5, 10]) {
    const candidateStep = multiplier * magnitude;
    if (candidateStep >= rawStep) return candidateStep;
  }
  return 10 * magnitude;
}

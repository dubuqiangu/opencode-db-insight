/**
 * KPI 卡片行：今日 tokens（in/out 分列）、今日缓存命中率（▲▼ 环比）、
 * 今日步骤数、累计会话数。每卡底部 mini sparkline，右上角精度标签。
 *
 * 数据形状 = data-source.fetchOverview()，字段见 mock-data.js 头注。
 * overview 为 null 时渲染骨架占位（由 app.js 决定何时重调）。
 */

import { formatTokens, formatPercent, formatCount } from "../format.js";
import { renderLoading } from "./state-views.js";

const PRECISION_TITLE_EXACT = "实值：直接来自 opencode.db 的原始计数，未做任何换算。";
const PRECISION_TITLE_ESTIMATE = "估算：由 token 量按公开单价换算而来，仅作量级参考（本库 cost 字段常为 0）。";

function precisionBadge(kind) {
  const isExact = kind === "exact";
  return `<span class="precision ${isExact ? "exact" : "estimate"}" title="${isExact ? PRECISION_TITLE_EXACT : PRECISION_TITLE_ESTIMATE}">${isExact ? "实值" : "估算"}</span>`;
}

/** 迷你 sparkline：min-max 归一化的面积折线，宽度铺满卡片底部。 */
function sparklineSvg(values, cssColor) {
  if (!Array.isArray(values) || values.length < 2) return "";
  const width = 100;
  const height = 30;
  let minValue = Math.min(...values);
  let maxValue = Math.max(...values);
  if (maxValue === minValue) {
    maxValue = minValue + 1;
  }
  const padding = (maxValue - minValue) * 0.12;
  minValue -= padding;
  maxValue += padding;

  const stepX = width / (values.length - 1);
  const points = values.map((value, index) => {
    const x = index * stepX;
    const y = height - ((value - minValue) / (maxValue - minValue)) * height;
    return `${x.toFixed(2)},${y.toFixed(2)}`;
  });
  const lastX = width;
  const lastY = height - ((values[values.length - 1] - minValue) / (maxValue - minValue)) * height;

  return `
    <svg class="kpi-spark" viewBox="0 0 ${width} ${height + 4}" preserveAspectRatio="none" aria-hidden="true">
      <polygon points="0,${height} ${points.join(" ")} ${lastX},${height}"
        style="fill:${cssColor}; opacity:0.14" />
      <polyline points="${points.join(" ")}"
        style="fill:none; stroke:${cssColor}; stroke-width:1.5; opacity:0.85"
        vector-effect="non-scaling-stroke" />
      <circle cx="${lastX}" cy="${lastY.toFixed(2)}" r="2"
        style="fill:${cssColor}" />
    </svg>`;
}

/** 环比角标：▲/▼ + 数值；deltaText 为 null 时显示持平。 */
function deltaBadge(deltaText, direction) {
  if (deltaText === null || deltaText === undefined) {
    return `<span class="delta flat">— 环比</span>`;
  }
  if (direction === 0) return `<span class="delta flat">持平</span>`;
  const arrow = direction > 0 ? "▲" : "▼";
  return `<span class="delta ${direction > 0 ? "up" : "down"}">${arrow} ${deltaText}</span>`;
}

function cardHtml({ tone, label, valueHtml, subHtml, sparkline, precision }) {
  return `
    <article class="kpi-card" data-tone="${tone}">
      <div class="kpi-head">
        <span class="kpi-label">${label}</span>
        ${precisionBadge(precision)}
      </div>
      <div class="kpi-value">${valueHtml}</div>
      <div class="kpi-sub">${subHtml}</div>
      ${sparkline}
    </article>`;
}

/**
 * 渲染整行 KPI 卡。container 通常为 #kpi-row。
 * overview 字段缺失时对应数字显示 "—"，不抛错。
 */
export function renderKpiRow(container, overview) {
  if (overview === null || overview === undefined) {
    renderLoading(container, 1);
    return;
  }

  const todayTokensDeltaText = ratioDeltaText(overview.todayTokens, overview.yesterdayTokens);
  const hitDeltaText = pointDeltaText(overview.todayHitRate, overview.yesterdayHitRate);
  const stepsDeltaText = ratioDeltaText(overview.todaySteps, overview.yesterdaySteps);

  const sessions14Day = (overview.sparklineSessions ?? []).filter((count) => Number.isFinite(count));
  const sessionsDailyAvg = sessions14Day.length > 0
    ? Math.round(sessions14Day.reduce((sum, count) => sum + count, 0) / sessions14Day.length)
    : null;

  const cardsHtml = [
    cardHtml({
      tone: "tokens",
      label: "今日 Tokens",
      valueHtml: `${formatTokens(overview.todayTokens)}<small>tok</small>`,
      subHtml: `
        <span class="kpi-split">入 <b class="in num">${formatTokens(overview.todayInput)}</b>
          · 出 <b class="out num">${formatTokens(overview.todayOutput)}</b></span>
        <span class="kpi-split">≈ <span class="num">$${overview.todayCostEstimateUsd ?? "—"}</span> ${precisionBadge("estimate")}</span>
        ${deltaBadge(todayTokensDeltaText, signOf(overview.todayTokens, overview.yesterdayTokens))}`,
      sparkline: sparklineSvg(overview.sparklineTokens, "var(--blue)"),
      precision: "exact",
    }),
    cardHtml({
      tone: "hitrate",
      label: "今日缓存命中率",
      valueHtml: `${formatPercent(overview.todayHitRate, 1)}`,
      subHtml: `
        <span>昨日 <span class="num">${formatPercent(overview.yesterdayHitRate, 1)}</span></span>
        ${deltaBadge(hitDeltaText, signOf(overview.todayHitRate, overview.yesterdayHitRate))}`,
      sparkline: sparklineSvg(overview.sparklineHitRate, "var(--accent)"),
      precision: "exact",
    }),
    cardHtml({
      tone: "steps",
      label: "今日步骤数",
      valueHtml: `${formatCount(overview.todaySteps)}`,
      subHtml: `
        <span>昨日 <span class="num">${formatCount(overview.yesterdaySteps)}</span></span>
        ${deltaBadge(stepsDeltaText, signOf(overview.todaySteps, overview.yesterdaySteps))}`,
      sparkline: sparklineSvg(overview.sparklineSteps, "var(--purple)"),
      precision: "exact",
    }),
    cardHtml({
      tone: "sessions",
      label: "累计会话数",
      valueHtml: `${formatCount(overview.sessionCount)}`,
      subHtml: sessionsDailyAvg === null
        ? `<span>全历史累计</span>`
        : `<span>近 14 日均 <span class="num">${sessionsDailyAvg}</span> 个/天</span>`,
      sparkline: sparklineSvg(overview.sparklineSessions, "var(--amber)"),
      precision: "exact",
    }),
  ].join("");

  container.innerHTML = cardsHtml;
}

/* ---------- 数值环比小函数 ---------- */

function signOf(current, previous) {
  if (!Number.isFinite(current) || !Number.isFinite(previous) || current === previous) return 0;
  return current > previous ? 1 : -1;
}

function ratioDeltaText(current, previous) {
  if (!Number.isFinite(current) || !Number.isFinite(previous) || previous === 0) return null;
  return Math.abs((current - previous) / previous * 100).toFixed(1) + "%";
}

function pointDeltaText(current, previous) {
  if (!Number.isFinite(current) || !Number.isFinite(previous)) return null;
  return Math.abs((current - previous) * 100).toFixed(1) + "pp";
}

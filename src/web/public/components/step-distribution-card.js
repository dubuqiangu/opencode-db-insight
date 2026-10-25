/**
 * 会话步数分布卡（v0.21.0）：复用共享分布直方图渲染器
 * （distribution-card.js 的 renderSharedDistributionCard），只是轴刻度
 * 按整数步数格式化、卡头小字报「均值 X 步」。
 *
 * 数据 = 与 token 分布同形的统一分布载荷：
 *   { totalSessions, buckets:[{start,end,count}], percentiles:{p50,p90,p99},
 *     mean, max }
 * 纯渲染：不 fetch、不碰全局 state；数据由接线 lane 传入。
 * distribution === null → 共享渲染器的「数据不可达」降级块。
 */

import { formatCount } from "../format.js";
import { MISSING_REASON, renderMissingValue } from "../precision.js";
import { renderSharedDistributionCard } from "./distribution-card.js";

/** 步数分布卡的展示选项：轴刻度走整数计数（formatCount），单位「步」。 */
const STEP_CARD_OPTIONS = {
  formatAxis: (value) => formatCount(value),
  // 均值缺失时给带原因悬浮的占位；本回调的返回值按 HTML 插入，
  // 故必须同时置 `formatMeanReturnsHtml`，否则会被共享渲染器转义成字面标签。
  formatMean: (value) => Number.isFinite(value) ? value.toFixed(1) : renderMissingValue(MISSING_REASON.noSamples),
  formatMeanReturnsHtml: true,
  sampleUnit: "步",
  rawUnit: "步",
  exclusionLabel: "已排除零 assistant 消息会话",
  emptyHint: "全部会话中没有 assistant 消息可统计",
  ariaLabel: "会话步数分布直方图，含 p50/p90/p99 分位标线",
};

/**
 * 渲染会话步数分布卡。
 * @param {HTMLElement} container 挂载点
 * @param {object|null} distribution 统一分布载荷或 null
 * @returns {() => void} cleanup
 */
export function renderStepDistributionCard(container, distribution) {
  return renderSharedDistributionCard(container, distribution, STEP_CARD_OPTIONS);
}
